import * as vscode from 'vscode';
import { logger } from '../utils/logger';

export const LOG_SCHEME = 'harness-log';

export class LogContentProvider implements vscode.TextDocumentContentProvider {
  private logs = new Map<string, string>();
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  setLog(key: string, content: string): void {
    this.logs.set(key, content);
    this._onDidChange.fire(vscode.Uri.parse(`${LOG_SCHEME}://${key}`));
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    // The key is stored with .log extension, uri.path includes leading /
    const key = uri.path.substring(1); // Remove leading /
    logger.debug('LogProvider', 'Requesting log:', { uri: uri.toString(), key, authority: uri.authority, path: uri.path });

    const content = this.logs.get(key);
    if (!content) {
      logger.warn('LogProvider', 'No content found for key:', key, 'Available keys:', Array.from(this.logs.keys()));
      return '# No logs available\n\nThis step has no log output.';
    }
    logger.debug('LogProvider', '✓ Returning content:', content.length, 'chars');
    return content;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
