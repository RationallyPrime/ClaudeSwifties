import SwiftUI
import UsageKit

/// One account. Renders three ways: live numbers, a dimmed stale reading with
/// its age, or a no-data state — never a confident-looking number that is
/// actually hours old.
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

            if state.showsNumbers {
                window(account.fiveHour, caption: "5h")
                window(account.sevenDay, caption: "7d")
            } else {
                Text(unavailableReason)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
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

    @ViewBuilder
    private func window(_ window: UsageWindow?, caption: String) -> some View {
        if let window {
            let fraction = window.effectiveFraction(readingTime: account.asOf, now: now)

            HStack(spacing: 6) {
                Text(caption)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .frame(width: 16, alignment: .leading)

                UsageBar(fraction: fraction, dimmed: dimmed)

                Text(UsageFormat.percent(fraction))
                    .font(.caption2)
                    .monospacedDigit()
                    .frame(width: 34, alignment: .trailing)

                Text(UsageFormat.countdown(to: window.resetsAt, from: now))
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
                    .frame(width: 44, alignment: .trailing)
            }
        }
    }

    private var unavailableReason: String {
        switch state {
        case .authExpired: "sign in on \(account.sourceHost)"
        case .error: "edge error · \(account.sourceHost)"
        case .unknown: "unrecognised state"
        case .live: ""
        }
    }
}
