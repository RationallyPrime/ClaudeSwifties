import SwiftUI
import UsageKit
import UsageUI
import WidgetKit

struct UsageEntry: TimelineEntry {
    let date: Date
    let snapshot: UsageSnapshot?
}

struct UsageTimelineProvider: TimelineProvider {
    private let store = UsageStore.shared()

    func placeholder(in context: Context) -> UsageEntry {
        UsageEntry(date: Date(), snapshot: .sample(now: Date()))
    }

    func getSnapshot(in context: Context, completion: @escaping (UsageEntry) -> Void) {
        let now = Date()
        // The gallery preview must never depend on the tailnet being up.
        guard !context.isPreview else {
            completion(UsageEntry(date: now, snapshot: .sample(now: now)))
            return
        }
        Task {
            completion(UsageEntry(date: now, snapshot: await load()))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<UsageEntry>) -> Void) {
        Task {
            let now = Date()
            let entry = UsageEntry(date: now, snapshot: await load())
            // WidgetKit grants roughly 40-70 refreshes a day, so ~15 minutes is
            // the sustainable floor. Polling the aggregator faster than this
            // would buy nothing — the phone, not the pipeline, is the bottleneck.
            let next = now.addingTimeInterval(15 * 60)
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }

    /// Never throws: an unreachable aggregator falls back to the cached
    /// snapshot, which the tiles then render with an honest age.
    private func load() async -> UsageSnapshot? {
        await store.refresh(using: store.resolvedProvider())
    }
}

struct UsageWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "UsageWidget", provider: UsageTimelineProvider()) { entry in
            UsageSummaryView(snapshot: entry.snapshot, now: entry.date)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Claude usage")
        .description("Limits and reset times across your accounts.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}
