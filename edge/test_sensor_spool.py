import datetime as dt
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from ai_usage.claude_sensor import claude_statusline
from ai_usage.contract import QuotaWindow
from ai_usage.errors import CollectorError, SpoolFull
from ai_usage.identity import IdentityHint
from ai_usage.observation import make_observation
from ai_usage.sensor_cli import statusline
from ai_usage.spool import ObserverInstance, Sequence, Spool
from ai_usage.util import UTC, atomic_write_json
from test_support import make_config, write_executable

TEST_OBSERVER_INSTANCE = "018f47f0-167a-7cc4-a3d1-d6f5eb04c0aa"

EDGE_DIR = Path(__file__).resolve().parent
STATUSLINE = EDGE_DIR / "statusline-usage.sh"
FIXTURES = EDGE_DIR / "fixtures"


def claude_payload(transcript: Path | None = None):
    value = json.loads(
        (FIXTURES / "claude-statusline.sanitized.json").read_text(encoding="utf-8")
    )
    value["session_id"] = "session-a"
    if transcript is not None:
        value["transcript_path"] = str(transcript)
    else:
        value.pop("transcript_path", None)
    return value


class ClaudeSensorTests(unittest.TestCase):
    def test_transcript_mtime_is_clamped_and_stamped_as_sample_time(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            transcript = root / "session.jsonl"
            transcript.write_text("{}\n")
            observed = dt.datetime(2026, 8, 15, 12, 0, tzinfo=UTC)
            old = observed.timestamp() - 90
            os.utime(transcript, (old, old))
            config = make_config(root)
            result = claude_statusline(
                json.dumps(claude_payload(transcript)).encode(),
                config,
                sequence=8,
                observer_instance_id=TEST_OBSERVER_INSTANCE,
                identity=IdentityHint("A" * 43, "org_email"),
                observed_at=observed,
            )
            self.assertEqual(result.text, "[Opus]  5h 12%  7d 34%\n")
            self.assertEqual(result.observation.sample_time_quality, "transcript_mtime")
            self.assertEqual(result.observation.sampled_at, "2026-08-15T11:58:30Z")
            self.assertEqual(result.observation.session_id, "session-a")

            future = observed.timestamp() + 500
            os.utime(transcript, (future, future))
            result = claude_statusline(
                json.dumps(claude_payload(transcript)).encode(),
                config,
                sequence=9,
                observer_instance_id=TEST_OBSERVER_INSTANCE,
                identity=IdentityHint(None, "unknown"),
                observed_at=observed,
            )
            self.assertEqual(
                result.observation.sampled_at, result.observation.observed_at
            )

    def test_missing_transcript_uses_sensor_time_and_missing_limits_do_not_spool(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(Path(temporary))
            result = claude_statusline(
                json.dumps(claude_payload(Path(temporary) / "missing")).encode(),
                config,
                sequence=1,
                observer_instance_id=TEST_OBSERVER_INSTANCE,
                identity=IdentityHint(None, "unknown"),
            )
            self.assertEqual(result.observation.sample_time_quality, "sensor_time")
            empty = claude_statusline(
                b'{"model":{"display_name":"Sonnet"}}',
                config,
                sequence=2,
                observer_instance_id=TEST_OBSERVER_INSTANCE,
                identity=IdentityHint(None, "unknown"),
            )
            self.assertEqual(empty.text, "[Sonnet]\n")
            self.assertIsNone(empty.observation)

    def test_shell_entrypoint_spools_private_complete_observation_without_network(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = make_config(
                root, write=True, endpoint="https://unreachable.invalid/v3/observations"
            )
            completed = subprocess.run(
                [str(STATUSLINE), "--config", str(config.path)],
                input=json.dumps(claude_payload()),
                text=True,
                capture_output=True,
                check=True,
                env={**os.environ, "PYTHON_BIN": sys.executable},
                timeout=2,
            )
            self.assertEqual(completed.stdout, "[Opus]  5h 12%  7d 34%\n")
            paths = list(config.spool_dir.glob("*.json"))
            self.assertEqual(len(paths), 1)
            self.assertEqual(stat.S_IMODE(paths[0].stat().st_mode), 0o600)
            self.assertEqual(json.loads(paths[0].read_text())["schema"], 3)

    def test_prior_status_line_receives_same_json_and_owns_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = make_config(root, write=True)
            captured = root / "captured.json"
            prior = write_executable(
                root / "prior.sh",
                f"#!/bin/sh\ncat > {captured}\nprintf 'prior status\\n'\n",
            )
            atomic_write_json(
                config.manifest_path,
                {
                    "schema": 1,
                    "prior_status_line_present": True,
                    "prior_status_line": {"type": "command", "command": str(prior)},
                    "wrapper_status_line": {"type": "command", "command": "wrapper"},
                },
            )
            raw = json.dumps(claude_payload())
            completed = subprocess.run(
                [str(STATUSLINE), "--config", str(config.path)],
                input=raw,
                text=True,
                capture_output=True,
                check=True,
                env={**os.environ, "PYTHON_BIN": sys.executable},
            )
            self.assertEqual(completed.stdout, "prior status\n")
            self.assertEqual(captured.read_text(), raw)

    def test_spool_failure_still_runs_the_exact_prior_status_line(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = make_config(root, write=True)
            captured = root / "captured-after-failure.json"
            prior = write_executable(
                root / "prior.sh",
                f"#!/bin/sh\ncat > {captured}\nprintf 'prior survives failure\\n'\n",
            )
            atomic_write_json(
                config.manifest_path,
                {
                    "schema": 1,
                    "prior_status_line_present": True,
                    "prior_status_line": {"type": "command", "command": str(prior)},
                    "wrapper_status_line": {"type": "command", "command": "wrapper"},
                },
            )
            raw = json.dumps(claude_payload()).encode()
            with mock.patch(
                "ai_usage.sensor_cli.Spool.enqueue",
                side_effect=SpoolFull("test spool pressure"),
            ):
                output = statusline(config.path, raw)
            self.assertEqual(output, b"prior survives failure\n")
            self.assertEqual(captured.read_bytes(), raw)


class ObserverInstanceTests(unittest.TestCase):
    def test_instance_is_created_once_and_survives_rereads(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(Path(temporary))
            instance = ObserverInstance(config)
            self.assertIsNone(instance.peek())
            created = instance.read_or_create()
            self.assertEqual(created, instance.read_or_create())
            self.assertEqual(created, instance.peek())
            self.assertEqual(created, ObserverInstance(config).read_or_create())
            mode = config.observer_instance_path.stat().st_mode & 0o777
            self.assertEqual(mode, 0o600)

    def test_fresh_state_dir_is_a_new_installation_generation(self):
        with (
            tempfile.TemporaryDirectory() as first,
            tempfile.TemporaryDirectory() as second,
        ):
            first_id = ObserverInstance(make_config(Path(first))).read_or_create()
            second_id = ObserverInstance(make_config(Path(second))).read_or_create()
            self.assertNotEqual(first_id, second_id)

    def test_corrupt_instance_state_fails_loudly(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(Path(temporary))
            config.observer_instance_path.parent.mkdir(parents=True, exist_ok=True)
            config.observer_instance_path.write_text("not-a-uuid\n")
            with self.assertRaises(CollectorError):
                ObserverInstance(config).read_or_create()
            self.assertIsNone(ObserverInstance(config).peek())


class SpoolTests(unittest.TestCase):
    def observation(
        self,
        config,
        sequence,
        subject="A" * 43,
        reset="2026-08-16T00:00:00Z",
        utilization=0.5,
        sampled_at=None,
        sample_time_quality="sensor_time",
    ):
        now = dt.datetime(2026, 8, 15, 12, 0, tzinfo=UTC)
        return make_observation(
            config,
            observer_instance_id=TEST_OBSERVER_INSTANCE,
            sequence=sequence,
            observed_at=now,
            sampled_at=sampled_at or now,
            sample_time_quality=sample_time_quality,
            status="ok",
            identity=IdentityHint(subject, "org_email"),
            windows=[QuotaWindow("five-hour", "5h", 300, utilization, reset)],
            session_id="same-session",
        )

    def test_incomplete_temp_file_is_never_visible_as_pending(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(Path(temporary))
            spool = Spool(config)
            (spool.temporary / "killed.tmp").write_bytes(b'{"partial":')
            complete = self.observation(config, 1)
            spool.enqueue(complete)
            self.assertEqual(
                [item.observation.observation_id for item in spool.pending()],
                [complete.observation_id],
            )

    def test_sequence_is_monotonic_across_allocator_instances(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(Path(temporary))
            self.assertEqual(Sequence(config).next(), 0)
            self.assertEqual(Sequence(config).next(), 1)

    def test_pressure_coalesces_same_session_generation_but_not_identity_transition(
        self,
    ):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(
                Path(temporary), spool_max_count=8, spool_max_bytes=65_536
            )
            spool = Spool(config)
            for sequence in range(9):
                spool.enqueue(
                    self.observation(
                        config, sequence, utilization=0.1 + (sequence * 0.05)
                    )
                )
            self.assertLessEqual(spool.stats()["pending"], 8)
            retained_sequences = [item.observation.sequence for item in spool.pending()]
            self.assertNotIn(0, retained_sequences)
            self.assertIn(8, retained_sequences)

            # A later lower value cannot erase a queued high-water reading.
            for item in list(spool.pending()):
                spool.acknowledge(item)
            spool.enqueue(self.observation(config, 20, utilization=0.8))
            for sequence in range(21, 29):
                spool.enqueue(self.observation(config, sequence, utilization=0.2))
            retained = list(spool.pending())
            retained_values = {
                item.observation.sequence: item.observation.windows[0].utilization
                for item in retained
            }
            self.assertEqual(retained_values[20], 0.8)
            self.assertEqual(retained_values[28], 0.2)
            self.assertLessEqual(len(retained_values), config.spool_max_count)

            # Fill with distinct subject evidence. The ninth distinct item is
            # refused instead of deleting any prior identity transition.
            for item in list(spool.pending()):
                spool.acknowledge(item)
            for sequence in range(8):
                spool.enqueue(
                    self.observation(
                        config, 100 + sequence, subject=(chr(65 + sequence) * 43)
                    )
                )
            with self.assertRaises(SpoolFull):
                spool.enqueue(self.observation(config, 200, subject="Z" * 43))
            self.assertEqual(spool.stats()["pending"], 8)

    def test_pressure_preserves_provider_fresher_sample_despite_newer_sequence(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = make_config(
                Path(temporary), spool_max_count=8, spool_max_bytes=65_536
            )
            spool = Spool(config)
            fresh = dt.datetime(2026, 8, 15, 12, 0, tzinfo=UTC)
            stale = fresh - dt.timedelta(minutes=1)
            spool.enqueue(
                self.observation(config, 1, utilization=0.5, sampled_at=fresh)
            )
            spool.enqueue(
                self.observation(config, 2, utilization=0.6, sampled_at=stale)
            )
            for sequence in range(10, 16):
                spool.enqueue(
                    self.observation(
                        config,
                        sequence,
                        subject=chr(65 + sequence) * 43,
                    )
                )

            spool.enqueue(
                self.observation(config, 3, utilization=0.7, sampled_at=stale)
            )
            retained = [item.observation.sequence for item in spool.pending()]
            self.assertEqual(retained, [1, 3, 10, 11, 12, 13, 14, 15])


if __name__ == "__main__":
    unittest.main()
