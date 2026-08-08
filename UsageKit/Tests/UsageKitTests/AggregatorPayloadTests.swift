import Foundation
import Testing

@testable import UsageKit

/// Captured verbatim from a running aggregator, after a real statusline payload
/// went through `edge/statusline-usage.sh`. If the service's output drifts from
/// what the widget can decode, this fails instead of the widget going blank.
private let capturedResponse = """
{
  "schema": 1,
  "generated_at": "2026-08-07T23:36:41.754Z",
  "accounts": [
    {
      "id": "rp-team",
      "label": "Team · rationallyprime",
      "source_host": "Mac",
      "as_of": "2026-08-07T23:36:39.000Z",
      "status": "ok",
      "five_hour": {
        "utilization": 0.423,
        "resets_at": "2026-08-07T19:13:20.000Z"
      },
      "seven_day": {
        "utilization": 0.71,
        "resets_at": "2026-08-09T18:26:40.000Z"
      }
    },
    {
      "id": "sokrates-team",
      "label": "Sokrates · Team",
      "source_host": "Mac",
      "as_of": "2026-08-07T23:36:44.000Z",
      "status": "ok",
      "five_hour": null,
      "seven_day": {
        "utilization": 0.08,
        "resets_at": "2026-08-09T18:26:40.000Z"
      }
    }
  ]
}
"""

@Test func decodesRealAggregatorOutput() throws {
    let snapshot = try JSONDecoder.usageDecoder()
        .decode(UsageSnapshot.self, from: Data(capturedResponse.utf8))

    #expect(snapshot.accounts.count == 2)
    #expect(snapshot.accounts[0].label == "Team · rationallyprime")
    #expect(snapshot.accounts[0].fiveHour?.fraction == 0.423)
    // An account whose session had only produced one window yet.
    #expect(snapshot.accounts[1].fiveHour == nil)
    #expect(snapshot.accounts[1].sevenDay?.fraction == 0.08)
}

/// A historical reset timestamp never licenses the client to invent a current
/// zero; the reading remains the old 42.3% and its age carries the warning.
@Test func pastBoundaryInRealPayloadDoesNotFabricateZero() throws {
    let snapshot = try JSONDecoder.usageDecoder()
        .decode(UsageSnapshot.self, from: Data(capturedResponse.utf8))
    let account = snapshot.accounts[0]
    let now = account.asOf.addingTimeInterval(10 * 60)

    #expect(account.fiveHour?.fraction == 0.423)
    #expect(account.tileState(now: now) == .live(.fresh))
}
