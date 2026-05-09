import * as zlib from 'zlib';
import { HarnessConfig } from '../config/configManager';
import { WebviewBridge } from '../ui/webviewBridge';
import { LayoutNode, ExecutionNode, ExecutionGraph } from './types';

const TERMINAL_STATUSES = new Set(['SUCCESS', 'FAILED', 'ABORTED', 'SKIPPED', 'EXPIRED']);

// ── Log-service token (needed for stream endpoint) ────────────────────────────
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getLogToken(config: HarnessConfig): Promise<string | null> {
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  try {
    // Add timeout to prevent hanging forever
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout for token fetch

    try {
      const res = await fetch(
        `${config.baseUrl}/log-service/token?accountID=${encodeURIComponent(config.accountIdentifier)}`,
        {
          headers: { 'x-api-key': config.apiKey },
          signal: controller.signal,
        }
      );
      clearTimeout(timeoutId);
      if (!res.ok) return null;
      const text = await res.text();
      cachedToken = text.replace(/^"|"$/g, '').trim();
      tokenExpiresAt = Date.now() + 20 * 60 * 1000;
      return cachedToken;
    } catch (err) {
      clearTimeout(timeoutId);
      return null;
    }
  } catch { return null; }
}

const CONTAINER_STEP_TYPES = new Set([
  'IntegrationStageStepPMS', 'STAGES_STEP', 'NG_EXECUTION',
  'liteEngineTask', 'LITEENGINE_TASK', 'NG_SECTION', 'FORK',
  'PIPELINE_SECTION', 'PIPELINE_STAGE', 'STEP_GROUP', 'CI_STEP_GROUP',
]);

// ── ZIP / gzip extraction ─────────────────────────────────────────────────────

async function extractAllFilesFromZip(buf: Buffer): Promise<string> {
  // Streaming ZIPs have compSize=0 in the local file header.
  // Read actual sizes from the Central Directory at the end of the file.
  // Extracts ALL files (one per sub-step) and concatenates them in order.
  const EOCD_SIG = 0x06054b50;
  const CD_SIG   = 0x02014b50;

  // Find End of Central Directory (scan backwards, handle up to 64KB comment)
  let eocdOffset = -1;
  for (let i = Math.max(0, buf.length - 65558); i <= buf.length - 22; i++) {
    if (buf.readUInt32LE(buf.length - 22 - i) === EOCD_SIG) {
      eocdOffset = buf.length - 22 - i;
      break;
    }
  }

  if (eocdOffset < 0) return buf.toString('utf8');

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  let cdOffset       = buf.readUInt32LE(eocdOffset + 16);
  if (buf.readUInt32LE(cdOffset) !== CD_SIG) return buf.toString('utf8');

  const parts: string[] = [];

  for (let i = 0; i < totalEntries; i++) {
    if (cdOffset + 46 > buf.length) break;
    if (buf.readUInt32LE(cdOffset) !== CD_SIG) break;

    const method      = buf.readUInt16LE(cdOffset + 10);
    const compSize    = buf.readUInt32LE(cdOffset + 20);
    const localOffset = buf.readUInt32LE(cdOffset + 42);
    const fnLen       = buf.readUInt16LE(cdOffset + 28);
    const extraLen    = buf.readUInt16LE(cdOffset + 30);
    const commentLen  = buf.readUInt16LE(cdOffset + 32);

    const localFnLen    = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart     = localOffset + 30 + localFnLen + localExtraLen;
    const compressed    = buf.slice(dataStart, dataStart + compSize);

    try {
      if (method === 0) {
        parts.push(compressed.toString('utf8'));
      } else if (method === 8) {
        const out = await new Promise<Buffer>((resolve, reject) =>
          zlib.inflateRaw(compressed, (e, r) => e ? reject(e) : resolve(r))
        );
        parts.push(out.toString('utf8'));
      }
    } catch { /* skip corrupt entry */ }

    cdOffset += 46 + fnLen + extraLen + commentLen;
  }

  return parts.join('\n');
}

async function decompressAndParse(buf: Buffer): Promise<string[]> {
  let text = '';
  // ZIP
  if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) {
    text = await extractAllFilesFromZip(buf);
  }
  // Gzip
  else if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      const out = await new Promise<Buffer>((resolve, reject) =>
        zlib.gunzip(buf, (e, r) => e ? reject(e) : resolve(r))
      );
      text = out.toString('utf8');
    } catch { text = buf.toString('utf8'); }
  }
  // Plain text / NDJSON
  else {
    text = buf.toString('utf8');
  }
  return parseLogLines(text).slice(-200);
}

function parseLogLines(text: string): string[] {
  return text.split('\n')
    .map(l => {
      try {
        const obj = JSON.parse(l) as { out?: string; args?: string; message?: string };
        return (obj.out ?? obj.args ?? obj.message ?? '').trimEnd();
      } catch {
        return l.trimEnd();
      }
    })
    .filter(l => l.length > 0);
}

// ── Log prefix builder ────────────────────────────────────────────────────────

/**
 * Step-level prefix:
 * ACCOUNT_ID/pipeline/PIPELINE_ID/RUN_SEQUENCE/-PLAN_EXECUTION_ID/STAGE_ID/STEP_ID
 *
 * The logBaseKey already contains this path in the format:
 * accountId:X/orgId:Y/projectId:Z/pipelineId:P/runSequence:N/level0:pipeline/...
 *
 * But the blob/download endpoint wants the key EXACTLY as returned in logBaseKey.
 */

// ── Main fetch function ───────────────────────────────────────────────────────

/**
 * Download logs for a completed step via:
 * POST /gateway/log-service/blob/download?accountID=...&prefix=<logBaseKey>
 * x-api-key: <PAT>
 *
 * Returns a signed URL → download ZIP → extract → parse log lines.
 */
/**
 * Fetch logs for a step. Two approaches:
 * 1. POST /gateway/log-service/blob/download (requires FF SPG_LOG_SERVICE_ENABLE_DOWNLOAD_LOGS)
 * 2. GET /log-service/stream with log-service token (works without FF, for recent runs)
 *
 * Returns [] if logs are unavailable (FF not enabled + stream empty).
 */
export async function fetchStepLogs(
  config: HarnessConfig,
  logBaseKey: string,
): Promise<string[]> {
  // ── Approach 1: blob/download (PAT, requires FF) ──────────────────────────
  try {
    const url = `${config.baseUrl}/gateway/log-service/blob/download` +
      `?accountID=${encodeURIComponent(config.accountIdentifier)}` +
      `&prefix=${encodeURIComponent(logBaseKey)}`;

    // Add timeout to prevent hanging forever
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'x-api-key': config.apiKey, 'content-type': 'application/json' },
        signal: controller.signal,
      });

      if (res.ok) {
        const text = await res.text();
        let downloadUrl: string | null = null;
        try {
          const json = JSON.parse(text) as Record<string, unknown>;
          downloadUrl = (json.link ?? json.url ?? json.resource ?? json.data) as string | null;
        } catch {
          downloadUrl = text.trim().replace(/^"|"$/g, '');
        }

        if (downloadUrl?.startsWith('http')) {
          const dlRes = await fetch(downloadUrl, { signal: controller.signal });
          if (dlRes.ok) {
            const buf = Buffer.from(await dlRes.arrayBuffer());
            const lines = await decompressAndParse(buf);
            clearTimeout(timeoutId);
            if (lines.length > 0) return lines;
          }
        }
      }
      clearTimeout(timeoutId);
    } catch (err) {
      clearTimeout(timeoutId);
      // Fall through to stream
    }
  } catch { /* fall through to stream */ }

  // ── Approach 2: stream endpoint (log-service token, no FF needed) ─────────
  try {
    const token = await getLogToken(config);
    if (token) {
      const qs  = new URLSearchParams({ accountID: config.accountIdentifier, key: logBaseKey }).toString();

      // Add timeout to prevent hanging forever
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

      try {
        const res = await fetch(`${config.baseUrl}/log-service/stream?${qs}`, {
          headers: { 'X-Harness-Token': token },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (res.ok) {
          const lines = parseLogLines(await res.text());
          if (lines.length > 0) return lines.slice(-200);
        }
      } catch (err) {
        clearTimeout(timeoutId);
        // Fall through
      }
    }
  } catch { /* silent */ }

  return [];
}

// ── Step discovery ────────────────────────────────────────────────────────────

export function findLeafStepsWithLogKey(
  graph: ExecutionGraph | null | undefined
): Array<{ nodeId: string; name: string; logBaseKey: string; status: string }> {
  if (!graph?.nodeMap) return [];
  const result: Array<{ nodeId: string; name: string; logBaseKey: string; status: string }> = [];
  for (const [id, node] of Object.entries(graph.nodeMap)) {
    if (node.logBaseKey && node.name && !CONTAINER_STEP_TYPES.has(node.stepType ?? '')) {
      result.push({
        nodeId:     id,
        name:       node.name,
        logBaseKey: node.logBaseKey,
        status:     (node.status ?? '').toUpperCase(),
      });
    }
  }
  return result;
}

export function findActiveSteps(
  graph: ExecutionGraph | null | undefined
): ExecutionNode[] {
  if (!graph?.nodeMap) return [];
  const active = new Set(['RUNNING', 'ASYNC_WAITING', 'TASK_WAITING']);
  return Object.values(graph.nodeMap).filter(
    n => n.status && active.has((n.status as string).toUpperCase()) && n.logBaseKey
  );
}

export function findActiveStage(layoutNodeMap: Record<string, LayoutNode>): LayoutNode | null {
  const active = new Set(['RUNNING', 'ASYNC_WAITING', 'TASK_WAITING']);
  for (const node of Object.values(layoutNodeMap)) {
    if (node.nodeGroup === 'STAGE' && active.has((node.status as string).toUpperCase())) {
      return node;
    }
  }
  return null;
}

export function findFailedStage(layoutNodeMap: Record<string, LayoutNode>): LayoutNode | null {
  for (const node of Object.values(layoutNodeMap)) {
    if (node.nodeGroup === 'STAGE' && (node.status as string).toUpperCase() === 'FAILED') {
      return node;
    }
  }
  return null;
}

// ── Live log streaming (active executions) ────────────────────────────────────

export function streamLogs(
  config: HarnessConfig,
  planExecutionId: string,
  node: { nodeId: string; logBaseKey?: string; status?: string },
  webview: WebviewBridge
): () => void {
  let stopped = false;

  async function poll() {
    if (stopped) return;
    try {
      // For live logs use the same blob/download endpoint — it works for in-progress too
      const logKey = node.logBaseKey;
      if (logKey) {
        const lines = await fetchStepLogs(config, logKey);
        if (lines.length > 0) webview.send({ type: 'LOG_CHUNK', nodeId: node.nodeId, lines });
      }
    } catch { /* silent */ }

    const done = node.status && TERMINAL_STATUSES.has((node.status as string).toUpperCase());
    if (!stopped && !done) setTimeout(poll, 3000);
  }

  poll();
  return () => { stopped = true; };
}
