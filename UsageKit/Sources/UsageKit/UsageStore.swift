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

public protocol KeychainAccessGroupResolving: Sendable {
    func resolveKeychainAccessGroup() -> String?
}

public struct BundleKeychainAccessGroupResolver: KeychainAccessGroupResolving {
    public let key: String

    public init(key: String = "UsageKeychainAccessGroup") {
        self.key = key
    }

    public func resolveKeychainAccessGroup() -> String? {
        Bundle.main.object(forInfoDictionaryKey: key) as? String
    }
}

public enum UsageStoreConfigurationError: Error, Equatable, LocalizedError {
    case appGroupUnavailable
    case keychainAccessGroupMissing

    public var errorDescription: String? {
        switch self {
        case .appGroupUnavailable:
            "The shared App Group is unavailable. Check signing entitlements for the app and widget."
        case .keychainAccessGroupMissing:
            "The shared Keychain access group is missing from this target's Info.plist."
        }
    }
}

/// Endpoint and snapshot remain in App Group preferences. The bearer is held
/// by a separately injected secret store so preference and Keychain behavior
/// can be tested without touching process-global storage.
public struct UsageStore: Sendable {
    private let preferences: any UsagePreferences
    private let secrets: any UsageSecretStoring

    public static let defaultAppGroup = "group.is.sokrates.claudeswifties"

    public init(preferences: any UsagePreferences, secretStore: any UsageSecretStoring) {
        self.preferences = preferences
        secrets = secretStore
    }

    public init(defaults: UserDefaults, secretStore: any UsageSecretStoring) {
        self.init(
            preferences: UserDefaultsUsagePreferences(defaults: defaults),
            secretStore: secretStore
        )
    }

    public init?(
        appGroup: String,
        keychainAccessGroup: String
    ) {
        guard let preferences = UserDefaultsUsagePreferences(appGroup: appGroup) else { return nil }
        self.init(
            preferences: preferences,
            secretStore: KeychainSecretStore(accessGroup: keychainAccessGroup)
        )
    }

    public var endpoint: URL? {
        get { preferences.endpointString.flatMap(URL.init(string:)) }
        nonmutating set { preferences.endpointString = newValue?.absoluteString }
    }

    public func readToken() throws -> String? {
        try migrateLegacyTokenIfNeeded()
        return try secrets.readSecret()
    }

    public func saveToken(_ token: String?) throws {
        if let token, !token.isEmpty {
            try secrets.storeSecret(token)
        } else {
            try secrets.deleteSecret()
        }
        // A successful Keychain mutation establishes the new source of truth.
        preferences.legacyToken = nil
        preferences.keychainMigrationComplete = true
    }

    /// Idempotent, retryable migration. The legacy preference is deleted only
    /// after an existing Keychain item is observed or a new one is stored.
    /// Any Keychain failure leaves the preference and marker untouched.
    public func migrateLegacyTokenIfNeeded() throws {
        if preferences.keychainMigrationComplete {
            preferences.legacyToken = nil
            return
        }

        if let existing = try secrets.readSecret(), !existing.isEmpty {
            preferences.legacyToken = nil
            preferences.keychainMigrationComplete = true
            return
        }

        guard let legacy = preferences.legacyToken, !legacy.isEmpty else {
            preferences.legacyToken = nil
            preferences.keychainMigrationComplete = true
            return
        }

        try secrets.storeSecret(legacy)
        preferences.legacyToken = nil
        preferences.keychainMigrationComplete = true
    }

    public func loadCached() -> UsageSnapshot? {
        guard let data = preferences.cachedSnapshotData else { return nil }
        return try? JSONDecoder.usageDecoder().decode(UsageSnapshot.self, from: data)
    }

    public func save(_ snapshot: UsageSnapshot) {
        preferences.cachedSnapshotData = try? JSONEncoder.usageEncoder().encode(snapshot)
    }

    /// Resolves the build-setting-expanded group from the running target. No
    /// team prefix is compiled into UsageKit, so alternate signing teams query
    /// the exact group their entitlements grant.
    public static func shared(
        accessGroupResolver: any KeychainAccessGroupResolving =
            BundleKeychainAccessGroupResolver()
    ) throws -> UsageStore {
        guard let accessGroup = accessGroupResolver.resolveKeychainAccessGroup(),
            !accessGroup.isEmpty,
            !accessGroup.contains("$(")
        else { throw UsageStoreConfigurationError.keychainAccessGroupMissing }

        guard let store = UsageStore(
            appGroup: defaultAppGroup,
            keychainAccessGroup: accessGroup
        ) else { throw UsageStoreConfigurationError.appGroupUnavailable }
        return store
    }

    public func resolvedProvider() throws -> (any UsageProvider)? {
        guard let endpoint else { return nil }
        guard UsageEndpointPolicy().allows(endpoint) else {
            throw UsageProviderError.unsafeEndpoint
        }
        return HTTPUsageProvider(endpoint: endpoint, bearerToken: try readToken())
    }

    public func refreshConfigured() async -> UsageRefreshState {
        do {
            // Migrate even when the endpoint was removed: a first schema-3
            // launch must not leave a bearer behind in shared preferences.
            try migrateLegacyTokenIfNeeded()
            guard let provider = try resolvedProvider() else { return .unconfigured }
            return await refresh(using: provider)
        } catch {
            return failureState(for: error)
        }
    }

    /// Fetches and caches a current snapshot. A network failure can use the
    /// last good value, but the result keeps that distinction visible.
    public func refresh(using provider: any UsageProvider) async -> UsageRefreshState {
        do {
            let snapshot = try await provider.fetch()
            save(snapshot)
            return .live(snapshot)
        } catch {
            return failureState(for: error)
        }
    }

    private func failureState(for error: any Error) -> UsageRefreshState {
        let message = Self.message(for: error)
        if let cached = loadCached() {
            return .cached(cached, message: message)
        }
        return .failed(message: message)
    }

    private static func message(for error: any Error) -> String {
        if let providerError = error as? UsageProviderError {
            switch providerError {
            case .badStatus(let status): return "Server returned HTTP \(status)."
            case .notHTTP: return "The endpoint did not return an HTTP response."
            case .unsafeEndpoint:
                return "The endpoint must be the HTTPS /v3/usage URL (except loopback development)."
            case .unsafeRedirect: return "The endpoint attempted an unsafe cross-origin redirect."
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
