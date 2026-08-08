import Foundation

extension UsageSnapshot {
    /// Three accounts, three edges, three states: a healthy one, one whose edge
    /// has gone quiet, and one whose token needs re-auth by its owning client.
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
                    id: "rp-max-20x",
                    label: "Max 20x · rationallyprime",
                    sourceHost: "linux-laptop",
                    asOf: now.addingTimeInterval(-96 * 60),
                    status: .ok,
                    fiveHour: UsageWindow(utilization: 0.18, resetsAt: now.addingTimeInterval(12 * 60)),
                    sevenDay: UsageWindow(utilization: 0.55, resetsAt: now.addingTimeInterval(50 * 3600))
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
