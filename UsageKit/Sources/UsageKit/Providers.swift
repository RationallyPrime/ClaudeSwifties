import Foundation

public protocol UsageProvider: Sendable {
    func fetch() async throws -> UsageSnapshot
}

public protocol UsageHTTPTransport: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

public enum UsageProviderError: Error, Equatable {
    case badStatus(Int)
    case notHTTP
    case unsafeEndpoint
    case unsafeRedirect
}

public struct UsageEndpointPolicy: Sendable, Equatable {
    public init() {}

    public func allows(_ endpoint: URL) -> Bool {
        guard let components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false),
            let scheme = endpoint.scheme?.lowercased(),
            let host = endpoint.host?.lowercased(),
            !host.isEmpty,
            endpoint.user == nil,
            endpoint.password == nil,
            components.percentEncodedPath == "/v3/usage",
            components.query == nil,
            components.fragment == nil
        else { return false }

        if scheme == "https" { return true }
        return scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host)
    }
}

public struct UsageReadTokenPolicy: Sendable, Equatable {
    public init() {}

    public func allows(_ token: String) -> Bool {
        let bytes = token.utf8
        return (16...512).contains(bytes.count) && bytes.allSatisfy { (0x21...0x7E).contains($0) }
    }
}

/// Origin comparison used by both the URLSession delegate and unit tests.
/// Redirects are permitted only when both URLs are HTTPS and their normalized
/// host/port tuple is unchanged.
public struct UsageRedirectPolicy: Sendable, Equatable {
    public init() {}

    public func allowsRedirect(from source: URL, to destination: URL) -> Bool {
        guard source.scheme?.lowercased() == "https",
            destination.scheme?.lowercased() == "https",
            source.host?.lowercased() == destination.host?.lowercased()
        else { return false }

        return normalizedPort(for: source) == normalizedPort(for: destination)
    }

    public func redirectedRequest(
        originalRequest: URLRequest,
        proposedRequest: URLRequest
    ) -> URLRequest? {
        guard let source = originalRequest.url,
            let destination = proposedRequest.url,
            allowsRedirect(from: source, to: destination)
        else { return nil }

        var permitted = proposedRequest
        if permitted.value(forHTTPHeaderField: "Authorization") == nil,
            let authorization = originalRequest.value(forHTTPHeaderField: "Authorization")
        {
            permitted.setValue(authorization, forHTTPHeaderField: "Authorization")
        }
        return permitted
    }

    private func normalizedPort(for url: URL) -> Int {
        url.port ?? 443
    }
}

public enum UsageSessionConfiguration {
    /// No disk cache, cookies, shared credential store, or persistent session
    /// state. The read bearer exists only on the request created for a fetch.
    public static func ephemeral() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCredentialStorage = nil
        return configuration
    }
}

private final class UsageRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let policy: UsageRedirectPolicy

    init(policy: UsageRedirectPolicy) {
        self.policy = policy
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        guard let original = task.originalRequest,
            let permitted = policy.redirectedRequest(
                originalRequest: original,
                proposedRequest: request
            )
        else {
            completionHandler(nil)
            return
        }
        completionHandler(permitted)
    }
}

public final class EphemeralUsageHTTPTransport: UsageHTTPTransport, @unchecked Sendable {
    private let delegate: UsageRedirectDelegate
    private let session: URLSession

    public init(
        configuration: URLSessionConfiguration = UsageSessionConfiguration.ephemeral(),
        redirectPolicy: UsageRedirectPolicy = UsageRedirectPolicy()
    ) {
        let delegate = UsageRedirectDelegate(policy: redirectPolicy)
        self.delegate = delegate
        session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    }

    public func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        try await session.data(for: request)
    }
}

/// Reads the private schema-3 projection. It intentionally does not use
/// `URLSession.shared`, which would inherit persistent cookies and credentials.
public struct HTTPUsageProvider: UsageProvider {
    private let endpoint: URL
    private let bearerToken: String?
    private let transport: any UsageHTTPTransport
    private let redirectPolicy: UsageRedirectPolicy
    private let endpointPolicy: UsageEndpointPolicy

    public init(
        endpoint: URL,
        bearerToken: String? = nil,
        transport: any UsageHTTPTransport = EphemeralUsageHTTPTransport(),
        redirectPolicy: UsageRedirectPolicy = UsageRedirectPolicy(),
        endpointPolicy: UsageEndpointPolicy = UsageEndpointPolicy()
    ) {
        self.endpoint = endpoint
        self.bearerToken = bearerToken
        self.transport = transport
        self.redirectPolicy = redirectPolicy
        self.endpointPolicy = endpointPolicy
    }

    public func fetch() async throws -> UsageSnapshot {
        // Validate before constructing a token-bearing request. Preferences are
        // not a trust boundary and may have been corrupted or migrated.
        guard endpointPolicy.allows(endpoint) else { throw UsageProviderError.unsafeEndpoint }

        var request = URLRequest(url: endpoint)
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let bearerToken {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await transport.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw UsageProviderError.notHTTP }

        if (300..<400).contains(http.statusCode),
            let location = http.value(forHTTPHeaderField: "Location"),
            let destination = URL(string: location, relativeTo: endpoint)?.absoluteURL,
            !redirectPolicy.allowsRedirect(from: endpoint, to: destination)
        {
            throw UsageProviderError.unsafeRedirect
        }

        guard (200..<300).contains(http.statusCode) else {
            throw UsageProviderError.badStatus(http.statusCode)
        }

        return try JSONDecoder.usageDecoder().decode(UsageSnapshot.self, from: data)
    }
}

public struct MockUsageProvider: UsageProvider {
    private let snapshot: UsageSnapshot

    public init(snapshot: UsageSnapshot = .sample(now: Date())) {
        self.snapshot = snapshot
    }

    public func fetch() async throws -> UsageSnapshot { snapshot }
}
