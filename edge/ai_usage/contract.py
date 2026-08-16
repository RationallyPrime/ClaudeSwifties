"""Strict schema-3 observation wire model."""

from __future__ import annotations

import dataclasses
import re
import uuid
from typing import Any

from .errors import CollectorError
from .util import parse_timestamp, validate_display, validate_identifier

COLLECTOR_VERSION = "3.0.0"
PROVIDERS = {"claude", "codex", "grok"}
SAMPLE_QUALITIES = {"provider_time", "transcript_mtime", "sensor_time", "unknown"}
STATUSES = {"ok", "stale", "auth_expired", "billing_unavailable", "error"}
IDENTITY_EVIDENCE = {
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
SUBJECT_PATTERN = re.compile(r"[A-Za-z0-9_-]{16,128}\Z")
IDENTITY_KEY_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{16}\Z")


def _canonical_uuid(value: str, field: str) -> None:
    try:
        parsed_uuid = uuid.UUID(value)
    except (ValueError, TypeError, AttributeError) as error:
        raise CollectorError(f"{field} must be a UUID") from error
    if (
        str(parsed_uuid) != value.lower()
        or parsed_uuid.version not in range(1, 9)
        or parsed_uuid.variant != uuid.RFC_4122
    ):
        raise CollectorError(f"{field} must use canonical UUID form")


@dataclasses.dataclass(frozen=True)
class QuotaWindow:
    id: str
    label: str
    duration_minutes: int | None
    utilization: float
    resets_at: str | None

    def __post_init__(self) -> None:
        validate_identifier(self.id, "window.id")
        validate_display(self.label, "window.label", 24)
        if self.duration_minutes is not None and (
            isinstance(self.duration_minutes, bool)
            or not isinstance(self.duration_minutes, int)
            or not 1 <= self.duration_minutes <= 5_256_000
        ):
            raise CollectorError(
                "window.duration_minutes must be within 1..5256000 or null"
            )
        if isinstance(self.utilization, bool) or not isinstance(
            self.utilization, (int, float)
        ):
            raise CollectorError("window.utilization must be numeric")
        if not 0 <= float(self.utilization) <= 1:
            raise CollectorError("window.utilization must be within 0..1")
        if self.resets_at is not None:
            if not self.resets_at.endswith("Z"):
                raise CollectorError(
                    "window.resets_at must be a UTC instant ending in Z"
                )
            parse_timestamp(self.resets_at, "window.resets_at")

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "duration_minutes": self.duration_minutes,
            "utilization": float(self.utilization),
            "resets_at": self.resets_at,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> QuotaWindow:
        return cls(
            id=value.get("id"),
            label=value.get("label"),
            duration_minutes=value.get("duration_minutes"),
            utilization=value.get("utilization"),
            resets_at=value.get("resets_at"),
        )


@dataclasses.dataclass(frozen=True)
class Observation:
    observation_id: str
    observer_instance_id: str
    identity_key_id: str
    sequence: int
    provider: str
    edge_id: str
    profile_id: str
    profile_label: str
    pool_label: str
    session_id: str | None
    source_host: str
    collector_version: str
    provider_client_version: str | None
    observed_at: str
    sampled_at: str
    sample_time_quality: str
    status: str
    provider_subject: str | None
    identity_evidence: str
    windows: tuple[QuotaWindow, ...]
    schema: int = 3

    def __post_init__(self) -> None:
        if self.schema != 3:
            raise CollectorError("observation.schema must be 3")
        _canonical_uuid(self.observation_id, "observation_id")
        _canonical_uuid(self.observer_instance_id, "observer_instance_id")
        if (
            not isinstance(self.identity_key_id, str)
            or IDENTITY_KEY_ID_PATTERN.fullmatch(self.identity_key_id) is None
        ):
            raise CollectorError(
                "identity_key_id must be a 16 character base64url identifier"
            )
        if (
            isinstance(self.sequence, bool)
            or not isinstance(self.sequence, int)
            or not 0 <= self.sequence <= 9_007_199_254_740_991
        ):
            raise CollectorError("sequence must be a nonnegative safe integer")
        if self.provider not in PROVIDERS:
            raise CollectorError("provider is unsupported")
        validate_identifier(self.edge_id, "edge_id")
        validate_identifier(self.profile_id, "profile_id")
        validate_display(self.profile_label, "profile_label")
        validate_display(self.pool_label, "pool_label")
        if self.session_id is not None:
            validate_identifier(self.session_id, "session_id", 128)
        validate_display(self.source_host, "source_host", 120)
        validate_display(self.collector_version, "collector_version", 40)
        if self.provider_client_version is not None:
            validate_display(
                self.provider_client_version, "provider_client_version", 64
            )
        observed = parse_timestamp(self.observed_at, "observed_at")
        sampled = parse_timestamp(self.sampled_at, "sampled_at")
        if not self.observed_at.endswith("Z") or not self.sampled_at.endswith("Z"):
            raise CollectorError(
                "observation timestamps must be UTC instants ending in Z"
            )
        if sampled > observed:
            raise CollectorError("sampled_at cannot be later than observed_at")
        if self.sample_time_quality not in SAMPLE_QUALITIES:
            raise CollectorError("sample_time_quality is unsupported")
        if self.status not in STATUSES:
            raise CollectorError("status is unsupported")
        if (
            self.provider_subject is not None
            and SUBJECT_PATTERN.fullmatch(self.provider_subject) is None
        ):
            raise CollectorError(
                "provider_subject must be a 16..128 character opaque base64url digest"
            )
        if self.identity_evidence not in IDENTITY_EVIDENCE:
            raise CollectorError("identity_evidence is unsupported")
        if self.provider_subject is None and self.identity_evidence != "unknown":
            raise CollectorError(
                "identity_evidence must be unknown without provider_subject"
            )
        if not isinstance(self.windows, tuple) or len(self.windows) > 8:
            raise CollectorError("windows must contain at most eight entries")
        if len({window.id for window in self.windows}) != len(self.windows):
            raise CollectorError("window ids must be unique within an observation")

    def to_dict(self) -> dict[str, Any]:
        # Keep this exact. The server rejects unknown top-level keys as a leak tripwire.
        return {
            "schema": 3,
            "observation_id": self.observation_id,
            "observer_instance_id": self.observer_instance_id,
            "identity_key_id": self.identity_key_id,
            "sequence": self.sequence,
            "provider": self.provider,
            "edge_id": self.edge_id,
            "profile_id": self.profile_id,
            "profile_label": self.profile_label,
            "pool_label": self.pool_label,
            "session_id": self.session_id,
            "source_host": self.source_host,
            "collector_version": self.collector_version,
            "provider_client_version": self.provider_client_version,
            "observed_at": self.observed_at,
            "sampled_at": self.sampled_at,
            "sample_time_quality": self.sample_time_quality,
            "status": self.status,
            "provider_subject": self.provider_subject,
            "identity_evidence": self.identity_evidence,
            "windows": [window.to_dict() for window in self.windows],
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> Observation:
        if not isinstance(value, dict):
            raise CollectorError("observation must be an object")
        expected = {
            "schema",
            "observation_id",
            "observer_instance_id",
            "identity_key_id",
            "sequence",
            "provider",
            "edge_id",
            "profile_id",
            "profile_label",
            "pool_label",
            "session_id",
            "source_host",
            "collector_version",
            "provider_client_version",
            "observed_at",
            "sampled_at",
            "sample_time_quality",
            "status",
            "provider_subject",
            "identity_evidence",
            "windows",
        }
        if set(value) != expected:
            raise CollectorError(
                "observation fields do not match the strict schema-3 contract"
            )
        raw_windows = value.get("windows")
        if not isinstance(raw_windows, list) or not all(
            isinstance(item, dict) for item in raw_windows
        ):
            raise CollectorError("windows must be an array of objects")
        return cls(
            schema=value.get("schema"),
            observation_id=value.get("observation_id"),
            observer_instance_id=value.get("observer_instance_id"),
            identity_key_id=value.get("identity_key_id"),
            sequence=value.get("sequence"),
            provider=value.get("provider"),
            edge_id=value.get("edge_id"),
            profile_id=value.get("profile_id"),
            profile_label=value.get("profile_label"),
            pool_label=value.get("pool_label"),
            session_id=value.get("session_id"),
            source_host=value.get("source_host"),
            collector_version=value.get("collector_version"),
            provider_client_version=value.get("provider_client_version"),
            observed_at=value.get("observed_at"),
            sampled_at=value.get("sampled_at"),
            sample_time_quality=value.get("sample_time_quality"),
            status=value.get("status"),
            provider_subject=value.get("provider_subject"),
            identity_evidence=value.get("identity_evidence"),
            windows=tuple(QuotaWindow.from_dict(item) for item in raw_windows),
        )
