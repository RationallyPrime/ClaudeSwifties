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
            // This is a request, not a guarantee; WidgetKit may coalesce it.
            let next = now.addingTimeInterval(15 * 60)
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }

    /// Never throws: an unreachable aggregator falls back to the cached
    /// snapshot, which the tiles then render with an honest age.
    private func load() async -> UsageSnapshot? {
        guard let store else { return nil }
        return await store.refreshConfigured().snapshot
    }
}

private struct UsageWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: UsageEntry

    var body: some View {
        UsageSummaryView(
            snapshot: entry.snapshot,
            now: entry.date,
            maxAccounts: family == .systemMedium ? 3 : 6
        )
        .containerBackground(.fill.tertiary, for: .widget)
    }
}

struct UsageWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "UsageWidget", provider: UsageTimelineProvider()) { entry in
            UsageWidgetView(entry: entry)
        }
        .configurationDisplayName("AI usage")
        .description("Claude and Codex limits with reset times.")
        .supportedFamilies([.systemMedium, .systemLarge])
    }
}
