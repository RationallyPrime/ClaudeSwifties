import SwiftUI
import UsageKit

public enum UsageSummaryStyle: Sendable {
    case dashboard
    case compact
    case widgetGrid
}

/// The account collection shared by the widget and host app. Each surface gets
/// a layout appropriate to its available space while preserving the same state
/// and freshness decisions.
public struct UsageSummaryView: View {
    private let snapshot: UsageSnapshot?
    private let now: Date
    private let maxAccounts: Int?
    private let emptyMessage: String
    private let style: UsageSummaryStyle

    public init(
        snapshot: UsageSnapshot?,
        now: Date,
        maxAccounts: Int? = nil,
        emptyMessage: String = "Open the app to configure the usage feed",
        style: UsageSummaryStyle = .dashboard
    ) {
        self.snapshot = snapshot
        self.now = now
        self.maxAccounts = maxAccounts
        self.emptyMessage = emptyMessage
        self.style = style
    }

    public var body: some View {
        if let snapshot, !snapshot.accounts.isEmpty {
            populated(snapshot)
        } else {
            emptyView
        }
    }

    @ViewBuilder
    private func populated(_ snapshot: UsageSnapshot) -> some View {
        switch style {
        case .dashboard:
            VStack(alignment: .leading, spacing: 12) {
                accountViews(in: snapshot, tileStyle: .dashboard)
                moreLabel(for: snapshot)
            }
        case .compact:
            VStack(alignment: .leading, spacing: 3) {
                accountViews(in: snapshot, tileStyle: .compact)
                moreLabel(for: snapshot)
            }
        case .widgetGrid:
            GeometryReader { geometry in
                let accounts = visibleAccounts(in: snapshot)
                let rowCount = max(1, Int(ceil(Double(accounts.count) / 2)))
                let totalSpacing = CGFloat(max(0, rowCount - 1)) * 8
                let rowHeight = max(
                    96,
                    (geometry.size.height - totalSpacing) / CGFloat(rowCount)
                )

                LazyVGrid(
                    columns: [GridItem(.flexible()), GridItem(.flexible())],
                    alignment: .leading,
                    spacing: 8
                ) {
                    ForEach(accounts) { account in
                        AccountTile(account: account, now: now, style: .widgetCard)
                            .frame(height: rowHeight)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func accountViews(
        in snapshot: UsageSnapshot,
        tileStyle: AccountTileStyle
    ) -> some View {
        ForEach(visibleAccounts(in: snapshot)) { account in
            AccountTile(account: account, now: now, style: tileStyle)
        }
    }

    @ViewBuilder
    private func moreLabel(for snapshot: UsageSnapshot) -> some View {
        if let maxAccounts, snapshot.accounts.count > maxAccounts {
            Text("+\(snapshot.accounts.count - maxAccounts) more in the app")
                .font(.caption2.weight(.medium))
                .foregroundStyle(.white.opacity(0.38))
        }
    }

    private var emptyView: some View {
        HStack(spacing: 10) {
            Image(systemName: "waveform.path.ecg")
                .font(.headline)
                .foregroundStyle(Color.white.opacity(0.46))
                .frame(width: 34, height: 34)
                .background(Color.white.opacity(0.06), in: Circle())

            VStack(alignment: .leading, spacing: 2) {
                Text("No readings yet")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.82))
                Text(emptyMessage)
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.44))
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(UsageTheme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func visibleAccounts(in snapshot: UsageSnapshot) -> [AccountUsage] {
        Array(snapshot.accounts.prefix(maxAccounts ?? snapshot.accounts.count))
    }
}

#Preview("Claude + Codex") {
    UsageSummaryView(snapshot: .sample(now: Date()), now: Date())
        .padding()
        .background(UsageTheme.canvas)
        .preferredColorScheme(.dark)
        .frame(width: 390)
}
