import Foundation
import Security
import Testing

@testable import UsageKit

private struct StubTransport: UsageHTTPTransport {
    let data: Data
    let response: URLResponse

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        (data, response)
    }
}

private actor RecordingTransport: UsageHTTPTransport {
    private(set) var wasCalled = false

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        wasCalled = true
        throw URLError(.badURL)
    }
}

@Test func ephemeralSessionHasNoCookieCredentialOrDiskCacheStores() {
    let configuration = UsageSessionConfiguration.ephemeral()

    #expect(configuration.identifier == nil)
    #expect(configuration.urlCache == nil)
    #expect(configuration.httpCookieStorage == nil)
    #expect(configuration.httpShouldSetCookies == false)
    #expect(configuration.httpCookieAcceptPolicy == .never)
    #expect(configuration.urlCredentialStorage == nil)
}

@Test func redirectPolicyRejectsEveryCrossOriginShape() throws {
    let policy = UsageRedirectPolicy()
    var original = URLRequest(url: try #require(URL(string: "https://usage.example/v3/usage")))
    original.setValue("Bearer secret", forHTTPHeaderField: "Authorization")

    let crossHost = URLRequest(url: try #require(URL(string: "https://evil.example/read")))
    let downgraded = URLRequest(url: try #require(URL(string: "http://usage.example/read")))
    let crossPort = URLRequest(url: try #require(URL(string: "https://usage.example:8443/read")))

    #expect(policy.redirectedRequest(originalRequest: original, proposedRequest: crossHost) == nil)
    #expect(policy.redirectedRequest(originalRequest: original, proposedRequest: downgraded) == nil)
    #expect(policy.redirectedRequest(originalRequest: original, proposedRequest: crossPort) == nil)
}

@Test func sameHTTPSOriginRedirectMayRetainAuthorization() throws {
    let policy = UsageRedirectPolicy()
    var original = URLRequest(url: try #require(URL(string: "https://usage.example/v3/usage")))
    original.setValue("Bearer secret", forHTTPHeaderField: "Authorization")
    let proposed = URLRequest(url: try #require(URL(string: "https://usage.example/v3/snapshot")))

    let permitted = try #require(
        policy.redirectedRequest(originalRequest: original, proposedRequest: proposed)
    )
    #expect(permitted.value(forHTTPHeaderField: "Authorization") == "Bearer secret")
}

@Test func providerReportsRejectedCrossOriginRedirect() async throws {
    let endpoint = try #require(URL(string: "https://usage.example/v3/usage"))
    let response = try #require(
        HTTPURLResponse(
            url: endpoint,
            statusCode: 302,
            httpVersion: "HTTP/1.1",
            headerFields: ["Location": "https://evil.example/steal"]
        )
    )
    let provider = HTTPUsageProvider(
        endpoint: endpoint,
        bearerToken: "secret",
        transport: StubTransport(data: Data(), response: response)
    )

    await #expect(throws: UsageProviderError.unsafeRedirect) {
        try await provider.fetch()
    }
}

@Test func nonLoopbackHTTPNeverCreatesTokenBearingRequest() async throws {
    let endpoint = try #require(URL(string: "http://usage.example/v3/usage"))
    let transport = RecordingTransport()
    let provider = HTTPUsageProvider(
        endpoint: endpoint,
        bearerToken: "must-not-leave-process",
        transport: transport
    )

    await #expect(throws: UsageProviderError.unsafeEndpoint) {
        try await provider.fetch()
    }
    let called = await transport.wasCalled
    #expect(called == false)
}

@Test func endpointPolicyAllowsHTTPSAndExplicitLoopbackOnly() throws {
    let policy = UsageEndpointPolicy()

    #expect(policy.allows(try #require(URL(string: "https://usage.example/v3/usage"))))
    #expect(policy.allows(try #require(URL(string: "http://localhost:8080/v3/usage"))))
    #expect(!policy.allows(try #require(URL(string: "http://usage.example/v3/usage"))))
    #expect(!policy.allows(try #require(URL(string: "https://user:pass@usage.example/v3/usage"))))
}

@Test func sharedKeychainQuerySelectsDataProtectionSemantics() {
    let store = KeychainSecretStore(accessGroup: "TESTTEAM.is.example.shared")
    let query = store.baseQuery

    #expect(query[kSecUseDataProtectionKeychain as String] as? Bool == true)
    #expect(query[kSecAttrSynchronizable as String] as? Bool == false)
    #expect(query[kSecAttrAccessGroup as String] as? String == "TESTTEAM.is.example.shared")
}
