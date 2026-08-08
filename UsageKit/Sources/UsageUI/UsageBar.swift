import SwiftUI
import UsageKit

/// A meter, not a progress bar: it fills toward a limit you don't want to hit,
/// so the tint escalates rather than staying decorative.
public struct UsageBar: View {
    private let fraction: Double
    private let dimmed: Bool

    public init(fraction: Double, dimmed: Bool = false) {
        self.fraction = min(max(fraction, 0), 1)
        self.dimmed = dimmed
    }

    public var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(.quaternary)
                Capsule()
                    .fill(Self.tint(for: fraction))
                    // A hairline of colour even at 0% so the row reads as a
                    // meter rather than an empty box.
                    .frame(width: max(3, geometry.size.width * fraction))
            }
        }
        .frame(height: 5)
        .opacity(dimmed ? 0.45 : 1)
        .accessibilityElement()
        .accessibilityValue(UsageFormat.percent(fraction))
    }

    static func tint(for fraction: Double) -> Color {
        switch fraction {
        case ..<0.70: .green
        case ..<0.90: .yellow
        default: .red
        }
    }
}
