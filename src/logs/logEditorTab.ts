import * as vscode from 'vscode';
import { LogContentProvider } from './logContentProvider';
import { logger } from '../utils/logger';
import { stripAnsiFromLines } from '../utils/ansiStrip';

export const LOG_SCHEME = 'harness-log';

export interface LogLine {
  lineNumber: number;
  timestamp: string;
  level: 'INFO' | 'DEBUG' | 'WARN' | 'ERROR' | 'SUCCESS' | 'UNKNOWN';
  message: string;
}

export interface StepLogInfo {
  stepName: string;
  stageName: string;
  pipelineName: string;
  planExecutionId: string;
  status: 'FAILED' | 'SUCCESS' | 'RUNNING' | 'SKIPPED' | 'IGNOREFAILED';
  durationMs?: number;
  logLines: string[];
}

function parseLogLine(rawLine: string, lineNum: number): LogLine {
  // Try to extract timestamp and level from common log formats
  // Format 1: "2024-01-15 10:30:45 INFO message"
  // Format 2: "[INFO] message"
  // Format 3: "plain message"

  const timestampMatch = rawLine.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
  const timestamp = timestampMatch ? timestampMatch[1] : '';

  let level: LogLine['level'] = 'UNKNOWN';
  let message = rawLine;

  // Check for log level indicators
  if (/\b(ERROR|ERRO|FAIL|FATAL)\b/i.test(rawLine)) {
    level = 'ERROR';
  } else if (/\b(WARN|WARNING)\b/i.test(rawLine)) {
    level = 'WARN';
  } else if (/\b(SUCCESS|PASS|DONE|✓)\b/i.test(rawLine)) {
    level = 'SUCCESS';
  } else if (/\b(DEBUG|TRACE)\b/i.test(rawLine)) {
    level = 'DEBUG';
  } else if (/\bINFO\b/i.test(rawLine)) {
    level = 'INFO';
  }

  return {
    lineNumber: lineNum,
    timestamp: timestamp || new Date().toISOString().substring(11, 19),
    level,
    message: message.trim(),
  };
}

function formatContent(info: StepLogInfo): string {
  const statusIcon =
    info.status === 'FAILED' ? '✗' :
    info.status === 'SUCCESS' ? '✓' :
    info.status === 'RUNNING' ? '▶' :
    info.status === 'IGNOREFAILED' ? '⚠' : '–';

  // Strip ANSI color codes from log lines
  const cleanLines = stripAnsiFromLines(info.logLines);

  const header = [
    `# ${statusIcon}  ${info.pipelineName}  ›  ${info.stageName}  ›  ${info.stepName}`,
    `#    execution: ${info.planExecutionId}`,
    info.durationMs ? `#    duration:  ${(info.durationMs / 1000).toFixed(1)}s` : '',
    `#    status:    ${info.status}`,
    `#    lines:     ${cleanLines.length}`,
    `# ${'─'.repeat(74)}`,
    '',
  ].filter(Boolean).join('\n');

  const parsedLines = cleanLines.map((line, idx) => parseLogLine(line, idx + 1));

  const body = parsedLines
    .map(l => {
      const ln = String(l.lineNumber).padStart(5);
      const ts = l.timestamp.padEnd(12);
      const lv = l.level.padEnd(7);
      return `${ln}  ${ts}  ${lv}  ${l.message}`;
    })
    .join('\n');

  return header + body;
}

function stepKey(info: StepLogInfo): string {
  return `${info.planExecutionId}/${info.stageName}/${info.stepName}`
    .replace(/[^a-zA-Z0-9/_-]/g, '-')
    .toLowerCase();
}

export async function openLogAsEditorTab(
  info: StepLogInfo,
  provider: LogContentProvider
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

  // Build URI using vscode.Uri.from for proper encoding
  const uri = vscode.Uri.from({
    scheme: LOG_SCHEME,
    path: `/${keyWithExt}`,
  });
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
}
