import unittest

from codex_usage import CollectorError, account_payload, select_codex_snapshot, windows_from_snapshot


class CodexUsageTests(unittest.TestCase):
    def test_prefers_general_codex_bucket_over_model_bucket(self):
        result = {
            "rateLimits": {"limitId": "legacy"},
            "rateLimitsByLimitId": {
                "codex_model": {"limitId": "codex_model", "primary": None},
                "codex": {"limitId": "codex", "primary": {"usedPercent": 45}},
            },
        }
        self.assertEqual(select_codex_snapshot(result)["limitId"], "codex")

    def test_maps_five_hour_and_weekly_windows_by_duration(self):
        snapshot = {
            "primary": {"usedPercent": 25, "windowDurationMins": 300, "resetsAt": 1_786_300_000},
            "secondary": {"usedPercent": 45, "windowDurationMins": 10_080, "resetsAt": 1_786_900_000},
        }
        windows = windows_from_snapshot(snapshot)

        self.assertEqual([window["label"] for window in windows], ["5h", "7d"])
        self.assertEqual([window["utilization"] for window in windows], [0.25, 0.45])

    def test_current_weekly_only_shape_remains_legacy_compatible(self):
        result = {
            "rateLimits": {
                "limitId": "codex",
                "planType": "pro",
                "primary": {"usedPercent": 45, "windowDurationMins": 10_080, "resetsAt": 1_786_296_992},
                "secondary": None,
            }
        }
        payload = account_payload(result, {"USAGE_ACCOUNT_ID": "codex-test"})

        self.assertEqual(payload["provider"], "codex")
        self.assertEqual(payload["windows"][0]["label"], "7d")
        self.assertIsNone(payload["five_hour"])
        self.assertEqual(payload["seven_day"]["utilization"], 0.45)

    def test_missing_reset_is_preserved_as_unknown(self):
        windows = windows_from_snapshot(
            {"primary": {"usedPercent": 10, "windowDurationMins": 300, "resetsAt": None}}
        )
        self.assertIsNone(windows[0]["resets_at"])

    def test_account_id_cannot_escape_the_cache_directory(self):
        result = {
            "rateLimits": {
                "limitId": "codex",
                "primary": {"usedPercent": 10, "windowDurationMins": 300, "resetsAt": None},
            }
        }
        with self.assertRaises(CollectorError):
            account_payload(result, {"USAGE_ACCOUNT_ID": "../../outside"})


if __name__ == "__main__":
    unittest.main()
