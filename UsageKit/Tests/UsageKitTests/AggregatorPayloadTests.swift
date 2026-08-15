import Foundation
import Testing

@testable import UsageKit

/// Contract fixture shared with the schema-3 aggregator implementation. It
/// includes a pool with no current observer to prove the read model preserves
/// last-good quota truth independently of profile bindings.
private let capturedResponse = """
{
  "schema": 3,
  "generated_at": "2026-08-15T18:36:41.754Z",
  "pools": [
    {
      "id": "claude-pool-a",
      "provider": "claude",
      "label": "Claude · Team",
      "identity_state": "provisional",
      "status": "stale",
      "sampled_at": "2026-08-15T16:36:39Z",
      "received_at": "2026-08-15T16:36:44Z",
      "windows": [
        {
          "id": "seven-day",
          "label": "7d",
          "duration_minutes": 10080,
          "utilization": 0.71,
          "resets_at": "2026-08-14T18:26:40Z"
        }
      ],
      "profiles": [
        {
          "id": "old-profile",
          "label": "Former observer",
          "source_host": "edge",
          "last_seen_at": "2026-08-14T12:00:00Z",
          "state": "stale",
          "binding_confidence": "profile_history"
        }
      ]
    }
  ]
}
"""

@Test func decodesAggregatorSchema3Projection() throws {
    let snapshot = try JSONDecoder.usageDecoder()
        .decode(UsageSnapshot.self, from: Data(capturedResponse.utf8))
    let pool = try #require(snapshot.pools.first)

    #expect(snapshot.schema == 3)
    #expect(pool.identityState == .provisional)
    #expect(pool.status == .stale)
    #expect(pool.currentProfiles(now: snapshot.generatedAt).isEmpty)
    #expect(pool.profiles.first?.bindingConfidence == .profileHistory)
    #expect(pool.windows.first?.fraction == 0.71)
}

@Test func passedResetInProjectionNeverFabricatesZero() throws {
    let snapshot = try JSONDecoder.usageDecoder()
        .decode(UsageSnapshot.self, from: Data(capturedResponse.utf8))
    let pool = try #require(snapshot.pools.first)
    let now = pool.sampledAt.addingTimeInterval(10 * 60)

    #expect(pool.windows.first?.fraction == 0.71)
    #expect(pool.tileState(now: now) == .live(.aging))
}
