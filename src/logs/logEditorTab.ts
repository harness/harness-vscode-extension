import * as vscode from 'vscode';
import { LogContentProvider, logUri, revealLogEnd } from './logContentProvider';
import { formatLogContent, type StepLogInfo } from './logFormat';
import { logger } from '../utils/logger';
import { stripAnsiFromLines } from '../utils/ansiStrip';

export const LOG_SCHEME = 'harness-log';
export type { StepLogInfo };

export function formatContent(info: StepLogInfo): string {
  return formatLogContent({ ...info, logLines: stripAnsiFromLines(info.logLines) });
}

export function stepKey(info: StepLogInfo): string {
  return `${info.planExecutionId}/${info.stageName}/${info.stepName}`
    .replace(/[^a-zA-Z0-9/_-]/g, '-')
    .toLowerCase();
}

export async function openLogAsEditorTab(
  info: StepLogInfo,
  provider: LogContentProvider,
  options?: { follow?: boolean },
): Promise<void> {
  logger.debug('LogEditorTab', 'Opening log for:', {
    stepName: info.stepName,
    stageName: info.stageName,
    logLinesCount: info.logLines.length,
  });

  if (!info.logLines || info.logLines.length === 0) {
    logger.warn('LogEditorTab', 'No log lines provided!');
  }

  const key = stepKey(info);
  const content = formatContent(info);

  logger.debug('LogEditorTab', 'Generated content:', {
    key,
    contentLength: content.length,
    contentPreview: content.substring(0, 200),
  });

  // Store with .log extension for consistency
  const keyWithExt = `${key}.log`;
  provider.setLog(keyWithExt, content);

  const uri = logUri(keyWithExt);
  logger.debug('LogEditorTab', 'Opening URI:', uri.toString(), '→ path:', uri.path);

  const doc = await vscode.workspace.openTextDocument(uri);

  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Two,
    preserveFocus: true, // Keep sidebar visible/focused so poller continues
    preview: false,
  });

  // Try to apply log language for syntax highlighting
  try {
    await vscode.languages.setTextDocumentLanguage(doc, 'harness-log');
  } catch {
    // Language not registered yet - plaintext is fine
    try {
      await vscode.languages.setTextDocumentLanguage(doc, 'log');
    } catch {
      // Neither available - plaintext fallback
    }
  }

  // A live step opens on its newest line. Later updates only follow while the
  // viewport is still sitting at the bottom.
  if (options?.follow) revealLogEnd(uri);
}
