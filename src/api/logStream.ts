// Live step-log tailing. The gateway stream endpoint is the SSE-capable
// sibling of the completed-log blob endpoint (same auth, same account/key
// query shape) — see completedLogs.ts for the one-shot counterpart. The
// Harness CLI reads this same endpoint with Accept: text/event-stream while
// a step is running.
import { Readable } from 'node:stream';
import { parseLogLines } from './completedLogs';

export interface LogStreamConfig {
  baseUrl: string;
  accountIdentifier: string;
  apiKey: string;
}

export interface LogStreamHandlers {
  onLines: (lines: string[]) => void;
  onDone: () => void;
  onError?: (err: unknown) => void;
}

export interface LogStreamDeps {
  fetchImpl?: typeof fetch;
}

export interface LogStreamHandle {
  close: () => void;
}

export function logStreamUrl(config: LogStreamConfig, key: string): string {
  const base = config.baseUrl.replace(/\/$/, '');
  const qs = new URLSearchParams({ accountID: config.accountIdentifier, key });
  return `${base}/gateway/log-service/stream?${qs.toString()}`;
}

/**
 * One line of a tailed response. SSE frames carry a `data:` prefix; plain
 * NDJSON streams do not. Both end up parsed through the same
 * {out,args,message} unwrapping used for completed logs.
 */
function toLogLine(rawLine: string): string | null {
  const line = rawLine.trim();
  if (!line || line.startsWith(':') || line.startsWith('event:') || line.startsWith('id:') || line.startsWith('retry:')) {
    return null;
  }
  const payload = line.startsWith('data:') ? line.slice('data:'.length).trim() : line;
  if (!payload) return null;
  return parseLogLines(payload)[0] ?? null;
}

/** Splits a growing buffer into complete lines plus an unterminated remainder. */
export function consumeStreamBuffer(buffer: string): { lines: string[]; remainder: string } {
  const parts = buffer.split('\n');
  const remainder = parts.pop() ?? '';
  const lines = parts.map(toLogLine).filter((line): line is string => line !== null);
  return { lines, remainder };
}

/**
 * Tails a step's log key over the gateway stream endpoint. Call close() to
 * abort — e.g. once the step reaches a terminal status (plus a short drain).
 * Resolves nothing itself; progress and completion go through `handlers`.
 */
export function openLogStream(
  config: LogStreamConfig,
  key: string,
  handlers: LogStreamHandlers,
  deps: LogStreamDeps = {},
): LogStreamHandle {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  let closed = false;

  (async () => {
    try {
      const res = await fetchImpl(logStreamUrl(config, key), {
        headers: { 'x-api-key': config.apiKey, 'Accept': 'text/event-stream' },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) return;

      let buffer = '';
      const body = Readable.fromWeb(res.body as any);
      for await (const chunk of body) {
        if (closed) break;
        buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        const { lines, remainder } = consumeStreamBuffer(buffer);
        buffer = remainder;
        if (lines.length > 0) handlers.onLines(lines);
      }
      if (!closed && buffer.trim()) {
        const { lines } = consumeStreamBuffer(buffer + '\n');
        if (lines.length > 0) handlers.onLines(lines);
      }
    } catch (err) {
      if (!closed) handlers.onError?.(err);
    } finally {
      if (!closed) handlers.onDone();
    }
  })();

  return {
    close() {
      if (closed) return;
      closed = true;
      controller.abort();
    },
  };
}
