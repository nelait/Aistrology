// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "AnalyticsPlatform",
    platforms: [.iOS(.v15), .macOS(.v12), .tvOS(.v15), .watchOS(.v8)],
    products: [
        .library(name: "AnalyticsPlatform", targets: ["AnalyticsPlatform"]),
    ],
    targets: [
        .target(name: "AnalyticsPlatform"),
        .testTarget(name: "AnalyticsPlatformTests", dependencies: ["AnalyticsPlatform"]),
    ]
)
