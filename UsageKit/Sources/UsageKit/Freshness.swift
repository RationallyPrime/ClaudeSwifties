import Foundation

/// How much to trust a number given how long ago the provider sampled it.
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

    public static let `default` = FreshnessPolicy(freshWithin: 15 * 60, agingWithin: 60 * 60)
}

public struct ProfileActivityPolicy: Sendable, Equatable {
    public var currentWithin: TimeInterval
    public var recentWithin: TimeInterval

    public init(currentWithin: TimeInterval, recentWithin: TimeInterval) {
        self.currentWithin = currentWithin
        self.recentWithin = recentWithin
    }

    public static let `default` = ProfileActivityPolicy(
        currentWithin: 15 * 60,
        recentWithin: 24 * 60 * 60
    )
}

/// A pool can be degraded while retaining a trustworthy last-good reading.
/// The UI therefore separates availability from whether numbers may render.
public enum PoolTileState: Sendable, Equatable {
    case live(Freshness)
    case degraded(Freshness, PoolStatus)
    case unavailable(PoolStatus)

    public var showsNumbers: Bool {
        switch self {
        case .live, .degraded: true
        case .unavailable: false
        }
    }

    public var freshness: Freshness? {
        switch self {
        case .live(let freshness), .degraded(let freshness, _): freshness
        case .unavailable: nil
        }
    }
}

extension UsagePool {
    /// Honest age uses provider sample time. Server receipt and snapshot
    /// generation times do not make an old terminal reading fresh again.
    public func age(now: Date) -> TimeInterval {
        max(0, now.timeIntervalSince(sampledAt))
    }

    public func freshness(now: Date, policy: FreshnessPolicy = .default) -> Freshness {
        let age = age(now: now)
        if age <= policy.freshWithin { return .fresh }
        if age <= policy.agingWithin { return .aging }
        return .stale
    }

    public func tileState(now: Date, policy: FreshnessPolicy = .default) -> PoolTileState {
        let clockFreshness = freshness(now: now, policy: policy)
        switch status {
        case .ok:
            return .live(clockFreshness)
        case .stale:
            return .live(max(clockFreshness, .aging))
        case .authExpired, .billingUnavailable, .error, .unknown:
            guard !windows.isEmpty else { return .unavailable(status) }
            return .degraded(max(clockFreshness, .aging), status)
        }
    }
}

extension ObserverProfile {
    /// A cached snapshot cannot keep a profile "current" forever. The client
    /// advances server state pessimistically from the heartbeat timestamp.
    public func effectiveState(
        now: Date,
        policy: ProfileActivityPolicy = .default
    ) -> ObserverProfileState {
        let age = max(0, now.timeIntervalSince(lastSeenAt))
        let clockState: ObserverProfileState
        if age <= policy.currentWithin {
            clockState = .current
        } else if age <= policy.recentWithin {
            clockState = .recent
        } else {
            clockState = .stale
        }

        switch state {
        case .current: return clockState
        case .recent: return clockState == .stale ? .stale : .recent
        case .stale: return .stale
        case .unknown: return .unknown
        }
    }
}

extension UsagePool {
    /// Server order is preserved while cached heartbeat state progresses.
    public func currentProfiles(now: Date) -> [ObserverProfile] {
        profiles.filter { $0.effectiveState(now: now) == .current }
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
