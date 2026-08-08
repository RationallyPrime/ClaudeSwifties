import SwiftUI

@main
struct ClaudeSwiftiesApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        #if os(macOS)
            .defaultSize(width: 380, height: 420)
        #endif
    }
}
