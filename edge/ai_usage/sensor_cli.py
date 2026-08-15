"""Minimal status-line process entry point kept separate for startup latency."""

from __future__ import annotations

import contextlib
import sys
from pathlib import Path

from .claude_sensor import claude_statusline
from .config import CollectorConfig
from .errors import CollectorError
from .identity import IdentityHint
from .spool import Sequence, Spool
from .util import read_json


def _identity(config: CollectorConfig) -> IdentityHint:
    try:
        raw = read_json(config.identity_path, maximum_bytes=4096)
    except (FileNotFoundError, CollectorError):
        return IdentityHint(None, "unknown")
    if not isinstance(raw, dict):
        return IdentityHint(None, "unknown")
    digest = raw.get("digest") if isinstance(raw.get("digest"), str) else None
    evidence = raw.get("evidence")
    if evidence not in {
        "org_email",
        "org",
        "email",
        "account_id",
        "workspace_id",
        "principal_id",
        "team_id",
        "organization_id",
        "unknown",
    }:
        return IdentityHint(None, "unknown")
    return IdentityHint(digest, evidence)


def _prior_output(config: CollectorConfig, raw_input: bytes) -> bytes | None:
    if config.manifest_path is None:
        return None
    try:
        manifest = read_json(config.manifest_path, maximum_bytes=64 * 1024)
    except (FileNotFoundError, CollectorError):
        return None
    if (
        not isinstance(manifest, dict)
        or manifest.get("prior_status_line_present") is not True
    ):
        return None
    prior = manifest.get("prior_status_line")
    if (
        not isinstance(prior, dict)
        or prior.get("type") != "command"
        or not isinstance(prior.get("command"), str)
    ):
        return None
    command = prior["command"]
    wrapper = manifest.get("wrapper_status_line")
    if isinstance(wrapper, dict) and command == wrapper.get("command"):
        return None
    import subprocess

    try:
        completed = subprocess.run(
            ["/bin/sh", "-c", command],
            input=raw_input,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=config.provider_environment(),
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return completed.stdout if completed.returncode == 0 else None


def statusline(config_path: Path, raw_input: bytes) -> bytes:
    fallback = b"[claude]\n"
    config: CollectorConfig | None = None
    try:
        config = CollectorConfig.load(config_path)
        if config.provider != "claude":
            raise CollectorError("statusline requires a Claude profile config")
        spool = Spool(config)
        result = claude_statusline(
            raw_input,
            config,
            sequence=Sequence(config).next,
            identity=_identity(config),
        )
        fallback = result.text.encode("utf-8")
        if result.observation is not None:
            spool.enqueue(result.observation)
    except Exception as error:  # noqa: BLE001 - status-line failures must never break a prompt
        # Diagnostics are outside the successful hot path. Importing the
        # supervisor and its HTTP/provider modules on every render costs more
        # than the entire target latency budget.
        with contextlib.suppress(Exception):
            if config is not None:
                from .supervisor import Diagnostics

                Diagnostics(config).write(
                    "statusline_sensor_failed", error=type(error).__name__
                )

    # Collector failure must not suppress a user's pre-existing status line.
    # In particular, a full spool is an observability problem, not authority
    # to replace unrelated UI behavior that the installer promised to chain.
    if config is not None:
        with contextlib.suppress(Exception):
            prior = _prior_output(config, raw_input)
            if prior is not None:
                return prior
    return fallback


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    raw_input = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)  # exactly one stdin read
    if len(arguments) != 2 or arguments[0] != "--config":
        sys.stdout.buffer.write(b"[claude]\n")
        return 0
    sys.stdout.buffer.write(statusline(Path(arguments[1]), raw_input))
    return 0
