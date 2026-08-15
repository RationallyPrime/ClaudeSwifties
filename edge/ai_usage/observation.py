"""Common schema-3 observation construction."""

from __future__ import annotations

import datetime as dt
import socket
import uuid

from .config import CollectorConfig
from .contract import COLLECTOR_VERSION, Observation, QuotaWindow
from .identity import IdentityHint
from .util import display_text, isoformat


def source_host() -> str:
    return display_text(socket.gethostname().split(".", 1)[0], "unknown", 120)


def make_observation(
    config: CollectorConfig,
    *,
    sequence: int,
    observed_at: dt.datetime,
    sampled_at: dt.datetime,
    sample_time_quality: str,
    status: str,
    identity: IdentityHint,
    windows: list[QuotaWindow],
    session_id: str | None = None,
    provider_client_version: str | None = None,
    pool_label: str | None = None,
) -> Observation:
    sampled_at = min(sampled_at, observed_at)
    return Observation(
        observation_id=str(uuid.uuid4()),
        sequence=sequence,
        provider=config.provider,
        edge_id=config.edge_id,
        profile_id=config.profile_id,
        profile_label=config.profile_label,
        pool_label=(
            display_text(pool_label, config.pool_label)
            if pool_label
            else config.pool_label
        ),
        session_id=session_id,
        source_host=source_host(),
        collector_version=COLLECTOR_VERSION,
        provider_client_version=(
            display_text(provider_client_version, "unknown", 64)
            if provider_client_version
            else None
        ),
        observed_at=isoformat(observed_at),
        sampled_at=isoformat(sampled_at),
        sample_time_quality=sample_time_quality,
        status=status,
        provider_subject=identity.digest,
        identity_evidence=identity.evidence,
        windows=tuple(windows),
    )
