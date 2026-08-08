import Foundation

/// Deterministic, testable string building. Deliberately not
/// `DateComponentsFormatter`: widget text is size-constrained and we want the
/// exact truncation behaviour pinned by tests.
public enum UsageFormat {
    public static func percent(_ utilization: Double) -> String {
        let clamped = min(max(utilization, 0), 1)
        return "\(Int((clamped * 100).rounded()))%"
    }

    /// "resets in" text for a window boundary, e.g. `3h 5m`, `12m`, `now`.
    public static func countdown(to date: Date, from now: Date) -> String {
        let remaining = date.timeIntervalSince(now)
        guard remaining > 0 else { return "now" }

        let totalMinutes = Int(remaining / 60)
        let days = totalMinutes / (60 * 24)
        if days >= 1 { return "\(days)d \((totalMinutes / 60) % 24)h" }

        let hours = totalMinutes / 60
        let minutes = totalMinutes % 60
        if hours >= 1 { return "\(hours)h \(minutes)m" }
        if totalMinutes >= 1 { return "\(totalMinutes)m" }
        return "<1m"
    }

    /// How old a reading is, e.g. `just now`, `5m ago`, `3h ago`, `2d ago`.
    public static func age(_ interval: TimeInterval) -> String {
        let seconds = Int(max(0, interval))
        if seconds < 60 { return "just now" }

        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m ago" }

        let hours = minutes / 60
        if hours < 24 { return "\(hours)h ago" }

        return "\(hours / 24)d ago"
    }
}
