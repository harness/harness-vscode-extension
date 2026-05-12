import * as zlib from 'zlib';
import { HarnessConfig } from '../config/configManager';
import { WebviewBridge } from '../ui/webviewBridge';
import { LayoutNode, ExecutionNode, ExecutionGraph } from './types';
import { logger } from '../utils/logger';

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

/**
 * Extract streaming ZIP (no central directory)
 * Reads local file headers sequentially
 */
async function extractStreamingZip(buf: Buffer): Promise<string> {
  const LOCAL_FILE_SIG = 0x04034b50;
  const parts: string[] = [];
  let offset = 0;

  while (offset < buf.length - 30) {
    // Check for local file header signature
    if (buf.readUInt32LE(offset) !== LOCAL_FILE_SIG) {
      break;
    }

    const method      = buf.readUInt16LE(offset + 8);
    const flags       = buf.readUInt16LE(offset + 6);
    const compSize    = buf.readUInt32LE(offset + 18);
    const uncompSize  = buf.readUInt32LE(offset + 22);
    const fnLen       = buf.readUInt16LE(offset + 26);
    const extraLen    = buf.readUInt16LE(offset + 28);
    const dataStart   = offset + 30 + fnLen + extraLen;
    const bytesAfterDataStart = buf.length - dataStart;

    // Check if bit 3 (0x0008) is set - indicates data descriptor present
    const hasDataDescriptor = (flags & 0x0008) !== 0;

    logger.debug('LogService', `Streaming ZIP entry at ${offset}:`, {
      method,
      hasDataDescriptor,
      compSize,
      uncompSize,
    });

    let actualCompSize = compSize;

    if (compSize === 0 && uncompSize === 0 && hasDataDescriptor) {
      // Scan for data descriptor signature (0x08074b50) or next local file header (0x04034b50)
      const DATA_DESC_SIG = 0x08074b50;
      let searchPos = dataStart;
      let foundDescAt = -1;

      // Search up to 10MB or end of buffer
      const searchLimit = Math.min(dataStart + 10 * 1024 * 1024, buf.length - 16);

      while (searchPos < searchLimit) {
        const sig = buf.readUInt32LE(searchPos);
        if (sig === DATA_DESC_SIG) {
          foundDescAt = searchPos;
          break;
        }
        if (sig === LOCAL_FILE_SIG) {
          // Next entry starts here, descriptor must be just before
          foundDescAt = searchPos - 16; // descriptor is 16 bytes (with sig) or 12 bytes (without)
          break;
        }
        searchPos++;
      }

      if (foundDescAt > dataStart) {
        actualCompSize = foundDescAt - dataStart;
        logger.debug('LogService', `Data descriptor scan: found compSize=${actualCompSize}`);
      } else {
        // Could not find data descriptor
        break;
      }
    }

    if (dataStart + actualCompSize > buf.length) {
      break;
    }

    const compressed = buf.slice(dataStart, dataStart + actualCompSize);

    try {
      let uncompressed: Buffer;

      if (method === 0) {
        // Stored (no compression)
        uncompressed = compressed;
      } else if (method === 8) {
        // Deflate
        uncompressed = await new Promise<Buffer>((resolve, reject) =>
          zlib.inflateRaw(compressed, (e, r) => e ? reject(e) : resolve(r))
        );
      } else {
        // Unknown compression method, skip
        offset = dataStart + actualCompSize;
        continue;
      }

      // Check if nested gzip
      if (uncompressed.length > 2 && uncompressed[0] === 0x1f && uncompressed[1] === 0x8b) {
        const decompressed = await new Promise<Buffer>((resolve, reject) =>
          zlib.gunzip(uncompressed, (e, r) => e ? reject(e) : resolve(r))
        );
        parts.push(decompressed.toString('utf8'));
      } else {
        parts.push(uncompressed.toString('utf8'));
      }
    } catch {
      /* skip corrupt entry */
    }

    offset = dataStart + actualCompSize;
    if (hasDataDescriptor) {
      // Skip past data descriptor (12 or 16 bytes)
      const nextSig = buf.readUInt32LE(offset);
      if (nextSig === 0x08074b50) {
        offset += 16; // signature + crc + compSize + uncompSize
      } else {
        offset += 12; // crc + compSize + uncompSize (no signature)
      }
    }
  }

  return parts.join('\n');
}

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

  if (eocdOffset < 0) {
    // Fall back to streaming ZIP - parse local file headers directly
    return extractStreamingZip(buf);
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  let cdOffset       = buf.readUInt32LE(eocdOffset + 16);

  if (buf.readUInt32LE(cdOffset) !== CD_SIG) {
    return buf.toString('utf8');
  }

  const parts: string[] = [];

  for (let i = 0; i < totalEntries; i++) {
    if (cdOffset + 46 > buf.length) break;
    if (buf.readUInt32LE(cdOffset) !== CD_SIG) break;

    const method      = buf.readUInt16LE(cdOffset + 10);
    const compSize    = buf.readUInt32LE(cdOffset + 20);
    const uncompSize  = buf.readUInt32LE(cdOffset + 24);
    const localOffset = buf.readUInt32LE(cdOffset + 42);
    const fnLen       = buf.readUInt16LE(cdOffset + 28);
    const extraLen    = buf.readUInt16LE(cdOffset + 30);
    const commentLen  = buf.readUInt16LE(cdOffset + 32);

    const localFnLen    = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart     = localOffset + 30 + localFnLen + localExtraLen;
    const compressed    = buf.slice(dataStart, dataStart + compSize);

    try {
      let uncompressed: Buffer;

      if (method === 0) {
        // Stored (no compression)
        uncompressed = compressed;
      } else if (method === 8) {
        // Deflate
        uncompressed = await new Promise<Buffer>((resolve, reject) =>
          zlib.inflateRaw(compressed, (e, r) => e ? reject(e) : resolve(r))
        );
      } else {
        // Unknown compression method, skip
        continue;
      }

      // Check if the uncompressed data is itself gzipped
      if (uncompressed.length > 2 && uncompressed[0] === 0x1f && uncompressed[1] === 0x8b) {
        const decompressed = await new Promise<Buffer>((resolve, reject) =>
          zlib.gunzip(uncompressed, (e, r) => e ? reject(e) : resolve(r))
        );
        parts.push(decompressed.toString('utf8'));
      } else {
        parts.push(uncompressed.toString('utf8'));
      }
    } catch {
      /* skip corrupt entry */
    }

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
    } catch {
      text = buf.toString('utf8');
    }
  }
  // Deflate (raw DEFLATE without gzip wrapper)
  else if (isBinaryData(buf)) {
    // Try inflating as raw DEFLATE
    try {
      const out = await new Promise<Buffer>((resolve, reject) =>
        zlib.inflateRaw(buf, (e, r) => e ? reject(e) : resolve(r))
      );
      text = out.toString('utf8');
    } catch {
      // If that fails, try regular inflate
      try {
        const out = await new Promise<Buffer>((resolve, reject) =>
          zlib.inflate(buf, (e, r) => e ? reject(e) : resolve(r))
        );
        text = out.toString('utf8');
      } catch {
        // Last resort: treat as base64 and decode
        try {
          text = Buffer.from(buf.toString('utf8'), 'base64').toString('utf8');
        } catch {
          // Give up, return empty
          return [];
        }
      }
    }
  }
  // Plain text / NDJSON
  else {
    text = buf.toString('utf8');
  }

  return parseLogLines(text).slice(-200);
}

/**
 * Detect if buffer contains binary data (not plain text)
 * Checks for high ratio of control characters and non-printable bytes
 */
function isBinaryData(buf: Buffer): boolean {
  if (buf.length === 0) return false;

  // Sample first 1KB to check
  const sample = buf.slice(0, Math.min(1024, buf.length));
  let nonPrintable = 0;

  for (const byte of sample) {
    // Count non-printable bytes (excluding common whitespace: \t \n \r)
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0A && byte !== 0x0D) {
      nonPrintable++;
    }
    // High bytes (> 0x7E) can be valid UTF-8, but excessive amounts indicate binary
    if (byte > 0x7E) {
      nonPrintable++;
    }
  }

  // If more than 30% non-printable, likely binary/compressed
  return (nonPrintable / sample.length) > 0.3;
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
  let zipFailed = false;
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
            // If we got 0 lines, mark as failed to try alternative approach
            zipFailed = true;
            logger.debug('LogService', 'ZIP extraction returned 0 lines, will try raw blob');
          }
        }
      }
      clearTimeout(timeoutId);
    } catch (err) {
      clearTimeout(timeoutId);
      zipFailed = true;
      logger.debug('LogService', 'ZIP download/extraction failed:', err);
      // Fall through to alternatives
    }
  } catch {
    zipFailed = true;
    /* fall through to alternatives */
  }

  // ── Approach 1.5: Raw blob (alternative, currently unused) ───────────────
  // Disabled: streaming ZIP parser now handles data descriptors correctly
  // if (zipFailed) { ... }

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
