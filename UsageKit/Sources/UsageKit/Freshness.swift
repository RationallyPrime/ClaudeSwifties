import Foundation

/// How much to trust a number given how long ago the edge read it.
public enum Freshness: Sendable, Equatable {
    case fresh
    case aging
    case stale
}

public struct FreshnessPolicy: Sendable, Equatable {
    public var freshWithin: TimeInterval
    public var agingWithin: TimeInterval

    public init(freshWithin: TimeInterval, agingWithin: TimeInterval) {
        self.freshWithin = freshWithin
        self.agingWithin = agingWithin
    }

    /// Tuned to the phone, which is the slow link: WidgetKit grants roughly
    /// 40-70 timeline refreshes a day, so ~15 minutes is the best a tile can
    /// realistically be regardless of how fast the edges push.
    public static let `default` = FreshnessPolicy(freshWithin: 15 * 60, agingWithin: 60 * 60)
}

/// What a tile should actually render. Collapses the edge-reported status and
/// the locally-computed age into one value, so the view never has to decide
/// whether a stale `.ok` outranks a fresh `.error`.
public enum TileState: Sendable, Equatable {
    case live(Freshness)
    case authExpired
    case error
    case unknown

    public var showsNumbers: Bool {
        switch self {
        case .live: true
        case .authExpired, .error, .unknown: false
        }
    }
}

extension UsageWindow {
    /// True when the window boundary fell between the reading and now.
    ///
    /// This is the one case where a stale number is not merely untrustworthy
    /// but known-obsolete in a specific direction: the window rolled over, so
    /// whatever it said before, it is empty now. Lets an idle tile answer
    /// "have I recovered yet?" — which the statusline ingress cannot, since it
    /// only reports while a session is live.
    public func hasResetSince(_ readingTime: Date, now: Date) -> Bool {
        resetsAt > readingTime && resetsAt <= now
    }

    /// Utilization corrected for a window that has since reset.
    public func effectiveFraction(readingTime: Date, now: Date) -> Double {
        hasResetSince(readingTime, now: now) ? 0 : fraction
    }
}

extension AccountUsage {
    public func age(now: Date) -> TimeInterval {
        max(0, now.timeIntervalSince(asOf))
    }

    /// A stale reading whose windows have all rolled over is effectively
    /// current again, and should be rendered with confidence rather than greyed.
    public func isSupersededByReset(now: Date) -> Bool {
        let windows = [fiveHour, sevenDay].compactMap(\.self)
        guard !windows.isEmpty else { return false }
        return windows.allSatisfy { $0.hasResetSince(asOf, now: now) }
    }

    public func freshness(now: Date, policy: FreshnessPolicy = .default) -> Freshness {
        let age = age(now: now)
        if age <= policy.freshWithin { return .fresh }
        if age <= policy.agingWithin { return .aging }
        return .stale
    }

    public func tileState(now: Date, policy: FreshnessPolicy = .default) -> TileState {
        switch status {
        case .authExpired: .authExpired
        case .error: .error
        case .unknown: .unknown
        case .ok, .stale:
            if status == .ok, isSupersededByReset(now: now) {
                // Old reading, but every window has rolled over since — we know
                // the answer is zero without needing a newer one. Deliberately
                // gated on `.ok`: an edge reporting `.stale` is disclaiming its
                // own data, and that includes the `resets_at` this inference
                // would be computing from.
                .live(.fresh)
            } else if status == .stale {
                // A `.stale` edge report can only ever be worse than the clock
                // says, never better, so take the pessimistic reading of the two.
                .live(max(freshness(now: now, policy: policy), .aging))
            } else {
                .live(freshness(now: now, policy: policy))
            }
        }
    }
}

extension Freshness: Comparable {
    private var severity: Int {
        switch self {
        case .fresh: 0
        case .aging: 1
        case .stale: 2
        }
    }

    public static func < (lhs: Freshness, rhs: Freshness) -> Bool {
        lhs.severity < rhs.severity
    }
}
