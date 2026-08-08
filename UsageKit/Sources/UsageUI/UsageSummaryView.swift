import SwiftUI
import UsageKit

/// The stack of accounts, shared by the widget and the host app so the two can
/// never drift.
public struct UsageSummaryView: View {
    private let snapshot: UsageSnapshot?
    private let now: Date

    public init(snapshot: UsageSnapshot?, now: Date) {
        self.snapshot = snapshot
        self.now = now
    }

    public var body: some View {
        if let snapshot, !snapshot.accounts.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(snapshot.accounts) { account in
                    AccountTile(account: account, now: now)
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 3) {
                Text("No readings")
                    .font(.caption)
                    .fontWeight(.medium)
                // The likeliest cause by far, given the aggregator is only
                // reachable over the tailnet.
                Text("Check Tailscale is connected")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

#Preview("Three accounts") {
    UsageSummaryView(snapshot: .sample(now: Date()), now: Date())
        .padding()
        .frame(width: 320)
}
