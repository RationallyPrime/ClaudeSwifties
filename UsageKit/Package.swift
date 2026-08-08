// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "UsageKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "UsageKit", targets: ["UsageKit"]),
        .library(name: "UsageUI", targets: ["UsageUI"]),
    ],
    targets: [
        .target(name: "UsageKit", swiftSettings: [.swiftLanguageMode(.v6)]),
        .target(
            name: "UsageUI",
            dependencies: ["UsageKit"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "UsageKitTests",
            dependencies: ["UsageKit"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
