import UIKit
import Capacitor
import Foundation
import Network

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
    }

    func applicationWillTerminate(_ application: UIApplication) {
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }
}

class AppViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(BackendDiscoveryPlugin())
    }
}

@objc(BackendDiscoveryPlugin)
class BackendDiscoveryPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BackendDiscoveryPlugin"
    public let jsName = "BackendDiscovery"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "discoverBackends", returnType: CAPPluginReturnPromise)
    ]

    private var operations: [ObjectIdentifier: BonjourDiscoveryOperation] = [:]
    fileprivate static let logPrefix = "[BackendDiscovery]"

    fileprivate static func log(_ message: String) {
        print("\(logPrefix) \(message)")
    }

    @objc func discoverBackends(_ call: CAPPluginCall) {
        let timeoutMs = max(500, min(call.getInt("timeoutMs") ?? 3000, 10000))
        Self.log("discoverBackends requested timeoutMs=\(timeoutMs)")
        let operation = BonjourDiscoveryOperation(timeoutMs: timeoutMs) { [weak self] operation, backends in
            self?.operations.removeValue(forKey: ObjectIdentifier(operation))
            Self.log("discoverBackends resolved count=\(backends.count) backends=\(backends)")
            call.resolve(["backends": backends])
        }
        operations[ObjectIdentifier(operation)] = operation
        operation.start()
    }
}

final class BonjourDiscoveryOperation {
    private struct BrowseTarget {
        let type: String
        let domain: String
    }

    private static let browseTargets: [BrowseTarget] = [
        BrowseTarget(type: "_t3code._tcp", domain: "local."),
        BrowseTarget(type: "_t3code._tcp", domain: ""),
    ]

    private let timeoutMs: Int
    private let completion: (BonjourDiscoveryOperation, [[String: Any]]) -> Void
    private var timer: Timer?
    private var backends: [String: [String: Any]] = [:]
    private var browsers: [NWBrowser] = []
    private var finished = false

    init(timeoutMs: Int, completion: @escaping (BonjourDiscoveryOperation, [[String: Any]]) -> Void) {
        self.timeoutMs = timeoutMs
        self.completion = completion
    }

    func start() {
        DispatchQueue.main.async {
            BackendDiscoveryPlugin.log("starting Bonjour browse targets=\(Self.browseTargets.map { "\($0.type)@\($0.domain)" })")
            self.browsers = Self.browseTargets.map { target in
                let parameters = NWParameters.tcp
                parameters.includePeerToPeer = true
                let browser = NWBrowser(
                    for: .bonjourWithTXTRecord(type: target.type, domain: target.domain),
                    using: parameters
                )
                browser.stateUpdateHandler = { state in
                    BackendDiscoveryPlugin.log("browser state target=\(target.type)@\(target.domain) state=\(String(describing: state))")
                }
                browser.browseResultsChangedHandler = { [weak self] results, _ in
                    self?.consumeBrowseResults(results)
                }
                browser.start(queue: .main)
                return browser
            }
            self.scheduleTimer(delayMs: self.timeoutMs)
        }
    }

    private func consumeBrowseResults(_ results: Set<NWBrowser.Result>) {
        for result in results {
            guard case let .service(name, type, domain, _) = result.endpoint else {
                continue
            }

            let key = "\(name)|\(type)|\(domain)"
            BackendDiscoveryPlugin.log("found browser result key=\(key) metadata=\(result.metadata.debugDescription)")

            if let backend = Self.backend(from: result, serviceName: name) {
                backends["\(backend["protocol"] ?? "ws"):\(backend["host"] ?? ""):\(backend["port"] ?? 0):\(backend["name"] ?? name)"] = backend
                BackendDiscoveryPlugin.log("using browser metadata backend key=\(key) backend=\(backend)")
            }
        }
    }

    private func scheduleTimer(delayMs: Int) {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: TimeInterval(Double(delayMs) / 1000.0), repeats: false) { [weak self] _ in
            self?.finish()
        }
    }

    private static func isUsableHost(_ host: String) -> Bool {
        let normalized = host.lowercased()
        return normalized != "127.0.0.1" && normalized != "::1" && normalized != "localhost"
    }

    private func finish() {
        if finished {
            return
        }
        finished = true
        timer?.invalidate()
        BackendDiscoveryPlugin.log("browse window expired")
        for browser in browsers {
            browser.cancel()
        }
        browsers.removeAll()
        let sortedBackends = backends.values.sorted {
            let leftName = ($0["name"] as? String ?? "")
            let rightName = ($1["name"] as? String ?? "")
            if leftName != rightName {
                return leftName.localizedCaseInsensitiveCompare(rightName) == .orderedAscending
            }
            let leftHost = ($0["host"] as? String ?? "")
            let rightHost = ($1["host"] as? String ?? "")
            if leftHost != rightHost {
                return leftHost.localizedCaseInsensitiveCompare(rightHost) == .orderedAscending
            }
            return ($0["port"] as? Int ?? 0) < ($1["port"] as? Int ?? 0)
        }
        BackendDiscoveryPlugin.log("finish count=\(sortedBackends.count) backends=\(sortedBackends)")
        completion(self, sortedBackends)
    }
}

private extension BonjourDiscoveryOperation {
    static func backend(from result: NWBrowser.Result, serviceName: String) -> [String: Any]? {
        guard case let .bonjour(txtRecord) = result.metadata else {
            return nil
        }

        guard
            let hostEntry = txtRecord.getEntry(for: "host"),
            let host = stringValue(from: hostEntry)?
                .trimmingCharacters(in: CharacterSet(charactersIn: ".")),
            !host.isEmpty,
            isUsableHost(host),
            let portEntry = txtRecord.getEntry(for: "port"),
            let portString = stringValue(from: portEntry),
            let port = Int(portString),
            port >= 1,
            port <= 65_535
        else {
            return nil
        }

        let protocolValue = stringValue(from: txtRecord.getEntry(for: "protocol")) == "wss" ? "wss" : "ws"
        return [
            "name": serviceName,
            "host": host,
            "port": port,
            "protocol": protocolValue,
        ]
    }

    static func stringValue(from entry: NWTXTRecord.Entry?) -> String? {
        guard let entry else {
            return nil
        }

        switch entry {
        case .string(let value):
            return value
        case .none, .empty:
            return nil
        @unknown default:
            return nil
        }
    }
}
