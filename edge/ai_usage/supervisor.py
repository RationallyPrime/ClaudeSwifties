"""One-shot durable supervisor, intended for a one-minute user timer."""

from __future__ import annotations

import dataclasses
import json
import os
import random
import time
from collections.abc import Callable
from typing import Any

from .config import CollectorConfig
from .contract import Observation
from .errors import AuthenticationRequired, CollectorError, ProviderError, SpoolFull
from .identity import IdentityHint, identity_key_id
from .observation import make_observation
from .providers import collect_provider, poll_claude_identity
from .spool import FileLock, ObserverInstance, Sequence, Spool
from .transport import DeliveryFailure, ObservationTransport
from .util import (
    Redactor,
    atomic_write_bytes,
    atomic_write_json,
    isoformat,
    parse_timestamp,
    private_directory,
    read_json,
    utc_now,
)

DIAGNOSTIC_LIMIT = 64 * 1024

# Statuses that CAN be verdicts about an observation's CONTENT — a
# malformed payload (400), an edge/profile claim the credential does not
# cover (403: this aggregator's only forbidden() site tests two fields OF
# the observation, so it is permanent for that payload, not credential
# rotation — rotation is 401), or a namespace rejection (422). The status
# alone is never sufficient: any hop (HTTPS ingress, tunnel, WAF) produces
# the same integers, so quarantine additionally requires the aggregator's
# own JSON error document (DeliveryFailure.aggregator_error). 413 is
# deliberately absent — the edge refuses oversize payloads at encode
# (MAX_OBSERVATION_BYTES matches the aggregator's MAX_BODY_BYTES), so a
# wire 413 is an ingress body limit, always transient. Everything else
# (401, 408/429 pressure, 5xx, network) stays on the transient backoff
# path: retrying those is harmless, retrying a true content verdict
# wedges the spool head forever.
PERMANENT_REJECTION_STATUSES = frozenset({400, 403, 422})


@dataclasses.dataclass
class RuntimeState:
    identity_checked_at: float = 0
    sample_checked_at: float = 0
    last_emit_at: float = 0
    identity_status: str = "unknown"
    last_ack_at: float = 0
    last_ack_observation_id: str | None = None

    @classmethod
    def from_dict(cls, value: Any) -> RuntimeState:
        if not isinstance(value, dict):
            return cls()
        state = cls()
        for name in (
            "identity_checked_at",
            "sample_checked_at",
            "last_emit_at",
            "last_ack_at",
        ):
            raw = value.get(name)
            if isinstance(raw, (int, float)) and not isinstance(raw, bool) and raw >= 0:
                setattr(state, name, float(raw))
        status = value.get("identity_status")
        if status in {"ok", "auth_expired", "error", "unknown"}:
            state.identity_status = status
        identifier = value.get("last_ack_observation_id")
        if isinstance(identifier, str):
            state.last_ack_observation_id = identifier
        return state

    def to_dict(self) -> dict[str, Any]:
        return dataclasses.asdict(self)

    def expire_future_scheduler_times(self, now: float) -> None:
        for name in ("identity_checked_at", "sample_checked_at", "last_emit_at"):
            if getattr(self, name) > now:
                setattr(self, name, 0)


class Diagnostics:
    def __init__(self, config: CollectorConfig):
        self.path = config.diagnostics_path
        self.redact = Redactor(config.ingest_token, config.identity_key.hex())

    def write(self, event: str, **fields: object) -> None:
        record = {
            "at": isoformat(utc_now()),
            "event": self.redact(event, maximum=80),
            **{key: self.redact(value) for key, value in fields.items()},
        }
        encoded = (
            json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        ).encode("utf-8")
        private_directory(self.path.parent)
        try:
            existing = self.path.read_bytes()
        except FileNotFoundError:
            existing = b""
        if len(existing) + len(encoded) > DIAGNOSTIC_LIMIT:
            # Retain complete recent lines, not an indefinitely growing log.
            retained = existing[-(DIAGNOSTIC_LIMIT // 2) :]
            newline = retained.find(b"\n")
            retained = retained[newline + 1 :] if newline >= 0 else b""
            atomic_write_bytes(self.path, retained + encoded, mode=0o600)
        else:
            descriptor = os.open(
                self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600
            )
            try:
                os.write(descriptor, encoded)
            finally:
                os.close(descriptor)


def load_identity(config: CollectorConfig) -> tuple[IdentityHint, str]:
    try:
        raw = read_json(config.identity_path, maximum_bytes=4096)
    except (FileNotFoundError, CollectorError):
        return IdentityHint(None, "unknown"), "unknown"
    if not isinstance(raw, dict):
        return IdentityHint(None, "unknown"), "unknown"
    digest = raw.get("digest") if isinstance(raw.get("digest"), str) else None
    evidence = (
        raw.get("evidence")
        if raw.get("evidence")
        in {
            "org_email",
            "org",
            "email",
            "account_id",
            "workspace_id",
            "principal_id",
            "team_id",
            "organization_id",
            "unknown",
        }
        else "unknown"
    )
    status = (
        raw.get("status")
        if raw.get("status") in {"ok", "auth_expired", "error", "unknown"}
        else "unknown"
    )
    return IdentityHint(digest, evidence), status


def save_identity(
    config: CollectorConfig, identity: IdentityHint, status: str, checked_at: float
) -> None:
    # Raw provider identifiers and emails are never persisted here.
    atomic_write_json(
        config.identity_path,
        {
            "schema": 1,
            "digest": identity.digest,
            "evidence": identity.evidence,
            "status": status,
            "checked_at": checked_at,
        },
        mode=0o600,
    )


class Supervisor:
    def __init__(
        self,
        config: CollectorConfig,
        *,
        transport: ObservationTransport | None = None,
        clock: Callable[[], float] = time.time,
        jitter: Callable[[], float] = random.random,
    ):
        self.config = config
        self.spool = Spool(config)
        self.sequence = Sequence(config)
        self.observer_instance = ObserverInstance(config)
        self.transport = transport or ObservationTransport(config)
        self.clock = clock
        self.jitter = jitter
        self.diagnostics = Diagnostics(config)
        self.runtime_path = config.state_dir / "runtime.json"
        self.lock_path = config.state_dir / "supervisor.lock"

    def _load_runtime(self) -> RuntimeState:
        try:
            return RuntimeState.from_dict(
                read_json(self.runtime_path, maximum_bytes=8192)
            )
        except (FileNotFoundError, CollectorError):
            return RuntimeState()

    def _save_runtime(self, state: RuntimeState) -> None:
        atomic_write_json(self.runtime_path, state.to_dict(), mode=0o600)

    def _load_last_sample(self) -> Observation | None:
        """Treat the derived last-good cache as rebuildable, never durable truth."""
        try:
            return self.spool.load_last_sample()
        except (CollectorError, OSError) as error:
            self.diagnostics.write("last_sample_invalid", error=type(error).__name__)
            try:
                self.config.last_sample_path.unlink(missing_ok=True)
            except OSError as unlink_error:
                self.diagnostics.write(
                    "last_sample_discard_failed",
                    error=type(unlink_error).__name__,
                )
            return None

    def _save_last_sample(self, observation: Observation) -> None:
        try:
            self.spool.save_last_sample(observation)
        except (CollectorError, OSError) as error:
            # This cache accelerates degraded readings but is never allowed to
            # block durable spool delivery.
            self.diagnostics.write(
                "last_sample_save_failed", error=type(error).__name__
            )

    def _poll_identity(
        self, state: RuntimeState, now: float
    ) -> tuple[IdentityHint, str]:
        identity, current_status = load_identity(self.config)
        if now - state.identity_checked_at < self.config.identity_poll_seconds:
            return identity, current_status
        if self.config.provider != "claude":
            # Codex and Grok identity is fetched in the same supported request
            # sequence as their quota sample.
            return identity, current_status
        try:
            identity = poll_claude_identity(self.config)
            status = "ok"
        except AuthenticationRequired:
            status = "auth_expired"
            self.diagnostics.write("identity_poll_failed", status=status)
        except ProviderError:
            status = "error"
            self.diagnostics.write("identity_poll_failed", status=status)
        state.identity_checked_at = now
        state.identity_status = status
        save_identity(self.config, identity, status, now)
        return identity, status

    def _collect(self, state: RuntimeState, now: float) -> Observation | None:
        if (
            self.config.provider == "claude"
            or now - state.sample_checked_at < self.config.sample_poll_seconds
        ):
            return None
        state.sample_checked_at = now
        observed = utc_now()
        try:
            reading = collect_provider(self.config)
        except AuthenticationRequired:
            state.identity_status = "auth_expired"
            identity, _ = load_identity(self.config)
            save_identity(self.config, identity, "auth_expired", now)
            state.identity_checked_at = now
            self.diagnostics.write("provider_sample_failed", status="auth_expired")
            return None
        except (CollectorError, OSError) as error:
            # Provider adapters can raise CollectorError for schema-shaped but
            # invalid fields (for example a non-numeric Codex resetsAt). Treat
            # those as a sample failure so previously queued items still drain.
            state.identity_status = "error"
            identity, _ = load_identity(self.config)
            save_identity(self.config, identity, "error", now)
            state.identity_checked_at = now
            self.diagnostics.write(
                "provider_sample_failed", status="error", error=type(error).__name__
            )
            return None
        save_identity(self.config, reading.identity, "ok", now)
        state.identity_checked_at = now
        state.identity_status = "ok"
        sampled_at = observed
        sample_quality = "sensor_time"
        windows = reading.windows
        pool_label = reading.pool_label
        if not windows:
            last = self._load_last_sample()
            if last is not None and self._identity_compatible(last, reading.identity):
                sampled_at = parse_timestamp(last.sampled_at, "last sample sampled_at")
                sample_quality = last.sample_time_quality
                windows = list(last.windows)
                pool_label = last.pool_label
        observation = make_observation(
            self.config,
            observer_instance_id=self.observer_instance.read_or_create(),
            sequence=self.sequence.next(),
            observed_at=observed,
            sampled_at=min(sampled_at, observed),
            sample_time_quality=sample_quality,
            status=reading.status,
            identity=reading.identity,
            windows=windows,
            provider_client_version=reading.provider_client_version,
            pool_label=pool_label,
        )
        try:
            self.spool.enqueue(observation)
        except SpoolFull:
            self.diagnostics.write(
                "spool_full", observation_id=observation.observation_id
            )
            return None
        self._save_last_sample(observation)
        state.last_emit_at = now
        return observation

    @staticmethod
    def _identity_compatible(sample: Observation, identity: IdentityHint) -> bool:
        """Require matching pseudonymous evidence before reusing quota data."""
        return (
            sample.provider_subject == identity.digest
            and sample.identity_evidence == identity.evidence
        )

    def _heartbeat(
        self,
        state: RuntimeState,
        identity: IdentityHint,
        identity_status: str,
        now: float,
    ) -> Observation | None:
        if now - state.last_emit_at < self.config.heartbeat_seconds:
            return None
        last = self._load_last_sample()
        if last is not None and not self._identity_compatible(last, identity):
            last = None
        observed = utc_now()
        if last is None:
            sampled = observed
            quality = "unknown"
            windows = []
            session_id = None
            client_version = None
            pool_label = self.config.pool_label
            status = (
                "auth_expired"
                if identity_status == "auth_expired"
                else "error"
                if identity_status == "error"
                else "stale"
            )
        else:
            sampled = parse_timestamp(last.sampled_at, "last sample sampled_at")
            quality = last.sample_time_quality
            windows = list(last.windows)
            session_id = last.session_id
            client_version = last.provider_client_version
            pool_label = last.pool_label
            status = (
                "auth_expired"
                if identity_status == "auth_expired"
                else "error"
                if identity_status == "error"
                else last.status
            )
        observation = make_observation(
            self.config,
            observer_instance_id=self.observer_instance.read_or_create(),
            sequence=self.sequence.next(),
            observed_at=observed,
            sampled_at=min(sampled, observed),
            sample_time_quality=quality,
            status=status,
            identity=identity,
            windows=windows,
            session_id=session_id,
            provider_client_version=client_version,
            pool_label=pool_label,
        )
        try:
            self.spool.enqueue(observation)
        except SpoolFull:
            self.diagnostics.write(
                "spool_full", observation_id=observation.observation_id
            )
            return None
        state.last_emit_at = now
        return observation

    def _refresh_last_sample(self, state: RuntimeState) -> None:
        """Move hot-path sample bookkeeping out of Claude's prompt render."""
        latest = None
        for pending in self.spool.pending():
            latest = pending.observation
        if latest is None:
            return
        current = self._load_last_sample()
        if current is None or latest.sequence > current.sequence:
            self._save_last_sample(latest)
        emitted_at = parse_timestamp(
            latest.observed_at, "queued observation observed_at"
        ).timestamp()
        state.last_emit_at = max(state.last_emit_at, emitted_at)

    def _load_retry(self) -> dict[str, Any]:
        try:
            raw = read_json(self.config.retry_path, maximum_bytes=8192)
        except (FileNotFoundError, CollectorError):
            return {}
        return raw if isinstance(raw, dict) else {}

    def _drain(self, state: RuntimeState, now: float) -> int:
        delivered = 0
        retry = self._load_retry()
        for pending in self.spool.pending():
            if retry.get("observation_id") == pending.observation.observation_id:
                next_attempt = retry.get("next_attempt_at")
                recorded_at = retry.get("recorded_at")
                clock_moved_back = (
                    isinstance(recorded_at, (int, float)) and recorded_at > now
                )
                if (
                    not clock_moved_back
                    and isinstance(next_attempt, (int, float))
                    and next_attempt > now
                ):
                    break
            try:
                acknowledgement = self.transport.send(pending.observation)
            except DeliveryFailure as error:
                if (
                    error.status in PERMANENT_REJECTION_STATUSES
                    and error.aggregator_error is not None
                ):
                    # A content verdict about THIS observation (schema or
                    # namespace rejection), not a transient transport state:
                    # retrying can never succeed, and backing off head-of-line
                    # blocks every observation behind it — the wedge Theoros
                    # reproduced on the identity-key 422. Both conditions are
                    # required: the status names the verdict class, the
                    # aggregator's own error document proves the verdict came
                    # from the aggregator and not an intermediary. Quarantine
                    # and keep draining.
                    self.spool.quarantine(
                        pending.path,
                        "permanently rejected by the aggregator: "
                        f"HTTP {error.status} ({error.aggregator_error})",
                    )
                    retry = {}
                    self.config.retry_path.unlink(missing_ok=True)
                    self.diagnostics.write(
                        "delivery_rejected_permanent",
                        observation_id=pending.observation.observation_id,
                        status=error.status,
                        error=error.aggregator_error,
                    )
                    continue
                previous_attempt = (
                    retry.get("attempt")
                    if retry.get("observation_id") == pending.observation.observation_id
                    else 0
                )
                attempt = (
                    int(previous_attempt) + 1
                    if isinstance(previous_attempt, int)
                    else 1
                )
                delay = min(300.0, 2.0 ** min(attempt, 8)) * (0.8 + 0.4 * self.jitter())
                if error.retry_after is not None:
                    delay = max(delay, error.retry_after)
                retry = {
                    "schema": 1,
                    "observation_id": pending.observation.observation_id,
                    "attempt": attempt,
                    "recorded_at": now,
                    "next_attempt_at": now + delay,
                    "last_status": error.status,
                    "last_error": type(error).__name__,
                }
                atomic_write_json(self.config.retry_path, retry, mode=0o600)
                self.diagnostics.write(
                    "delivery_failed",
                    observation_id=pending.observation.observation_id,
                    status=error.status,
                    attempt=attempt,
                )
                break
            # The transport validates a 2xx fixed-shape ACK naming this exact
            # observation. Only that proof authorizes deletion.
            self.spool.acknowledge(pending)
            delivered += 1
            state.last_ack_at = now
            state.last_ack_observation_id = acknowledgement.observation_id
            retry = {}
            self.config.retry_path.unlink(missing_ok=True)
            self.diagnostics.write(
                "delivery_acknowledged",
                observation_id=acknowledgement.observation_id,
                outcome=acknowledgement.outcome,
            )
        return delivered

    def run(self) -> dict[str, int | bool]:
        private_directory(self.config.state_dir)
        try:
            lock = FileLock(self.lock_path, blocking=False)
            lock.__enter__()
        except BlockingIOError:
            return {"already_running": True, "queued": 0, "delivered": 0}
        try:
            now = self.clock()
            state = self._load_runtime()
            state.expire_future_scheduler_times(now)
            identity, identity_status = self._poll_identity(state, now)
            queued = 1 if self._collect(state, now) is not None else 0
            self._refresh_last_sample(state)
            state.expire_future_scheduler_times(now)
            identity, identity_status = load_identity(self.config)
            queued += (
                1
                if self._heartbeat(state, identity, identity_status, now) is not None
                else 0
            )
            delivered = self._drain(state, now)
            self._save_runtime(state)
            return {"already_running": False, "queued": queued, "delivered": delivered}
        finally:
            lock.__exit__(None, None, None)


def doctor_report(config: CollectorConfig) -> dict[str, Any]:
    spool = Spool(config)
    identity, identity_status = load_identity(config)
    try:
        retry = read_json(config.retry_path, maximum_bytes=8192)
    except (FileNotFoundError, CollectorError):
        retry = None
    if isinstance(retry, dict):
        retry_report = {
            "observation_id": retry.get("observation_id"),
            "attempt": retry.get("attempt"),
            "next_attempt_at": retry.get("next_attempt_at"),
            "last_status": retry.get("last_status"),
            "last_error": retry.get("last_error"),
        }
    else:
        retry_report = None
    warnings: list[str] = []
    try:
        config_mode = oct(config.path.stat().st_mode & 0o777)
        if config.path.stat().st_mode & 0o077:
            warnings.append("config permissions are broader than 0600")
    except OSError:
        config_mode = "missing"
        warnings.append("config file is missing")
    return {
        "schema": 1,
        "collector_version": "3.0.0",
        "provider": config.provider,
        "edge_id": config.edge_id,
        "profile_id": config.profile_id,
        "profile_label": config.profile_label,
        "observer_instance_id": ObserverInstance(config).peek(),
        "identity_key_id": identity_key_id(config.identity_key),
        "config_mode": config_mode,
        "endpoint_configured": bool(config.endpoint),
        "ingest_token_configured": bool(config.ingest_token),
        "identity_key_configured": bool(config.identity_key),
        "identity": {
            "present": identity.digest is not None,
            "evidence": identity.evidence,
            "status": identity_status,
        },
        "spool": spool.stats(),
        "retry": retry_report,
        "warnings": warnings,
    }
