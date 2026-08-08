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

    /// The widget asks for a refresh every 15 minutes, though WidgetKit remains
    /// free to coalesce that schedule. Older readings stay visible but dim.
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

extension AccountUsage {
    public func age(now: Date) -> TimeInterval {
        max(0, now.timeIntervalSince(asOf))
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
            if status == .stale {
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
