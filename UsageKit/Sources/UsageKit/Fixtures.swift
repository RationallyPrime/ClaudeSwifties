import Foundation

extension UsageSnapshot {
    /// Five pools exercise the intended medium-widget capacity: three Claude
    /// subscriptions plus Codex and Grok Build. The shared Claude pool also
    /// keeps two-profile presentation visible in previews.
    public static func sample(now: Date) -> UsageSnapshot {
        UsageSnapshot(
            generatedAt: now,
            pools: [
                UsagePool(
                    id: "claude-max-opaque",
                    provider: .claude,
                    label: "Claude · Max 20x",
                    identityState: .verified,
                    status: .ok,
                    sampledAt: now.addingTimeInterval(-3 * 60),
                    receivedAt: now.addingTimeInterval(-2 * 60),
                    windows: [
                        UsageWindow(
                            id: "five-hour",
                            label: "5h",
                            durationMinutes: 300,
                            utilization: 0.42,
                            resetsAt: now.addingTimeInterval(94 * 60)
                        ),
                        UsageWindow(
                            id: "seven-day",
                            label: "7d",
                            durationMinutes: 10_080,
                            utilization: 0.71,
                            resetsAt: now.addingTimeInterval(31 * 3600)
                        ),
                    ],
                    profiles: [
                        .sample(
                            id: "desktop-a",
                            label: "Desktop A",
                            host: "linux-workstation",
                            now: now
                        ),
                        .sample(
                            id: "edge-profile-b",
                            label: "Edge profile B",
                            host: "edge-host",
                            now: now.addingTimeInterval(-4 * 60)
                        ),
                    ]
                ),
                UsagePool(
                    id: "claude-team-opaque",
                    provider: .claude,
                    label: "Claude · Team",
                    identityState: .verified,
                    status: .ok,
                    sampledAt: now.addingTimeInterval(-8 * 60),
                    receivedAt: now.addingTimeInterval(-7 * 60),
                    windows: [
                        UsageWindow(
                            id: "seven-day",
                            label: "7d",
                            durationMinutes: 10_080,
                            utilization: 0.18,
                            resetsAt: now.addingTimeInterval(4 * 24 * 3600)
                        )
                    ],
                    profiles: [
                        .sample(
                            id: "laptop-c",
                            label: "Laptop C",
                            host: "macbook",
                            now: now.addingTimeInterval(-7 * 60)
                        )
                    ]
                ),
                UsagePool(
                    id: "claude-provisional-opaque",
                    provider: .claude,
                    label: "Claude · Provisional pool",
                    identityState: .provisional,
                    status: .stale,
                    sampledAt: now.addingTimeInterval(-3 * 3600),
                    receivedAt: now.addingTimeInterval(-3 * 3600),
                    windows: [
                        UsageWindow(
                            id: "five-hour",
                            label: "5h",
                            durationMinutes: 300,
                            utilization: 0.87,
                            resetsAt: now.addingTimeInterval(-30 * 60)
                        )
                    ],
                    profiles: []
                ),
                UsagePool(
                    id: "codex-opaque",
                    provider: .codex,
                    label: "Codex · Pro",
                    identityState: .verified,
                    status: .ok,
                    sampledAt: now.addingTimeInterval(-6 * 60),
                    receivedAt: now.addingTimeInterval(-5 * 60),
                    windows: [
                        UsageWindow(
                            id: "weekly",
                            label: "7d",
                            durationMinutes: 10_080,
                            utilization: 0.45,
                            resetsAt: now.addingTimeInterval(41 * 3600)
                        )
                    ],
                    profiles: [
                        .sample(
                            id: "desktop-d",
                            label: "Desktop D",
                            host: "macbook",
                            now: now.addingTimeInterval(-5 * 60)
                        )
                    ]
                ),
                UsagePool(
                    id: "grok-opaque",
                    provider: .grok,
                    label: "Grok Build · SuperGrok",
                    identityState: .conflict,
                    status: .billingUnavailable,
                    sampledAt: now.addingTimeInterval(-26 * 60),
                    receivedAt: now.addingTimeInterval(-25 * 60),
                    windows: [
                        UsageWindow(
                            id: "credits-monthly",
                            label: "Monthly",
                            durationMinutes: 43_200,
                            utilization: 0.36,
                            resetsAt: now.addingTimeInterval(12 * 24 * 3600)
                        )
                    ],
                    profiles: [
                        .sample(
                            id: "build-station-e",
                            label: "Build station E",
                            host: "gpu-host",
                            now: now.addingTimeInterval(-25 * 60),
                            state: .recent,
                            confidence: .windowContinuity
                        )
                    ]
                ),
            ]
        )
    }
}

private extension ObserverProfile {
    static func sample(
        id: String,
        label: String,
        host: String,
        now: Date,
        state: ObserverProfileState = .current,
        confidence: BindingConfidence = .subject
    ) -> ObserverProfile {
        ObserverProfile(
            id: id,
            label: label,
            sourceHost: host,
            lastSeenAt: now,
            state: state,
            bindingConfidence: confidence
        )
    }
}
