"""Fast, local-only Claude status-line parser."""

from __future__ import annotations

import datetime as dt
import json
import math
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import CollectorConfig
from .contract import Observation, QuotaWindow
from .errors import CollectorError
from .identity import IdentityHint
from .observation import make_observation
from .util import UTC, display_text, epoch_timestamp, utc_now


def _safe_session(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    candidate = value.strip()
    if (
        len(candidate) > 128
        or not candidate[0].isalnum()
        or any(
            not (character.isascii() and (character.isalnum() or character in "._-"))
            for character in candidate
        )
    ):
        return None
    return candidate


@dataclass(frozen=True)
class ClaudeSensorResult:
    text: str
    observation: Observation | None


def _claude_window(
    raw: Any, identifier: str, label: str, duration: int
) -> tuple[float | None, QuotaWindow | None]:
    if not isinstance(raw, dict):
        return None, None
    used = raw.get("used_percentage")
    if (
        isinstance(used, bool)
        or not isinstance(used, (int, float))
        or not math.isfinite(float(used))
        or not 0 <= used <= 100
    ):
        return None, None
    try:
        reset_at = epoch_timestamp(
            raw.get("resets_at"), f"Claude {identifier}.resets_at"
        )
    except CollectorError:
        reset_at = None
    return float(used), QuotaWindow(
        identifier, label, duration, float(used) / 100, reset_at
    )


def claude_statusline(
    raw_input: bytes,
    config: CollectorConfig,
    *,
    sequence: int | Callable[[], int],
    observer_instance_id: str | Callable[[], str],
    identity: IdentityHint,
    observed_at: dt.datetime | None = None,
) -> ClaudeSensorResult:
    """Parse one status-line document once and build one local observation."""
    observed = observed_at or utc_now()
    if len(raw_input) > 2 * 1024 * 1024:
        return ClaudeSensorResult("[claude]\n", None)
    try:
        source = json.loads(raw_input)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return ClaudeSensorResult("[claude]\n", None)
    if not isinstance(source, dict):
        return ClaudeSensorResult("[claude]\n", None)
    model = source.get("model")
    model_name = display_text(
        model.get("display_name") if isinstance(model, dict) else None, "claude", 60
    )
    limits = source.get("rate_limits")
    limits = limits if isinstance(limits, dict) else {}
    five_used, five = _claude_window(limits.get("five_hour"), "five-hour", "5h", 300)
    seven_used, seven = _claude_window(
        limits.get("seven_day"), "seven-day", "7d", 10_080
    )
    line = f"[{model_name}]"
    if five_used is not None:
        line += f"  5h {five_used:.0f}%"
    if seven_used is not None:
        line += f"  7d {seven_used:.0f}%"
    line += "\n"
    windows = [window for window in (five, seven) if window is not None]
    if not windows:
        return ClaudeSensorResult(line, None)

    sampled = observed
    quality = "sensor_time"
    transcript = source.get("transcript_path")
    if isinstance(transcript, str) and transcript:
        try:
            modified = dt.datetime.fromtimestamp(
                Path(transcript).stat().st_mtime, tz=UTC
            )
        except (OSError, ValueError, OverflowError):
            pass
        else:
            sampled = min(modified, observed)
            quality = "transcript_mtime"
    resolved_sequence = sequence() if callable(sequence) else sequence
    resolved_instance = (
        observer_instance_id()
        if callable(observer_instance_id)
        else observer_instance_id
    )
    observation = make_observation(
        config,
        observer_instance_id=resolved_instance,
        sequence=resolved_sequence,
        observed_at=observed,
        sampled_at=sampled,
        sample_time_quality=quality,
        status="ok",
        identity=identity,
        windows=windows,
        session_id=_safe_session(source.get("session_id")),
        provider_client_version=(
            source.get("version") if isinstance(source.get("version"), str) else None
        ),
    )
    return ClaudeSensorResult(line, observation)
