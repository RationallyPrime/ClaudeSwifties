import json
import os
import pathlib
import shutil
import stat
import subprocess
import tempfile
import unittest


EDGE_DIR = pathlib.Path(__file__).resolve().parent
STATUSLINE = EDGE_DIR / "statusline-usage.sh"
INSTALLER = EDGE_DIR / "install-claude-collector.sh"


class StatusLineUsageTests(unittest.TestCase):
    def test_python_fallback_emits_and_caches_complete_payload(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            binary_dir = root / "bin"
            binary_dir.mkdir()
            for command in ("cat", "hostname", "mkdir", "python3", "sed"):
                source = shutil.which(command)
                self.assertIsNotNone(source, command)
                (binary_dir / command).symlink_to(source)

            source_payload = {
                "model": {"display_name": "Opus"},
                "rate_limits": {
                    "five_hour": {"used_percentage": 12, "resets_at": 1_786_200_000},
                    "seven_day": {"used_percentage": 34, "resets_at": 1_786_800_000},
                },
            }
            environment = {
                **os.environ,
                "HOME": str(root / "home"),
                "PATH": str(binary_dir),  # Deliberately excludes jq.
                "XDG_CACHE_HOME": str(root / "cache"),
                "USAGE_ACCOUNT_ID": "python-edge",
                "USAGE_LABEL": "Python edge",
            }
            completed = subprocess.run(
                [str(STATUSLINE)],
                input=json.dumps(source_payload),
                text=True,
                capture_output=True,
                check=True,
                env=environment,
            )

            self.assertEqual(completed.stdout, "[Opus]  5h 12%  7d 34%\n")
            cached = json.loads(
                (root / "cache" / "claude-usage" / "python-edge.json").read_text()
            )
            self.assertEqual(cached["provider"], "claude")
            self.assertEqual(len(cached["windows"]), 2)
            self.assertEqual(cached["five_hour"]["utilization"], 0.12)
            self.assertEqual(cached["seven_day"]["utilization"], 0.34)

    def test_installer_preserves_settings_and_writes_private_config(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = pathlib.Path(temporary)
            settings = home / ".claude" / "settings.json"
            settings.parent.mkdir()
            settings.write_text(
                json.dumps(
                    {
                        "theme": "dark",
                        "statusLine": {"type": "command", "command": "old-status"},
                    }
                )
                + "\n"
            )
            environment = {
                **os.environ,
                "HOME": str(home),
                "CLAUDE_SETTINGS_FILE": str(settings),
                "USAGE_ACCOUNT_ID": "test-team",
                "USAGE_LABEL": "Test Team",
                "USAGE_ENDPOINT": "https://example.test/v1/ingest",
                "USAGE_TOKEN": "fake-ingest-token-1234567890",
            }
            subprocess.run(
                [str(INSTALLER)],
                text=True,
                capture_output=True,
                check=True,
                env=environment,
            )

            installed = json.loads(settings.read_text())
            backup = json.loads(
                pathlib.Path(f"{settings}.before-ai-usage").read_text()
            )
            self.assertEqual(backup["statusLine"]["command"], "old-status")
            self.assertEqual(
                installed["statusLine"]["command"],
                str(home / ".local" / "libexec" / "ai-usage" / "statusline-usage.sh"),
            )
            config = home / ".config" / "claude-usage" / "config"
            self.assertEqual(stat.S_IMODE(config.stat().st_mode), 0o600)

    def test_invalid_account_id_cannot_escape_statusline_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            source_payload = {
                "model": {"display_name": "Opus"},
                "rate_limits": {
                    "five_hour": {"used_percentage": 12, "resets_at": 1_786_200_000}
                },
            }
            environment = {
                **os.environ,
                "HOME": str(root / "home"),
                "XDG_CACHE_HOME": str(root / "cache"),
                "USAGE_ACCOUNT_ID": "../../outside",
                "USAGE_LABEL": "Invalid edge",
            }
            completed = subprocess.run(
                [str(STATUSLINE)],
                input=json.dumps(source_payload),
                text=True,
                capture_output=True,
                check=True,
                env=environment,
            )

            self.assertIn("5h 12%", completed.stdout)
            self.assertFalse((root / "outside.json").exists())
            self.assertFalse((root / "cache" / "claude-usage" / "invalid-account.json").exists())


if __name__ == "__main__":
    unittest.main()
