#!/usr/bin/env python3
"""Read Codex subscription limits through the local app-server and push them.

The Codex process owns authentication. This collector speaks the documented
JSONL protocol and never reads, copies, or refreshes Codex credentials.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import selectors
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, TextIO


CONFIG_KEYS = {
    "USAGE_ACCOUNT_ID",
    "USAGE_LABEL",
    "USAGE_ENDPOINT",
    "USAGE_TOKEN",
    "CODEX_BIN",
}
ACCOUNT_ID_PATTERN = re.compile(r"[A-Za-z0-9._-]{1,64}\Z")


class CollectorError(RuntimeError):
    pass


def load_config(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if path.exists():
        for line_number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                raise CollectorError(f"{path}:{line_number}: expected KEY=VALUE")
            key, raw_value = line.split("=", 1)
            key = key.strip()
            if key not in CONFIG_KEYS:
                continue
            parsed = shlex.split(raw_value, comments=True, posix=True)
            values[key] = " ".join(parsed) if parsed else ""

    for key in CONFIG_KEYS:
        if key in os.environ:
            values[key] = os.environ[key]
    return values


def send_message(process: subprocess.Popen[str], message: dict[str, Any]) -> None:
    if process.stdin is None:
        raise CollectorError("Codex app-server stdin is unavailable")
    process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
    process.stdin.flush()


def read_response(stream: TextIO, request_id: int, timeout: float) -> dict[str, Any]:
    selector = selectors.DefaultSelector()
    selector.register(stream, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CollectorError(f"Codex app-server timed out waiting for response {request_id}")
            if not selector.select(remaining):
                raise CollectorError(f"Codex app-server timed out waiting for response {request_id}")
            line = stream.readline()
            if not line:
                raise CollectorError("Codex app-server exited before returning rate limits")
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("id") == request_id:
                if "error" in message:
                    raise CollectorError(f"Codex app-server request failed: {message['error']}")
                result = message.get("result")
                if not isinstance(result, dict):
                    raise CollectorError("Codex app-server returned no result object")
                return result
    finally:
        selector.close()


def read_codex_rate_limits(codex_bin: str, timeout: float = 15) -> dict[str, Any]:
    process = subprocess.Popen(
        [codex_bin, "app-server", "--stdio"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )
    try:
        if process.stdout is None:
            raise CollectorError("Codex app-server stdout is unavailable")
        send_message(
            process,
            {
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {"name": "ai-usage-collector", "version": "1.0.0"},
                    "capabilities": {},
                },
            },
        )
        read_response(process.stdout, 1, timeout)
        send_message(process, {"method": "initialized"})
        send_message(process, {"id": 2, "method": "account/rateLimits/read"})
        return read_response(process.stdout, 2, timeout)
    finally:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)


def select_codex_snapshot(result: dict[str, Any]) -> dict[str, Any]:
    buckets = result.get("rateLimitsByLimitId")
    if isinstance(buckets, dict):
        direct = buckets.get("codex")
        if isinstance(direct, dict):
            return direct
        for value in buckets.values():
            if isinstance(value, dict) and value.get("limitId") == "codex":
                return value

    fallback = result.get("rateLimits")
    if isinstance(fallback, dict) and fallback.get("limitId") in (None, "codex"):
        return fallback
    raise CollectorError("Codex returned no general 'codex' rate-limit bucket")


def duration_label(minutes: int | None) -> str:
    if minutes is None:
        return "Limit"
    if minutes % 10_080 == 0:
        return f"{minutes // 10_080 * 7}d"
    if minutes % 1_440 == 0:
        return f"{minutes // 1_440}d"
    if minutes % 60 == 0:
        return f"{minutes // 60}h"
    return f"{minutes}m"


def iso_timestamp(epoch: Any) -> str | None:
    if epoch is None:
        return None
    if isinstance(epoch, bool) or not isinstance(epoch, (int, float)):
        raise CollectorError("Codex resetsAt must be a Unix timestamp")
    return dt.datetime.fromtimestamp(epoch, tz=dt.timezone.utc).isoformat().replace("+00:00", "Z")


def windows_from_snapshot(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    windows: list[dict[str, Any]] = []
    for slot in ("primary", "secondary"):
        raw = snapshot.get(slot)
        if raw is None:
            continue
        if not isinstance(raw, dict):
            raise CollectorError(f"Codex {slot} rate-limit window is malformed")
        used = raw.get("usedPercent")
        if isinstance(used, bool) or not isinstance(used, (int, float)) or not 0 <= used <= 100:
            raise CollectorError(f"Codex {slot}.usedPercent must be within 0..100")
        duration = raw.get("windowDurationMins")
        if duration is not None and (
            isinstance(duration, bool) or not isinstance(duration, int) or duration < 1
        ):
            raise CollectorError(f"Codex {slot}.windowDurationMins is invalid")
        windows.append(
            {
                "id": f"{slot}-{duration}m" if duration else slot,
                "label": duration_label(duration),
                "duration_minutes": duration,
                "utilization": used / 100,
                "resets_at": iso_timestamp(raw.get("resetsAt")),
            }
        )
    return windows


def safe_account_id(host: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]", "-", host)[:48].strip("-") or "mac"
    return f"codex-{cleaned}"


def compatibility_window(
    windows: list[dict[str, Any]], duration: int
) -> dict[str, Any] | None:
    for window in windows:
        if window["duration_minutes"] == duration and window["resets_at"] is not None:
            return {
                "utilization": window["utilization"],
                "resets_at": window["resets_at"],
            }
    return None


def account_payload(result: dict[str, Any], config: dict[str, str]) -> dict[str, Any]:
    snapshot = select_codex_snapshot(result)
    windows = windows_from_snapshot(snapshot)
    host = socket.gethostname().split(".", 1)[0]
    plan = snapshot.get("planType")
    plan_label = str(plan).replace("_", " ").title() if plan else "Account"
    account_id = config.get("USAGE_ACCOUNT_ID") or safe_account_id(host)
    if ACCOUNT_ID_PATTERN.fullmatch(account_id) is None:
        raise CollectorError("USAGE_ACCOUNT_ID must match [A-Za-z0-9._-]{1,64}")

    return {
        "id": account_id,
        "label": config.get("USAGE_LABEL") or f"Codex · {plan_label}",
        "provider": "codex",
        "source_host": host,
        "as_of": dt.datetime.now(tz=dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "status": "ok" if windows else "error",
        "windows": windows,
        # Compatibility with the currently deployed schema-1 aggregator.
        "five_hour": compatibility_window(windows, 300),
        "seven_day": compatibility_window(windows, 10_080),
    }


def cache_payload(payload: dict[str, Any]) -> Path:
    root = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "codex-usage"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    destination = root / f"{payload['id']}.json"
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=root, delete=False) as handle:
        json.dump(payload, handle, separators=(",", ":"))
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.chmod(0o600)
    temporary.replace(destination)
    return destination


def push_payload(payload: dict[str, Any], endpoint: str, token: str) -> None:
    if len(token) < 16:
        raise CollectorError("USAGE_TOKEN must be at least 16 characters")
    curl = shutil.which("curl")
    if curl is None:
        raise CollectorError("curl is required to push usage")
    try:
        subprocess.run(
            [
                curl,
                "-fsS",
                "--max-time",
                "10",
                "-X",
                "POST",
                endpoint,
                "-H",
                "Content-Type: application/json",
                "-H",
                f"Authorization: Bearer {token}",
                "--data-binary",
                json.dumps(payload, separators=(",", ":")),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
    except subprocess.CalledProcessError as error:
        # CalledProcessError includes the complete argv, including the bearer
        # header. Replace it before it can reach logs or a launchd diagnostic.
        raise CollectorError(f"usage push failed (curl exit {error.returncode})") from None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        type=Path,
        default=Path.home() / ".config" / "codex-usage" / "config",
    )
    parser.add_argument("--print", action="store_true", dest="print_payload")
    parser.add_argument("--no-push", action="store_true")
    args = parser.parse_args()

    try:
        config = load_config(args.config)
        codex_bin = config.get("CODEX_BIN") or shutil.which("codex")
        if not codex_bin:
            raise CollectorError("codex was not found; set CODEX_BIN in the collector config")
        result = read_codex_rate_limits(codex_bin)
        payload = account_payload(result, config)
        cache_payload(payload)
        if args.print_payload:
            print(json.dumps(payload, indent=2, sort_keys=True))

        endpoint = config.get("USAGE_ENDPOINT", "")
        if endpoint and not args.no_push:
            push_payload(payload, endpoint, config.get("USAGE_TOKEN", ""))
        return 0
    except (CollectorError, OSError, subprocess.SubprocessError) as error:
        print(f"codex-usage: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
