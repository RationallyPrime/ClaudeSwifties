import Foundation
import Testing

@testable import UsageKit

private let now = Date(timeIntervalSince1970: 1_786_100_000)

private func snapshot(count: Int) -> UsageSnapshot {
    UsageSnapshot(
        generatedAt: now,
        pools: (0..<count).map { index in
            testPool(
                id: "server-position-\(index)",
                provider: index < 3 ? .claude : (index == 3 ? .codex : .grok),
                sampledAt: now
            )
        }
    )
}

@Test func mediumCapacityIncludesExpectedFiveInServerOrder() {
    let source = snapshot(count: 9)
    let selected = UsagePoolSelection.pools(
        from: source,
        capacity: UsagePoolSelection.mediumCapacity
    )

    #expect(selected.count == 5)
    #expect(selected.prefix(3).allSatisfy { $0.provider == .claude })
    #expect(selected.map(\.id) == Array(source.pools.prefix(5)).map(\.id))
}

@Test func largeCapacityRendersAtLeastEightWithoutLexicalSorting() {
    let source = snapshot(count: 9)
    let selected = UsagePoolSelection.pools(
        from: source,
        capacity: UsagePoolSelection.largeCapacity
    )

    #expect(UsagePoolSelection.largeCapacity >= 8)
    #expect(selected.count == 8)
    #expect(selected.map(\.id) == Array(source.pools.prefix(8)).map(\.id))
}

@Test func hostSelectionHasNoCapacityAndReturnsEveryPool() {
    let source = snapshot(count: 11)
    #expect(UsagePoolSelection.pools(from: source).map(\.id) == source.pools.map(\.id))
}

@Test func poolExposesBothCurrentProfilesWithoutCollapsingThem() {
    let profiles = [
        testProfile(id: "desktop-a", label: "Desktop A", now: now),
        testProfile(id: "edge-profile-b", label: "Edge profile B", now: now),
        testProfile(id: "old", label: "Old observer", now: now, state: .recent),
    ]
    let pool = testPool(sampledAt: now, profiles: profiles)

    #expect(pool.currentProfiles(now: now).map(\.label) == ["Desktop A", "Edge profile B"])
}
