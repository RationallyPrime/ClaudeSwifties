import SwiftUI

@main
struct ClaudeSwiftiesApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        #if os(macOS)
            .defaultSize(width: 460, height: 520)
        #endif
    }
}
