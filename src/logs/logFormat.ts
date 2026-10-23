// Renders a step log for the editor tab. The editor already numbers rows, so
// the body is the original line. A real timestamp is moved to the front,
// including one written as "at 23:10:01" at the end of the line. A level is
// shown only when the line actually starts with one.

export interface StepLogInfo {
  stepName: string;
  stageName: string;
  pipelineName: string;
  planExecutionId: string;
  status: string;
  durationMs?: number;
  logLines: string[];
  /** Step is still running and this tab is tailing it. */
  live?: boolean;
}

export type LogHeaderStatus = 'FAILED' | 'SUCCESS' | 'RUNNING' | 'SKIPPED' | 'IGNOREFAILED';

const LEVELS: Record<string, string> = {
  ERROR: 'ERROR',
  ERRO: 'ERROR',
  FATAL: 'ERROR',
  WARN: 'WARN',
  WARNING: 'WARN',
  SUCCESS: 'SUCCESS',
  DEBUG: 'DEBUG',
  TRACE: 'DEBUG',
  INFO: 'INFO',
};

export interface ParsedLogLine {
  lineNumber: number;
  time?: string;
  level?: string;
  message: string;
}

/** Header label. Waiting and running spellings share one icon. */
export function displayStatus(status?: string): LogHeaderStatus {
  const normalized = (status ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  if (normalized === 'SUCCESS') return 'SUCCESS';
  if (normalized === 'SKIPPED') return 'SKIPPED';
  if (normalized === 'IGNOREFAILED') return 'IGNOREFAILED';
  if (['FAILED', 'ERRORED', 'ABORTED', 'EXPIRED', 'POLICYEVALUATIONFAILURE'].includes(normalized)) return 'FAILED';
  return 'RUNNING';
}

const CLOCK = String.raw`(?:(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|(\d{2}:\d{2}:\d{2})(?:\.\d+)?)`;

/**
 * A real timestamp, leading or written as "at 23:10:01" at the end, moves to
 * the front. A leading level token is kept. Anything else, including the word
 * "fail" inside a sentence, stays in the message.
 */
export function parseLogLine(rawLine: string, lineNumber: number): ParsedLogLine {
  let message = rawLine.replace(/\s+$/, '');
  let time: string | undefined;
  let level: string | undefined;

  const timestamp = message.match(new RegExp(`^${CLOCK}(?:\\s+|$)`));
  if (timestamp) {
    time = timestamp[2] ?? timestamp[3];
    message = message.slice(timestamp[0].length);
  }

  const levelToken = message.match(/^(?:\[)?(ERROR|ERRO|FATAL|WARN|WARNING|SUCCESS|DEBUG|TRACE|INFO)(?:\])?:?(?=\s|$)/i);
  if (levelToken) {
    level = LEVELS[levelToken[1].toUpperCase()];
    message = message.slice(levelToken[0].length).replace(/^\s+/, '');
  }

  if (!time) {
    const trailing = message.match(new RegExp(String.raw`\s+at\s+${CLOCK}$`, 'i'));
    if (trailing) {
      time = trailing[2] ?? trailing[3];
      message = message.slice(0, trailing.index).trimEnd();
    }
  }

  return { lineNumber, time, level, message };
}

export function formatLogBody(lines: string[]): string {
  return lines.map((line, index) => {
    const parsed = parseLogLine(line, index + 1);
    return [parsed.time, parsed.level, parsed.message].filter(part => part).join(' ');
  }).join('\n');
}

export function formatLogContent(info: StepLogInfo): string {
  const status = displayStatus(info.status);
  const statusIcon =
    status === 'FAILED' ? '✗' :
    status === 'SUCCESS' ? '✓' :
    status === 'RUNNING' ? '▶' :
    status === 'IGNOREFAILED' ? '⚠' : '–';
  const live = info.live && status === 'RUNNING' ? '  ·  live' : '';

  const header = [
    `# ${statusIcon}  ${info.pipelineName}  ›  ${info.stageName}  ›  ${info.stepName}`,
    `#    execution: ${info.planExecutionId}`,
    info.durationMs ? `#    duration:  ${(info.durationMs / 1000).toFixed(1)}s` : null,
    `#    status:    ${status}${live}`,
    `#    lines:     ${info.logLines.length}`,
    `# ${'─'.repeat(74)}`,
  ].filter((line): line is string => line !== null);

  return `${header.join('\n')}\n\n${formatLogBody(info.logLines)}`;
}
