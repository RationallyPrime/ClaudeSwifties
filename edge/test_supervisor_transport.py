import datetime as dt
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from ai_usage.contract import QuotaWindow
from ai_usage.errors import CollectorError
from ai_usage.identity import IdentityHint
from ai_usage.observation import make_observation
from ai_usage.providers import ProviderReading
from ai_usage.spool import FileLock, Spool
from ai_usage.supervisor import RuntimeState, Supervisor, doctor_report
from ai_usage.transport import Acknowledgement, DeliveryFailure, ObservationTransport
from ai_usage.util import UTC
from test_support import make_config


def observation(config, sequence=1, utilization=0.42):
    now = dt.datetime(2026, 8, 15, 12, 0, tzinfo=UTC)
    return make_observation(
        config,
        sequence=sequence,
        observed_at=now,
        sampled_at=now,
        sample_time_quality="sensor_time",
        status="ok",
        identity=IdentityHint("A" * 43, "org_email"),
        windows=[
            QuotaWindow("five-hour", "5h", 300, utilization, "2026-08-15T13:00:00Z")
        ],
    )


class FakeResponse:
    def __init__(self, status, value):
        self.status = status
        self.body = json.dumps(value).encode()

    def getcode(self):
        return self.status

    def read(self, count):
        return self.body[:count]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None


class FakeOpener:
    def __init__(self, response):
        self.response = response
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        if isinstance(self.response, Exception):
            raise self.response
        return self.response


class RecordingTransport:
    def __init__(self, failures=None):
        self.failures = list(failures or [])
        self.sent = []

    def send(self, value):
        self.sent.append(value)
        if self.failures:
            failure = self.failures.pop(0)
            if failure is not None:
                raise failure
        return Acknowledgement(value.observation_id, "accepted", False)


class TransportTests(unittest.TestCase):
    def test_fixed_ack_and_header_are_validated_without_subprocess_argv(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(Path(temporary))
            value = observation(config)
            opener = FakeOpener(
                FakeResponse(
                    200,
                    {
                        "ok": True,
                        "observation_id": value.observation_id,
                        "outcome": "accepted",
                        "clock_skewed": False,
                    },
                )
            )
            transport = ObservationTransport(config, opener=opener)
            with mock.patch(
                "subprocess.Popen",
                side_effect=AssertionError("transport must not spawn curl"),
            ):
                acknowledgement = transport.send(value)
            self.assertEqual(acknowledgement.observation_id, value.observation_id)
            request = opener.requests[0]
            self.assertEqual(
                request.full_url, "https://collector.example/v3/observations"
            )
            self.assertEqual(
                request.get_header("Authorization"), f"Bearer {config.ingest_token}"
            )

    def test_wrong_or_malformed_ack_never_authorizes_deletion(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(Path(temporary))
            value = observation(config)
            for response in (
                {
                    "ok": True,
                    "observation_id": "wrong",
                    "outcome": "accepted",
                    "clock_skewed": False,
                },
                {
                    "ok": True,
                    "observation_id": value.observation_id,
                    "outcome": "accepted",
                    "clock_skewed": False,
                    "extra": 1,
                },
            ):
                with self.subTest(response=response):
                    transport = ObservationTransport(
                        config, opener=FakeOpener(FakeResponse(200, response))
                    )
                    with self.assertRaises(DeliveryFailure):
                        transport.send(value)

    def test_http_errors_are_bounded_and_do_not_include_bearer(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(Path(temporary))
            value = observation(config)
            error = urllib.error.HTTPError(
                config.endpoint, 429, "too many", {"Retry-After": "17"}, None
            )
            transport = ObservationTransport(config, opener=FakeOpener(error))
            with self.assertRaises(DeliveryFailure) as caught:
                transport.send(value)
            self.assertEqual(caught.exception.status, 429)
            self.assertEqual(caught.exception.retry_after, 17)
            self.assertNotIn(config.ingest_token, str(caught.exception))


class SupervisorTests(unittest.TestCase):
    def test_oldest_first_and_delete_only_after_matching_ack(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(Path(temporary))
            spool = Spool(config)
            first, second = observation(config, 1), observation(config, 2)
            spool.enqueue(second)
            spool.enqueue(first)
            transport = RecordingTransport()
            supervisor = Supervisor(config, transport=transport, clock=lambda: 1000)
            state = RuntimeState()
            self.assertEqual(supervisor._drain(state, 1000), 2)
            self.assertEqual([item.sequence for item in transport.sent], [1, 2])
            self.assertEqual(spool.stats()["pending"], 0)
            self.assertEqual(state.last_ack_observation_id, second.observation_id)

    def test_connect_headers_body_response_failures_all_preserve_pending_data(self):
        phases = ("connect", "headers", "body", "response")
        for phase in phases:
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as temporary:
                config = make_config(Path(temporary))
                spool = Spool(config)
                queued = observation(config)
                spool.enqueue(queued)
                failure = DeliveryFailure(f"simulated {phase} cancellation")
                supervisor = Supervisor(
                    config,
                    transport=RecordingTransport([failure]),
                    clock=lambda: 1000,
                    jitter=lambda: 0.5,
                )
                state = RuntimeState()
                self.assertEqual(supervisor._drain(state, 1000), 0)
                self.assertEqual(spool.stats()["pending"], 1)
                self.assertIsNone(state.last_ack_observation_id)
                retry = json.loads(config.retry_path.read_text())
                self.assertEqual(retry["observation_id"], queued.observation_id)

    def test_dns_tls_401_429_500_preserve_eventual_delivery(self):
        failures = [
            DeliveryFailure("dns"),
            DeliveryFailure("tls"),
            DeliveryFailure("401", status=401),
            DeliveryFailure("429", status=429, retry_after=1),
            DeliveryFailure("500", status=500),
        ]
        for index, failure in enumerate(failures):
            with self.subTest(index=index), tempfile.TemporaryDirectory() as temporary:
                config = make_config(Path(temporary))
                spool = Spool(config)
                spool.enqueue(observation(config))
                transport = RecordingTransport([failure, None])
                supervisor = Supervisor(
                    config, transport=transport, clock=lambda: 1000, jitter=lambda: 0
                )
                state = RuntimeState()
                supervisor._drain(state, 1000)
                self.assertEqual(spool.stats()["pending"], 1)
                # Retry after the persisted backoff expires.
                supervisor._drain(state, 2000)
                self.assertEqual(spool.stats()["pending"], 0)

    def test_duplicate_timer_lock_prevents_double_drain(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(Path(temporary))
            supervisor = Supervisor(
                config, transport=RecordingTransport(), clock=lambda: 1000
            )
            with FileLock(config.state_dir / "supervisor.lock"):
                result = supervisor.run()
            self.assertTrue(result["already_running"])

    def test_heartbeat_occurs_within_five_minutes_and_reuses_sample_time(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(Path(temporary))
            spool = Spool(config)
            sample = observation(config)
            spool.save_last_sample(sample)
            transport = RecordingTransport()
            current = [1000.0]
            supervisor = Supervisor(
                config, transport=transport, clock=lambda: current[0]
            )
            state = RuntimeState(last_emit_at=699)
            heartbeat = supervisor._heartbeat(
                state, IdentityHint("A" * 43, "org_email"), "ok", current[0]
            )
            self.assertIsNotNone(heartbeat)
            self.assertEqual(heartbeat.sampled_at, sample.sampled_at)
            self.assertEqual(heartbeat.provider_subject, "A" * 43)
            self.assertIsNone(
                supervisor._heartbeat(
                    state, IdentityHint("A" * 43, "org_email"), "ok", 1200
                )
            )

    def test_supervisor_adopts_hot_path_sample_before_heartbeat_and_delivery(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(Path(temporary))
            sample = observation(config)
            Spool(config).enqueue(sample)
            state = RuntimeState()
            supervisor = Supervisor(
                config, transport=RecordingTransport(), clock=lambda: 1_786_795_250
            )

            supervisor._refresh_last_sample(state)

            saved = Spool(config).load_last_sample()
            self.assertEqual(saved.observation_id, sample.observation_id)
            self.assertEqual(state.last_emit_at, 1_786_795_200)
            self.assertIsNone(
                supervisor._heartbeat(
                    state,
                    IdentityHint("A" * 43, "org_email"),
                    "ok",
                    1_786_795_250,
                )
            )

    def test_grok_billing_unavailable_preserves_last_good_windows(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(Path(temporary), "grok")
            spool = Spool(config)
            sample = observation(config)
            # Rebuild under the Grok provider config.
            sample = make_observation(
                config,
                sequence=1,
                observed_at=dt.datetime(2026, 8, 15, 12, 0, tzinfo=UTC),
                sampled_at=dt.datetime(2026, 8, 15, 11, 59, tzinfo=UTC),
                sample_time_quality="provider_time",
                status="ok",
                identity=IdentityHint("G" * 43, "principal_id"),
                windows=[
                    QuotaWindow("weekly", "7d", 10080, 0.3, "2026-08-17T00:00:00Z")
                ],
                pool_label="Grok · Old Plan",
            )
            spool.save_last_sample(sample)
            reading = ProviderReading(
                IdentityHint("G" * 43, "principal_id"),
                [],
                "billing_unavailable",
                "Grok · Build",
            )
            supervisor = Supervisor(
                config, transport=RecordingTransport(), clock=lambda: 1000
            )
            state = RuntimeState(sample_checked_at=0)
            with mock.patch(
                "ai_usage.supervisor.collect_provider", return_value=reading
            ):
                degraded = supervisor._collect(state, 1000)
            self.assertEqual(degraded.status, "billing_unavailable")
            self.assertEqual(degraded.windows, sample.windows)
            self.assertEqual(degraded.sampled_at, sample.sampled_at)
            self.assertEqual(degraded.pool_label, "Grok · Old Plan")

    def test_new_subject_never_inherits_previous_subject_windows_or_pool(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(Path(temporary), "grok")
            previous = make_observation(
                config,
                sequence=1,
                observed_at=dt.datetime(2026, 8, 15, 12, 0, tzinfo=UTC),
                sampled_at=dt.datetime(2026, 8, 15, 11, 59, tzinfo=UTC),
                sample_time_quality="provider_time",
                status="ok",
                identity=IdentityHint("A" * 43, "principal_id"),
                windows=[
                    QuotaWindow("weekly", "7d", 10080, 0.7, "2026-08-17T00:00:00Z")
                ],
                pool_label="Grok · Subject A Plan",
            )
            spool = Spool(config)
            spool.save_last_sample(previous)
            new_subject = ProviderReading(
                IdentityHint("B" * 43, "principal_id"),
                [],
                "billing_unavailable",
                "Grok · Subject B Plan",
            )
            supervisor = Supervisor(
                config, transport=RecordingTransport(), clock=lambda: 1000
            )
            with mock.patch(
                "ai_usage.supervisor.collect_provider", return_value=new_subject
            ):
                degraded = supervisor._collect(RuntimeState(), 1000)

            self.assertEqual(degraded.provider_subject, "B" * 43)
            self.assertEqual(degraded.windows, ())
            self.assertEqual(degraded.pool_label, "Grok · Subject B Plan")
            self.assertEqual(degraded.sampled_at, degraded.observed_at)

            # The same fence applies when a Claude/auth identity transition is
            # observed between status-line samples and the next heartbeat.
            spool.save_last_sample(previous)
            heartbeat = supervisor._heartbeat(
                RuntimeState(last_emit_at=0),
                IdentityHint("B" * 43, "principal_id"),
                "ok",
                1000,
            )
            self.assertEqual(heartbeat.provider_subject, "B" * 43)
            self.assertEqual(heartbeat.windows, ())
            self.assertEqual(heartbeat.pool_label, config.pool_label)
            self.assertEqual(heartbeat.status, "stale")

    def test_malformed_provider_fields_still_drain_queued_observations(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(Path(temporary), "codex")
            queued = observation(config)
            Spool(config).enqueue(queued)
            transport = RecordingTransport()
            supervisor = Supervisor(
                config, transport=transport, clock=lambda: 1_786_795_200
            )
            with mock.patch(
                "ai_usage.supervisor.collect_provider",
                side_effect=CollectorError(
                    "Codex primary.resetsAt must be a Unix timestamp"
                ),
            ):
                result = supervisor.run()
            self.assertFalse(result["already_running"])
            self.assertEqual(result["queued"], 0)
            self.assertEqual(result["delivered"], 1)
            self.assertEqual(Spool(config).stats()["pending"], 0)
            self.assertEqual(transport.sent[0].observation_id, queued.observation_id)

    def test_corrupt_last_sample_is_rebuilt_without_blocking_spool_drain(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(Path(temporary), "codex")
            queued = observation(config)
            spool = Spool(config)
            spool.enqueue(queued)
            config.last_sample_path.parent.mkdir(parents=True, exist_ok=True)
            config.last_sample_path.write_text("{not-json", encoding="utf-8")
            transport = RecordingTransport()
            supervisor = Supervisor(
                config, transport=transport, clock=lambda: 1_786_795_200
            )

            with mock.patch(
                "ai_usage.supervisor.collect_provider",
                side_effect=CollectorError("provider sample is unavailable"),
            ):
                result = supervisor.run()

            self.assertEqual(result["queued"], 0)
            self.assertEqual(result["delivered"], 1)
            self.assertEqual(spool.stats()["pending"], 0)
            self.assertEqual(transport.sent[0].observation_id, queued.observation_id)
            rebuilt = spool.load_last_sample()
            self.assertEqual(rebuilt.observation_id, queued.observation_id)
            self.assertIn("last_sample_invalid", config.diagnostics_path.read_text())

    def test_full_spool_skips_new_sample_but_still_drains(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(Path(temporary), "codex", spool_max_count=8)
            spool = Spool(config)
            for sequence in range(8):
                spool.enqueue(
                    make_observation(
                        config,
                        sequence=sequence,
                        observed_at=dt.datetime(2026, 8, 15, 12, 0, tzinfo=UTC),
                        sampled_at=dt.datetime(2026, 8, 15, 12, 0, tzinfo=UTC),
                        sample_time_quality="sensor_time",
                        status="ok",
                        identity=IdentityHint(chr(65 + sequence) * 43, "account_id"),
                        windows=[
                            QuotaWindow(
                                "five-hour", "5h", 300, 0.1, "2026-08-15T13:00:00Z"
                            )
                        ],
                    )
                )
            transport = RecordingTransport()
            reading = ProviderReading(
                IdentityHint("Z" * 43, "account_id"),
                [QuotaWindow("five-hour", "5h", 300, 0.2, "2026-08-15T13:00:00Z")],
                "ok",
                "Codex · Account",
            )
            supervisor = Supervisor(config, transport=transport, clock=lambda: 1000)
            with mock.patch(
                "ai_usage.supervisor.collect_provider", return_value=reading
            ):
                result = supervisor.run()
            self.assertEqual(result["queued"], 0)
            self.assertEqual(result["delivered"], 8)
            self.assertEqual(spool.stats()["pending"], 0)
            self.assertEqual(len(transport.sent), 8)
            follow_up = Supervisor(
                config, transport=RecordingTransport(), clock=lambda: 1001
            )
            with mock.patch(
                "ai_usage.supervisor.collect_provider", return_value=reading
            ) as collect:
                follow_up.run()
                collect.assert_not_called()

    def test_backward_clock_jump_expires_scheduler_and_retry_deadlines(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(Path(temporary), "codex", write=True)
            queued = observation(config)
            Spool(config).enqueue(queued)
            runtime_path = config.state_dir / "runtime.json"
            runtime_path.parent.mkdir(parents=True, exist_ok=True)
            runtime_path.write_text(
                json.dumps(
                    {
                        "identity_checked_at": 5000,
                        "sample_checked_at": 5000,
                        "last_emit_at": 5000,
                    }
                )
            )
            config.retry_path.write_text(
                json.dumps(
                    {
                        "schema": 1,
                        "observation_id": queued.observation_id,
                        "attempt": 1,
                        "recorded_at": 5000,
                        "next_attempt_at": 5002,
                    }
                )
            )
            transport = RecordingTransport()
            reading = ProviderReading(
                IdentityHint("Z" * 43, "account_id"),
                [QuotaWindow("five-hour", "5h", 300, 0.2, "2026-08-15T13:00:00Z")],
                "ok",
                "Codex · Account",
            )
            supervisor = Supervisor(config, transport=transport, clock=lambda: 1000)

            with mock.patch(
                "ai_usage.supervisor.collect_provider", return_value=reading
            ) as collect:
                result = supervisor.run()

            collect.assert_called_once()
            self.assertGreaterEqual(result["delivered"], 1)
            self.assertEqual(Spool(config).stats()["pending"], 0)
            runtime = json.loads(runtime_path.read_text())
            self.assertLessEqual(runtime["identity_checked_at"], 1000)
            self.assertLessEqual(runtime["sample_checked_at"], 1000)
            self.assertLessEqual(runtime["last_emit_at"], 1000)

    def test_doctor_is_redacted_and_diagnostics_are_bounded(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(Path(temporary), write=True)
            spool = Spool(config)
            spool.enqueue(observation(config))
            supervisor = Supervisor(
                config,
                transport=RecordingTransport(
                    [DeliveryFailure(f"Bearer {config.ingest_token}")]
                ),
                clock=lambda: 1000,
            )
            supervisor._drain(RuntimeState(), 1000)
            report = doctor_report(config)
            encoded = json.dumps(report)
            diagnostics = config.diagnostics_path.read_text()
            self.assertNotIn(config.ingest_token, encoded)
            self.assertNotIn(config.ingest_token, diagnostics)
            self.assertNotIn(config.identity_key.hex(), encoded)
            self.assertLessEqual(config.diagnostics_path.stat().st_size, 64 * 1024)


if __name__ == "__main__":
    unittest.main()
