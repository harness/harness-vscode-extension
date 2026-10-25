// Completed-step logs follow the Harness CLI: GET the raw gateway blob for
// every unit, and retry a few times only when the step just finished.

export interface CompletedLogUnit {
  key: string;
  unit: string;
}

export interface CompletedLogConfig {
  baseUrl: string;
  accountIdentifier: string;
  apiKey: string;
}

export interface CompletedLogDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Used when the gateway blob endpoint rejects a key. */
  fallback?: (key: string) => Promise<string[]>;
  debug?: (message: string, extra?: Record<string, unknown>) => void;
}

const RETRY_WINDOW_MS = 60_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;
const BLOB_TIMEOUT_MS = 30_000;

export function parseLogLines(text: string): string[] {
  return text.split('\n')
    .map(line => {
      try {
        const obj = JSON.parse(line) as { out?: string; args?: string; message?: string };
        return (obj.out ?? obj.args ?? obj.message ?? '').trimEnd();
      } catch {
        return line.trimEnd();
      }
    })
    .filter(line => line.length > 0);
}

export function combineUnitLogs(units: CompletedLogUnit[], parts: string[][]): string[] {
  const present = units
    .map((unit, index) => ({ unit, lines: parts[index] ?? [] }))
    .filter(item => item.lines.length > 0);
  const lines: string[] = [];
  for (const item of present) {
    if (present.length > 1) lines.push(`== ${item.unit.unit} ==`);
    lines.push(...item.lines);
  }
  return lines;
}

export function gatewayBlobUrl(config: CompletedLogConfig, key: string): string {
  const base = config.baseUrl.replace(/\/$/, '');
  const query = new URLSearchParams({
    accountID: config.accountIdentifier,
    key,
  });
  return `${base}/gateway/log-service/blob?${query.toString()}`;
}

export async function fetchCompletedLogs(
  config: CompletedLogConfig,
  units: CompletedLogUnit[],
  options: { endTs?: number | null } = {},
  deps: CompletedLogDeps = {},
): Promise<string[]> {
  const parts: string[][] = [];
  for (const unit of units) {
    if (!unit.key) {
      parts.push([]);
      continue;
    }
    const blob = await fetchGatewayBlob(config, unit.key, options.endTs, deps);
    if (blob === 'fallback') {
      deps.debug?.('gateway blob unavailable, using legacy fetch', { unit: unit.unit });
      parts.push(deps.fallback ? await deps.fallback(unit.key) : []);
    } else {
      parts.push(parseLogLines(blob));
    }
  }
  return combineUnitLogs(units, parts);
}

async function fetchGatewayBlob(
  config: CompletedLogConfig,
  key: string,
  endTs: number | null | undefined,
  deps: CompletedLogDeps,
): Promise<string | 'fallback'> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? delay;
  const now = deps.now ?? Date.now;
  const recent = typeof endTs === 'number' && endTs > 0 && now() - endTs < RETRY_WINDOW_MS;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      if (!recent) break;
      await sleep(RETRY_DELAY_MS);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BLOB_TIMEOUT_MS);
    try {
      const res = await fetchImpl(gatewayBlobUrl(config, key), {
        headers: { 'x-api-key': config.apiKey },
        signal: controller.signal,
      });
      if (!res.ok) {
        deps.debug?.('gateway blob response', { status: res.status, attempt });
        return 'fallback';
      }
      const text = await res.text();
      deps.debug?.('gateway blob response', { status: res.status, attempt, bodyChars: text.trim().length });
      if (text.trim().length > 0) return text;
    } catch (err) {
      deps.debug?.('gateway blob request failed', { attempt, error: String(err) });
      return 'fallback';
    } finally {
      clearTimeout(timer);
    }
  }
  deps.debug?.('gateway blob stayed empty', { recent });
  return 'fallback';
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
