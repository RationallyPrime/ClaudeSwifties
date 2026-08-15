import Foundation
import Testing

@testable import UsageKit

private let schema3JSON = """
{
  "schema": 3,
  "generated_at": "2026-08-15T16:00:00Z",
  "pools": [
    {
      "id": "claude-opaque",
      "provider": "claude",
      "label": "Claude · Max 20x",
      "identity_state": "verified",
      "status": "ok",
      "sampled_at": "2026-08-15T15:57:00.125Z",
      "received_at": "2026-08-15T15:57:03Z",
      "windows": [
        {
          "id": "five-hour",
          "label": "5h",
          "duration_minutes": 300,
          "utilization": 0.58,
          "resets_at": "2026-08-15T18:00:00Z"
        }
      ],
      "profiles": [
        {
          "id": "desktop-a",
          "label": "Desktop A",
          "source_host": "linux-host",
          "last_seen_at": "2026-08-15T15:58:00Z",
          "state": "current",
          "binding_confidence": "subject"
        },
        {
          "id": "edge-profile-b",
          "label": "Edge profile B",
          "source_host": "edge-host",
          "last_seen_at": "2026-08-15T15:57:30Z",
          "state": "current",
          "binding_confidence": "window_continuity"
        }
      ]
    },
    {
      "id": "grok-opaque",
      "provider": "grok",
      "label": "Grok Build · SuperGrok",
      "identity_state": "conflict",
      "status": "billing_unavailable",
      "sampled_at": "2026-08-15T15:00:00Z",
      "received_at": "2026-08-15T15:00:05Z",
      "windows": [],
      "profiles": []
    }
  ]
}
"""

@Test func decodesSchema3PoolsAndSharedProfiles() throws {
    let snapshot = try JSONDecoder.usageDecoder()
        .decode(UsageSnapshot.self, from: Data(schema3JSON.utf8))

    #expect(snapshot.schema == 3)
    #expect(snapshot.pools.map(\.id) == ["claude-opaque", "grok-opaque"])

    let claude = try #require(snapshot.pools.first)
    #expect(claude.identityState == .verified)
    #expect(claude.windows.first?.fraction == 0.58)
    #expect(
        claude.currentProfiles(now: snapshot.generatedAt).map(\.label)
            == ["Desktop A", "Edge profile B"]
    )
    #expect(claude.profiles[1].bindingConfidence == .windowContinuity)

    let grok = snapshot.pools[1]
    #expect(grok.provider == .grok)
    #expect(grok.identityState == .conflict)
    #expect(grok.status == .billingUnavailable)
}

@Test func acceptsFractionalAndPlainTimestamps() throws {
    let snapshot = try JSONDecoder.usageDecoder()
        .decode(UsageSnapshot.self, from: Data(schema3JSON.utf8))
    let pool = try #require(snapshot.pools.first)

    #expect(abs(pool.receivedAt.timeIntervalSince(pool.sampledAt) - 2.875) < 0.001)
}

@Test func unknownEnumValuesDegradeOnePoolWithoutBlankingSnapshot() throws {
    let unknown = schema3JSON
        .replacingOccurrences(of: "\"verified\"", with: "\"future_identity\"")
        .replacingOccurrences(of: "\"subject\"", with: "\"future_binding\"")
    let snapshot = try JSONDecoder.usageDecoder().decode(UsageSnapshot.self, from: Data(unknown.utf8))

    #expect(snapshot.pools[0].identityState == .unknown)
    #expect(snapshot.pools[0].profiles[0].bindingConfidence == .unknown)
    #expect(snapshot.pools[1].provider == .grok)
}

@Test func rejectsNonSchema3Projection() {
    let legacy = schema3JSON.replacingOccurrences(of: "\"schema\": 3", with: "\"schema\": 2")
    #expect(throws: DecodingError.self) {
        try JSONDecoder.usageDecoder().decode(UsageSnapshot.self, from: Data(legacy.utf8))
    }
}

@Test func utilizationIsClampedForDisplay() {
    #expect(
        UsageWindow(id: "a", label: "A", utilization: 1.4, resetsAt: .now).fraction == 1.0
    )
    #expect(
        UsageWindow(id: "a", label: "A", utilization: -0.2, resetsAt: .now).fraction == 0.0
    )
}

@Test func roundTripsSchema3WithoutChangingServerOrder() throws {
    let original = UsageSnapshot.sample(now: Date(timeIntervalSince1970: 1_786_100_000))
    let data = try JSONEncoder.usageEncoder().encode(original)
    let restored = try JSONDecoder.usageDecoder().decode(UsageSnapshot.self, from: data)

    #expect(restored == original)
    #expect(restored.pools.map(\.id) == original.pools.map(\.id))
    #expect(restored.pools.last?.provider == .grok)
}
