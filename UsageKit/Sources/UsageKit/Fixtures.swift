import Foundation

extension UsageSnapshot {
    /// Claude and Codex together, including a stale edge and a sign-in state.
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
                        ),
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
            ]
        )
    }
}
