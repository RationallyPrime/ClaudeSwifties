import SwiftUI
import UsageKit

/// A meter, not a progress bar: it fills toward a limit you don't want to hit,
/// so the tint escalates rather than staying decorative.
public struct UsageBar: View {
    private let fraction: Double
    private let dimmed: Bool
    private let accent: Color
    private let height: CGFloat

    public init(
        fraction: Double,
        dimmed: Bool = false,
        accent: Color = .blue,
        height: CGFloat = 7
    ) {
        self.fraction = min(max(fraction, 0), 1)
        self.dimmed = dimmed
        self.accent = accent
        self.height = height
    }

    public var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.white.opacity(0.085))
                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [accent, terminalTint],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    // A hairline of colour even at 0% so the row reads as a
                    // meter rather than an empty box.
                    .frame(width: max(3, geometry.size.width * fraction))
                    .shadow(color: terminalTint.opacity(0.42), radius: 4, y: 1)
            }
        }
        .frame(height: height)
        .opacity(dimmed ? 0.45 : 1)
        .accessibilityElement()
        .accessibilityValue(UsageFormat.percent(fraction))
    }

    private var terminalTint: Color {
        switch fraction {
        case ..<0.70: accent.opacity(0.82)
        case ..<0.90: Color(red: 1.000, green: 0.730, blue: 0.180)
        default: Color(red: 1.000, green: 0.275, blue: 0.235)
        }
    }
}
