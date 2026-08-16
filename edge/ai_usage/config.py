"""Private, profile-scoped collector configuration."""

from __future__ import annotations

import base64
import dataclasses
import os
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from .errors import ConfigError
from .util import read_json, validate_display, validate_identifier

CONFIG_FIELDS = {
    "schema",
    "provider",
    "edge_id",
    "profile_id",
    "profile_label",
    "pool_label",
    "endpoint",
    "ingest_token",
    "identity_key",
    "provider_home",
    "provider_command",
    "state_dir",
    "manifest_path",
    "heartbeat_seconds",
    "identity_poll_seconds",
    "sample_poll_seconds",
    "request_timeout_seconds",
    "spool_max_count",
    "spool_max_bytes",
}


def _positive_int(value: Any, field: str, minimum: int, maximum: int) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not minimum <= value <= maximum
    ):
        raise ConfigError(f"{field} must be within {minimum}..{maximum}")
    return value


def _endpoint(value: Any) -> str:
    if not isinstance(value, str):
        raise ConfigError("endpoint must be a URL")
    parsed = urlsplit(value)
    try:
        port = parsed.port
    except ValueError as error:
        raise ConfigError("endpoint port must be a valid integer") from error
    if port is not None and not 1 <= port <= 65_535:
        raise ConfigError("endpoint port must be within 1..65535")
    if (
        parsed.scheme not in {"https", "http"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise ConfigError("endpoint must be an absolute HTTP(S) URL without userinfo")
    if parsed.scheme == "http" and parsed.hostname not in {
        "127.0.0.1",
        "localhost",
        "::1",
    }:
        raise ConfigError("endpoint must use HTTPS except on loopback")
    if parsed.query or parsed.fragment:
        raise ConfigError("endpoint cannot contain a query or fragment")
    if parsed.path in {"", "/"}:
        parsed = parsed._replace(path="/v3/observations")
    elif parsed.path.rstrip("/") != "/v3/observations":
        raise ConfigError("endpoint path must be /v3/observations")
    else:
        parsed = parsed._replace(path="/v3/observations")
    return urlunsplit(parsed)


@dataclasses.dataclass(frozen=True)
class CollectorConfig:
    path: Path
    provider: str
    edge_id: str
    profile_id: str
    profile_label: str
    pool_label: str
    endpoint: str
    ingest_token: str
    identity_key: bytes
    provider_home: Path
    provider_command: tuple[str, ...]
    state_dir: Path
    manifest_path: Path | None
    heartbeat_seconds: int = 300
    identity_poll_seconds: int = 900
    sample_poll_seconds: int = 300
    request_timeout_seconds: int = 15
    spool_max_count: int = 512
    spool_max_bytes: int = 4 * 1024 * 1024

    @property
    def spool_dir(self) -> Path:
        return self.state_dir / "spool"

    @property
    def identity_path(self) -> Path:
        return self.state_dir / "identity.json"

    @property
    def last_sample_path(self) -> Path:
        return self.state_dir / "last-sample.json"

    @property
    def retry_path(self) -> Path:
        return self.state_dir / "retry.json"

    @property
    def sequence_path(self) -> Path:
        return self.state_dir / "sequence"

    @property
    def observer_instance_path(self) -> Path:
        return self.state_dir / "observer-instance"

    @property
    def diagnostics_path(self) -> Path:
        return self.state_dir / "diagnostics.jsonl"

    @classmethod
    def load(cls, path: Path) -> CollectorConfig:
        try:
            raw = read_json(path, maximum_bytes=64 * 1024)
        except FileNotFoundError as error:
            raise ConfigError(f"collector config does not exist: {path}") from error
        return cls.from_mapping(path, raw)

    @classmethod
    def from_mapping(cls, path: Path, raw: Any) -> CollectorConfig:
        if not isinstance(raw, dict):
            raise ConfigError("collector config must be a JSON object")
        unknown = set(raw) - CONFIG_FIELDS
        if unknown:
            raise ConfigError(
                f"collector config contains unknown fields: {', '.join(sorted(unknown))}"
            )
        if raw.get("schema") != 1:
            raise ConfigError("collector config schema must be 1")
        provider = raw.get("provider")
        if provider not in {"claude", "codex", "grok"}:
            raise ConfigError("provider must be claude, codex, or grok")
        edge_id = validate_identifier(raw.get("edge_id"), "edge_id")
        profile_id = validate_identifier(raw.get("profile_id"), "profile_id")
        profile_label = validate_display(raw.get("profile_label"), "profile_label")
        pool_label = validate_display(raw.get("pool_label"), "pool_label")
        endpoint = _endpoint(raw.get("endpoint"))
        token = raw.get("ingest_token")
        if (
            not isinstance(token, str)
            or len(token) < 16
            or len(token) > 512
            or any(not 0x21 <= ord(c) <= 0x7E for c in token)
        ):
            raise ConfigError(
                "ingest_token must contain 16..512 ASCII graphic characters"
            )
        encoded_key = raw.get("identity_key")
        if not isinstance(encoded_key, str):
            raise ConfigError("identity_key must be base64")
        try:
            identity_key = base64.b64decode(encoded_key, validate=True)
        except (ValueError, TypeError) as error:
            raise ConfigError("identity_key must be valid base64") from error
        if len(identity_key) < 32 or len(identity_key) > 256:
            raise ConfigError("identity_key must decode to 32..256 bytes")
        provider_home = Path(raw.get("provider_home", "")).expanduser()
        if not provider_home.is_absolute():
            raise ConfigError("provider_home must be absolute")
        command = raw.get("provider_command")
        if (
            not isinstance(command, list)
            or not command
            or not all(isinstance(part, str) and part for part in command)
        ):
            raise ConfigError("provider_command must be a non-empty string array")
        state_dir = Path(raw.get("state_dir", "")).expanduser()
        if not state_dir.is_absolute():
            raise ConfigError("state_dir must be absolute")
        manifest_raw = raw.get("manifest_path")
        manifest = (
            Path(manifest_raw).expanduser()
            if isinstance(manifest_raw, str) and manifest_raw
            else None
        )
        if manifest is not None and not manifest.is_absolute():
            raise ConfigError("manifest_path must be absolute")
        return cls(
            path=path,
            provider=provider,
            edge_id=edge_id,
            profile_id=profile_id,
            profile_label=profile_label,
            pool_label=pool_label,
            endpoint=endpoint,
            ingest_token=token,
            identity_key=identity_key,
            provider_home=provider_home,
            provider_command=tuple(command),
            state_dir=state_dir,
            manifest_path=manifest,
            heartbeat_seconds=_positive_int(
                raw.get("heartbeat_seconds", 300), "heartbeat_seconds", 60, 300
            ),
            identity_poll_seconds=_positive_int(
                raw.get("identity_poll_seconds", 900),
                "identity_poll_seconds",
                60,
                86_400,
            ),
            sample_poll_seconds=_positive_int(
                raw.get("sample_poll_seconds", 300), "sample_poll_seconds", 60, 86_400
            ),
            request_timeout_seconds=_positive_int(
                raw.get("request_timeout_seconds", 15), "request_timeout_seconds", 1, 60
            ),
            spool_max_count=_positive_int(
                raw.get("spool_max_count", 512), "spool_max_count", 8, 10_000
            ),
            spool_max_bytes=_positive_int(
                raw.get("spool_max_bytes", 4 * 1024 * 1024),
                "spool_max_bytes",
                65_536,
                64 * 1024 * 1024,
            ),
        )

    def provider_environment(self) -> dict[str, str]:
        collector_only = {
            "READ_TOKEN",
            "INGEST_TOKEN",
            "EDGE_CREDENTIALS_JSON",
        }
        environment = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("AI_USAGE_")
            and not key.startswith("USAGE_")
            and key not in collector_only
        }
        if self.provider == "claude":
            environment["CLAUDE_CONFIG_DIR"] = str(self.provider_home)
        elif self.provider == "codex":
            environment["CODEX_HOME"] = str(self.provider_home)
        elif self.provider == "grok":
            environment["HOME"] = str(self.provider_home)
            # Grok's profile identity is HOME-scoped; do not let a surrounding
            # GROK_HOME redirect the child to another profile.
            environment.pop("GROK_HOME", None)
        return environment
