import Foundation
import Testing

@testable import UsageKit

private struct FailingProvider: UsageProvider {
    func fetch() async throws -> UsageSnapshot {
        throw URLError(.notConnectedToInternet)
    }
}

private struct MissingAccessGroupResolver: KeychainAccessGroupResolving {
    func resolveKeychainAccessGroup() -> String? { nil }
}

private func isolatedStore(
    preferences: TestPreferences = TestPreferences(),
    secrets: TestSecretStore = TestSecretStore()
) -> UsageStore {
    UsageStore(preferences: preferences, secretStore: secrets)
}

@Test func unconfiguredStoreNeverReturnsPlausibleDemoData() async {
    let store = isolatedStore()
    let state = await store.refreshConfigured()

    #expect(state == .unconfigured)
    #expect(state.snapshot == nil)
}

@Test func failedRefreshMarksLastGoodSchema3SnapshotAsCached() async {
    let store = isolatedStore()
    let snapshot = UsageSnapshot.sample(now: Date(timeIntervalSince1970: 1_786_100_000))
    store.save(snapshot)

    let state = await store.refresh(using: FailingProvider())

    guard case .cached(let cached, let message) = state else {
        Issue.record("Expected cached state")
        return
    }
    #expect(cached == snapshot)
    #expect(!message.isEmpty)
}

@Test func legacyPreferenceTokenMigratesOnceThenIsDeleted() throws {
    let preferences = TestPreferences()
    preferences.legacyToken = "legacy-read-bearer"
    let secrets = TestSecretStore()
    let store = isolatedStore(preferences: preferences, secrets: secrets)

    #expect(try store.readToken() == "legacy-read-bearer")
    #expect(preferences.legacyToken == nil)
    #expect(preferences.keychainMigrationComplete)
    #expect(secrets.storeCount == 1)

    #expect(try store.readToken() == "legacy-read-bearer")
    #expect(secrets.storeCount == 1)
}

@Test func failedKeychainMigrationPreservesLegacyPreferenceForRetry() {
    let preferences = TestPreferences()
    preferences.legacyToken = "legacy-read-bearer"
    let secrets = TestSecretStore()
    secrets.failStore = true
    let store = isolatedStore(preferences: preferences, secrets: secrets)

    #expect(throws: TestSecretError.self) {
        try store.readToken()
    }
    #expect(preferences.legacyToken == "legacy-read-bearer")
    #expect(!preferences.keychainMigrationComplete)
}

@Test func existingKeychainSecretWinsAndDeletesLegacyCopy() throws {
    let preferences = TestPreferences()
    preferences.legacyToken = "obsolete-preference-copy"
    let secrets = TestSecretStore(value: "keychain-source-of-truth")
    let store = isolatedStore(preferences: preferences, secrets: secrets)

    #expect(try store.readToken() == "keychain-source-of-truth")
    #expect(preferences.legacyToken == nil)
    #expect(secrets.storeCount == 0)
}

@Test func appAndWidgetStoresCanReadOneSharedSecretItem() throws {
    let sharedSecret = TestSecretStore()
    let appStore = isolatedStore(preferences: TestPreferences(), secrets: sharedSecret)
    let widgetStore = isolatedStore(preferences: TestPreferences(), secrets: sharedSecret)

    try appStore.saveToken("shared-keychain-bearer")
    #expect(try widgetStore.readToken() == "shared-keychain-bearer")
}

@Test func sharedStoreFailsVisiblyWhenBundleAccessGroupIsMissing() {
    #expect(throws: UsageStoreConfigurationError.keychainAccessGroupMissing) {
        try UsageStore.shared(accessGroupResolver: MissingAccessGroupResolver())
    }
}

@Test func persistedUnsafeEndpointFailsBeforeTokenResolution() {
    let preferences = TestPreferences()
    preferences.endpointString = "http://not-loopback.example/v3/usage"
    preferences.keychainMigrationComplete = true
    let secrets = TestSecretStore(value: "secret")
    let store = isolatedStore(preferences: preferences, secrets: secrets)

    #expect(throws: UsageProviderError.unsafeEndpoint) {
        try store.resolvedProvider()
    }
    #expect(secrets.readCount == 0)
}

@Test func persistedV1EndpointIsRejectedWithoutCompatibilityOrTokenAccess() {
    let preferences = TestPreferences()
    preferences.endpointString = "https://usage.example/v1/usage"
    preferences.keychainMigrationComplete = true
    let secrets = TestSecretStore(value: "secret")
    let store = isolatedStore(preferences: preferences, secrets: secrets)

    #expect(throws: UsageProviderError.unsafeEndpoint) {
        try store.resolvedProvider()
    }
    #expect(preferences.endpointString == "https://usage.example/v1/usage")
    #expect(secrets.readCount == 0)
}
