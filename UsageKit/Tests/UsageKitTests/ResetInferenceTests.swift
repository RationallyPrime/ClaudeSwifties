import Foundation
import Testing

@testable import UsageKit

private let now = Date(timeIntervalSince1970: 1_786_100_000)

@Test func passedResetNeverFabricatesZeroUsage() {
    let window = UsageWindow(
        id: "five-hour",
        label: "5h",
        durationMinutes: 300,
        utilization: 0.88,
        resetsAt: now.addingTimeInterval(-2 * 3600)
    )
    let pool = testPool(
        sampledAt: now.addingTimeInterval(-9 * 3600),
        windows: [window]
    )

    #expect(pool.windows.first?.fraction == 0.88)
    #expect(pool.tileState(now: now) == .live(.stale))
}

@Test func openWindowKeepsItsReportedNumber() {
    let window = UsageWindow(
        id: "five-hour",
        label: "5h",
        durationMinutes: 300,
        utilization: 0.92,
        resetsAt: now.addingTimeInterval(45 * 60)
    )
    let pool = testPool(
        sampledAt: now.addingTimeInterval(-4 * 3600),
        windows: [window]
    )

    #expect(pool.windows.first?.fraction == 0.92)
    #expect(pool.tileState(now: now) == .live(.stale))
}

@Test func noWindowsStillLeavesPoolVisible() {
    let pool = testPool(
        status: .stale,
        sampledAt: now.addingTimeInterval(-9 * 3600),
        windows: []
    )

    #expect(pool.tileState(now: now) == .live(.stale))
    #expect(pool.windows.isEmpty)
}
