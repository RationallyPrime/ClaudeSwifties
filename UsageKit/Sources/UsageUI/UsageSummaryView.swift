import SwiftUI
import UsageKit

/// The stack of accounts, shared by the widget and the host app so the two can
/// never drift.
public struct UsageSummaryView: View {
    private let snapshot: UsageSnapshot?
    private let now: Date
    private let maxAccounts: Int?
    private let emptyMessage: String

    public init(
        snapshot: UsageSnapshot?,
        now: Date,
        maxAccounts: Int? = nil,
        emptyMessage: String = "Open the app to configure the usage feed"
    ) {
        self.snapshot = snapshot
        self.now = now
        self.maxAccounts = maxAccounts
        self.emptyMessage = emptyMessage
    }

    public var body: some View {
        if let snapshot, !snapshot.accounts.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(visibleAccounts(in: snapshot)) { account in
                    AccountTile(account: account, now: now)
                }

                if let maxAccounts, snapshot.accounts.count > maxAccounts {
                    Text("+\(snapshot.accounts.count - maxAccounts) more in the app")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 3) {
                Text("No readings")
                    .font(.caption)
                    .fontWeight(.medium)
                Text(emptyMessage)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func visibleAccounts(in snapshot: UsageSnapshot) -> [AccountUsage] {
        Array(snapshot.accounts.prefix(maxAccounts ?? snapshot.accounts.count))
    }
}

#Preview("Claude + Codex") {
    UsageSummaryView(snapshot: .sample(now: Date()), now: Date())
        .padding()
        .frame(width: 320)
}
