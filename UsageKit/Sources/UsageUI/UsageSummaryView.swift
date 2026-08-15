import SwiftUI
import UsageKit

public enum UsageSummaryStyle: Sendable {
    case dashboard
    case compact
    case widgetGrid
}

/// Pool collection shared by the widget and host app. The server's explicit
/// order is retained on every surface; opaque IDs are never sorted locally.
public struct UsageSummaryView: View {
    private let snapshot: UsageSnapshot?
    private let now: Date
    private let maxPools: Int?
    private let emptyMessage: String
    private let style: UsageSummaryStyle

    public init(
        snapshot: UsageSnapshot?,
        now: Date,
        maxPools: Int? = nil,
        emptyMessage: String = "Open the app to configure the usage feed",
        style: UsageSummaryStyle = .dashboard
    ) {
        self.snapshot = snapshot
        self.now = now
        self.maxPools = maxPools
        self.emptyMessage = emptyMessage
        self.style = style
    }

    public var body: some View {
        if let snapshot, !snapshot.pools.isEmpty {
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
                poolViews(in: snapshot, tileStyle: .dashboard)
                moreLabel(for: snapshot)
            }
        case .compact:
            VStack(alignment: .leading, spacing: 2) {
                poolViews(in: snapshot, tileStyle: .compact)
                moreLabel(for: snapshot)
            }
        case .widgetGrid:
            GeometryReader { geometry in
                let pools = visiblePools(in: snapshot)
                let rowCount = max(1, Int(ceil(Double(pools.count) / 2)))
                let totalSpacing = CGFloat(max(0, rowCount - 1)) * 5
                let rowHeight = max(48, (geometry.size.height - totalSpacing) / CGFloat(rowCount))

                LazyVGrid(
                    columns: [GridItem(.flexible()), GridItem(.flexible())],
                    alignment: .leading,
                    spacing: 5
                ) {
                    ForEach(pools) { pool in
                        PoolTile(pool: pool, now: now, style: .widgetCard)
                            .frame(height: rowHeight)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func poolViews(in snapshot: UsageSnapshot, tileStyle: PoolTileStyle) -> some View {
        ForEach(visiblePools(in: snapshot)) { pool in
            PoolTile(pool: pool, now: now, style: tileStyle)
        }
    }

    @ViewBuilder
    private func moreLabel(for snapshot: UsageSnapshot) -> some View {
        if let maxPools, snapshot.pools.count > maxPools {
            Text("+\(snapshot.pools.count - maxPools) more in the app")
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
                Text("No pools yet")
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

    private func visiblePools(in snapshot: UsageSnapshot) -> [UsagePool] {
        UsagePoolSelection.pools(from: snapshot, capacity: maxPools)
    }
}

#Preview("Claude + Codex + Grok") {
    UsageSummaryView(snapshot: .sample(now: Date()), now: Date())
        .padding()
        .background(UsageTheme.canvas)
        .preferredColorScheme(.dark)
        .frame(width: 390)
}
