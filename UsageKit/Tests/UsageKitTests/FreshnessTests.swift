import Foundation
import Testing

@testable import UsageKit

private let now = Date(timeIntervalSince1970: 1_786_100_000)

private func pool(minutesOld: Double, status: PoolStatus = .ok) -> UsagePool {
    testPool(
        status: status,
        sampledAt: now.addingTimeInterval(-minutesOld * 60),
        // A recent server receipt must not disguise an old provider sample.
        receivedAt: now.addingTimeInterval(-30)
    )
}

@Test func freshnessTracksProviderSampleAge() {
    #expect(pool(minutesOld: 2).freshness(now: now) == .fresh)
    #expect(pool(minutesOld: 15).freshness(now: now) == .fresh)
    #expect(pool(minutesOld: 16).freshness(now: now) == .aging)
    #expect(pool(minutesOld: 61).freshness(now: now) == .stale)
}

@Test func recentReceiptDoesNotMakeOldSampleFresh() {
    let stale = pool(minutesOld: 180)
    #expect(stale.receivedAt > stale.sampledAt)
    #expect(stale.tileState(now: now) == .live(.stale))
}

@Test func edgeReportedStaleIsNeverShownAsFresh() {
    #expect(pool(minutesOld: 1, status: .stale).tileState(now: now) == .live(.aging))
}

@Test func degradedPoolKeepsLastGoodNumbersVisible() {
    let authExpired = pool(minutesOld: 20, status: .authExpired)
    #expect(authExpired.tileState(now: now) == .degraded(.aging, .authExpired))
    #expect(authExpired.tileState(now: now).showsNumbers)

    let withoutLastGood = testPool(
        status: .billingUnavailable,
        sampledAt: now,
        windows: []
    )
    #expect(withoutLastGood.tileState(now: now) == .unavailable(.billingUnavailable))
}

@Test func futureTimestampsClampToZeroAge() {
    let future = pool(minutesOld: -30)
    #expect(future.age(now: now) == 0)
    #expect(future.freshness(now: now) == .fresh)
}

@Test func cachedCurrentProfileProgressesToRecentThenStale() {
    let profile = testProfile(now: now, state: .current)

    #expect(profile.effectiveState(now: now.addingTimeInterval(15 * 60)) == .current)
    #expect(profile.effectiveState(now: now.addingTimeInterval(16 * 60)) == .recent)
    #expect(profile.effectiveState(now: now.addingTimeInterval(24 * 60 * 60 + 1)) == .stale)
}

@Test func serverReportedRecentIsNeverPromotedByClientClock() {
    let profile = testProfile(now: now, state: .recent)
    #expect(profile.effectiveState(now: now) == .recent)
}

@Test func countdownFormatting() {
    #expect(UsageFormat.countdown(to: now.addingTimeInterval(185 * 60), from: now) == "3h 5m")
    #expect(UsageFormat.countdown(to: now.addingTimeInterval(12 * 60), from: now) == "12m")
    #expect(UsageFormat.countdown(to: now.addingTimeInterval(30), from: now) == "<1m")
    #expect(UsageFormat.countdown(to: now.addingTimeInterval(-60), from: now) == "now")
    #expect(UsageFormat.countdown(to: now.addingTimeInterval(50 * 3600), from: now) == "2d 2h")
}

@Test func ageFormatting() {
    #expect(UsageFormat.age(30) == "just now")
    #expect(UsageFormat.age(5 * 60) == "5m ago")
    #expect(UsageFormat.age(3 * 3600) == "3h ago")
    #expect(UsageFormat.age(50 * 3600) == "2d ago")
}

@Test func percentFormatting() {
    #expect(UsageFormat.percent(0.42) == "42%")
    #expect(UsageFormat.percent(0.005) == "1%")
    #expect(UsageFormat.percent(1.4) == "100%")
}
