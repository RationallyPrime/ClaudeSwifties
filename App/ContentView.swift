import SwiftUI
import UsageKit
import UsageUI
import WidgetKit

struct ContentView: View {
    @State private var refreshState: UsageRefreshState = .unconfigured
    @State private var now = Date()
    @State private var endpoint = ""
    @State private var token = ""
    @State private var validationMessage: String?
    @State private var isRefreshing = false
    @State private var saved = false

    private let store = UsageStore.shared()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header

                UsageSummaryView(
                    snapshot: refreshState.snapshot,
                    now: now,
                    emptyMessage: "Configure the private feed below"
                )

                Divider()
                settings
            }
            .padding()
            .frame(maxWidth: 520, alignment: .leading)
        }
        .task { await load() }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("AI usage")
                .font(.headline)

            Spacer()
            statusLabel
                .font(.caption)
        }
    }

    @ViewBuilder
    private var statusLabel: some View {
        switch refreshState {
        case .live:
            Label("Live", systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
        case .cached:
            Label("Cached", systemImage: "clock.badge.exclamationmark")
                .foregroundStyle(.orange)
        case .failed:
            Label("Offline", systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
        case .unconfigured:
            Label("Setup", systemImage: "gearshape")
                .foregroundStyle(.secondary)
        }
    }

    private var settings: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("Private usage feed")
                .font(.caption)
                .fontWeight(.semibold)

            TextField("https://host/v1/usage", text: $endpoint)
                .textFieldStyle(.roundedBorder)
                .font(.caption)
                #if os(iOS)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                #endif

            SecureField("read token", text: $token)
                .textFieldStyle(.roundedBorder)
                .font(.caption)

            Text("The read token and last snapshot are shared only with this app's widget extension.")
                .font(.caption2)
                .foregroundStyle(.secondary)

            if let validationMessage {
                Text(validationMessage)
                    .font(.caption2)
                    .foregroundStyle(.red)
            } else if case .cached(_, let message) = refreshState {
                Text("Showing the last good reading: \(message)")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            } else if case .failed(let message) = refreshState {
                Text(message)
                    .font(.caption2)
                    .foregroundStyle(.red)
            }

            HStack {
                Button("Save & refresh") { Task { await save() } }
                    .disabled(isRefreshing || store == nil)

                Button("Refresh") { Task { await refresh() } }
                    .disabled(isRefreshing || store?.endpoint == nil)

                if isRefreshing {
                    ProgressView()
                        .controlSize(.small)
                } else if saved {
                    Text("saved")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .transition(.opacity)
                }
            }
        }
    }

    private func load() async {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--sample-usage") {
            now = Date()
            refreshState = .live(.sample(now: now))
            return
        }
        #endif

        guard let store else {
            refreshState = .failed(
                message: "The shared App Group is unavailable. Check signing entitlements for the app and widget."
            )
            return
        }
        endpoint = store.endpoint?.absoluteString ?? ""
        token = store.token ?? ""
        await refresh()
    }

    private func save() async {
        guard let store else { return }
        validationMessage = nil

        guard let url = validatedEndpoint() else { return }
        guard token.count >= 16 else {
            validationMessage = "The read token must be at least 16 characters."
            return
        }

        store.endpoint = url
        store.token = token
        await refresh()
        WidgetCenter.shared.reloadAllTimelines()

        withAnimation { saved = true }
        try? await Task.sleep(for: .seconds(2))
        withAnimation { saved = false }
    }

    private func refresh() async {
        guard let store else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        now = Date()
        refreshState = await store.refreshConfigured()
    }

    private func validatedEndpoint() -> URL? {
        guard let url = URL(string: endpoint),
              let scheme = url.scheme?.lowercased(),
              let host = url.host,
              !host.isEmpty
        else {
            validationMessage = "Enter a complete HTTPS URL."
            return nil
        }

        if scheme == "https" { return url }
        if scheme == "http", ["localhost", "127.0.0.1", "::1"].contains(host) { return url }

        validationMessage = "Use HTTPS for any non-local usage feed."
        return nil
    }
}

#Preview {
    ContentView()
}
