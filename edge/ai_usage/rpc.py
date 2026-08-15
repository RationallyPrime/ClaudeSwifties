"""Bounded newline-delimited JSON-RPC subprocess client."""

from __future__ import annotations

import json
import os
import selectors
import subprocess
import threading
import time
from typing import Any

from .errors import AuthenticationRequired, ProviderError

MAX_RPC_LINE = 1024 * 1024
MAX_STDERR_CAPTURE = 4096


class JsonLineProcess:
    """Talk to a provider-owned JSONL process without reading its credentials."""

    def __init__(
        self,
        command: list[str],
        *,
        environment: dict[str, str],
        timeout: float,
        jsonrpc: bool,
    ):
        self.command = command
        self.deadline = time.monotonic() + timeout
        self.jsonrpc = jsonrpc
        self.process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            bufsize=0,
        )
        if (
            self.process.stdout is None
            or self.process.stdin is None
            or self.process.stderr is None
        ):
            self.process.kill()
            raise ProviderError("provider process did not expose stdio")
        self._selector = selectors.DefaultSelector()
        self._selector.register(self.process.stdout, selectors.EVENT_READ)
        self._buffer = bytearray()
        self._next_id = 1
        self._stderr = bytearray()
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()

    def _drain_stderr(self) -> None:
        assert self.process.stderr is not None
        while True:
            try:
                chunk = os.read(self.process.stderr.fileno(), 4096)
            except OSError:
                return
            if not chunk:
                return
            self._stderr.extend(chunk)
            if len(self._stderr) > MAX_STDERR_CAPTURE:
                del self._stderr[:-MAX_STDERR_CAPTURE]

    @property
    def stderr_summary(self) -> str:
        return bytes(self._stderr).decode("utf-8", errors="replace")

    def _remaining(self) -> float:
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise ProviderError("provider process timed out")
        return remaining

    def _send(self, message: dict[str, Any]) -> None:
        assert self.process.stdin is not None
        encoded = (
            json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode(
                "utf-8"
            )
            + b"\n"
        )
        try:
            self.process.stdin.write(encoded)
            self.process.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            raise ProviderError("provider process closed its input") from error

    def _line(self) -> bytes:
        assert self.process.stdout is not None
        while True:
            newline = self._buffer.find(b"\n")
            if newline >= 0:
                line = bytes(self._buffer[:newline])
                del self._buffer[: newline + 1]
                return line
            if len(self._buffer) > MAX_RPC_LINE:
                raise ProviderError("provider returned an oversized JSON message")
            if not self._selector.select(self._remaining()):
                raise ProviderError("provider process timed out")
            try:
                chunk = os.read(self.process.stdout.fileno(), 4096)
            except OSError as error:
                raise ProviderError("provider output could not be read") from error
            if not chunk:
                raise ProviderError("provider process exited before responding")
            self._buffer.extend(chunk)

    def request(
        self, method: str, params: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        request_id = self._next_id
        self._next_id += 1
        message: dict[str, Any] = {"id": request_id, "method": method}
        if self.jsonrpc:
            message["jsonrpc"] = "2.0"
        if params is not None:
            message["params"] = params
        self._send(message)
        while True:
            raw = self._line()
            try:
                response = json.loads(raw)
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if not isinstance(response, dict) or response.get("id") != request_id:
                continue
            if "error" in response:
                error = response.get("error")
                # Do not include provider payloads in exceptions. They can
                # contain private account metadata or, in future versions,
                # credential-shaped values.
                classification = json.dumps(error, ensure_ascii=False).casefold()
                if any(
                    word in classification
                    for word in ("auth", "login", "unauthorized", "forbidden")
                ):
                    raise AuthenticationRequired(
                        f"{method} requires provider authentication"
                    )
                raise ProviderError(f"provider request {method} failed")
            result = response.get("result")
            if not isinstance(result, dict):
                raise ProviderError(
                    f"provider request {method} returned no result object"
                )
            return result

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        message: dict[str, Any] = {"method": method}
        if self.jsonrpc:
            message["jsonrpc"] = "2.0"
        if params is not None:
            message["params"] = params
        self._send(message)

    def close(self) -> None:
        try:
            if self.process.stdin is not None:
                self.process.stdin.close()
        except OSError:
            pass
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)
        self._selector.close()
        self._stderr_thread.join(timeout=0.2)
        if self.process.stdout is not None:
            self.process.stdout.close()
        if self.process.stderr is not None:
            self.process.stderr.close()

    def __enter__(self) -> JsonLineProcess:  # noqa: PYI034 - Python 3.10 has no typing.Self
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.close()
