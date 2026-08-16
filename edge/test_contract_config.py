import os
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

from ai_usage.config import CollectorConfig
from ai_usage.contract import Observation, QuotaWindow
from ai_usage.errors import CollectorError, ConfigError
from ai_usage.identity import (
    claude_identity,
    codex_identity,
    grok_identity,
    identity_key_id,
)
from ai_usage.util import Redactor
from test_support import config_mapping, make_config


class ContractTests(unittest.TestCase):
    def observation(self):
        return Observation(
            observation_id=str(uuid.uuid4()),
            observer_instance_id=str(uuid.uuid4()),
            identity_key_id="A1b2C3d4E5f6G7h8",
            sequence=4,
            provider="claude",
            edge_id="edge-test",
            profile_id="desktop-a",
            profile_label="Desktop A",
            pool_label="Claude · Max 20x",
            session_id="session-1",
            source_host="test-host",
            collector_version="3.0.0",
            provider_client_version="2.1.0",
            observed_at="2026-08-15T12:00:00Z",
            sampled_at="2026-08-15T11:59:59Z",
            sample_time_quality="transcript_mtime",
            status="ok",
            provider_subject="A" * 43,
            identity_evidence="org_email",
            windows=(
                QuotaWindow("five-hour", "5h", 300, 0.58, "2026-08-15T13:00:00Z"),
            ),
        )

    def test_serializer_has_exact_flat_aggregator_key_set(self):
        original = self.observation()
        value = original.to_dict()
        self.assertEqual(
            set(value),
            {
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
            },
        )
        self.assertEqual(Observation.from_dict(value), original)

    def test_unknown_secret_shaped_field_fails_closed(self):
        value = self.observation().to_dict()
        value["provider_token"] = "must-not-cross-wire"
        with self.assertRaises(CollectorError):
            Observation.from_dict(value)

    def test_observer_instance_and_identity_key_id_are_required_and_validated(self):
        for field in ("observer_instance_id", "identity_key_id"):
            value = self.observation().to_dict()
            del value[field]
            with self.assertRaises(CollectorError):
                Observation.from_dict(value)
        value = self.observation().to_dict()
        value["observer_instance_id"] = "not-a-uuid"
        with self.assertRaises(CollectorError):
            Observation.from_dict(value)
        value = self.observation().to_dict()
        value["identity_key_id"] = "too/short!"
        with self.assertRaises(CollectorError):
            Observation.from_dict(value)

    def test_future_sample_and_control_characters_are_rejected(self):
        value = self.observation().to_dict()
        value["sampled_at"] = "2026-08-15T12:00:01Z"
        with self.assertRaises(CollectorError):
            Observation.from_dict(value)

    def test_display_limits_match_javascript_utf16_code_units(self):
        value = self.observation().to_dict()
        value["profile_label"] = "🚀" * 65
        with self.assertRaises(CollectorError):
            Observation.from_dict(value)

    def test_provider_display_sanitizes_lone_surrogates(self):
        from ai_usage.util import display_text

        self.assertEqual(display_text("Build\ud800Plan", "fallback"), "Build\ufffdPlan")
        value = self.observation().to_dict()
        value["source_host"] = "host\nforged-log-line"
        with self.assertRaises(CollectorError):
            Observation.from_dict(value)

    def test_billing_unavailable_is_an_explicit_status(self):
        value = self.observation().to_dict()
        value["status"] = "billing_unavailable"
        self.assertEqual(Observation.from_dict(value).status, "billing_unavailable")


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.key = b"x" * 32

    def test_identity_key_id_is_stable_nonsecret_and_key_scoped(self):
        first = identity_key_id(self.key)
        self.assertRegex(first, r"^[A-Za-z0-9_-]{16}$")
        self.assertEqual(first, identity_key_id(self.key))
        # A different fleet key produces a different namespace identifier —
        # the whole point is detecting a mis-provisioned collector.
        self.assertNotEqual(first, identity_key_id(b"y" * 32))
        self.assertNotIn(self.key.hex(), first)

    def test_same_claude_subject_matches_across_profiles_without_exporting_email(self):
        first = claude_identity(
            {"orgId": "ORG-1", "email": " Person@Example.COM "}, self.key
        )
        second = claude_identity(
            {
                "oauthAccount": {
                    "organizationId": "org-1",
                    "emailAddress": "person@example.com",
                }
            },
            self.key,
        )
        self.assertEqual(first, second)
        self.assertEqual(first.evidence, "org_email")
        self.assertRegex(first.digest, r"^[A-Za-z0-9_-]{43}$")
        self.assertNotIn("person", first.digest.casefold())

    def test_provider_priority_rules(self):
        codex = codex_identity(
            {"account": {"accountId": "acct", "workspaceId": "work", "email": "a@b.c"}},
            self.key,
        )
        grok = grok_identity(
            {"principalId": "principal", "teamId": "team", "email": "a@b.c"}, self.key
        )
        self.assertEqual(codex.evidence, "account_id")
        self.assertEqual(grok.evidence, "principal_id")

    def test_unknown_identity_remains_advisory(self):
        self.assertIsNone(claude_identity({}, self.key).digest)


class ConfigTests(unittest.TestCase):
    def test_origin_endpoint_is_normalized_to_v3_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(Path(temporary), endpoint="https://collector.example")
            self.assertEqual(
                config.endpoint, "https://collector.example/v3/observations"
            )

    def test_non_loopback_http_and_wrong_path_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaises(ConfigError):
                CollectorConfig.from_mapping(
                    root / "config.json",
                    config_mapping(root, endpoint="http://collector.example"),
                )
            with self.assertRaises(ConfigError):
                CollectorConfig.from_mapping(
                    root / "config.json",
                    config_mapping(
                        root, endpoint="https://collector.example/v1/ingest"
                    ),
                )

    def test_invalid_endpoint_port_is_rejected_during_parse(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(ConfigError, "endpoint port"):
                CollectorConfig.from_mapping(
                    root / "config.json",
                    config_mapping(
                        root,
                        endpoint="https://collector.example:bad/v3/observations",
                    ),
                )

    def test_loopback_http_is_allowed_for_falsifiers(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(Path(temporary), endpoint="http://127.0.0.1:9000")
            self.assertEqual(config.endpoint, "http://127.0.0.1:9000/v3/observations")

    def test_unknown_config_fields_fail_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw = config_mapping(root)
            raw["oauth_token"] = "leak"
            with self.assertRaises(ConfigError):
                CollectorConfig.from_mapping(root / "config.json", raw)

    def test_ingest_token_matches_the_http_bearer_wire_grammar(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for token in (
                "contains a space 12345",
                "contains-delete-\x7f-12345",
                "contains-unicode-é-12345",
            ):
                with self.subTest(token=repr(token)):
                    raw = config_mapping(root)
                    raw["ingest_token"] = token
                    with self.assertRaisesRegex(ConfigError, "ASCII graphic"):
                        CollectorConfig.from_mapping(root / "config.json", raw)

    def test_provider_child_environment_strips_all_collector_credentials(self):
        with (
            tempfile.TemporaryDirectory() as temporary,
            mock.patch.dict(
                os.environ,
                {
                    "AI_USAGE_TOKEN": "edge-secret",
                    "AI_USAGE_IDENTITY_KEY": "identity-secret",
                    "USAGE_TOKEN": "legacy-secret",
                    "READ_TOKEN": "read-secret",
                    "INGEST_TOKEN": "ingest-secret",
                    "EDGE_CREDENTIALS_JSON": "credential-map-secret",
                    "ANTHROPIC_API_KEY": "provider-owned-secret",
                },
                clear=False,
            ),
        ):
            config = make_config(Path(temporary), "claude")
            environment = config.provider_environment()
            for key in (
                "AI_USAGE_TOKEN",
                "AI_USAGE_IDENTITY_KEY",
                "USAGE_TOKEN",
                "READ_TOKEN",
                "INGEST_TOKEN",
                "EDGE_CREDENTIALS_JSON",
            ):
                self.assertNotIn(key, environment)
            self.assertEqual(environment["ANTHROPIC_API_KEY"], "provider-owned-secret")
            self.assertEqual(
                environment["CLAUDE_CONFIG_DIR"], str(config.provider_home)
            )

    def test_redactor_never_persists_known_or_bearer_secrets(self):
        redacted = Redactor("super-secret-token")(
            "Authorization: Bearer abc.def token=super-secret-token\nforged"
        )
        self.assertNotIn("abc.def", redacted)
        self.assertNotIn("super-secret-token", redacted)
        self.assertNotIn("\n", redacted)


if __name__ == "__main__":
    unittest.main()
