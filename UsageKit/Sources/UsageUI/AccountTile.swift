import SwiftUI
import UsageKit

/// One provider/account. Old readings remain visible and explicitly dimmed;
/// crossing a reset boundary never turns an old value into a made-up zero.
public struct AccountTile: View {
    private let account: AccountUsage
    private let now: Date

    public init(account: AccountUsage, now: Date) {
        self.account = account
        self.now = now
    }

    private var state: TileState { account.tileState(now: now) }

    private var dimmed: Bool {
        if case .live(let freshness) = state { return freshness != .fresh }
        return true
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            header

            if state.showsNumbers, !account.windows.isEmpty {
                ForEach(account.windows.prefix(2)) { window in
                    windowRow(window)
                }
            } else {
                Text(unavailableReason)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Image(systemName: providerIcon)
                .font(.caption2)
                .foregroundStyle(providerTint)
                .accessibilityLabel(providerName)

            Text(account.label)
                .font(.caption)
                .fontWeight(.medium)
                .lineLimit(1)

            Spacer(minLength: 4)

            if case .live(let freshness) = state, freshness != .fresh {
                Text(UsageFormat.age(account.age(now: now)))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private func windowRow(_ window: UsageWindow) -> some View {
        HStack(spacing: 6) {
            Text(window.label)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(width: 25, alignment: .leading)

            UsageBar(fraction: window.fraction, dimmed: dimmed)

            Text(UsageFormat.percent(window.fraction))
                .font(.caption2)
                .monospacedDigit()
                .frame(width: 34, alignment: .trailing)

            Text(resetText(for: window))
                .font(.caption2)
                .monospacedDigit()
                .foregroundStyle(.tertiary)
                .frame(width: 48, alignment: .trailing)
        }
    }

    private func resetText(for window: UsageWindow) -> String {
        guard let resetsAt = window.resetsAt else { return "—" }
        guard resetsAt > now else { return "passed" }
        return UsageFormat.countdown(to: resetsAt, from: now)
    }

    private var unavailableReason: String {
        switch state {
        case .authExpired: "sign in on \(account.sourceHost)"
        case .error: "collector error · \(account.sourceHost)"
        case .unknown: "unrecognised state"
        case .live: "No quota windows reported"
        }
    }

    private var providerName: String {
        switch account.provider {
        case .claude: "Claude"
        case .codex: "Codex"
        case .unknown: "Usage provider"
        }
    }

    private var providerIcon: String {
        switch account.provider {
        case .claude: "sparkles"
        case .codex: "chevron.left.forwardslash.chevron.right"
        case .unknown: "gauge.with.dots.needle.33percent"
        }
    }

    private var providerTint: Color {
        switch account.provider {
        case .claude: .orange
        case .codex: .blue
        case .unknown: .secondary
        }
    }
}
