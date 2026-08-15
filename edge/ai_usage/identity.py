"""Pseudonymous provider-subject identity derivation."""

from __future__ import annotations

import base64
import hashlib
import hmac
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from .util import normalize_identity


@dataclass(frozen=True)
class IdentityHint:
    digest: str | None
    evidence: str

    def to_dict(self) -> dict[str, str | None]:
        return {"digest": self.digest, "evidence": self.evidence}


def _first(mapping: dict[str, Any], paths: Iterable[tuple[str, ...]]) -> str | None:
    for path in paths:
        value: Any = mapping
        for key in path:
            if not isinstance(value, dict):
                value = None
                break
            value = value.get(key)
        normalized = normalize_identity(value)
        if normalized:
            return normalized
    return None


def _digest(
    provider: str, evidence: str, pieces: list[str], key: bytes
) -> IdentityHint:
    canonical = "\x1f".join([provider, evidence, *pieces]).encode("utf-8")
    raw = hmac.new(key, canonical, hashlib.sha256).digest()
    # Opaque unpadded base64url is accepted by the strict aggregator contract;
    # no algorithm prefix or provider identity material crosses the wire.
    value = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    return IdentityHint(digest=value, evidence=evidence)


def claude_identity(raw: dict[str, Any], key: bytes) -> IdentityHint:
    org = _first(
        raw,
        (
            ("orgId",),
            ("organizationId",),
            ("oauthAccount", "organizationId"),
            ("account", "orgId"),
        ),
    )
    email = _first(
        raw,
        (
            ("email",),
            ("emailAddress",),
            ("oauthAccount", "emailAddress"),
            ("oauthAccount", "email"),
            ("account", "email"),
        ),
    )
    if org and email:
        return _digest("claude", "org_email", [org, email], key)
    if org:
        return _digest("claude", "org", [org], key)
    if email:
        return _digest("claude", "email", [email], key)
    return IdentityHint(None, "unknown")


def codex_identity(raw: dict[str, Any], key: bytes) -> IdentityHint:
    account = raw.get("account") if isinstance(raw.get("account"), dict) else raw
    account_id = _first(
        account, (("accountId",), ("account_id",), ("id",), ("organizationId",))
    )
    workspace_id = _first(
        account, (("workspaceId",), ("workspace_id",), ("workspace", "id"))
    )
    email = _first(account, (("email",), ("emailAddress",)))
    if account_id:
        return _digest("codex", "account_id", [account_id], key)
    if workspace_id:
        return _digest("codex", "workspace_id", [workspace_id], key)
    if email:
        return _digest("codex", "email", [email], key)
    return IdentityHint(None, "unknown")


def grok_identity(raw: dict[str, Any], key: bytes) -> IdentityHint:
    for field, evidence in (
        ("principalId", "principal_id"),
        ("teamId", "team_id"),
        ("organizationId", "organization_id"),
        ("email", "email"),
    ):
        value = normalize_identity(raw.get(field))
        if value:
            return _digest("grok", evidence, [value], key)
    return IdentityHint(None, "unknown")
