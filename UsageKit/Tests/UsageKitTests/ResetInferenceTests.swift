import Foundation
import Testing

@testable import UsageKit

private let now = Date(timeIntervalSince1970: 1_786_100_000)

/// A passed reset boundary says the old sample is obsolete; it does not prove
/// that no use occurred in the new window.
@Test func passedResetNeverFabricatesZeroUsage() {
    let account = AccountUsage(
        id: "claude-max",
        label: "Claude Max",
        sourceHost: "laptop",
        asOf: now.addingTimeInterval(-9 * 3600),
        status: .ok,
        fiveHour: UsageWindow(utilization: 0.88, resetsAt: now.addingTimeInterval(-2 * 3600)),
        sevenDay: UsageWindow(utilization: 0.64, resetsAt: now.addingTimeInterval(-1 * 3600))
    )

    #expect(account.fiveHour?.fraction == 0.88)
    #expect(account.sevenDay?.fraction == 0.64)
    #expect(account.tileState(now: now) == .live(.stale))
}
@Test func openWindowKeepsItsReportedNumber() {
    let account = AccountUsage(
        id: "claude-max",
        label: "Claude Max",
        sourceHost: "laptop",
        asOf: now.addingTimeInterval(-4 * 3600),
        status: .ok,
        fiveHour: UsageWindow(utilization: 0.92, resetsAt: now.addingTimeInterval(45 * 60)),
        sevenDay: nil
    )

    #expect(account.fiveHour?.fraction == 0.92)
    #expect(account.tileState(now: now) == .live(.stale))
}

@Test func noWindowsIsStillAVisibleStaleAccount() {
    let account = AccountUsage(
        id: "claude-team",
        label: "Team",
        sourceHost: "edge",
        asOf: now.addingTimeInterval(-9 * 3600),
        status: .ok,
        windows: []
    )

    #expect(account.tileState(now: now) == .live(.stale))
}
