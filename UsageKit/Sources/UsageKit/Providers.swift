import Foundation

public protocol UsageProvider: Sendable {
    func fetch() async throws -> UsageSnapshot
}

public enum UsageProviderError: Error, Equatable {
    case badStatus(Int)
    case notHTTP
}

/// Reads the aggregator. Transport-agnostic on purpose: whether `endpoint` is a
/// tailnet address or a public HTTPS host behind Caddy, only the URL and the
/// presence of a bearer token change.
public struct HTTPUsageProvider: UsageProvider {
    private let endpoint: URL
    private let bearerToken: String?
    private let session: URLSession

    public init(endpoint: URL, bearerToken: String? = nil, session: URLSession = .shared) {
        self.endpoint = endpoint
        self.bearerToken = bearerToken
        self.session = session
    }

    public func fetch() async throws -> UsageSnapshot {
        var request = URLRequest(url: endpoint)
        // Widget timelines are cheap to retry and expensive to block; fail fast
        // and show the cached tile rather than holding the refresh budget open.
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let bearerToken {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw UsageProviderError.notHTTP }
        guard (200..<300).contains(http.statusCode) else {
            throw UsageProviderError.badStatus(http.statusCode)
        }

        return try JSONDecoder.usageDecoder().decode(UsageSnapshot.self, from: data)
    }
}

/// Drives the UI before any real credential is involved. Returns the awkward
/// states as well as the happy one, since those are the tiles worth designing.
public struct MockUsageProvider: UsageProvider {
    private let snapshot: UsageSnapshot

    public init(snapshot: UsageSnapshot = .sample(now: Date())) {
        self.snapshot = snapshot
    }

    public func fetch() async throws -> UsageSnapshot { snapshot }
}
