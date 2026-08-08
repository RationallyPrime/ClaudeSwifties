import SwiftUI
import UsageKit
import UsageUI
import WidgetKit

/// Deliberately thin. WidgetKit requires a host app; the widget is the product.
/// The one thing this screen must actually do is let you point the widget at an
/// aggregator — without it there is no way to enter an endpoint at all, and the
/// widget can only ever show sample data.
struct ContentView: View {
    @State private var snapshot: UsageSnapshot?
    @State private var now = Date()
    @State private var endpoint = ""
    @State private var token = ""
    @State private var saved = false

    private let store = UsageStore.shared()

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Claude usage")
                .font(.headline)

            UsageSummaryView(snapshot: snapshot, now: now)

            Divider()

            settings
        }
        .padding()
        .task { await load() }
    }

    private var settings: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Aggregator")
                .font(.caption)
                .fontWeight(.medium)

            TextField("https://host/v1/usage", text: $endpoint)
                .textFieldStyle(.roundedBorder)
                .font(.caption)
                #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                #endif

            // Secure because it is a bearer token for a service holding your
            // usage history — not because it unlocks anything else.
            SecureField("read token", text: $token)
                .textFieldStyle(.roundedBorder)
                .font(.caption)

            HStack {
                Button("Save & refresh") { Task { await save() } }
                    .disabled(URL(string: endpoint)?.scheme == nil)

                if saved {
                    Text("saved")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .transition(.opacity)
                }
            }
        }
    }

    private func load() async {
        endpoint = store.endpoint?.absoluteString ?? ""
        token = store.token ?? ""
        now = Date()
        snapshot = await store.refresh(using: store.resolvedProvider())
    }

    private func save() async {
        store.endpoint = URL(string: endpoint)
        store.token = token.isEmpty ? nil : token
        now = Date()
        snapshot = await store.refresh(using: store.resolvedProvider())
        // The widget is a separate process and won't notice the change on its
        // own; without this you'd wait up to 15 minutes to see if it worked.
        WidgetCenter.shared.reloadAllTimelines()

        withAnimation { saved = true }
        try? await Task.sleep(for: .seconds(2))
        withAnimation { saved = false }
    }
}

#Preview {
    ContentView()
}
