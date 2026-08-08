import Foundation

/// Shared state between the app and the widget extension, which are separate
/// processes and can only talk through an App Group container.
///
/// The cached snapshot matters more here than in most widgets: the aggregator
/// lives on a tailnet, so a phone with the VPN off cannot reach it at all. In
/// that state the widget must show the last good reading with an honest age
/// rather than an error.
public struct UsageStore: Sendable {
    // `UserDefaults` is documented as thread-safe but predates `Sendable`, so
    // the compiler can't see it. The store crosses an async boundary in
    // `refresh(using:)`, which is what makes the conformance necessary.
    nonisolated(unsafe) private let defaults: UserDefaults

    private enum Key {
        static let snapshot = "usage.snapshot"
        static let endpoint = "usage.endpoint"
        static let token = "usage.token"
    }

    public init?(appGroup: String) {
        guard let defaults = UserDefaults(suiteName: appGroup) else { return nil }
        self.defaults = defaults
    }

    public init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    public var endpoint: URL? {
        get { defaults.string(forKey: Key.endpoint).flatMap(URL.init(string:)) }
        nonmutating set { defaults.set(newValue?.absoluteString, forKey: Key.endpoint) }
    }

    /// Not a credential store. This is a bearer token for the user's own
    /// tailnet-local aggregator; anything sensitive belongs in the Keychain.
    public var token: String? {
        get { defaults.string(forKey: Key.token) }
        nonmutating set { defaults.set(newValue, forKey: Key.token) }
    }

    public func loadCached() -> UsageSnapshot? {
        guard let data = defaults.data(forKey: Key.snapshot) else { return nil }
        return try? JSONDecoder.usageDecoder().decode(UsageSnapshot.self, from: data)
    }

    public func save(_ snapshot: UsageSnapshot) {
        guard let data = try? JSONEncoder.usageEncoder().encode(snapshot) else { return }
        defaults.set(data, forKey: Key.snapshot)
    }

    /// The App Group shared by the host app and the widget extension. Both
    /// resolve their store and provider through here so they cannot disagree
    /// about where the endpoint or the cache lives.
    public static let defaultAppGroup = "group.is.sokrates.claudeswifties"

    /// Falls back to standard defaults when the App Group entitlement isn't
    /// configured yet, so the app runs before provisioning is sorted out.
    public static func shared() -> UsageStore {
        UsageStore(appGroup: defaultAppGroup) ?? UsageStore(defaults: .standard)
    }

    /// The mock stands in until an aggregator endpoint is configured, which is
    /// what lets the UI be developed before any of the backend exists.
    public func resolvedProvider() -> any UsageProvider {
        guard let endpoint else { return MockUsageProvider() }
        return HTTPUsageProvider(endpoint: endpoint, bearerToken: token)
    }

    /// Fetches and caches, falling back to the last good snapshot. Returns nil
    /// only when the network failed *and* nothing was ever cached.
    public func refresh(using provider: any UsageProvider) async -> UsageSnapshot? {
        do {
            let snapshot = try await provider.fetch()
            save(snapshot)
            return snapshot
        } catch {
            return loadCached()
        }
    }
}
