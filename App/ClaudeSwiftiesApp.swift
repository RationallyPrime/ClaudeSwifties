import SwiftUI

@main
struct ClaudeSwiftiesApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        #if os(macOS)
            .defaultSize(width: 500, height: 700)
        #endif
    }
}
