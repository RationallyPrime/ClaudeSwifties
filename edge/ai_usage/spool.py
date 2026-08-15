"""Atomic immutable observation spool and monotonic profile sequence."""

from __future__ import annotations

import fcntl
import json
import os
import re
import tempfile
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from .config import CollectorConfig
from .contract import Observation
from .errors import CollectorError, SpoolFull
from .util import atomic_write_bytes, atomic_write_json, private_directory, read_json

SPOOL_NAME_RE = re.compile(r"(?P<sequence>[0-9]{16})-(?P<id>[0-9a-f-]{36})\.json\Z")
MAX_OBSERVATION_BYTES = 8 * 1024


class FileLock:
    """Advisory non-reentrant lock used on the supported macOS/Linux edges."""

    def __init__(self, path: Path, *, blocking: bool = True):
        self.path = path
        self.blocking = blocking
        self._handle = None

    def __enter__(self) -> FileLock:  # noqa: PYI034 - Python 3.10 has no typing.Self
        private_directory(self.path.parent)
        handle = self.path.open("a+")
        os.chmod(self.path, 0o600)
        operation = fcntl.LOCK_EX | (0 if self.blocking else fcntl.LOCK_NB)
        try:
            fcntl.flock(handle.fileno(), operation)
        except BlockingIOError:
            handle.close()
            raise
        self._handle = handle
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        if self._handle is not None:
            fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
            self._handle.close()
            self._handle = None


class Sequence:
    def __init__(self, config: CollectorConfig):
        self.path = config.sequence_path
        self.lock_path = config.state_dir / "sequence.lock"

    def next(self) -> int:
        with FileLock(self.lock_path):
            current = -1
            try:
                raw = self.path.read_text(encoding="ascii").strip()
                if raw:
                    current = int(raw)
            except FileNotFoundError:
                pass
            except (OSError, UnicodeDecodeError, ValueError) as error:
                raise CollectorError("profile sequence state is corrupt") from error
            if current >= 9_007_199_254_740_990:
                raise CollectorError(
                    "profile sequence exhausted the JSON safe-integer range"
                )
            value = current + 1
            # Atomic rename is enough for process-cancellation safety. A full
            # disk barrier on every status-line render misses the 50 ms hot
            # path budget by an order of magnitude on APFS.
            atomic_write_bytes(
                self.path, f"{value}\n".encode("ascii"), mode=0o600, sync=False
            )
            return value


@dataclass(frozen=True)
class PendingObservation:
    path: Path
    observation: Observation


class Spool:
    def __init__(self, config: CollectorConfig):
        self.config = config
        self.root = private_directory(config.spool_dir)
        self.temporary = private_directory(self.root / ".tmp")

    @staticmethod
    def _encode(observation: Observation) -> bytes:
        encoded = (
            json.dumps(observation.to_dict(), ensure_ascii=False, separators=(",", ":"))
            + "\n"
        ).encode("utf-8")
        if len(encoded) > MAX_OBSERVATION_BYTES:
            raise CollectorError("observation exceeds the server's 8 KiB request bound")
        return encoded

    def _paths(self) -> list[Path]:
        return sorted(
            path for path in self.root.iterdir() if SPOOL_NAME_RE.fullmatch(path.name)
        )

    def _usage(self, paths: list[Path] | None = None) -> tuple[int, int]:
        paths = self._paths() if paths is None else paths
        total = 0
        for path in paths:
            try:
                total += path.stat().st_size
            except FileNotFoundError:
                pass
        return len(paths), total

    @staticmethod
    def _coalesce_key(value: dict) -> tuple:
        windows = value.get("windows")
        generations = (
            tuple(
                (window.get("id"), window.get("resets_at"))
                for window in windows
                if isinstance(window, dict)
            )
            if isinstance(windows, list)
            else ()
        )
        return (
            value.get("provider"),
            value.get("profile_id"),
            value.get("session_id"),
            value.get("provider_subject"),
            value.get("identity_evidence"),
            value.get("status"),
            value.get("sample_time_quality"),
            value.get("pool_label"),
            generations,
        )

    @staticmethod
    def _componentwise_monotonic(older: dict, newer: dict) -> bool:
        older_windows = older.get("windows")
        newer_windows = newer.get("windows")
        if not isinstance(older_windows, list) or not isinstance(newer_windows, list):
            return False
        older_values = {
            window.get("id"): window.get("utilization")
            for window in older_windows
            if isinstance(window, dict)
        }
        newer_values = {
            window.get("id"): window.get("utilization")
            for window in newer_windows
            if isinstance(window, dict)
        }
        if older_values.keys() != newer_values.keys():
            return False
        return all(
            isinstance(old_value, (int, float))
            and not isinstance(old_value, bool)
            and isinstance(newer_values[identifier], (int, float))
            and not isinstance(newer_values[identifier], bool)
            and newer_values[identifier] >= old_value
            for identifier, old_value in older_values.items()
        )

    def _coalesce_if_needed(self, count: int, size: int) -> tuple[int, int]:
        paths = self._paths()
        newer_for_key: dict[tuple, list[dict]] = {}
        redundant: set[Path] = set()
        for path in reversed(paths):
            try:
                value = read_json(path, maximum_bytes=MAX_OBSERVATION_BYTES)
            except CollectorError:
                continue
            if not isinstance(value, dict):
                continue
            key = self._coalesce_key(value)
            if any(
                self._componentwise_monotonic(value, newer)
                for newer in newer_for_key.get(key, [])
            ):
                redundant.add(path)
            newer_for_key.setdefault(key, []).append(value)

        # Delete only observations superseded by a newer sample with identical
        # profile/session/identity/reset-generation evidence. Identity changes
        # and reset transitions therefore survive pressure intact. A newer
        # regression cannot erase an undelivered high-water reading.
        for path in paths:
            if path not in redundant:
                continue
            path.unlink(missing_ok=True)
            count, size = self._usage()
            if (
                count <= self.config.spool_max_count
                and size <= self.config.spool_max_bytes
            ):
                return count, size
        return self._usage()

    def enqueue(self, observation: Observation) -> Path:
        with FileLock(self.config.state_dir / "spool.lock"):
            return self._enqueue_locked(observation)

    def _enqueue_locked(self, observation: Observation) -> Path:
        encoded = self._encode(observation)
        destination = (
            self.root / f"{observation.sequence:016d}-{observation.observation_id}.json"
        )
        if destination.exists():
            # The UUID+sequence pair is immutable. An identical local replay is
            # harmless, while any different bytes indicate state corruption.
            if destination.read_bytes() == encoded:
                return destination
            raise CollectorError("observation spool name collision")

        descriptor, temporary_name = tempfile.mkstemp(
            prefix="observation-", suffix=".tmp", dir=self.temporary
        )
        temporary = Path(temporary_name)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb", closefd=True) as handle:
                handle.write(encoded)
                handle.flush()
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)

        paths = self._paths()
        count = len(paths)
        # Every accepted observation is at most MAX_OBSERVATION_BYTES. Below
        # this conservative count threshold, both configured bounds are
        # therefore proven without an O(n) stat pass on the prompt hot path.
        safe_count = min(
            self.config.spool_max_count,
            self.config.spool_max_bytes // MAX_OBSERVATION_BYTES,
        )
        if count <= safe_count:
            return destination
        count, size = self._usage(paths)
        if count > self.config.spool_max_count or size > self.config.spool_max_bytes:
            count, size = self._coalesce_if_needed(count, size)
        if count > self.config.spool_max_count or size > self.config.spool_max_bytes:
            # Do not sacrifice a distinct identity transition or reset
            # generation just to remain under a numeric bound. Refuse this new
            # item and keep every previously queued observation intact.
            destination.unlink(missing_ok=True)
            raise SpoolFull(
                "spool is full of distinct undelivered observations; run doctor"
            )
        return destination

    def pending(self) -> Iterator[PendingObservation]:
        for path in self._paths():
            try:
                value = read_json(path, maximum_bytes=MAX_OBSERVATION_BYTES)
                observation = Observation.from_dict(value)
            except (CollectorError, OSError) as error:
                raise CollectorError(
                    f"queued observation is corrupt: {path.name}"
                ) from error
            yield PendingObservation(path=path, observation=observation)

    def acknowledge(self, pending: PendingObservation) -> None:
        # Unlink only the exact immutable path that was acknowledged.
        with FileLock(self.config.state_dir / "spool.lock"):
            pending.path.unlink(missing_ok=True)

    def stats(self, now: float | None = None) -> dict[str, int | float | None]:
        paths = self._paths()
        size = sum(path.stat().st_size for path in paths)
        oldest_age = None
        if paths:
            current = time.time() if now is None else now
            oldest_age = max(0.0, current - paths[0].stat().st_mtime)
        return {"pending": len(paths), "bytes": size, "oldest_age_seconds": oldest_age}

    def save_last_sample(self, observation: Observation) -> None:
        atomic_write_json(
            self.config.last_sample_path,
            observation.to_dict(),
            mode=0o600,
            sync=False,
        )

    def load_last_sample(self) -> Observation | None:
        try:
            value = read_json(
                self.config.last_sample_path, maximum_bytes=MAX_OBSERVATION_BYTES
            )
        except FileNotFoundError:
            return None
        return Observation.from_dict(value)
