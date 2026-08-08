import Foundation
import Testing

@testable import UsageKit

private let now = Date(timeIntervalSince1970: 1_786_100_000)

private func account(
    minutesOld: Double,
    status: AccountStatus = .ok
) -> AccountUsage {
    AccountUsage(
        id: "test",
        label: "Test",
        sourceHost: "edge",
        asOf: now.addingTimeInterval(-minutesOld * 60),
        status: status,
        // Deliberately still open, so these cases exercise age handling alone
        // and never trip the window-reset inference.
        fiveHour: UsageWindow(utilization: 0.5, resetsAt: now.addingTimeInterval(3600)),
        sevenDay: nil
    )
}

@Test func freshnessTracksAge() {
    #expect(account(minutesOld: 2).freshness(now: now) == .fresh)
    #expect(account(minutesOld: 15).freshness(now: now) == .fresh)
    #expect(account(minutesOld: 16).freshness(now: now) == .aging)
    #expect(account(minutesOld: 61).freshness(now: now) == .stale)
}

/// The edge saying "stale" outranks a clock that merely looks recent — the edge
/// knows things the timestamp doesn't.
@Test func edgeReportedStaleIsNeverShownAsFresh() {
    let recentButFlagged = account(minutesOld: 1, status: .stale)
    #expect(recentButFlagged.tileState(now: now) == .live(.aging))
}

@Test func authExpiredHidesNumbers() {
    let expired = account(minutesOld: 1, status: .authExpired)
    #expect(expired.tileState(now: now) == .authExpired)
    #expect(expired.tileState(now: now).showsNumbers == false)
    #expect(account(minutesOld: 1).tileState(now: now).showsNumbers == true)
}

/// Clock skew between an edge and the phone must not produce negative ages.
@Test func futureTimestampsClampToZeroAge() {
    #expect(account(minutesOld: -30).age(now: now) == 0)
    #expect(account(minutesOld: -30).freshness(now: now) == .fresh)
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
