from __future__ import annotations

import base64
from pathlib import Path

from ai_usage.config import CollectorConfig
from ai_usage.util import atomic_write_json


def config_mapping(root: Path, provider: str = "claude", **overrides):
    profile_root = root / provider
    value = {
        "schema": 1,
        "provider": provider,
        "edge_id": "edge-test",
        "profile_id": f"{provider}-profile",
        "profile_label": f"{provider.title()} · Test",
        "pool_label": provider.title(),
        "endpoint": "https://collector.example/v3/observations",
        "ingest_token": "test-ingest-token-not-a-secret-12345",
        "identity_key": base64.b64encode(b"identity-key-for-tests-32-bytes!!").decode(
            "ascii"
        ),
        "provider_home": str(profile_root / "provider-home"),
        "provider_command": ["/usr/bin/true"],
        "state_dir": str(profile_root / "state"),
        "manifest_path": str(profile_root / "manifest.json"),
        "heartbeat_seconds": 300,
        "identity_poll_seconds": 900,
        "sample_poll_seconds": 300,
        "request_timeout_seconds": 2,
        "spool_max_count": 512,
        "spool_max_bytes": 4 * 1024 * 1024,
    }
    value.update(overrides)
    return value


def make_config(
    root: Path, provider: str = "claude", *, write: bool = False, **overrides
) -> CollectorConfig:
    path = root / provider / "config.json"
    raw = config_mapping(root, provider, **overrides)
    if write:
        atomic_write_json(path, raw, mode=0o600)
        return CollectorConfig.load(path)
    return CollectorConfig.from_mapping(path, raw)


def write_executable(path: Path, source: str) -> Path:
    path.write_text(source, encoding="utf-8")
    path.chmod(0o700)
    return path
