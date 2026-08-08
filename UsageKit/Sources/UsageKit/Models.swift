import Foundation

/// The payload served by the aggregator. Schema 2 adds provider identity and
/// provider-defined windows while retaining decoding support for schema 1.
public struct UsageSnapshot: Codable, Sendable, Equatable {
    public let schema: Int
    public let generatedAt: Date
    public let accounts: [AccountUsage]

    public init(schema: Int = 2, generatedAt: Date, accounts: [AccountUsage]) {
        self.schema = schema
        self.generatedAt = generatedAt
        self.accounts = accounts
    }
}

public enum UsageProviderKind: String, Codable, Sendable, Equatable {
    case claude
    case codex
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = UsageProviderKind(rawValue: raw) ?? .unknown
    }
}

/// One subscription's state, as last reported by the edge that owns its
/// authenticated client. `asOf` is the edge's reading time, not the
/// aggregator's serve time.
public struct AccountUsage: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let label: String
    public let provider: UsageProviderKind
    public let sourceHost: String
    public let asOf: Date
    public let status: AccountStatus
    public let windows: [UsageWindow]

    public init(
        id: String,
        label: String,
        provider: UsageProviderKind = .claude,
        sourceHost: String,
        asOf: Date,
        status: AccountStatus,
        windows: [UsageWindow]
    ) {
        self.id = id
        self.label = label
        self.provider = provider
        self.sourceHost = sourceHost
        self.asOf = asOf
        self.status = status
        self.windows = windows
    }

    /// Compatibility initializer for the original Claude-only contract.
    public init(
        id: String,
        label: String,
        provider: UsageProviderKind = .claude,
        sourceHost: String,
        asOf: Date,
        status: AccountStatus,
        fiveHour: UsageWindow?,
        sevenDay: UsageWindow?
    ) {
        self.init(
            id: id,
            label: label,
            provider: provider,
            sourceHost: sourceHost,
            asOf: asOf,
            status: status,
            windows: [
                fiveHour?.withMetadata(id: "five-hour", label: "5h", durationMinutes: 300),
                sevenDay?.withMetadata(id: "seven-day", label: "7d", durationMinutes: 10_080),
            ].compactMap(\.self)
        )
    }

    public var fiveHour: UsageWindow? {
        windows.first { $0.durationMinutes == 300 || $0.id == "five-hour" }
    }

    public var sevenDay: UsageWindow? {
        windows.first { $0.durationMinutes == 10_080 || $0.id == "seven-day" }
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case label
        case provider
        case sourceHost
        case asOf
        case status
        case windows
        case fiveHour
        case sevenDay
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        label = try container.decode(String.self, forKey: .label)
        provider = try container.decodeIfPresent(UsageProviderKind.self, forKey: .provider) ??
            (id.lowercased().hasPrefix("codex") ? .codex : .claude)
        sourceHost = try container.decode(String.self, forKey: .sourceHost)
        asOf = try container.decode(Date.self, forKey: .asOf)
        status = try container.decode(AccountStatus.self, forKey: .status)

        if let decoded = try container.decodeIfPresent([UsageWindow].self, forKey: .windows) {
            windows = decoded
        } else {
            let fiveHour = try container.decodeIfPresent(UsageWindow.self, forKey: .fiveHour)
            let sevenDay = try container.decodeIfPresent(UsageWindow.self, forKey: .sevenDay)
            windows = [
                fiveHour?.withMetadata(id: "five-hour", label: "5h", durationMinutes: 300),
                sevenDay?.withMetadata(id: "seven-day", label: "7d", durationMinutes: 10_080),
            ].compactMap(\.self)
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(label, forKey: .label)
        try container.encode(provider, forKey: .provider)
        try container.encode(sourceHost, forKey: .sourceHost)
        try container.encode(asOf, forKey: .asOf)
        try container.encode(status, forKey: .status)
        try container.encode(windows, forKey: .windows)

        // Keep old app versions useful while the new server rolls out.
        try container.encodeIfPresent(fiveHour, forKey: .fiveHour)
        try container.encodeIfPresent(sevenDay, forKey: .sevenDay)
    }
}

/// Reported by the edge. `authExpired` means the owning client needs a human
/// sign-in; the collector never refreshes or exports its credentials.
public enum AccountStatus: String, Codable, Sendable {
    case ok
    case stale
    case authExpired = "auth_expired"
    case error
    case unknown

    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AccountStatus(rawValue: raw) ?? .unknown
    }
}

/// One provider-defined quota window. `utilization` is 0...1 on the wire and
/// `resetsAt` may be absent when the provider does not publish a boundary.
public struct UsageWindow: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let label: String
    public let durationMinutes: Int?
    public let utilization: Double
    public let resetsAt: Date?

    public init(
        id: String = "limit",
        label: String = "Limit",
        durationMinutes: Int? = nil,
        utilization: Double,
        resetsAt: Date?
    ) {
        self.id = id
        self.label = label
        self.durationMinutes = durationMinutes
        self.utilization = utilization
        self.resetsAt = resetsAt
    }

    public var fraction: Double { min(max(utilization, 0), 1) }

    fileprivate func withMetadata(id: String, label: String, durationMinutes: Int) -> UsageWindow {
        UsageWindow(
            id: id,
            label: label,
            durationMinutes: durationMinutes,
            utilization: utilization,
            resetsAt: resetsAt
        )
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case label
        case durationMinutes
        case utilization
        case resetsAt
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? "limit"
        durationMinutes = try container.decodeIfPresent(Int.self, forKey: .durationMinutes)
        label = try container.decodeIfPresent(String.self, forKey: .label) ??
            Self.label(for: durationMinutes)
        utilization = try container.decode(Double.self, forKey: .utilization)
        resetsAt = try container.decodeIfPresent(Date.self, forKey: .resetsAt)
    }

    private static func label(for durationMinutes: Int?) -> String {
        guard let durationMinutes else { return "Limit" }
        if durationMinutes == 10_080 { return "7d" }
        if durationMinutes.isMultiple(of: 1_440) { return "\(durationMinutes / 1_440)d" }
        if durationMinutes.isMultiple(of: 60) { return "\(durationMinutes / 60)h" }
        return "\(durationMinutes)m"
    }
}
