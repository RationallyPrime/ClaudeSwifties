import Foundation
import Testing

@testable import UsageKit

private let now = Date(timeIntervalSince1970: 1_786_100_000)

/// The statusline ingress only reports while a session is live, so idle tiles
/// go stale by design. These cover the cases where a stale reading is still
/// answerable without a fresh one.
@Test func windowThatRolledOverReadsAsEmpty() {
    let reading = now.addingTimeInterval(-4 * 3600)
    let window = UsageWindow(utilization: 0.92, resetsAt: now.addingTimeInterval(-30 * 60))

    #expect(window.hasResetSince(reading, now: now))
    #expect(window.effectiveFraction(readingTime: reading, now: now) == 0)
}

@Test func windowStillOpenKeepsItsNumber() {
    let reading = now.addingTimeInterval(-4 * 3600)
    let window = UsageWindow(utilization: 0.92, resetsAt: now.addingTimeInterval(45 * 60))

    #expect(window.hasResetSince(reading, now: now) == false)
    #expect(window.effectiveFraction(readingTime: reading, now: now) == 0.92)
}

/// A boundary that had already passed when the reading was taken tells us
/// nothing — it belongs to a window the reading already accounted for.
@Test func boundaryBeforeTheReadingIsNotAReset() {
    let reading = now.addingTimeInterval(-60 * 60)
    let window = UsageWindow(utilization: 0.5, resetsAt: now.addingTimeInterval(-90 * 60))

    #expect(window.hasResetSince(reading, now: now) == false)
}

@Test func staleAccountWithAllWindowsResetRendersAsFresh() {
    let account = AccountUsage(
        id: "rp-max-20x",
        label: "Max 20x",
        sourceHost: "linux-laptop",
        asOf: now.addingTimeInterval(-9 * 3600),
        status: .ok,
        fiveHour: UsageWindow(utilization: 0.88, resetsAt: now.addingTimeInterval(-2 * 3600)),
        sevenDay: UsageWindow(utilization: 0.64, resetsAt: now.addingTimeInterval(-1 * 3600))
    )

    #expect(account.freshness(now: now) == .stale)
    #expect(account.isSupersededByReset(now: now))
    #expect(account.tileState(now: now) == .live(.fresh))
}

/// Partial rollover is not rollover: the seven-day window still carries a real
/// number, so the tile must stay honest about its age.
@Test func partialResetStaysStale() {
    let account = AccountUsage(
        id: "rp-max-20x",
        label: "Max 20x",
        sourceHost: "linux-laptop",
        asOf: now.addingTimeInterval(-9 * 3600),
        status: .ok,
        fiveHour: UsageWindow(utilization: 0.88, resetsAt: now.addingTimeInterval(-2 * 3600)),
        sevenDay: UsageWindow(utilization: 0.64, resetsAt: now.addingTimeInterval(20 * 3600))
    )

    #expect(account.isSupersededByReset(now: now) == false)
    #expect(account.tileState(now: now) == .live(.stale))
}

/// An account with no windows at all (auth expired, say) must not be claimed as
/// reset just because `allSatisfy` is vacuously true on an empty collection.
@Test func noWindowsIsNotAReset() {
    let account = AccountUsage(
        id: "rp-team",
        label: "Team",
        sourceHost: "hetzner-cx53",
        asOf: now.addingTimeInterval(-9 * 3600),
        status: .ok,
        fiveHour: nil,
        sevenDay: nil
    )

    #expect(account.isSupersededByReset(now: now) == false)
    #expect(account.tileState(now: now) == .live(.stale))
}
