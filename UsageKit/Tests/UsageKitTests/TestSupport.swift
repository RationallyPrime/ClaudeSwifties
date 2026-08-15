import Foundation

@testable import UsageKit

final class TestPreferences: UsagePreferences, @unchecked Sendable {
    var endpointString: String?
    var cachedSnapshotData: Data?
    var legacyToken: String?
    var keychainMigrationComplete = false
}

enum TestSecretError: Error {
    case unavailable
}

final class TestSecretStore: UsageSecretStoring, @unchecked Sendable {
    var value: String?
    var readCount = 0
    var storeCount = 0
    var deleteCount = 0
    var failRead = false
    var failStore = false

    init(value: String? = nil) {
        self.value = value
    }

    func readSecret() throws -> String? {
        readCount += 1
        if failRead { throw TestSecretError.unavailable }
        return value
    }

    func storeSecret(_ secret: String) throws {
        storeCount += 1
        if failStore { throw TestSecretError.unavailable }
        value = secret
    }

    func deleteSecret() throws {
        deleteCount += 1
        value = nil
    }
}

func testProfile(
    id: String = "profile",
    label: String = "Profile · Host",
    now: Date,
    state: ObserverProfileState = .current,
    confidence: BindingConfidence = .subject
) -> ObserverProfile {
    ObserverProfile(
        id: id,
        label: label,
        sourceHost: "host",
        lastSeenAt: now,
        state: state,
        bindingConfidence: confidence
    )
}

func testPool(
    id: String = "pool",
    provider: UsageProviderKind = .claude,
    identityState: PoolIdentityState = .verified,
    status: PoolStatus = .ok,
    sampledAt: Date,
    receivedAt: Date? = nil,
    windows: [UsageWindow]? = nil,
    profiles: [ObserverProfile] = []
) -> UsagePool {
    UsagePool(
        id: id,
        provider: provider,
        label: "Pool \(id)",
        identityState: identityState,
        status: status,
        sampledAt: sampledAt,
        receivedAt: receivedAt ?? sampledAt,
        windows: windows ?? [
            UsageWindow(
                id: "five-hour",
                label: "5h",
                durationMinutes: 300,
                utilization: 0.5,
                resetsAt: sampledAt.addingTimeInterval(3600)
            )
        ],
        profiles: profiles
    )
}
