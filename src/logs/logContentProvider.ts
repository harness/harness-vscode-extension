import * as vscode from 'vscode';
import { logger } from '../utils/logger';

export const LOG_SCHEME = 'harness-log';

// The change event must name the exact URI of the open tab, or VS Code
// never re-reads it. Keys live entirely in the path, never the authority.
export function logUri(key: string): vscode.Uri {
  return vscode.Uri.from({ scheme: LOG_SCHEME, path: `/${key}` });
}

const NEAR_BOTTOM_LINES = 3;

function visibleEditor(uri: vscode.Uri): vscode.TextEditor | undefined {
  return vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === uri.toString());
}

function isNearBottom(editor: vscode.TextEditor): boolean {
  const range = editor.visibleRanges[0];
  if (!range) return true;
  return editor.document.lineCount - 1 - range.end.line <= NEAR_BOTTOM_LINES;
}

function pinToBottom(editor: vscode.TextEditor): void {
  const last = Math.max(0, editor.document.lineCount - 1);
  const range = editor.visibleRanges[0];
  const height = range ? Math.max(1, range.end.line - range.start.line) : 1;
  const top = Math.max(0, last - height + 1);
  editor.revealRange(new vscode.Range(top, 0, last, 0), vscode.TextEditorRevealType.AtTop);
}

export function revealLogEnd(uri: vscode.Uri): void {
  const editor = visibleEditor(uri);
  if (editor) pinToBottom(editor);
}

export class LogContentProvider implements vscode.TextDocumentContentProvider {
  private logs = new Map<string, string>();
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  setLog(key: string, content: string, options?: { follow?: boolean }): void {
    const uri = logUri(key);
    const editor = options?.follow ? visibleEditor(uri) : undefined;
    const follow = !!editor && isNearBottom(editor);
    this.logs.set(key, content);
    this._onDidChange.fire(uri);
    if (!follow) return;

    // The document is re-read after the change event. Pin once that lands,
    // and drop the listener if the content did not actually change.
    let timer: ReturnType<typeof setTimeout>;
    const sub = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.toString() !== uri.toString()) return;
      sub.dispose();
      clearTimeout(timer);
      const updated = visibleEditor(uri);
      if (updated) pinToBottom(updated);
    });
    timer = setTimeout(() => sub.dispose(), 1000);
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
