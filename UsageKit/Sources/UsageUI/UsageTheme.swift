import SwiftUI
import UsageKit

/// The small visual vocabulary shared by the app and widget. The palette is
/// deliberately derived from the app icon: Claude orange, Codex blue, and a
/// deep ink background that keeps both luminous without sacrificing contrast.
public enum UsageTheme {
    public static var canvas: Color {
        Color(red: 0.018, green: 0.030, blue: 0.070)
    }

    public static var canvasLifted: Color {
        Color(red: 0.035, green: 0.062, blue: 0.130)
    }

    public static var card: Color {
        Color.white.opacity(0.075)
    }

    public static var border: Color {
        Color.white.opacity(0.105)
    }

    public static func accent(for provider: UsageProviderKind) -> Color {
        switch provider {
        case .claude: Color(red: 1.000, green: 0.560, blue: 0.105)
        case .codex: Color(red: 0.100, green: 0.585, blue: 1.000)
        case .unknown: Color(red: 0.610, green: 0.660, blue: 0.760)
        }
    }

    public static func secondaryAccent(for provider: UsageProviderKind) -> Color {
        switch provider {
        case .claude: Color(red: 1.000, green: 0.780, blue: 0.270)
        case .codex: Color(red: 0.110, green: 0.850, blue: 1.000)
        case .unknown: Color(red: 0.760, green: 0.790, blue: 0.850)
        }
    }

    public static func providerGradient(for provider: UsageProviderKind) -> LinearGradient {
        LinearGradient(
            colors: [accent(for: provider), secondaryAccent(for: provider)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }
}
