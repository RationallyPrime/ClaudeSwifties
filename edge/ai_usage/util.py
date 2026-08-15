"""Small security and filesystem helpers shared by the collector."""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from .errors import CollectorError

UTC = dt.timezone.utc
IDENTIFIER_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z")
CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
BEARER_RE = re.compile(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]+")
TOKENISH_RE = re.compile(r"(?i)(token|secret|identity[_ -]?key)(\s*[:=]\s*)[^\s,;}]+")


def utc_now() -> dt.datetime:
    return dt.datetime.now(tz=UTC)


def isoformat(value: dt.datetime) -> str:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_timestamp(value: Any, field: str) -> dt.datetime:
    if not isinstance(value, str) or not value:
        raise CollectorError(f"{field} must be an RFC 3339 timestamp")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise CollectorError(f"{field} must be an RFC 3339 timestamp") from error
    if parsed.tzinfo is None:
        raise CollectorError(f"{field} must include a timezone")
    return parsed.astimezone(UTC)


def epoch_timestamp(value: Any, field: str) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise CollectorError(f"{field} must be a Unix timestamp")
    try:
        parsed = dt.datetime.fromtimestamp(value, tz=UTC)
    except (OverflowError, OSError, ValueError) as error:
        raise CollectorError(
            f"{field} is outside the supported timestamp range"
        ) from error
    return isoformat(parsed)


def validate_identifier(value: Any, field: str, maximum: int = 64) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= maximum
        or IDENTIFIER_RE.fullmatch(value) is None
    ):
        raise CollectorError(
            f"{field} must be 1..{maximum} characters, start alphanumeric, and contain only [A-Za-z0-9._-]"
        )
    return value


def validate_display(value: Any, field: str, maximum: int = 120) -> str:
    if not isinstance(value, str):
        raise CollectorError(f"{field} must be a string")
    stripped = value.strip()
    if not stripped or utf16_length(stripped) > maximum or CONTROL_RE.search(stripped):
        raise CollectorError(f"{field} must be 1..{maximum} printable characters")
    return stripped


def utf16_length(value: str) -> int:
    """Match JavaScript string-length limits used by the aggregator."""
    return len(value.encode("utf-16-le")) // 2


def truncate_utf16(value: str, maximum: int) -> str:
    used = 0
    result: list[str] = []
    for character in value:
        width = utf16_length(character)
        if used + width > maximum:
            break
        result.append(character)
        used += width
    return "".join(result)


def display_text(value: Any, fallback: str, maximum: int = 120) -> str:
    """Return provider text safe for the strict wire/log contract."""
    if not isinstance(value, str):
        return fallback
    cleaned = CONTROL_RE.sub(" ", value).strip()
    return truncate_utf16(cleaned, maximum) or fallback


def normalize_identity(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = " ".join(value.strip().casefold().split())
    if not normalized or CONTROL_RE.search(normalized):
        return None
    return normalized


def private_directory(path: Path) -> Path:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        path.chmod(0o700)
    except OSError:
        pass
    return path


def atomic_write_bytes(
    path: Path, content: bytes, mode: int = 0o600, *, sync: bool = True
) -> None:
    """Write a complete file and publish it with one atomic rename."""
    private_directory(path.parent)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(content)
            handle.flush()
            if sync:
                os.fsync(handle.fileno())
        os.replace(temporary, path)
        if not sync:
            return
        try:
            directory_fd = os.open(path.parent, os.O_RDONLY)
        except OSError:
            return
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def atomic_write_json(
    path: Path, value: Any, mode: int = 0o600, *, sync: bool = True
) -> None:
    encoded = (
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")
    atomic_write_bytes(path, encoded, mode=mode, sync=sync)


def read_json(path: Path, *, maximum_bytes: int = 1_048_576) -> Any:
    size = path.stat().st_size
    if size > maximum_bytes:
        raise CollectorError(
            f"{path.name} exceeds the {maximum_bytes}-byte safety limit"
        )
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, OSError) as error:
        raise CollectorError(f"{path.name} is not valid JSON") from error


class Redactor:
    """Remove known and token-shaped secrets before diagnostics are persisted."""

    def __init__(self, *secrets: str):
        self._secrets = tuple(secret for secret in secrets if secret)

    def __call__(self, value: object, *, maximum: int = 500) -> str:
        text = str(value)
        for secret in self._secrets:
            text = text.replace(secret, "[REDACTED]")
        text = BEARER_RE.sub("Bearer [REDACTED]", text)
        text = TOKENISH_RE.sub(
            lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]", text
        )
        text = CONTROL_RE.sub(" ", text)
        return text[:maximum]
