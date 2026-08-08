import Foundation
import Testing

@testable import UsageKit

private struct FailingProvider: UsageProvider {
    func fetch() async throws -> UsageSnapshot {
        throw URLError(.notConnectedToInternet)
    }
}

private func isolatedStore() -> UsageStore {
    let name = "UsageStoreTests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defaults.removePersistentDomain(forName: name)
    return UsageStore(defaults: defaults)
}

@Test func unconfiguredStoreNeverReturnsPlausibleDemoData() async {
    let store = isolatedStore()
    let state = await store.refreshConfigured()

    #expect(state == .unconfigured)
    #expect(state.snapshot == nil)
}

@Test func failedRefreshMarksLastGoodSnapshotAsCached() async {
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
