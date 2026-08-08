import Foundation

extension UsageSnapshot {
    /// The current four-account shape, including both providers and a sign-in
    /// state that keeps previews honest about failure presentation.
    public static func sample(now: Date) -> UsageSnapshot {
        UsageSnapshot(
            generatedAt: now,
            accounts: [
                AccountUsage(
                    id: "sokrates-team",
                    label: "Sokrates · Team",
                    sourceHost: "timaeus-mbp",
                    asOf: now.addingTimeInterval(-3 * 60),
                    status: .ok,
                    fiveHour: UsageWindow(utilization: 0.42, resetsAt: now.addingTimeInterval(94 * 60)),
                    sevenDay: UsageWindow(utilization: 0.71, resetsAt: now.addingTimeInterval(31 * 3600))
                ),
                AccountUsage(
                    id: "codex-pro",
                    label: "Codex · Pro",
                    provider: .codex,
                    sourceHost: "hakon-mbp",
                    asOf: now.addingTimeInterval(-6 * 60),
                    status: .ok,
                    windows: [
                        UsageWindow(
                            id: "weekly",
                            label: "7d",
                            durationMinutes: 10_080,
                            utilization: 0.45,
                            resetsAt: now.addingTimeInterval(41 * 3600)
                        )
                    ]
                ),
                AccountUsage(
                    id: "rp-team",
                    label: "Team · rationallyprime",
                    sourceHost: "hetzner-cx53",
                    asOf: now.addingTimeInterval(-8 * 60),
                    status: .authExpired,
                    fiveHour: nil,
                    sevenDay: nil
                ),
                AccountUsage(
                    id: "rp-max-20x",
                    label: "Max 20x · rationallyprime",
                    sourceHost: "pop-os",
                    asOf: now.addingTimeInterval(-12 * 60),
                    status: .ok,
                    fiveHour: UsageWindow(
                        utilization: 0.18,
                        resetsAt: now.addingTimeInterval(4 * 3600 + 18 * 60)
                    ),
                    sevenDay: UsageWindow(
                        utilization: 0.87,
                        resetsAt: now.addingTimeInterval(4 * 24 * 3600 + 12 * 3600)
                    )
                ),
            ]
        )
    }
}
