import Foundation
import Security

public protocol UsageSecretStoring: Sendable {
    func readSecret() throws -> String?
    func storeSecret(_ secret: String) throws
    func deleteSecret() throws
}

public struct KeychainSecretStoreError: Error, Equatable, LocalizedError {
    public let status: OSStatus

    public init(status: OSStatus) {
        self.status = status
    }

    public var errorDescription: String? {
        "The shared Keychain item is unavailable (Security status \(status))."
    }
}

/// A non-synchronizing shared Keychain item. The app and extension both carry
/// the matching access-group entitlement. After-first-unlock accessibility
/// lets WidgetKit refresh after a reboot without making the bearer syncable.
public struct KeychainSecretStore: UsageSecretStoring {
    public let service: String
    public let account: String
    public let accessGroup: String?

    public init(
        service: String = "is.sokrates.ClaudeSwifties.usage",
        account: String = "read-bearer",
        accessGroup: String?
    ) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
    }

    public func readSecret() throws -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainSecretStoreError(status: status) }
        guard let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            throw KeychainSecretStoreError(status: errSecDecode)
        }
        return value
    }

    public func storeSecret(_ secret: String) throws {
        let data = Data(secret.utf8)
        let update: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw KeychainSecretStoreError(status: updateStatus)
        }

        var addition = baseQuery
        update.forEach { addition[$0.key] = $0.value }
        let addStatus = SecItemAdd(addition as CFDictionary, nil)
        if addStatus == errSecDuplicateItem {
            let retryStatus = SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary)
            guard retryStatus == errSecSuccess else {
                throw KeychainSecretStoreError(status: retryStatus)
            }
            return
        }
        guard addStatus == errSecSuccess else { throw KeychainSecretStoreError(status: addStatus) }
    }

    public func deleteSecret() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainSecretStoreError(status: status)
        }
    }

    /// The data-protection keychain is required on macOS for access groups and
    /// `kSecAttrAccessible` to have the same semantics as iOS. Kept internal
    /// so the complete query policy can be falsified without writing a secret.
    var baseQuery: [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false,
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }
}

/// Semantic preferences protocol keeps App Group behavior independently
/// testable without exposing generic preference keys throughout UsageStore.
public protocol UsagePreferences: AnyObject, Sendable {
    var endpointString: String? { get set }
    var cachedSnapshotData: Data? { get set }
    var legacyToken: String? { get set }
    var keychainMigrationComplete: Bool { get set }
}

public final class UserDefaultsUsagePreferences: UsagePreferences, @unchecked Sendable {
    private let defaults: UserDefaults

    private enum Key {
        static let snapshot = "usage.snapshot"
        static let endpoint = "usage.endpoint"
        static let legacyToken = "usage.token"
        static let migrationComplete = "usage.token.keychainMigrationComplete"
    }

    public init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    public convenience init?(appGroup: String) {
        #if os(iOS) || os(macOS)
        guard FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroup
        ) != nil else { return nil }
        #endif
        guard let defaults = UserDefaults(suiteName: appGroup) else { return nil }
        self.init(defaults: defaults)
    }

    public var endpointString: String? {
        get { defaults.string(forKey: Key.endpoint) }
        set { defaults.set(newValue, forKey: Key.endpoint) }
    }

    public var cachedSnapshotData: Data? {
        get { defaults.data(forKey: Key.snapshot) }
        set { defaults.set(newValue, forKey: Key.snapshot) }
    }

    public var legacyToken: String? {
        get { defaults.string(forKey: Key.legacyToken) }
        set { defaults.set(newValue, forKey: Key.legacyToken) }
    }

    public var keychainMigrationComplete: Bool {
        get { defaults.bool(forKey: Key.migrationComplete) }
        set { defaults.set(newValue, forKey: Key.migrationComplete) }
    }
}
