import Foundation
import Testing

@testable import UsageKit

/// Mirrors the contract exactly as the aggregator will serve it, including the
/// mixed fractional/plain timestamps the three edges will disagree about.
private let contractJSON = """
{
  "schema": 1,
  "generated_at": "2026-08-07T21:40:00Z",
  "accounts": [
    {
      "id": "sokrates-team",
      "label": "Sokrates · Team",
      "source_host": "timaeus-mbp",
      "as_of": "2026-08-07T21:38:12.482Z",
      "status": "ok",
      "five_hour": { "utilization": 0.42, "resets_at": "2026-08-07T23:10:00Z" },
      "seven_day": { "utilization": 0.71, "resets_at": "2026-08-09T04:00:00Z" }
    },
    {
      "id": "rp-team",
      "label": "Team · rationallyprime",
      "source_host": "hetzner-cx53",
      "as_of": "2026-08-07T21:32:00Z",
      "status": "auth_expired",
      "five_hour": null,
      "seven_day": null
    }
  ]
}
"""

@Test func decodesTheContract() throws {
    let snapshot = try JSONDecoder.usageDecoder()
        .decode(UsageSnapshot.self, from: Data(contractJSON.utf8))

    #expect(snapshot.schema == 1)
    #expect(snapshot.accounts.count == 2)

    let first = snapshot.accounts[0]
    #expect(first.id == "sokrates-team")
    #expect(first.provider == .claude)
    #expect(first.sourceHost == "timaeus-mbp")
    #expect(first.status == .ok)
    #expect(first.fiveHour?.fraction == 0.42)

    let second = snapshot.accounts[1]
    #expect(second.status == .authExpired)
    #expect(second.fiveHour == nil)
}

@Test func decodesProviderDefinedCodexWindows() throws {
    let json = """
    {
      "schema": 2,
      "generated_at": "2026-08-08T00:20:00Z",
      "accounts": [{
        "id": "codex-pro",
        "label": "Codex · Pro",
        "provider": "codex",
        "source_host": "hakon-mbp",
        "as_of": "2026-08-08T00:19:50Z",
        "status": "ok",
        "windows": [{
          "id": "primary-10080m",
          "label": "7d",
          "duration_minutes": 10080,
          "utilization": 0.45,
          "resets_at": "2026-08-09T17:36:32Z"
        }],
        "five_hour": null,
        "seven_day": {
          "utilization": 0.45,
          "resets_at": "2026-08-09T17:36:32Z"
        }
      }]
    }
    """

    let snapshot = try JSONDecoder.usageDecoder().decode(UsageSnapshot.self, from: Data(json.utf8))
    let account = try #require(snapshot.accounts.first)

    #expect(snapshot.schema == 2)
    #expect(account.provider == .codex)
    #expect(account.windows.count == 1)
    #expect(account.windows[0].label == "7d")
    #expect(account.windows[0].durationMinutes == 10_080)
    #expect(account.windows[0].fraction == 0.45)
}

@Test func acceptsBothTimestampShapes() throws {
    let snapshot = try JSONDecoder.usageDecoder()
        .decode(UsageSnapshot.self, from: Data(contractJSON.utf8))

    // 21:38:12.482Z (fractional) and 21:32:00Z (plain) — six minutes apart.
    let gap = snapshot.accounts[0].asOf.timeIntervalSince(snapshot.accounts[1].asOf)
    #expect(abs(gap - 372.482) < 0.01)
}

/// A new status value shipped by the aggregator must degrade one tile, never
/// blank the widget.
@Test func unknownStatusDoesNotThrow() throws {
    let json = contractJSON.replacingOccurrences(of: "\"auth_expired\"", with: "\"quota_hold\"")
    let snapshot = try JSONDecoder.usageDecoder().decode(UsageSnapshot.self, from: Data(json.utf8))

    #expect(snapshot.accounts[1].status == .unknown)
    #expect(snapshot.accounts[0].status == .ok)
}

@Test func utilizationIsClampedForDisplay() {
    #expect(UsageWindow(utilization: 1.4, resetsAt: .now).fraction == 1.0)
    #expect(UsageWindow(utilization: -0.2, resetsAt: .now).fraction == 0.0)
}

@Test func roundTripsThroughEncoder() throws {
    let original = UsageSnapshot.sample(now: Date(timeIntervalSince1970: 1_786_100_000))
    let data = try JSONEncoder.usageEncoder().encode(original)
    let restored = try JSONDecoder.usageDecoder().decode(UsageSnapshot.self, from: data)

    #expect(restored.accounts.map(\.id) == original.accounts.map(\.id))
    #expect(restored.accounts[1].provider == .codex)
    #expect(restored.accounts[2].status == .authExpired)
}
