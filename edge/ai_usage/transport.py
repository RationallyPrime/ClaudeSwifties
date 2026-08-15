"""Idempotent schema-3 HTTP delivery using Python's standard library."""

from __future__ import annotations

import dataclasses
import json
import urllib.error
import urllib.request
from email.message import Message
from typing import Any

from .config import CollectorConfig
from .contract import Observation
from .errors import TransportError

MAX_RESPONSE_BYTES = 8 * 1024
ACK_OUTCOMES = {"accepted", "duplicate", "ignored", "conflict"}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward a per-edge bearer through a redirect. The configured
        # URL must name the final HTTPS origin and path.
        return None


@dataclasses.dataclass(frozen=True)
class Acknowledgement:
    observation_id: str
    outcome: str
    clock_skewed: bool


class DeliveryFailure(TransportError):
    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        retry_after: float | None = None,
    ):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


def _retry_after(headers: Message | None) -> float | None:
    if headers is None:
        return None
    value = headers.get("Retry-After")
    if value is None:
        return None
    try:
        seconds = float(value)
    except ValueError:
        return None
    return min(max(seconds, 0), 3600)


class ObservationTransport:
    def __init__(self, config: CollectorConfig, *, opener: Any | None = None):
        self.config = config
        self.opener = opener or urllib.request.build_opener(_NoRedirect())

    def send(self, observation: Observation) -> Acknowledgement:
        body = json.dumps(
            observation.to_dict(), ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        request = urllib.request.Request(
            self.config.endpoint,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {self.config.ingest_token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Content-Encoding": "identity",
                "User-Agent": f"ai-usage-edge/{observation.collector_version}",
            },
        )
        try:
            response = self.opener.open(
                request, timeout=self.config.request_timeout_seconds
            )
            with response:
                status = response.getcode()
                encoded = response.read(MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as error:
            # Never stringify HTTPError or Request: both can retain the
            # Authorization header in object state.
            raise DeliveryFailure(
                f"aggregator returned HTTP {error.code}",
                status=error.code,
                retry_after=_retry_after(error.headers),
            ) from None
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise DeliveryFailure(
                f"aggregator transport failed ({type(error).__name__})"
            ) from None

        if not 200 <= status < 300:
            raise DeliveryFailure(f"aggregator returned HTTP {status}", status=status)
        if len(encoded) > MAX_RESPONSE_BYTES:
            raise DeliveryFailure(
                "aggregator acknowledgement is oversized", status=status
            )
        try:
            acknowledgement = json.loads(encoded)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise DeliveryFailure(
                "aggregator returned malformed acknowledgement", status=status
            ) from None
        expected = {"ok", "observation_id", "outcome", "clock_skewed"}
        if not isinstance(acknowledgement, dict) or set(acknowledgement) != expected:
            raise DeliveryFailure(
                "aggregator acknowledgement has the wrong shape", status=status
            )
        if acknowledgement.get("ok") is not True:
            raise DeliveryFailure(
                "aggregator did not acknowledge the observation", status=status
            )
        if acknowledgement.get("observation_id") != observation.observation_id:
            raise DeliveryFailure(
                "aggregator acknowledged a different observation", status=status
            )
        outcome = acknowledgement.get("outcome")
        if outcome not in ACK_OUTCOMES or not isinstance(
            acknowledgement.get("clock_skewed"), bool
        ):
            raise DeliveryFailure(
                "aggregator acknowledgement has invalid fields", status=status
            )
        return Acknowledgement(
            observation.observation_id, outcome, acknowledgement["clock_skewed"]
        )
