import * as vscode from 'vscode';
import { WebviewBridge } from './webviewBridge';

export class SidebarProvider implements vscode.WebviewViewProvider {
  private onVisibilityChangeCallback?: (visible: boolean) => void;
  private webviewView?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly bridge: WebviewBridge
  ) {}

  /**
   * Register callback to be notified when sidebar visibility changes
   */
  onVisibilityChange(callback: (visible: boolean) => void): void {
    this.onVisibilityChangeCallback = callback;
  }

  /**
   * Current sidebar visibility. Used to initialise a freshly-created poller
   * (e.g. after an org/project switch) since visibility events only fire on
   * an actual change, not when a new poller is wired up.
   */
  isVisible(): boolean {
    return this.webviewView?.visible ?? false;
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.webviewView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'icons'),
      ],
    };

    // Wait for FME to be ready (with 1s timeout) to get correct theme variation
    const { waitForFmeReady, getWebviewThemeVariation } = await import('../fme/fmeClient');
    await waitForFmeReady(1000);
    const themeVariation = getWebviewThemeVariation();

    // HTML must be set first so the webview script loads and sends WEBVIEW_READY
    // before the bridge flushes its queued messages.
    webviewView.webview.html = this.getHtml(webviewView.webview, themeVariation);
    this.bridge.setView(webviewView);

    // Track visibility changes and notify callback
    webviewView.onDidChangeVisibility(() => {
      if (this.onVisibilityChangeCallback) {
        this.onVisibilityChangeCallback(webviewView.visible);
      }
    });

    // Notify initial visibility state
    if (this.onVisibilityChangeCallback) {
      this.onVisibilityChangeCallback(webviewView.visible);
    }
  }

  private getHtml(webview: vscode.Webview, themeVariation: 'simple' | 'enhanced'): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css')
    );
    const aiBarStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'ai-bar.css')
    );

    const nonce = Array.from({ length: 16 }, () =>
      Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
    ).join('');

    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'icons', 'harness-logo.png')
    );

    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src 'nonce-${nonce}';
             img-src ${webview.cspSource} data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <link rel="stylesheet" href="${aiBarStyleUri}">
  <title>Harness</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    window.__HARNESS_LOGO__ = "${logoUri}";
    window.__THEME_VARIATION__ = "${themeVariation}";
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
