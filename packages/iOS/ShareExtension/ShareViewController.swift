import UIKit
import SwiftUI

class ShareViewController: UIViewController {

    override func viewDidLoad() {
        super.viewDidLoad()

        guard let extensionItem = extensionContext?.inputItems.first as? NSExtensionItem,
              let itemProviders = extensionItem.attachments, !itemProviders.isEmpty else {
            cancel()
            return
        }

        let shareView = ShareNavigationView(
            itemProviders: itemProviders,
            onComplete: { [weak self] in self?.complete() },
            onCancel: { [weak self] in self?.cancel() },
            onOpenApp: { [weak self] url in self?.openApp(url: url) }
        )

        let hostingController = UIHostingController(rootView: shareView)
        addChild(hostingController)
        view.addSubview(hostingController.view)
        hostingController.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            hostingController.view.topAnchor.constraint(equalTo: view.topAnchor),
            hostingController.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            hostingController.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hostingController.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        hostingController.didMove(toParent: self)
    }

    private func complete() {
        extensionContext?.completeRequest(returningItems: nil)
    }

    private func cancel() {
        extensionContext?.cancelRequest(withError: NSError(domain: "ShareExtension", code: 0, userInfo: nil))
    }

    private func openApp(url: URL) {
        // Open the containing app — do NOT call completeRequest, system handles dismissal
        extensionContext?.open(url, completionHandler: nil)
    }
}
