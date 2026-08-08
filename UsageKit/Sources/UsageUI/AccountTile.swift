import SwiftUI
import UsageKit

public enum AccountTileStyle: Sendable {
    /// Full information hierarchy for the scrolling host app.
    case dashboard
    /// Four dense rows fit in a medium widget without hiding an account.
    case compact
    /// Two-column cards use the room available in a large widget.
    case widgetCard
}

/// One provider/account. Old readings remain visible and explicitly dimmed;
/// crossing a reset boundary never turns an old value into a made-up zero.
public struct AccountTile: View {
    private let account: AccountUsage
    private let now: Date
    private let style: AccountTileStyle

    public init(
        account: AccountUsage,
        now: Date,
        style: AccountTileStyle = .dashboard
    ) {
        self.account = account
        self.now = now
        self.style = style
    }

    private var state: TileState { account.tileState(now: now) }
    private var accent: Color { UsageTheme.accent(for: account.provider) }

    private var dimmed: Bool {
        if case .live(let freshness) = state { return freshness != .fresh }
        return true
    }

    public var body: some View {
        Group {
            switch style {
            case .dashboard:
                dashboardTile
            case .compact:
                compactTile
            case .widgetCard:
                widgetCard
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var dashboardTile: some View {
        VStack(alignment: .leading, spacing: 13) {
            dashboardHeader

            if state.showsNumbers, !account.windows.isEmpty {
                VStack(spacing: 12) {
                    ForEach(account.windows) { window in
                        dashboardWindow(window)
                    }
                }
            } else {
                unavailableView
            }
        }
        .padding(15)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: 19, style: .continuous)
                    .fill(UsageTheme.card)
                RoundedRectangle(cornerRadius: 19, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [accent.opacity(0.17), .clear, .clear],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
            }
        }
        .overlay {
            RoundedRectangle(cornerRadius: 19, style: .continuous)
                .stroke(UsageTheme.border, lineWidth: 1)
        }
    }

    private var dashboardHeader: some View {
        HStack(spacing: 10) {
            providerBadge(size: 34, iconSize: 13)

            VStack(alignment: .leading, spacing: 2) {
                Text(account.label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)

                Text(providerName)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(accent.opacity(0.92))
            }

            Spacer(minLength: 6)

            freshnessBadge
        }
    }

    private func dashboardWindow(_ window: UsageWindow) -> some View {
        VStack(spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(window.label.uppercased())
                    .font(.caption2.weight(.bold))
                    .tracking(0.8)
                    .foregroundStyle(accent)

                Text(longResetText(for: window))
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.48))
                    .lineLimit(1)

                Spacer(minLength: 6)

                Text(UsageFormat.percent(window.fraction))
                    .font(.title3.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(.white)
            }

            UsageBar(
                fraction: window.fraction,
                dimmed: dimmed,
                accent: accent,
                height: 8
            )
        }
    }

    private var compactTile: some View {
        HStack(spacing: 7) {
            providerBadge(size: 22, iconSize: 9)

            Text(account.label)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.white)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
                .frame(maxWidth: .infinity, alignment: .leading)

            if state.showsNumbers, !account.windows.isEmpty {
                HStack(spacing: 5) {
                    ForEach(account.windows.prefix(2)) { window in
                        compactWindow(window)
                    }
                }
            } else {
                Text(shortUnavailableReason)
                    .font(.system(size: 8, weight: .medium))
                    .foregroundStyle(.white.opacity(0.52))
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .background {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(Color.white.opacity(0.055))
        }
        .overlay(alignment: .leading) {
            Capsule()
                .fill(accent)
                .frame(width: 2.5)
                .padding(.vertical, 5)
        }
    }

    private func compactWindow(_ window: UsageWindow) -> some View {
        VStack(alignment: .trailing, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text(window.label)
                    .foregroundStyle(.white.opacity(0.48))
                Text(UsageFormat.percent(window.fraction))
                    .fontWeight(.bold)
                    .foregroundStyle(meterTextColor(for: window.fraction))
            }
            .font(.system(size: 9, design: .rounded))

            Text(shortResetText(for: window))
                .font(.system(size: 8, weight: .medium, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(.white.opacity(0.42))
        }
        .frame(width: 57, alignment: .trailing)
        .opacity(dimmed ? 0.55 : 1)
    }

    private var widgetCard: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 7) {
                providerBadge(size: 26, iconSize: 10)
                Text(account.label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .minimumScaleFactor(0.78)
                Spacer(minLength: 0)
            }

            Spacer(minLength: 0)

            if state.showsNumbers, !account.windows.isEmpty {
                VStack(spacing: 8) {
                    ForEach(account.windows.prefix(2)) { window in
                        widgetWindow(window)
                    }
                }
            } else {
                Text(shortUnavailableReason)
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.48))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Spacer(minLength: 0)
        }
        .padding(10)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background {
            ZStack {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.white.opacity(0.065))
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [accent.opacity(0.14), .clear],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
            }
        }
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 1)
        }
    }

    private func widgetWindow(_ window: UsageWindow) -> some View {
        VStack(spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(window.label.uppercased())
                    .font(.system(size: 9, weight: .bold, design: .rounded))
                    .foregroundStyle(accent)
                Text(shortResetText(for: window))
                    .font(.system(size: 8, weight: .medium, design: .rounded))
                    .foregroundStyle(.white.opacity(0.40))
                    .lineLimit(1)
                Spacer(minLength: 2)
                Text(UsageFormat.percent(window.fraction))
                    .font(.caption2.weight(.bold))
                    .monospacedDigit()
                    .foregroundStyle(.white)
            }

            UsageBar(
                fraction: window.fraction,
                dimmed: dimmed,
                accent: accent,
                height: 5
            )
        }
    }

    private func providerBadge(size: CGFloat, iconSize: CGFloat) -> some View {
        ZStack {
            Circle()
                .fill(UsageTheme.providerGradient(for: account.provider))
                .shadow(color: accent.opacity(0.28), radius: 5, y: 2)
            Image(systemName: providerIcon)
                .font(.system(size: iconSize, weight: .bold))
                .foregroundStyle(.white)
        }
        .frame(width: size, height: size)
        .accessibilityLabel(providerName)
    }

    @ViewBuilder
    private var freshnessBadge: some View {
        switch state {
        case .live(let freshness):
            HStack(spacing: 5) {
                Circle()
                    .fill(freshness == .fresh ? Color.green : Color.orange)
                    .frame(width: 6, height: 6)
                Text(freshness == .fresh ? "Live" : UsageFormat.age(account.age(now: now)))
                    .font(.caption2.weight(.semibold))
                    .monospacedDigit()
            }
            .foregroundStyle(.white.opacity(freshness == .fresh ? 0.68 : 0.48))
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(Color.white.opacity(0.06), in: Capsule())
        case .authExpired:
            statusBadge("Sign in", color: .orange)
        case .error:
            statusBadge("Error", color: .red)
        case .unknown:
            statusBadge("Unknown", color: .gray)
        }
    }

    private func statusBadge(_ title: String, color: Color) -> some View {
        HStack(spacing: 5) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text(title)
                .font(.caption2.weight(.semibold))
        }
        .foregroundStyle(.white.opacity(0.68))
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Color.white.opacity(0.06), in: Capsule())
    }

    private var unavailableView: some View {
        HStack(spacing: 9) {
            Image(
                systemName: state == .authExpired
                    ? "person.crop.circle.badge.exclamationmark" : "exclamationmark.triangle"
            )
            .foregroundStyle(accent)
            VStack(alignment: .leading, spacing: 2) {
                Text(unavailableTitle)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.82))
                Text(unavailableReason)
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.46))
            }
        }
        .padding(.top, 2)
    }

    private func meterTextColor(for fraction: Double) -> Color {
        switch fraction {
        case ..<0.70: .white
        case ..<0.90: Color(red: 1.000, green: 0.760, blue: 0.260)
        default: Color(red: 1.000, green: 0.385, blue: 0.330)
        }
    }

    private func longResetText(for window: UsageWindow) -> String {
        guard let resetsAt = window.resetsAt else { return "Reset time unavailable" }
        guard resetsAt > now else { return "Reset passed · awaiting a fresh reading" }
        return "Resets in \(UsageFormat.countdown(to: resetsAt, from: now))"
    }

    private func shortResetText(for window: UsageWindow) -> String {
        guard let resetsAt = window.resetsAt else { return "no reset" }
        guard resetsAt > now else { return "passed" }
        return UsageFormat.countdown(to: resetsAt, from: now)
    }

    private var unavailableTitle: String {
        switch state {
        case .authExpired: "Sign-in needed"
        case .error: "Collector unavailable"
        case .unknown: "Unknown collector state"
        case .live: "No quota windows"
        }
    }

    private var unavailableReason: String {
        switch state {
        case .authExpired: "Open Claude on \(account.sourceHost) and send one message."
        case .error: "The collector on \(account.sourceHost) reported an error."
        case .unknown: "This app does not recognise the reported status yet."
        case .live: "This provider did not report any limits."
        }
    }

    private var shortUnavailableReason: String {
        switch state {
        case .authExpired: "sign in"
        case .error: "collector error"
        case .unknown: "unknown"
        case .live: "no limits"
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
}

#Preview("Dashboard") {
    ScrollView {
        VStack(spacing: 12) {
            ForEach(UsageSnapshot.sample(now: .now).accounts) { account in
                AccountTile(account: account, now: .now)
            }
        }
        .padding()
    }
    .background(UsageTheme.canvas)
    .preferredColorScheme(.dark)
    .frame(width: 390, height: 700)
}
