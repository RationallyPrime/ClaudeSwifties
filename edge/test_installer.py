import base64
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

EDGE_DIR = Path(__file__).resolve().parent


class InstallerTests(unittest.TestCase):
    def environment(self, root: Path, provider: str, profile_id: str):
        profile = root / "profiles" / profile_id
        environment = {
            **os.environ,
            "HOME": str(root / "home"),
            "XDG_CONFIG_HOME": str(root / "xdg"),
            "AI_USAGE_INSTALL_ROOT": str(root / "installed"),
            "AI_USAGE_SKIP_SERVICE_START": "1",
            "AI_USAGE_EDGE_ID": "edge-test",
            "AI_USAGE_PROFILE_ID": profile_id,
            "AI_USAGE_PROFILE_LABEL": f"{profile_id} · Test",
            "AI_USAGE_ENDPOINT": "https://collector.example/v3/observations",
            "AI_USAGE_TOKEN": "installer-test-token-not-secret-12345",
            "AI_USAGE_IDENTITY_KEY": base64.b64encode(b"k" * 32).decode("ascii"),
            "AI_USAGE_PROVIDER_BIN": "/usr/bin/true",
            "PYTHON_BIN": sys.executable,
        }
        if provider == "claude":
            environment["CLAUDE_CONFIG_DIR"] = str(profile)
            environment["CLAUDE_SETTINGS_FILE"] = str(profile / "settings.json")
        elif provider == "codex":
            environment["CODEX_HOME"] = str(profile)
        else:
            environment["AI_USAGE_GROK_HOME"] = str(profile)
        return environment

    def run_installer(self, provider: str, environment, *arguments, check=True):
        return subprocess.run(
            [str(EDGE_DIR / f"install-{provider}-collector.sh"), *arguments],
            env=environment,
            text=True,
            capture_output=True,
            check=check,
            timeout=10,
        )

    def test_claude_reinstall_never_nests_and_uninstall_restores_exact_prior_object(
        self,
    ):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            environment = self.environment(root, "claude", "desktop-a")
            settings_path = Path(environment["CLAUDE_SETTINGS_FILE"])
            settings_path.parent.mkdir(parents=True)
            prior = {
                "type": "command",
                "command": "old-status --flag 'exact value'",
                "padding": 1,
            }
            settings_path.write_text(
                json.dumps({"theme": "dark", "statusLine": prior}) + "\n"
            )

            self.run_installer("claude", environment)
            first_settings = json.loads(settings_path.read_text())
            config_path = (
                Path(environment["CLAUDE_CONFIG_DIR"]) / "ai-usage" / "config.json"
            )
            manifest_path = config_path.with_name("install-manifest.json")
            manifest = json.loads(manifest_path.read_text())
            self.assertEqual(manifest["prior_status_line"], prior)
            self.assertEqual(
                first_settings["statusLine"], manifest["wrapper_status_line"]
            )
            self.assertEqual(stat.S_IMODE(config_path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(manifest_path.stat().st_mode), 0o600)

            self.run_installer("claude", environment)
            reinstalled = json.loads(manifest_path.read_text())
            self.assertEqual(reinstalled["prior_status_line"], prior)
            self.assertNotIn(
                "ai-usage-v3", json.dumps(reinstalled["prior_status_line"])
            )

            self.run_installer("claude", environment, "--uninstall")
            restored = json.loads(settings_path.read_text())
            self.assertEqual(restored["statusLine"], prior)
            self.assertEqual(restored["theme"], "dark")
            self.assertTrue(
                config_path.exists(), "private config is retained for recoverability"
            )

    def test_uninstall_refuses_to_overwrite_status_line_drift(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            environment = self.environment(root, "claude", "desktop-a")
            settings_path = Path(environment["CLAUDE_SETTINGS_FILE"])
            settings_path.parent.mkdir(parents=True)
            settings_path.write_text("{}\n")
            self.run_installer("claude", environment)
            settings_path.write_text(
                json.dumps(
                    {
                        "statusLine": {
                            "type": "command",
                            "command": "changed-after-install",
                        }
                    }
                )
            )
            completed = self.run_installer(
                "claude", environment, "--uninstall", check=False
            )
            self.assertNotEqual(completed.returncode, 0)
            self.assertIn("refusing to overwrite", completed.stderr)
            self.assertEqual(
                json.loads(settings_path.read_text())["statusLine"]["command"],
                "changed-after-install",
            )

    def test_reinstall_recognizes_owned_wrapper_after_root_or_interpreter_change(self):
        for change in ("install-root", "interpreter"):
            with (
                self.subTest(change=change),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                environment = self.environment(root, "claude", "fable-linux")
                settings_path = Path(environment["CLAUDE_SETTINGS_FILE"])
                settings_path.parent.mkdir(parents=True)
                prior = {
                    "type": "command",
                    "command": "original-status --exact 'prior value'",
                    "padding": 2,
                }
                settings_path.write_text(json.dumps({"statusLine": prior}) + "\n")
                self.run_installer("claude", environment)

                config_path = (
                    Path(environment["CLAUDE_CONFIG_DIR"]) / "ai-usage" / "config.json"
                )
                manifest_path = config_path.with_name("install-manifest.json")
                first_manifest = json.loads(manifest_path.read_text())
                old_wrapper = first_manifest["wrapper_status_line"]

                changed = dict(environment)
                if change == "install-root":
                    changed["AI_USAGE_INSTALL_ROOT"] = str(root / "installed-two")
                else:
                    alternate_python = root / "python-alternate"
                    alternate_python.symlink_to(sys.executable)
                    changed["PYTHON_BIN"] = str(alternate_python)

                self.run_installer("claude", changed)
                second_manifest = json.loads(manifest_path.read_text())
                second_settings = json.loads(settings_path.read_text())
                self.assertNotEqual(second_manifest["wrapper_status_line"], old_wrapper)
                self.assertEqual(second_manifest["prior_status_line"], prior)
                self.assertEqual(
                    second_settings["statusLine"],
                    second_manifest["wrapper_status_line"],
                )
                self.assertNotEqual(second_manifest["prior_status_line"], old_wrapper)

                # A further reinstall at the moved command is also idempotent.
                self.run_installer("claude", changed)
                third_manifest = json.loads(manifest_path.read_text())
                self.assertEqual(third_manifest["prior_status_line"], prior)

    def test_two_claude_profiles_have_distinct_private_config_spool_and_manifests(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            paths = []
            for profile_id in ("desktop-a", "desktop-b"):
                environment = self.environment(root, "claude", profile_id)
                settings = Path(environment["CLAUDE_SETTINGS_FILE"])
                settings.parent.mkdir(parents=True)
                settings.write_text("{}\n")
                self.run_installer("claude", environment)
                config = (
                    Path(environment["CLAUDE_CONFIG_DIR"]) / "ai-usage" / "config.json"
                )
                paths.append(config)
            self.assertNotEqual(paths[0], paths[1])
            first, second = (json.loads(path.read_text()) for path in paths)
            self.assertNotEqual(first["profile_id"], second["profile_id"])
            self.assertNotEqual(first["state_dir"], second["state_dir"])

    def test_codex_and_grok_installers_pin_exact_provider_homes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for provider in ("codex", "grok"):
                with self.subTest(provider=provider):
                    environment = self.environment(
                        root, provider, f"{provider}-profile"
                    )
                    self.run_installer(provider, environment)
                    if provider == "codex":
                        profile_home = Path(environment["CODEX_HOME"])
                        config_path = profile_home / "ai-usage" / "config.json"
                    else:
                        profile_home = Path(environment["AI_USAGE_GROK_HOME"])
                        config_path = (
                            profile_home / ".grok" / "ai-usage" / "config.json"
                        )
                    config = json.loads(config_path.read_text())
                    self.assertEqual(
                        config["provider_home"], str(profile_home.resolve())
                    )
                    self.assertEqual(stat.S_IMODE(config_path.stat().st_mode), 0o600)


if __name__ == "__main__":
    unittest.main()
