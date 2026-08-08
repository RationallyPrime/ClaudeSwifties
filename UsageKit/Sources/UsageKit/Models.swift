import Foundation

/// The payload served by the aggregator (timaeus). Both the widget and the
/// edge pollers are written against this shape; it is the only contract
/// between them.
public struct UsageSnapshot: Codable, Sendable, Equatable {
    public let schema: Int
    public let generatedAt: Date
    public let accounts: [AccountUsage]

    public init(schema: Int = 1, generatedAt: Date, accounts: [AccountUsage]) {
        self.schema = schema
        self.generatedAt = generatedAt
        self.accounts = accounts
    }
}

/// One subscription's state, as last reported by the edge that owns its
/// credential. `asOf` is the edge's reading time, not the aggregator's serve
/// time — the gap between the two is exactly the staleness the widget shows.
public struct AccountUsage: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let label: String
    public let sourceHost: String
    public let asOf: Date
    public let status: AccountStatus
    public let fiveHour: UsageWindow?
    public let sevenDay: UsageWindow?

    public init(
        id: String,
        label: String,
        sourceHost: String,
        asOf: Date,
        status: AccountStatus,
        fiveHour: UsageWindow?,
        sevenDay: UsageWindow?
    ) {
        self.id = id
        self.label = label
        self.sourceHost = sourceHost
        self.asOf = asOf
        self.status = status
        self.fiveHour = fiveHour
        self.sevenDay = sevenDay
    }
}

/// Reported by the edge. `authExpired` specifically means the poller saw a 401
/// and declined to refresh — refreshing is the owning client's job, never ours.
public enum AccountStatus: String, Codable, Sendable {
    case ok
    case stale
    case authExpired = "auth_expired"
    case error
    case unknown

    /// Unrecognised values decode to `.unknown` rather than throwing, so a
    /// server-side schema addition degrades a single tile instead of blanking
    /// the whole widget.
    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AccountStatus(rawValue: raw) ?? .unknown
    }
}

/// A single rate-limit window. `utilization` is 0...1 as served; callers should
/// read `fraction` rather than the raw value, which clamps defensively.
public struct UsageWindow: Codable, Sendable, Equatable {
    public let utilization: Double
    public let resetsAt: Date

    public init(utilization: Double, resetsAt: Date) {
        self.utilization = utilization
        self.resetsAt = resetsAt
    }

    public var fraction: Double { min(max(utilization, 0), 1) }
}
