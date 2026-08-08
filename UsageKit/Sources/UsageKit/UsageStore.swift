import Foundation

public enum UsageRefreshState: Sendable, Equatable {
    case unconfigured
    case live(UsageSnapshot)
    case cached(UsageSnapshot, message: String)
    case failed(message: String)

    public var snapshot: UsageSnapshot? {
        switch self {
        case .live(let snapshot), .cached(let snapshot, _): snapshot
        case .unconfigured, .failed: nil
        }
    }
}

/// Shared state between the host app and widget extension. The App Group is a
/// functional requirement: silently falling back to per-process defaults makes
/// the host appear configured while the widget remains empty.
public struct UsageStore: Sendable {
    nonisolated(unsafe) private let defaults: UserDefaults

    private enum Key {
        static let snapshot = "usage.snapshot"
        static let endpoint = "usage.endpoint"
        static let token = "usage.token"
    }

    public init?(appGroup: String) {
        #if os(iOS) || os(macOS)
        guard FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroup
        ) != nil else { return nil }
        #endif
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

    /// A secret for the read-only usage feed. It lives in the sandboxed App
    /// Group because the widget process must be able to read it too.
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

    public static let defaultAppGroup = "group.is.sokrates.claudeswifties"

    /// Returns nil when the signed target lacks the App Group entitlement. The
    /// UI can then report the signing problem instead of showing demo data.
    public static func shared() -> UsageStore? {
        UsageStore(appGroup: defaultAppGroup)
    }

    public func resolvedProvider() -> (any UsageProvider)? {
        guard let endpoint else { return nil }
        return HTTPUsageProvider(endpoint: endpoint, bearerToken: token)
    }

    public func refreshConfigured() async -> UsageRefreshState {
        guard let provider = resolvedProvider() else { return .unconfigured }
        return await refresh(using: provider)
    }

    /// Fetches and caches a current snapshot. A network failure can use the
    /// last good value, but the result keeps that distinction visible to the
    /// host app and to tests.
    public func refresh(using provider: any UsageProvider) async -> UsageRefreshState {
        do {
            let snapshot = try await provider.fetch()
            save(snapshot)
            return .live(snapshot)
        } catch {
            let message = Self.message(for: error)
            if let cached = loadCached() {
                return .cached(cached, message: message)
            }
            return .failed(message: message)
        }
    }

    private static func message(for error: any Error) -> String {
        if let providerError = error as? UsageProviderError {
            switch providerError {
            case .badStatus(let status): return "Server returned HTTP \(status)."
            case .notHTTP: return "The endpoint did not return an HTTP response."
            }
        }
        if let urlError = error as? URLError {
            return urlError.localizedDescription
        }
        if error is DecodingError {
            return "The server returned an unsupported usage payload."
        }
        return error.localizedDescription
    }
}
