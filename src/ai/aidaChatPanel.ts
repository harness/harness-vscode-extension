import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { ConfigManager } from '../config/configManager';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AidaChatConfig {
  baseUrl: string;
  accountId: string;
  orgId: string;
  projectId: string;
  apiKey: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  thought?: string;
  table?: AidaTable;
  feedbackReasons?: string[];
  interactionId?: string;
  sessionId?: string;
  conversationId?: string;
  elicitation?: ElicitationEvent;
  entityMutation?: EntityMutation;
  isStreaming?: boolean;
}

interface AidaTable {
  columns: { key: string; label: string }[];
  rows: Record<string, string>[];
}

interface ElicitationEvent {
  type: 'yaml' | 'confirm' | 'free_text' | 'select' | 'multi_select' | 'form';
  reviewId: string;
  title: string;
  subtitle: string;
  yaml?: string;
  question?: string;
  summary?: string;
  details?: { label: string; value: string }[];
  entityInfo?: Record<string, unknown>;
  toolInput?: Record<string, unknown>;
  actions: { id: string; label: string; variant: string; sends?: string }[];
  editable?: boolean;
  resolved?: { action_id: string; event_type: string };
}

interface EntityMutation {
  action: string;
  resource_type: string;
  identifier: string;
  name: string;
  org_id: string;
  project_id: string;
  url: string;
}

// Context passed from extension.ts when opening the panel — carries current execution/view state
export interface IntelligenceChatContext {
  // The Harness execution URL (becomes metadata.context.currentUrl in the API request)
  currentUrl?: string;
  // Module hint — 'ci' | 'cd' | 'sto' | 'ai-agents' | 'UNKNOWN' (omit on unified /all/ view)
  module?: string;
  // Optional canned prompt to pre-fill the input
  initialPrompt?: string;
  // Active pipeline/execution for chip label in header
  pipelineName?: string;
  planExecutionId?: string;
}

// ── Panel registry ─────────────────────────────────────────────────────────────

const activePanel: { panel?: vscode.WebviewPanel } = {};

// Push updated context to an already-open chat panel (auto-follow on navigation).
// No-op if the panel isn't open. Lets the extension keep the chat's pipeline
// context in sync as the user navigates to different executions.
export function updateActiveChatContext(chatContext: IntelligenceChatContext): void {
  if (!activePanel.panel) { return; }
  activePanel.panel.webview.postMessage({ type: 'SET_CONTEXT', context: chatContext });
}

/** Keep Harness AI Chat panel in sync when the IDE switches light/dark theme. */
export function updateActiveChatTheme(ideThemeKind: number): void {
  if (!activePanel.panel) { return; }
  activePanel.panel.webview.postMessage({ type: 'IDE_THEME', ideThemeKind });
}

/** Focus the chat input (used by keyboard shortcut when panel is already open). */
function focusChatInput(panel: vscode.WebviewPanel): void {
  panel.webview.postMessage({ type: 'FOCUS_INPUT' });
}

/** Teal Harness diamond in the editor tab (works on light + dark tab bars). */
function setHarnessAiPanelIcon(panel: vscode.WebviewPanel, extensionUri: vscode.Uri): void {
  const icons = vscode.Uri.joinPath(extensionUri, 'icons');
  const diamond = vscode.Uri.joinPath(icons, 'harness-icon.png');
  panel.iconPath = { light: diamond, dark: diamond };
}

/** Wire HTML, message handlers, and initial host→webview messages for a panel. */
async function initAidaChatPanel(
  vsContext: vscode.ExtensionContext,
  configManager: ConfigManager,
  panel: vscode.WebviewPanel,
  chatContext?: IntelligenceChatContext,
  options?: { focusInput?: boolean },
): Promise<void> {
  setHarnessAiPanelIcon(panel, vsContext.extensionUri);
  const cfg = await buildConfig(configManager);

  let markedScript = '';
  try {
    markedScript = fs.readFileSync(path.join(vsContext.extensionPath, 'dist', 'marked.js'), 'utf8');
  } catch (err) {
    logger.warn('AidaChatPanel', 'Could not load marked.js — falling back to basic markdown', err);
  }

  panel.webview.html = buildHtml(panel, cfg, chatContext, markedScript);
  updateActiveChatTheme(vscode.window.activeColorTheme.kind);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === 'CHAT_WEBVIEW_READY') {
      void fetchSelectedConnectorIds(cfg).then((ids) => {
        panel.webview.postMessage({
          type: 'MCP_CONNECTOR_STATUS',
          count: ids.length,
          connectors: ids,
          org: cfg.orgId,
          project: cfg.projectId,
        });
      });
      if (chatContext?.currentUrl || chatContext?.initialPrompt) {
        panel.webview.postMessage({ type: 'SET_CONTEXT', context: chatContext });
      }
      return;
    }
    if (msg.type === 'SEND_MESSAGE') {
      await handleSendMessage(panel, cfg, msg.prompt, msg.conversationId, msg.module, msg.currentUrl, msg.systemEvent);
    } else if (msg.type === 'SUBMIT_FEEDBACK') {
      await submitFeedback(cfg, msg.sentiment, msg.reasons, msg.conversationId, msg.interactionId, msg.sessionId);
    } else if (msg.type === 'LIST_SESSIONS') {
      try {
        const sessions = await fetchSessions(cfg);
        panel.webview.postMessage({ type: 'SESSIONS_LIST', sessions });
      } catch (err) {
        panel.webview.postMessage({ type: 'SESSIONS_ERROR', error: err instanceof Error ? err.message : String(err) });
      }
    } else if (msg.type === 'LOAD_SESSION') {
      try {
        const messages = await fetchSessionMessages(cfg, msg.sessionId);
        panel.webview.postMessage({
          type: 'SESSION_MESSAGES',
          sessionId: msg.sessionId,
          conversationId: msg.conversationId,
          title: msg.title,
          messages,
        });
      } catch (err) {
        panel.webview.postMessage({ type: 'SESSIONS_ERROR', error: err instanceof Error ? err.message : String(err) });
      }
    } else if (msg.type === 'RENAME_SESSION') {
      try {
        await renameSession(cfg, msg.sessionId, msg.title);
        panel.webview.postMessage({ type: 'SESSION_RENAMED', sessionId: msg.sessionId, title: msg.title });
      } catch (err) {
        panel.webview.postMessage({ type: 'SESSIONS_ERROR', error: err instanceof Error ? err.message : String(err) });
      }
    } else if (msg.type === 'CONFIRM_DELETE_SESSION') {
      const choice = await vscode.window.showWarningMessage(
        `Permanently delete "${msg.title}"? This action cannot be undone.`,
        { modal: true },
        'Delete',
      );
      if (choice !== 'Delete') return;
      try {
        await deleteSession(cfg, msg.sessionId);
        panel.webview.postMessage({ type: 'SESSION_DELETED', sessionId: msg.sessionId });
      } catch (err) {
        panel.webview.postMessage({ type: 'SESSIONS_ERROR', error: err instanceof Error ? err.message : String(err) });
      }
    } else if (msg.type === 'FETCH_SESSION_TITLE') {
      try {
        const sessions = await fetchSessions(cfg);
        const match = (sessions as { id?: string; title?: string }[])
          .find(s => s.id === msg.sessionId);
        if (match?.title) {
          panel.webview.postMessage({ type: 'SESSION_TITLE', title: match.title });
        }
      } catch (err) {
        logger.warn('AidaChatPanel', 'Could not fetch session title', err);
      }
    } else if (msg.type === 'COPY_CONVERSATION_ID') {
      await vscode.env.clipboard.writeText(msg.conversationId || '');
      vscode.window.showInformationMessage('Conversation ID copied to clipboard.');
    }
  }, undefined, vsContext.subscriptions);

  if (options?.focusInput !== false) {
    setTimeout(() => focusChatInput(panel), 150);
  }
}

/** Restore Harness AI panel tabs after a window reload (like Claude Code chat). */
export function registerAidaChatPanelSerializer(
  vsContext: vscode.ExtensionContext,
  configManager: ConfigManager,
  /** Optional admin gate: when it resolves false, the restored tab is closed instead of reopened. */
  isAllowed?: () => Promise<boolean>,
): void {
  vsContext.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer('harnessIntelligenceChat', {
      async deserializeWebviewPanel(panel) {
        if (isAllowed && !(await isAllowed())) {
          logger.info('AidaChatPanel', 'Harness AI is disabled by admin; closing restored panel');
          panel.dispose();
          return;
        }
        logger.debug('AidaChatPanel', 'Restoring Harness AI panel after reload');
        activePanel.panel = panel;
        panel.onDidDispose(() => { activePanel.panel = undefined; });
        try {
          await initAidaChatPanel(vsContext, configManager, panel, undefined, { focusInput: false });
        } catch (err) {
          logger.error('AidaChatPanel', 'Failed to restore chat panel:', err);
        }
      },
    }),
  );
}

export async function openAidaChatPanel(
  vsContext: vscode.ExtensionContext,
  configManager: ConfigManager,
  chatContext?: IntelligenceChatContext,
): Promise<void> {
  if (activePanel.panel) {
    activePanel.panel.reveal(vscode.ViewColumn.Beside, false);
    // Update context even if panel already open — send new context to webview
    if (chatContext?.currentUrl || chatContext?.initialPrompt) {
      activePanel.panel.webview.postMessage({ type: 'SET_CONTEXT', context: chatContext });
    }
    focusChatInput(activePanel.panel);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'harnessIntelligenceChat',
    'Harness AI',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    }
  );

  activePanel.panel = panel;
  panel.onDidDispose(() => { activePanel.panel = undefined; });

  await initAidaChatPanel(vsContext, configManager, panel, chatContext);
}

// ── Config ─────────────────────────────────────────────────────────────────────

async function buildConfig(configManager: ConfigManager): Promise<AidaChatConfig> {
  const cfg = await configManager.getConfig();
  return {
    baseUrl: cfg?.baseUrl || 'https://app.harness.io',
    accountId: cfg?.accountIdentifier || '',
    orgId: cfg?.orgIdentifier || '',
    projectId: cfg?.projectIdentifier || '',
    apiKey: cfg?.apiKey || '',
  };
}

// ── SSE streaming ──────────────────────────────────────────────────────────────

async function handleSendMessage(
  panel: vscode.WebviewPanel,
  cfg: AidaChatConfig,
  prompt: string,
  conversationId: string | undefined,
  module: string | undefined,
  currentUrl: string | undefined,
  systemEvent: unknown | undefined,
): Promise<void> {
  const now = new Date();
  const metadata: Record<string, unknown> = {
    action: 'UNKNOWN',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    localtimeISO: now.toISOString(),
    utctimeISO: now.toUTCString(),
    epochMs: String(now.getTime()),
  };
  if (module && module !== 'all') { metadata.module = module; }

  const body: Record<string, unknown> = {
    prompt,
    metadata,
    conversation: [],
    stream: true,
  };
  if (currentUrl) { body.context = { currentUrl }; }
  if (conversationId) { body.conversation_id = conversationId; }
  if (systemEvent) { body.system_event = systemEvent; }

  const url = `${cfg.baseUrl}/gateway/harness-intelligence/api/v2/chat?is_v2=false&orgIdentifier=${encodeURIComponent(cfg.orgId)}&projectIdentifier=${encodeURIComponent(cfg.projectId)}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'harness-account': cfg.accountId,
        'x-api-key': cfg.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      panel.webview.postMessage({
        type: 'STREAM_ERROR',
        error: `HTTP ${response.status}: ${response.statusText}`,
      });
      return;
    }

    panel.webview.postMessage({ type: 'STREAM_START' });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) { break; }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const raw = line.slice(6).trim();
          let data: unknown = raw;
          try { data = JSON.parse(raw); } catch { /* keep as string */ }

          panel.webview.postMessage({ type: 'STREAM_EVENT', event: currentEvent, data });
          currentEvent = '';
        }
      }
    }

    panel.webview.postMessage({ type: 'STREAM_END' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('AidaChatPanel', 'Stream error:', msg);
    panel.webview.postMessage({ type: 'STREAM_ERROR', error: msg });
  }
}

// ── Feedback ───────────────────────────────────────────────────────────────────

async function submitFeedback(
  cfg: AidaChatConfig,
  sentiment: 'positive' | 'negative',
  reasons: string[],
  conversationId: string,
  interactionId: string,
  sessionId: string,
): Promise<void> {
  try {
    await fetch(
      `${cfg.baseUrl}/gateway/harness-intelligence/api/v1/chat/feedback?orgIdentifier=${encodeURIComponent(cfg.orgId)}&projectIdentifier=${encodeURIComponent(cfg.projectId)}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'harness-account': cfg.accountId,
          'x-api-key': cfg.apiKey,
        },
        body: JSON.stringify({ sentiment, reasons, comment: '', conversation_id: conversationId, interaction_id: interactionId, session_id: sessionId }),
      }
    );
  } catch (err) {
    logger.debug('AidaChatPanel', 'Feedback error:', err);
  }
}

// ── Session management ───────────────────────────────────────────────────────────

// GET the MCP connector IDs the user has selected for this org/project.
// The setting is per-user-per-project; an empty value means no external MCP
// tools are available in chat for the current project. Returns [] on any error
// so a failed read never surfaces a misleading hint.
async function fetchSelectedConnectorIds(cfg: AidaChatConfig): Promise<string[]> {
  const url = `${cfg.baseUrl}/gateway/harness-intelligence/api/v1/user-settings/selected_connector_ids?orgIdentifier=${encodeURIComponent(cfg.orgId)}&projectIdentifier=${encodeURIComponent(cfg.projectId)}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'harness-account': cfg.accountId, 'x-api-key': cfg.apiKey },
    });
    if (!res.ok) { return []; }
    const data = await res.json() as { value?: string };
    return (data.value || '').split(',').map(s => s.trim()).filter(Boolean);
  } catch (err) {
    logger.warn('AidaChatPanel', 'Could not fetch selected MCP connectors', err);
    return [];
  }
}

// GET all sessions for the authenticated user (across orgs/projects).
async function fetchSessions(cfg: AidaChatConfig, page = 0, size = 50): Promise<unknown[]> {
  const url = `${cfg.baseUrl}/gateway/harness-intelligence/api/v1/chat/sessions?includev2messages=true&page=${page}&size=${size}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'harness-account': cfg.accountId, 'x-api-key': cfg.apiKey },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// GET the full message history for one session (use session.id, not conversation_id).
async function fetchSessionMessages(cfg: AidaChatConfig, sessionId: string, page = 0, size = 100): Promise<unknown[]> {
  const url = `${cfg.baseUrl}/gateway/harness-intelligence/api/v2/chat/sessions/${encodeURIComponent(sessionId)}/messages?page=${page}&size=${size}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'harness-account': cfg.accountId, 'x-api-key': cfg.apiKey },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// PUT — rename a session. Endpoint verified via se3.harness.io capture.
async function renameSession(cfg: AidaChatConfig, sessionId: string, title: string): Promise<void> {
  const url = `${cfg.baseUrl}/gateway/harness-intelligence/api/v1/chat/sessions/${encodeURIComponent(sessionId)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'harness-account': cfg.accountId, 'x-api-key': cfg.apiKey },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
}

// DELETE — permanently delete a session. Endpoint verified via se3.harness.io capture.
async function deleteSession(cfg: AidaChatConfig, sessionId: string): Promise<void> {
  const url = `${cfg.baseUrl}/gateway/harness-intelligence/api/v1/chat/sessions/${encodeURIComponent(sessionId)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'harness-account': cfg.accountId, 'x-api-key': cfg.apiKey },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
}

// ── HTML ───────────────────────────────────────────────────────────────────────

function buildHtml(_panel: vscode.WebviewPanel, cfg: AidaChatConfig, chatContext?: IntelligenceChatContext, markedScript?: string): string {
  const ideThemeKind = vscode.window.activeColorTheme.kind;
  const isLightTheme = ideThemeKind === vscode.ColorThemeKind.Light
    || ideThemeKind === vscode.ColorThemeKind.HighContrastLight;
  const themeAttr = isLightTheme ? 'light' : 'dark';

  const nonce = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2);
  const csp = [
    `default-src 'none'`,
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `connect-src ${cfg.baseUrl}`,
  ].join('; ');

  // Default currentUrl: worker-agents page (gives AIDA module context for ai-agents)
  const defaultUrl = `${cfg.baseUrl}/ng/account/${cfg.accountId}/module/ai-agents/orgs/${cfg.orgId}/projects/${cfg.projectId}/worker-agents`;
  const cfgJson = JSON.stringify({
    baseUrl: cfg.baseUrl,
    accountId: cfg.accountId,
    orgId: cfg.orgId,
    projectId: cfg.projectId,
    module: chatContext?.module || 'ai-agents',
    currentUrl: chatContext?.currentUrl || defaultUrl,
    pipelineName: chatContext?.pipelineName || null,
    planExecutionId: chatContext?.planExecutionId || null,
  });

  const bodyClass = `theme-enhanced ${isLightTheme ? 'theme-light' : 'theme-dark'}`;

  return `<!DOCTYPE html>
<html lang="en" data-theme="${themeAttr}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Harness AI</title>
<style nonce="${nonce}">
${CSS}
</style>
</head>
<body class="${bodyClass}">
${HEADER_HTML}
<div id="ac-error-bar" style="display:none;background:#a1260d;color:#fff;font-size:12px;padding:6px 12px;white-space:pre-wrap;"></div>
<div class="ac-messages" id="ac-messages">
${GREETING_HTML}
</div>
${HISTORY_HTML}
${INPUT_HTML}
<div class="ac-disclaimer" id="ac-disclaimer">Harness AI can make mistakes. Check answers.</div>
<div class="ac-mcp-popover" id="ac-mcp-popover" role="tooltip" aria-hidden="true"></div>

${markedScript ? `<script nonce="${nonce}">${markedScript}</script>` : ''}
<script nonce="${nonce}">
// Surface any runtime error visibly so failures never silently disable the UI
window.onerror = function (message, source, lineno, colno) {
  try {
    var bar = document.getElementById('ac-error-bar');
    if (bar) {
      bar.textContent = 'Script error: ' + message + ' (line ' + lineno + ':' + colno + ')';
      bar.style.display = 'block';
    }
    var sb = document.getElementById('ac-send');
    var ta = document.getElementById('ac-textarea');
    if (sb) sb.disabled = false;
    if (ta) ta.disabled = false;
  } catch (e) { /* noop */ }
  return false;
};

const vscode = acquireVsCodeApi();
const CFG = ${cfgJson};
const GREETING_INNER = document.getElementById('ac-messages').innerHTML;

// ── State ──────────────────────────────────────────────────────────────────────
let conversationId = undefined;
let sessionId = undefined;
let interactionId = undefined;
let isStreaming = false;
let pendingThought = '';
let pendingText = '';
let pendingTable = null;
let feedbackReasons = [];
let currentAssistantEl = null;
let pendingElicitation = null;
// When the user removes the pipeline-context chip, we stop sending currentUrl
// until new context arrives (navigating re-attaches it).
let contextCleared = false;
let mcpConnectorCount = 0;
let mcpConnectors = [];
let mcpPopoverHideTimer = null;
let persistTimer = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const messagesEl = document.getElementById('ac-messages');
const textarea   = document.getElementById('ac-textarea');
const sendBtn    = document.getElementById('ac-send');
const form       = document.getElementById('ac-form');

function persistChatState() {
  const hasGreeting = !!messagesEl.querySelector('.ac-greeting-wrap');
  const hasMessages = !hasGreeting && messagesEl.childElementCount > 0;
  vscode.setState({
    v: 1,
    conversationId,
    sessionId,
    interactionId,
    currentChatTitle,
    viewMode,
    contextCleared,
    chatContext: {
      currentUrl: CFG.currentUrl,
      module: CFG.module,
      pipelineName: CFG.pipelineName,
      planExecutionId: CFG.planExecutionId,
    },
    hasMessages,
    // Fallback when the backend hasn't assigned a session id yet.
    messagesHtml: hasMessages && !sessionId ? messagesEl.innerHTML : undefined,
  });
}

function schedulePersistChatState() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistChatState, 150);
}

function restoreFromSavedState(saved) {
  if (!saved || saved.v !== 1) return false;

  conversationId = saved.conversationId;
  sessionId = saved.sessionId;
  interactionId = saved.interactionId;
  contextCleared = !!saved.contextCleared;

  if (saved.currentChatTitle) setChatTitle(saved.currentChatTitle);
  else clearChatTitle();

  if (saved.chatContext) {
    const ctx = saved.chatContext;
    if (ctx.currentUrl) CFG.currentUrl = ctx.currentUrl;
    if (ctx.module) CFG.module = ctx.module;
    if (ctx.pipelineName != null) CFG.pipelineName = ctx.pipelineName;
    if (ctx.planExecutionId != null) CFG.planExecutionId = ctx.planExecutionId;
    renderContextChip(ctx.pipelineName, false);
  }

  if (saved.viewMode === 'history') {
    showHistoryView();
    schedulePersistChatState();
    return true;
  }

  showChatView();
  if (saved.sessionId) {
    messagesEl.innerHTML = '<div class="ac-history-empty">Restoring conversation…</div>';
    vscode.postMessage({
      type: 'LOAD_SESSION',
      sessionId: saved.sessionId,
      conversationId: saved.conversationId,
      title: saved.currentChatTitle,
    });
  } else if (saved.hasMessages && saved.messagesHtml) {
    messagesEl.innerHTML = saved.messagesHtml;
  } else {
    messagesEl.innerHTML = GREETING_INNER;
  }

  schedulePersistChatState();
  return true;
}

// Platform-aware focus shortcut hint in disclaimer
(function () {
  const disc = document.getElementById('ac-disclaimer');
  if (disc) {
    const mod = /Mac|iPhone|iPad/i.test(navigator.platform) ? '⌘' : 'Ctrl+';
    disc.textContent = 'Harness AI can make mistakes. Check answers. · ' + mod + '⇧H to focus';
  }
})();

// ── New chat reset ────────────────────────────────────────────────────────────
document.getElementById('ac-new-chat').addEventListener('click', () => {
  clearChatTitle();
  showChatView();
  conversationId = undefined;
  sessionId = undefined;
  interactionId = undefined;
  pendingThought = '';
  pendingText = '';
  messagesEl.innerHTML = GREETING_INNER;
  textarea.value = '';
  sendBtn.disabled = true;
  isStreaming = false;
  setSendState(false);
  // Hide context chip
  const chip = document.getElementById('ac-context-chip');
  if (chip) chip.style.display = 'none';
  schedulePersistChatState();
});

// ── History: overflow menu, view toggle, session list ──────────────────────────
const historyEl       = document.getElementById('ac-history');
const historyListEl    = document.getElementById('ac-history-list');
const historySearchEl  = document.getElementById('ac-history-search');
const overflowBtn      = document.getElementById('ac-overflow');
const overflowMenu     = document.getElementById('ac-overflow-menu');
const historyBackBtn   = document.getElementById('ac-history-back');
const headerTitleEl    = document.getElementById('ac-header-title');
const inputWrapEl      = document.querySelector('.ac-input-wrapper');
const disclaimerEl     = document.getElementById('ac-disclaimer');
let allSessions = [];        // cached session list
let openRowMenu = null;      // currently open per-row menu element
let currentChatTitle = '';
let viewMode = 'chat';       // 'chat' | 'history'

function updateHeaderTitle() {
  if (!headerTitleEl) return;
  if (viewMode === 'history') {
    headerTitleEl.textContent = 'History';
    headerTitleEl.classList.remove('is-empty');
    return;
  }
  headerTitleEl.textContent = currentChatTitle;
  headerTitleEl.classList.toggle('is-empty', !currentChatTitle);
}

function setChatTitle(title) {
  const t = (title || '').trim();
  if (!t) return;
  currentChatTitle = t;
  updateHeaderTitle();
  if (sessionId) {
    const s = allSessions.find(x => x.id === sessionId);
    if (s) s.title = t;
  }
  schedulePersistChatState();
}

function clearChatTitle() {
  currentChatTitle = '';
  updateHeaderTitle();
  schedulePersistChatState();
}

function showChatView() {
  viewMode = 'chat';
  historyEl.style.display = 'none';
  messagesEl.style.display = '';
  if (inputWrapEl) inputWrapEl.style.display = '';
  if (disclaimerEl) disclaimerEl.style.display = '';
  historyBackBtn.style.display = 'none';
  updateHeaderTitle();
  schedulePersistChatState();
}

function showHistoryView() {
  viewMode = 'history';
  overflowMenu.style.display = 'none';
  messagesEl.style.display = 'none';
  if (inputWrapEl) inputWrapEl.style.display = 'none';
  if (disclaimerEl) disclaimerEl.style.display = 'none';
  historyEl.style.display = 'flex';
  historyBackBtn.style.display = '';
  updateHeaderTitle();
  historyListEl.innerHTML = '<div class="ac-history-empty">Loading…</div>';
  vscode.postMessage({ type: 'LIST_SESSIONS' });
  schedulePersistChatState();
}

overflowBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  overflowMenu.style.display = overflowMenu.style.display === 'none' ? 'block' : 'none';
});
document.getElementById('ac-menu-history').addEventListener('click', () => {
  overflowMenu.style.display = 'none';
  showHistoryView();
});
historyBackBtn.addEventListener('click', showChatView);
// Establish baseline view; restore persisted state when reloading the window.
overflowMenu.style.display = 'none';
if (!restoreFromSavedState(vscode.getState())) {
  showChatView();
}
vscode.postMessage({ type: 'CHAT_WEBVIEW_READY' });
// Dismiss menus on outside click
document.addEventListener('click', (e) => {
  if (overflowMenu.style.display !== 'none' && !overflowMenu.contains(e.target) && e.target !== overflowBtn && !overflowBtn.contains(e.target)) {
    overflowMenu.style.display = 'none';
  }
  if (openRowMenu && !openRowMenu.contains(e.target)) {
    openRowMenu.remove();
    openRowMenu = null;
  }
});

// Relative time formatting ("3m ago", "2h ago", "1w ago")
function relativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - then);
  const s = Math.floor(diff / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 7) return d + 'd ago';
  const w = Math.floor(d / 7);
  if (w < 5) return w + 'w ago';
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + 'mo ago';
  return Math.floor(d / 365) + 'y ago';
}

function renderSessions(sessions) {
  const filter = (historySearchEl.value || '').toLowerCase().trim();
  const list = filter
    ? sessions.filter(s => (s.title || '').toLowerCase().includes(filter))
    : sessions;
  if (!list.length) {
    historyListEl.innerHTML = '<div class="ac-history-empty">' + (filter ? 'No matching chats.' : 'No previous chats.') + '</div>';
    return;
  }
  historyListEl.innerHTML = '';
  list.forEach(s => {
    const row = document.createElement('div');
    row.className = 'ac-history-item';
    row.dataset.sessionId = s.id;
    row.dataset.conversationId = s.conversation_id || '';
    row.innerHTML =
      '<div class="ac-history-item-main">' +
        '<div class="ac-history-item-title">' + esc(s.title || 'Untitled chat') + '</div>' +
        '<div class="ac-history-item-time">' + esc(relativeTime(s.updated_at || s.created_at)) + '</div>' +
      '</div>' +
      '<button class="ac-history-item-menu-btn" title="More">' +
        '<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="4" r="1.2"/><circle cx="8" cy="8" r="1.2"/><circle cx="8" cy="12" r="1.2"/></svg>' +
      '</button>';
    // Open session on row click (but not when clicking the menu button)
    row.querySelector('.ac-history-item-main').addEventListener('click', () => {
      openSession(s);
    });
    row.querySelector('.ac-history-item-menu-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openRowMenuFor(row, s, e.currentTarget);
    });
    historyListEl.appendChild(row);
  });
}

function openRowMenuFor(row, session, anchorBtn) {
  if (openRowMenu) { openRowMenu.remove(); openRowMenu = null; }
  const menu = document.createElement('div');
  menu.className = 'ac-menu';
  menu.style.top = '38px';
  menu.style.right = '10px';
  menu.innerHTML =
    '<button class="ac-menu-item" data-act="rename">' +
      '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 16 16" width="15" height="15"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M11 2.5 13.5 5 6 12.5 3 13l.5-3z"/></svg>Rename</button>' +
    '<button class="ac-menu-item" data-act="copy">' +
      '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 16 16" width="15" height="15"><rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor"/><path stroke="currentColor" d="M3 10V4a1 1 0 0 1 1-1h6"/></svg>Copy Conversation ID</button>' +
    '<button class="ac-menu-item ac-menu-danger" data-act="delete">' +
      '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 16 16" width="15" height="15"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M3 4h10M6 4V2.5h4V4M4.5 4l.5 9h6l.5-9"/></svg>Delete</button>';
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.ac-menu-item');
    if (!item) return;
    const act = item.dataset.act;
    menu.remove(); openRowMenu = null;
    if (act === 'rename') startRename(row, session);
    else if (act === 'copy') vscode.postMessage({ type: 'COPY_CONVERSATION_ID', conversationId: session.conversation_id });
    else if (act === 'delete') confirmDelete(session);
  });
  row.appendChild(menu);
  openRowMenu = menu;
}

function startRename(row, session) {
  const titleEl = row.querySelector('.ac-history-item-title');
  const oldTitle = session.title || '';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ac-history-rename-input';
  input.value = oldTitle;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => {
    const nt = input.value.trim();
    if (nt && nt !== oldTitle) {
      session.title = nt;
      vscode.postMessage({ type: 'RENAME_SESSION', sessionId: session.id, title: nt });
    }
    renderSessions(allSessions);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { renderSessions(allSessions); }
  });
  input.addEventListener('blur', commit);
}

function confirmDelete(session) {
  // window.confirm() is disabled in VS Code webviews — delegate the confirm dialog to the host.
  vscode.postMessage({ type: 'CONFIRM_DELETE_SESSION', sessionId: session.id, title: session.title || 'this chat' });
}

function openSession(session) {
  showChatView();
  conversationId = session.conversation_id || undefined;
  sessionId = session.id || undefined;
  interactionId = undefined;
  setChatTitle(session.title || '');
  messagesEl.innerHTML = '<div class="ac-history-empty">Loading conversation…</div>';
  vscode.postMessage({ type: 'LOAD_SESSION', sessionId: session.id, conversationId: session.conversation_id, title: session.title });
}

historySearchEl.addEventListener('input', () => renderSessions(allSessions));

// Replay stored messages into the chat DOM using the existing render helpers.
function hydrateFromHistory(messages) {
  messagesEl.innerHTML = '';
  const list = messages || [];
  list.forEach((m, idx) => {
    const isLastMessage = idx === list.length - 1;
    const contents = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'user') {
      const text = contents.map(c => (c.type === 'text' && c.data ? (c.data.v || '') : '')).join('');
      const userEl = document.createElement('div');
      userEl.className = 'ac-msg-row ac-msg-user';
      userEl.innerHTML = '<div class="ac-bubble-user">' + esc(text) + '</div>';
      messagesEl.appendChild(userEl);
      return;
    }
    // assistant — accumulate thought / answer / table / elicitation
    let thought = '', answer = '', table = null, elicitation = null, mutation = null;
    contents.forEach(c => {
      if (c.type === 'assistant_thought' && c.data && c.data.delta) thought += (c.data.delta.v || '');
      else if ((c.type === 'assistant_message' || c.type === 'text') && c.data) answer += (c.data.v || (c.data.delta && c.data.delta.v) || '');
      else if (c.type === 'table' && c.data && c.data.table) table = c.data.table;
      else if ((c.type === 'elicitation_yaml' || c.type === 'elicitation_confirm' || c.type === 'elicitation_free_text' || c.type === 'elicitation_select' || c.type === 'elicitation_multi_select' || c.type === 'elicitation_form') && c.data) elicitation = parseElicitationData(c.type, c.data);
      else if (c.type === 'entity_mutation' && c.data) mutation = c.data;
    });
    const row = document.createElement('div');
    row.className = 'ac-msg-row ac-msg-assistant';
    messagesEl.appendChild(row);
    currentAssistantEl = row;
    if (thought) {
      const id = 'h-thought-' + Math.floor(Math.random() * 1e9);
      const tEl = document.createElement('div');
      tEl.className = 'ac-reasoning';
      tEl.innerHTML =
        '<button class="ac-reasoning-trigger" aria-expanded="false" aria-controls="' + id + '">' +
          getChevronSvg() + '<span>Thought (' + thought.length + ' chars)</span></button>' +
        '<div class="ac-reasoning-content" id="' + id + '" hidden><div class="ac-reasoning-text">' + esc(thought) + '</div></div>';
      row.appendChild(tEl);
    }
    if (table) {
      const tw = document.createElement('div');
      tw.className = 'ac-table-wrap';
      tw.innerHTML = renderTable(table);
      row.appendChild(tw);
    }
    if (answer) {
      const bodyEl = document.createElement('div');
      bodyEl.className = 'ac-msg-body';
      bodyEl.innerHTML = renderMarkdown(answer);
      row.appendChild(bodyEl);
    }
    if (elicitation) {
      // An unresolved elicitation on the final message is still awaiting the user —
      // keep it interactive so they can continue. All others are read-only.
      const stillPending = isLastMessage && !elicitation.resolved;
      renderElicitation(elicitation, !stillPending);
    }
    if (mutation) appendEntityMutation(mutation);
  });
  currentAssistantEl = null;
  scrollBottom();
}

// Normalize a stored elicitation content payload into the shape renderElicitation expects.
function parseElicitationData(type, data) {
  const kind = type === 'elicitation_yaml' ? 'yaml'
    : type === 'elicitation_confirm' ? 'confirm'
    : type === 'elicitation_select' ? 'select'
    : type === 'elicitation_multi_select' ? 'multi_select'
    : type === 'elicitation_form' ? 'form'
    : 'free_text';
  // In stored history the user's answer sits under resolved.result
  // (form_values / selection / selections). Flatten it up so the render
  // sites can read resolved.<field> directly, as they do for live events.
  let resolved = data.resolved;
  if (resolved && resolved.result) {
    resolved = { ...resolved, ...resolved.result };
  }
  return {
    type: kind,
    review_id: data.review_id || '',
    title: data.title || '',
    subtitle: data.subtitle || '',
    content: data.content || {},
    actions: data.actions || [],
    entity_info: data.entity_info || {},
    tool_input: data.tool_input || {},
    resolved,
  };
}

// ── Scroll ────────────────────────────────────────────────────────────────────
function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ── Textarea auto-grow ────────────────────────────────────────────────────────
textarea.addEventListener('input', () => {
  sendBtn.disabled = isStreaming || !textarea.value.trim();
});
// Also update on paste since paste doesn't always fire input in webviews
textarea.addEventListener('paste', () => {
  setTimeout(() => { sendBtn.disabled = isStreaming || !textarea.value.trim(); }, 0);
});
textarea.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) form.requestSubmit();
  }
});

// ── Send form ─────────────────────────────────────────────────────────────────
// Handle stop click (button acts as stop when streaming)
sendBtn.addEventListener('click', (e) => {
  if (isStreaming) {
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ type: 'STOP_STREAM' });
    isStreaming = false;
    finalizeAssistant();
    setSendState(false);
  }
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (isStreaming) return;
  const prompt = textarea.value.trim();
  if (!prompt) return;
  textarea.value = '';
  textarea.style.height = '';
  setSendState(true);
  sendMessage(prompt, conversationId);
});

// Reflect MCP connector availability — compact pill (MCP + count) with a
// fixed-position popover table so long connector lists aren't clipped.
function renderMcpPill(count, org, project, connectors) {
  const pill = document.getElementById('ac-mcp-pill');
  if (!pill) return;
  mcpConnectorCount = count || 0;
  mcpConnectors = connectors || [];
  const n = mcpConnectorCount;
  pill.className = 'ac-mcp-pill' + (n > 0 ? ' ac-mcp-on' : '');
  pill.innerHTML =
    '<span class="ac-mcp-dot" aria-hidden="true"></span>' +
    '<span class="ac-mcp-label">MCP</span>' +
    '<span class="ac-mcp-count' + (n === 0 ? ' is-zero' : '') + '">' + n + '</span>';
  pill.style.display = 'inline-flex';
  pill.setAttribute('aria-label', n > 0 ? n + ' MCP connector' + (n === 1 ? '' : 's') + ' available' : 'No MCP connectors');
}

function buildMcpPopoverHtml(count, connectors) {
  if (count > 0) {
    const rows = connectors.map(function (c) {
      return '<tr><td class="ac-mcp-pop-ico"><span class="ac-mcp-pop-dot"></span></td>' +
        '<td class="ac-mcp-pop-name">' + esc(c) + '</td></tr>';
    }).join('');
    return '<div class="ac-mcp-pop-head">MCP connectors <span class="ac-mcp-pop-badge">' + count + '</span></div>' +
      '<div class="ac-mcp-pop-sub">Available in this chat</div>' +
      '<div class="ac-mcp-pop-scroll"><table class="ac-mcp-pop-table"><tbody>' + rows + '</tbody></table></div>';
  }
  return '<div class="ac-mcp-pop-head">MCP connectors</div>' +
    '<div class="ac-mcp-pop-empty">No connectors configured for this project in Harness.</div>';
}

function hideMcpPopover() {
  const pop = document.getElementById('ac-mcp-popover');
  if (!pop) return;
  pop.classList.remove('is-visible');
  pop.style.display = 'none';
  pop.setAttribute('aria-hidden', 'true');
}

function showMcpPopover(pill) {
  const pop = document.getElementById('ac-mcp-popover');
  if (!pop || !pill) return;
  clearTimeout(mcpPopoverHideTimer);
  pop.innerHTML = buildMcpPopoverHtml(mcpConnectorCount, mcpConnectors);
  pop.style.display = 'block';
  pop.style.visibility = 'hidden';
  pop.classList.add('is-visible');
  pop.setAttribute('aria-hidden', 'false');

  const r = pill.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let top = r.top - pr.height - 10;
  let left = r.left;
  if (top < 8) top = r.bottom + 10;
  left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - pr.height - 8));
  pop.style.top = top + 'px';
  pop.style.left = left + 'px';
  pop.style.visibility = '';
}

function bindMcpPopover() {
  const pill = document.getElementById('ac-mcp-pill');
  const pop = document.getElementById('ac-mcp-popover');
  if (!pill || !pop) return;

  pill.addEventListener('mouseenter', function () { showMcpPopover(pill); });
  pill.addEventListener('mouseleave', function () {
    mcpPopoverHideTimer = setTimeout(hideMcpPopover, 140);
  });
  pill.addEventListener('focus', function () { showMcpPopover(pill); });
  pill.addEventListener('blur', function () {
    mcpPopoverHideTimer = setTimeout(hideMcpPopover, 140);
  });

  pop.addEventListener('mouseenter', function () { clearTimeout(mcpPopoverHideTimer); });
  pop.addEventListener('mouseleave', hideMcpPopover);

  window.addEventListener('scroll', hideMcpPopover, true);
  window.addEventListener('resize', hideMcpPopover);
}

bindMcpPopover();

// Render the pipeline-context chip in the input footer (after MCP). Shows which
// pipeline the chat is scoped to, with an × to clear it. The highlight flag
// briefly pulses the chip when context auto-updates on navigation.
function renderContextChip(pipelineName, highlight) {
  const chip = document.getElementById('ac-context-chip');
  if (!chip) return;
  if (!pipelineName || contextCleared) {
    chip.style.display = 'none';
    chip.innerHTML = '';
    return;
  }
  chip.innerHTML =
    '<span class="ac-context-label">Context: ' + esc(pipelineName) + '</span>' +
    '<button class="ac-context-remove" title="Ask without this pipeline context" aria-label="Remove context">' +
      '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 16 16" width="12" height="12">' +
        '<path stroke="currentColor" stroke-linecap="round" stroke-width="1.5" d="m4 4 8 8M12 4l-8 8"/>' +
      '</svg>' +
    '</button>';
  chip.style.display = 'inline-flex';
  chip.title = 'This pipeline context is sent to Harness AI.';
  const removeBtn = chip.querySelector('.ac-context-remove');
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      contextCleared = true;
      chip.style.display = 'none';
      chip.innerHTML = '';
      schedulePersistChatState();
    });
  }
  if (highlight) {
    chip.classList.remove('ac-context-flash');
    // Force reflow so the animation restarts on repeated updates.
    void chip.offsetWidth;
    chip.classList.add('ac-context-flash');
  }
  schedulePersistChatState();
}

function sendMessage(prompt, convId, systemEvent) {
  // Remove greeting if present
  const greeting = messagesEl.querySelector('.ac-greeting-wrap');
  if (greeting) greeting.remove();

  // Append user bubble (skip for system_event responses)
  if (prompt) {
    const userEl = document.createElement('div');
    userEl.className = 'ac-msg-row ac-msg-user';
    userEl.innerHTML = '<div class="ac-bubble-user">' + esc(prompt) + '</div>';
    messagesEl.appendChild(userEl);
  }

  // Append streaming assistant row
  currentAssistantEl = document.createElement('div');
  currentAssistantEl.className = 'ac-msg-row ac-msg-assistant';
  currentAssistantEl.innerHTML = getLoadingHtml();
  messagesEl.appendChild(currentAssistantEl);
  scrollBottom();

  vscode.postMessage({
    type: 'SEND_MESSAGE',
    prompt,
    conversationId: convId,
    module: CFG.module,
    currentUrl: contextCleared ? undefined : CFG.currentUrl,
    systemEvent,
  });
  schedulePersistChatState();
}

// ── IDE theme (VS Code / Cursor light-dark) ───────────────────────────────────
function applyIdeTheme(kind) {
  const isLight = kind === 1 || kind === 4;
  document.documentElement.dataset.theme = isLight ? 'light' : 'dark';
  document.body.classList.toggle('theme-enhanced', true);
  document.body.classList.toggle('theme-light', isLight);
  document.body.classList.toggle('theme-dark', !isLight);
}

(function initIdeTheme() {
  const cls = document.body.classList;
  if (cls.contains('vscode-light') || cls.contains('vscode-high-contrast-light')) {
    applyIdeTheme(1);
  } else if (cls.contains('vscode-dark') || cls.contains('vscode-high-contrast')) {
    applyIdeTheme(2);
  }
})();

// ── VS Code message handler ───────────────────────────────────────────────────
window.addEventListener('message', (e) => {
  const msg = e.data;

  if (msg.type === 'IDE_THEME') {
    applyIdeTheme(msg.ideThemeKind);
    return;
  }

  if (msg.type === 'FOCUS_INPUT') {
    showChatView();
    textarea.focus();
    return;
  }

  if (msg.type === 'SET_PROMPT') {
    textarea.value = msg.prompt;
    sendBtn.disabled = false;
    textarea.focus();
    return;
  }

  if (msg.type === 'MCP_CONNECTOR_STATUS') {
    renderMcpPill(msg.count, msg.org, msg.project, msg.connectors);
    return;
  }

  if (msg.type === 'SET_CONTEXT') {
    const ctx = msg.context;
    if (!ctx) return;
    // New context arriving (e.g. navigated to another pipeline) re-attaches
    // context even if the user had removed the previous one.
    const changed = ctx.currentUrl !== CFG.currentUrl;
    if (ctx.currentUrl) CFG.currentUrl = ctx.currentUrl;
    if (ctx.module) CFG.module = ctx.module;
    if (ctx.pipelineName != null) CFG.pipelineName = ctx.pipelineName;
    if (ctx.planExecutionId != null) CFG.planExecutionId = ctx.planExecutionId;
    if (changed) contextCleared = false;
    renderContextChip(ctx.pipelineName, changed);
    schedulePersistChatState();
    // Pre-fill prompt if supplied
    if (ctx.initialPrompt) {
      textarea.value = ctx.initialPrompt;
      sendBtn.disabled = false;
    }
    return;
  }

  if (msg.type === 'STREAM_START') {
    isStreaming = true;
    pendingThought = '';
    pendingText = '';
    pendingTable = null;
    pendingElicitation = null;
    feedbackReasons = [];
    setSendState(true);
    return;
  }

  if (msg.type === 'STREAM_END') {
    isStreaming = false;
    finalizeAssistant();
    setSendState(false);
    if (sessionId && !currentChatTitle) {
      vscode.postMessage({ type: 'FETCH_SESSION_TITLE', sessionId });
    }
    schedulePersistChatState();
    return;
  }

  if (msg.type === 'SESSION_TITLE') {
    setChatTitle(msg.title);
    return;
  }

  if (msg.type === 'STREAM_ERROR') {
    isStreaming = false;
    if (currentAssistantEl) {
      currentAssistantEl.innerHTML = '<div class="ac-msg-error">Error: ' + esc(msg.error) + '</div>';
    }
    setSendState(false);
    return;
  }

  if (msg.type === 'STREAM_EVENT') {
    handleSseEvent(msg.event, msg.data);
    return;
  }

  if (msg.type === 'SESSIONS_LIST') {
    allSessions = msg.sessions || [];
    renderSessions(allSessions);
    return;
  }

  if (msg.type === 'SESSIONS_ERROR') {
    if (historyEl.style.display !== 'none') {
      historyListEl.innerHTML = '<div class="ac-history-empty">Error: ' + esc(msg.error) + '</div>';
    }
    return;
  }

  if (msg.type === 'SESSION_MESSAGES') {
    if (msg.title) setChatTitle(msg.title);
    hydrateFromHistory(msg.messages);
    schedulePersistChatState();
    return;
  }

  if (msg.type === 'SESSION_RENAMED') {
    const s = allSessions.find(x => x.id === msg.sessionId);
    if (s) s.title = msg.title;
    if (sessionId === msg.sessionId) setChatTitle(msg.title);
    renderSessions(allSessions);
    return;
  }

  if (msg.type === 'SESSION_DELETED') {
    allSessions = allSessions.filter(x => x.id !== msg.sessionId);
    renderSessions(allSessions);
    // If the deleted session was the active chat, reset to a new chat
    if (sessionId === msg.sessionId) {
      conversationId = undefined;
      sessionId = undefined;
      clearChatTitle();
      messagesEl.innerHTML = GREETING_INNER;
    }
    return;
  }
});

function handleSseEvent(event, data) {
  if (event === 'stream_metadata' && data) {
    if (data.conversation_id && !conversationId) conversationId = data.conversation_id;
    sessionId = data.session_id || sessionId;
    interactionId = data.interaction_id || interactionId;
    if (data.title) setChatTitle(data.title);
    schedulePersistChatState();
    return;
  }

  if ((event === 'session_title' || event === 'title') && data) {
    const t = typeof data === 'string' ? data : (data.title || data.v || '');
    if (t) setChatTitle(t);
    return;
  }

  if (event === 'assistant_thought' && data && data.delta) {
    pendingThought += data.delta.v || '';
    updateStreamingThought();
    return;
  }

  if (event === 'assistant_message' && data) {
    pendingText = typeof data === 'string' ? data : (data.v || '');
    updateStreamingAnswer();
    return;
  }

  if (event === 'table' && data && data.table) {
    pendingTable = data.table;
    return;
  }

  if (event === 'elicitation_yaml' && data) {
    pendingElicitation = { type: 'yaml', ...data };
    return;
  }

  if (event === 'elicitation_confirm' && data) {
    pendingElicitation = { type: 'confirm', ...data };
    return;
  }

  if (event === 'elicitation_free_text' && data) {
    pendingElicitation = { type: 'free_text', ...data };
    return;
  }

  if (event === 'elicitation_select' && data) {
    pendingElicitation = { type: 'select', ...data };
    return;
  }

  if (event === 'elicitation_multi_select' && data) {
    pendingElicitation = { type: 'multi_select', ...data };
    return;
  }

  if (event === 'elicitation_form' && data) {
    pendingElicitation = { type: 'form', ...data };
    return;
  }

  if (event === 'entity_mutation' && data) {
    appendEntityMutation(data);
    return;
  }

  if (event === 'collect_feedback' && data && data.reasons) {
    feedbackReasons = data.reasons;
    return;
  }
}

function updateStreamingThought() {
  if (!currentAssistantEl) return;
  let thoughtEl = currentAssistantEl.querySelector('.ac-reasoning');
  if (!thoughtEl) {
    currentAssistantEl.innerHTML = '';
    thoughtEl = document.createElement('div');
    thoughtEl.className = 'ac-reasoning ac-reasoning-open';
    const id = 'thought-' + Date.now();
    thoughtEl.innerHTML =
      '<button class="ac-reasoning-trigger" aria-expanded="true" aria-controls="' + id + '">' +
        getChevronSvg() +
        '<span>Thinking…</span>' +
      '</button>' +
      '<div class="ac-reasoning-content" id="' + id + '">' +
        '<div class="ac-reasoning-text" id="' + id + '-text"></div>' +
      '</div>';
    currentAssistantEl.appendChild(thoughtEl);
  }
  const textEl = thoughtEl.querySelector('.ac-reasoning-text');
  if (textEl) textEl.textContent = pendingThought;
  scrollBottom();
}

function updateStreamingAnswer() {
  if (!currentAssistantEl) return;
  let bodyEl = currentAssistantEl.querySelector('.ac-msg-body');
  if (!bodyEl) {
    // Collapse thought if present
    const reasoning = currentAssistantEl.querySelector('.ac-reasoning');
    if (reasoning) {
      const trigger = reasoning.querySelector('.ac-reasoning-trigger');
      const contentId = trigger && trigger.getAttribute('aria-controls');
      const content = contentId && document.getElementById(contentId);
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
      if (content) content.hidden = true;
      // Update label to show thought was completed
      const span = trigger && trigger.querySelector('span');
      if (span) span.textContent = 'Thought (' + pendingThought.length + ' chars)';
    }
    bodyEl = document.createElement('div');
    bodyEl.className = 'ac-msg-body';
    currentAssistantEl.appendChild(bodyEl);
  }
  bodyEl.innerHTML = renderMarkdown(pendingText);
  scrollBottom();
}

function finalizeAssistant() {
  if (!currentAssistantEl) return;

  // Render table before message text if present
  if (pendingTable) {
    const tableHtml = renderTable(pendingTable);
    const tableEl = document.createElement('div');
    tableEl.className = 'ac-table-wrap';
    tableEl.innerHTML = tableHtml;
    // Insert before message body
    const body = currentAssistantEl.querySelector('.ac-msg-body');
    if (body) {
      currentAssistantEl.insertBefore(tableEl, body);
    } else {
      currentAssistantEl.appendChild(tableEl);
    }
  }

  // Render elicitation if present
  if (pendingElicitation) {
    renderElicitation(pendingElicitation);
  }

  // Add feedback row
  if (interactionId && conversationId) {
    const feedRow = document.createElement('div');
    feedRow.className = 'ac-feedback';
    feedRow.dataset.interactionId = interactionId;
    feedRow.dataset.conversationId = conversationId;
    feedRow.dataset.sessionId = sessionId || '';
    feedRow.dataset.reasons = JSON.stringify(feedbackReasons);
    feedRow.innerHTML =
      '<button class="ac-feedback-btn" data-sentiment="positive" title="Helpful">' + getThumbsUpSvg() + '</button>' +
      '<button class="ac-feedback-btn" data-sentiment="negative" title="Not helpful">' + getThumbsDownSvg() + '</button>';
    currentAssistantEl.appendChild(feedRow);
  }

  scrollBottom();
  currentAssistantEl = null;
}

function appendEntityMutation(data) {
  if (!currentAssistantEl) return;
  const el = document.createElement('div');
  el.className = 'ac-mutation';
  const action = (data.action || 'updated').toLowerCase();
  const icon = action === 'create' ? '✓' : action === 'delete' ? '✗' : '✎';
  const href = data.url ? CFG.baseUrl + data.url : '#';
  el.innerHTML =
    '<span class="ac-mutation-icon">' + icon + '</span>' +
    '<span class="ac-mutation-text">' + esc(data.resource_type) + ' <strong>' + esc(data.name || data.identifier) + '</strong> ' + esc(action) + 'd</span>' +
    (data.url ? ' <a class="ac-mutation-link" href="' + href + '">Open →</a>' : '');
  currentAssistantEl.appendChild(el);
  scrollBottom();
}

function renderElicitation(elicitation, readOnly) {
  if (!currentAssistantEl) return;
  const el = document.createElement('div');
  el.className = 'ac-elicitation' + (readOnly ? ' ac-elicitation-readonly' : '');
  el.dataset.reviewId = elicitation.review_id;
  el.dataset.type = elicitation.type;

  // For past chats, the resolution (which action the user took) is stored on the elicitation.
  const resolvedActionId = readOnly && elicitation.resolved ? elicitation.resolved.action_id : null;
  const disabledAttr = readOnly ? ' disabled' : '';

  if (elicitation.type === 'yaml' || elicitation.type === 'confirm') {
    const entityInfo = elicitation.entity_info ? JSON.stringify(elicitation.entity_info) : '{}';
    const toolInput  = elicitation.tool_input  ? JSON.stringify(elicitation.tool_input)  : '{}';
    const yaml = elicitation.content && elicitation.content.yaml ? elicitation.content.yaml : '';
    const detailsHtml = elicitation.type === 'confirm' && elicitation.content && elicitation.content.details
      ? elicitation.content.details.map(d =>
          '<div class="ac-elix-detail"><span class="ac-elix-label">' + esc(d.label) + '</span><span>' + esc(d.value) + '</span></div>'
        ).join('')
      : '';

    el.innerHTML =
      '<div class="ac-elix-title">' + esc(elicitation.title || '') + '</div>' +
      '<div class="ac-elix-subtitle">' + esc(elicitation.subtitle || '') + '</div>' +
      (elicitation.type === 'confirm' && elicitation.content && elicitation.content.summary
        ? '<div class="ac-elix-summary">' + esc(elicitation.content.summary) + '</div>'
        : '') +
      detailsHtml +
      (yaml ? '<pre class="ac-elix-yaml">' + esc(yaml) + '</pre>' : '') +
      '<div class="ac-elix-actions">' +
        (elicitation.actions || []).map(a => {
          const chosen = resolvedActionId && a.id === resolvedActionId;
          return '<button class="ac-elix-btn ac-elix-btn-' + esc(a.variant) + (chosen ? ' ac-elix-btn-chosen' : '') + '"' + disabledAttr + ' ' +
            'data-action-id="' + esc(a.id) + '" ' +
            'data-sends="' + esc(a.sends || 'action_completed') + '" ' +
            'data-review-id="' + esc(elicitation.review_id) + '" ' +
            'data-yaml="' + esc(yaml) + '" ' +
            'data-entity-info="' + entityInfo.replace(/"/g,'&quot;') + '" ' +
            'data-tool-input="' + toolInput.replace(/"/g,'&quot;') + '" ' +
            'data-entity-type="' + esc((elicitation.entity_info || {}).entity_type || '') + '" ' +
            'data-request-action="' + esc((elicitation.entity_info || {}).request_action || '') + '">' +
            esc(a.label) + (chosen ? ' ✓' : '') +
          '</button>';
        }).join('') +
      '</div>' +
      (readOnly && resolvedActionId ? '<div class="ac-elix-resolved-note">Resolved in a previous session.</div>' : '');
  } else if (elicitation.type === 'free_text') {
    const placeholder = (elicitation.content && elicitation.content.placeholder) || 'Type your answer…';
    el.innerHTML =
      '<div class="ac-elix-title">' + esc(elicitation.title || '') + '</div>' +
      '<div class="ac-elix-question">' + esc((elicitation.content || {}).question || '') + '</div>' +
      '<textarea class="ac-elix-input" placeholder="' + esc(placeholder) + '"' + disabledAttr + ' ' +
        'maxlength="' + ((elicitation.content || {}).max_length || 500) + '"></textarea>' +
      '<div class="ac-elix-actions">' +
        '<button class="ac-elix-btn ac-elix-btn-primary ac-elix-submit"' + disabledAttr + ' ' +
          'data-review-id="' + esc(elicitation.review_id) + '">Submit</button>' +
      '</div>';
  } else if (elicitation.type === 'select') {
    // Single-select submits a flat selection = the chosen item label.
    const question = (elicitation.content || {}).question || elicitation.title || '';
    const resolvedLabel = readOnly && elicitation.resolved ? elicitation.resolved.selection : null;
    const items = (elicitation.content && elicitation.content.items) || [];
    const submitAction = (elicitation.actions || []).find(a => a.id) || { id: 'respond', label: 'Submit' };
    el.innerHTML =
      '<div class="ac-elix-title">' + esc(elicitation.title || '') + '</div>' +
      (elicitation.subtitle ? '<div class="ac-elix-subtitle">' + esc(elicitation.subtitle) + '</div>' : '') +
      (question && question !== elicitation.title ? '<div class="ac-elix-question">' + esc(question) + '</div>' : '') +
      '<div class="ac-elix-options" data-question="' + esc(question).replace(/"/g,'&quot;') + '">' +
        items.map(it => {
          const chosen = resolvedLabel != null && String(it.label) === String(resolvedLabel);
          return '<button class="ac-elix-option' + (chosen ? ' ac-elix-option-chosen' : '') + '"' + disabledAttr + ' ' +
            'data-item-id="' + esc(it.id) + '" data-item-label="' + esc(it.label || '').replace(/"/g,'&quot;') + '">' +
            '<span class="ac-elix-option-label">' + esc(it.label || '') + (chosen ? ' ✓' : '') + '</span>' +
            (it.description ? '<span class="ac-elix-option-desc">' + esc(it.description) + '</span>' : '') +
          '</button>';
        }).join('') +
      '</div>' +
      '<div class="ac-elix-actions">' +
        '<button class="ac-elix-btn ac-elix-btn-primary ac-elix-submit" disabled ' +
          'data-action-id="' + esc(submitAction.id) + '" ' +
          'data-review-id="' + esc(elicitation.review_id) + '">' + esc(submitAction.label || 'Submit') + '</button>' +
      '</div>' +
      (readOnly && resolvedLabel != null ? '<div class="ac-elix-resolved-note">Resolved in a previous session.</div>' : '');
  } else if (elicitation.type === 'multi_select') {
    // Multi-select submits selections (array of labels) + selection (comma-joined).
    const question = (elicitation.content || {}).question || elicitation.title || '';
    const resolvedSelections = (readOnly && elicitation.resolved && elicitation.resolved.selections) || [];
    const items = (elicitation.content && elicitation.content.items) || [];
    const submitAction = (elicitation.actions || []).find(a => a.id) || { id: 'respond', label: 'Submit' };
    el.innerHTML =
      '<div class="ac-elix-title">' + esc(elicitation.title || '') + '</div>' +
      (elicitation.subtitle ? '<div class="ac-elix-subtitle">' + esc(elicitation.subtitle) + '</div>' : '') +
      (question && question !== elicitation.title ? '<div class="ac-elix-question">' + esc(question) + '</div>' : '') +
      '<div class="ac-elix-hint">Select one or more options, then click Submit</div>' +
      '<div class="ac-elix-options ac-elix-multi">' +
        items.map(it => {
          const chosen = resolvedSelections.map(String).indexOf(String(it.label)) !== -1;
          return '<label class="ac-elix-option ac-elix-option-check' + (chosen ? ' ac-elix-option-chosen' : '') + '">' +
            '<input type="checkbox" class="ac-elix-checkbox"' + disabledAttr + (chosen ? ' checked' : '') + ' ' +
              'data-item-label="' + esc(it.label || '').replace(/"/g,'&quot;') + '">' +
            '<span class="ac-elix-option-text">' +
              '<span class="ac-elix-option-label">' + esc(it.label || '') + '</span>' +
              (it.description ? '<span class="ac-elix-option-desc">' + esc(it.description) + '</span>' : '') +
            '</span>' +
          '</label>';
        }).join('') +
      '</div>' +
      '<div class="ac-elix-actions">' +
        '<button class="ac-elix-btn ac-elix-btn-primary ac-elix-submit ac-elix-submit-multi" disabled ' +
          'data-action-id="' + esc(submitAction.id) + '" ' +
          'data-submit-label="' + esc(submitAction.label || 'Submit') + '" ' +
          'data-review-id="' + esc(elicitation.review_id) + '">' + esc(submitAction.label || 'Submit') + '</button>' +
      '</div>' +
      (readOnly && resolvedSelections.length ? '<div class="ac-elix-resolved-note">Resolved in a previous session.</div>' : '');
  } else if (elicitation.type === 'form') {
    // Multi-field form: each field is a select dropdown or a free-text input.
    const resolvedValues = (readOnly && elicitation.resolved && elicitation.resolved.form_values) || {};
    const fields = (elicitation.content && elicitation.content.fields) || [];
    const submitAction = (elicitation.actions || []).find(a => a.id) || { id: 'respond', label: 'Submit' };
    el.innerHTML =
      '<div class="ac-elix-title">' + esc(elicitation.title || '') + '</div>' +
      (elicitation.subtitle ? '<div class="ac-elix-subtitle">' + esc(elicitation.subtitle) + '</div>' : '') +
      '<div class="ac-elix-fields">' +
        fields.map(f => {
          // The backend keys form_values by the field's human label, not its key.
          const key = esc(f.label || f.key);
          const saved = resolvedValues[f.label] != null ? resolvedValues[f.label] : resolvedValues[f.key];
          const labelHtml =
            '<div class="ac-elix-field-label">' + esc(f.label || '') + '</div>' +
            (f.header ? '<div class="ac-elix-field-header">' + esc(f.header) + '</div>' : '');
          if (f.type === 'select') {
            const opts = '<option value=""' + (saved == null ? ' selected' : '') + ' disabled>Select…</option>' +
              (f.options || []).map(o => {
                const val = o.value != null ? o.value : o.label;
                const sel = saved != null && String(saved) === String(val) ? ' selected' : '';
                return '<option value="' + esc(val) + '"' + sel + '>' + esc(o.label || val) + '</option>';
              }).join('');
            return '<div class="ac-elix-field">' + labelHtml +
              '<select class="ac-elix-field-select" data-field-key="' + key + '"' + disabledAttr + '>' + opts + '</select>' +
            '</div>';
          }
          if (f.type === 'multi_select') {
            // Value submits as an array of option values, keyed by field label.
            const savedArr = Array.isArray(saved) ? saved.map(String) : [];
            const boxes = (f.options || []).map(o => {
              const val = o.value != null ? o.value : o.label;
              const chk = savedArr.indexOf(String(val)) !== -1 ? ' checked' : '';
              return '<label class="ac-elix-option ac-elix-option-check' + (chk ? ' ac-elix-option-chosen' : '') + '">' +
                '<input type="checkbox" class="ac-elix-field-checkbox"' + disabledAttr + chk + ' ' +
                  'data-field-key="' + key + '" data-option-value="' + esc(val).replace(/"/g,'&quot;') + '">' +
                '<span class="ac-elix-option-text">' +
                  '<span class="ac-elix-option-label">' + esc(o.label || val) + '</span>' +
                  (o.description ? '<span class="ac-elix-option-desc">' + esc(o.description) + '</span>' : '') +
                '</span>' +
              '</label>';
            }).join('');
            return '<div class="ac-elix-field">' + labelHtml +
              '<div class="ac-elix-options ac-elix-multi" data-field-key="' + key + '">' + boxes + '</div>' +
            '</div>';
          }
          // text
          return '<div class="ac-elix-field">' + labelHtml +
            '<textarea class="ac-elix-field-text" data-field-key="' + key + '" ' +
              'placeholder="' + esc(f.placeholder || 'Type your answer…') + '"' + disabledAttr + '>' + esc(saved != null ? String(saved) : '') + '</textarea>' +
          '</div>';
        }).join('') +
      '</div>' +
      '<div class="ac-elix-actions">' +
        '<button class="ac-elix-btn ac-elix-btn-primary ac-elix-submit" disabled ' +
          'data-action-id="' + esc(submitAction.id) + '" ' +
          'data-review-id="' + esc(elicitation.review_id) + '">' + esc(submitAction.label || 'Submit') + '</button>' +
      '</div>' +
      (readOnly && Object.keys(resolvedValues).length ? '<div class="ac-elix-resolved-note">Resolved in a previous session.</div>' : '');
  }

  currentAssistantEl.appendChild(el);

  // Only wire up interactions for live (non-history) elicitations.
  if (!readOnly) {
    el.querySelectorAll('.ac-elix-btn').forEach(btn => {
      btn.addEventListener('click', handleElicitationAction);
    });
    // Single-select option pills: pick one, then enable Submit.
    const options = el.querySelectorAll('.ac-elix-options:not(.ac-elix-multi) .ac-elix-option');
    if (options.length) {
      const submitBtn = el.querySelector('.ac-elix-submit');
      options.forEach(opt => {
        opt.addEventListener('click', () => {
          options.forEach(o => o.classList.remove('ac-elix-option-selected'));
          opt.classList.add('ac-elix-option-selected');
          if (submitBtn) submitBtn.disabled = false;
        });
      });
    }
    // Multi-select checkboxes: enable Submit with ≥1 checked; reflect count in label.
    const checkboxes = el.querySelectorAll('.ac-elix-checkbox');
    if (checkboxes.length) {
      const submitBtn = el.querySelector('.ac-elix-submit-multi');
      const baseLabel = submitBtn ? (submitBtn.dataset.submitLabel || 'Submit') : 'Submit';
      const refresh = () => {
        const count = Array.from(checkboxes).filter(cb => cb.checked).length;
        checkboxes.forEach(cb => {
          cb.closest('.ac-elix-option').classList.toggle('ac-elix-option-chosen', cb.checked);
        });
        if (submitBtn) {
          submitBtn.disabled = count === 0;
          submitBtn.textContent = count ? baseLabel + ' (' + count + ' selected)' : baseLabel;
        }
      };
      checkboxes.forEach(cb => cb.addEventListener('change', refresh));
    }
    // Multi-field form: enable Submit once every field has a value.
    const valueEls = el.querySelectorAll('.ac-elix-field-select, .ac-elix-field-text');
    const multiGroups = el.querySelectorAll('.ac-elix-options.ac-elix-multi[data-field-key]');
    if (valueEls.length || multiGroups.length) {
      const submitBtn = el.querySelector('.ac-elix-submit');
      const fieldCheckboxes = el.querySelectorAll('.ac-elix-field-checkbox');
      const refresh = () => {
        const valuesFilled = Array.from(valueEls).every(fe => String(fe.value || '').trim() !== '');
        const multiFilled = Array.from(multiGroups).every(g => g.querySelector('.ac-elix-field-checkbox:checked'));
        // Reflect checked state on each option pill.
        fieldCheckboxes.forEach(cb => {
          cb.closest('.ac-elix-option').classList.toggle('ac-elix-option-chosen', cb.checked);
        });
        if (submitBtn) submitBtn.disabled = !(valuesFilled && multiFilled);
      };
      valueEls.forEach(fe => {
        fe.addEventListener('change', refresh);
        fe.addEventListener('input', refresh);
      });
      fieldCheckboxes.forEach(cb => cb.addEventListener('change', refresh));
    }
  }
}

function handleElicitationAction(e) {
  const btn = e.currentTarget;
  const sends      = btn.dataset.sends;
  const actionId   = btn.dataset.actionId;
  const reviewId   = btn.dataset.reviewId;
  const yaml       = btn.dataset.yaml || '';
  let entityInfo   = {};
  let toolInput    = {};
  try { entityInfo = JSON.parse(btn.dataset.entityInfo || '{}'); } catch {}
  try { toolInput  = JSON.parse(btn.dataset.toolInput  || '{}'); } catch {}
  const entityType    = btn.dataset.entityType || '';
  const requestAction = btn.dataset.requestAction || '';

  // Free-text submit
  const elix = btn.closest('.ac-elicitation');
  const freeInput = elix && elix.querySelector('.ac-elix-input');
  const freeText = freeInput ? freeInput.value.trim() : undefined;

  // Multi-select submits selections (array of labels) + selection (comma-joined).
  let selection = undefined;
  let selections = undefined;
  const checkboxes = elix ? elix.querySelectorAll('.ac-elix-checkbox') : [];
  if (checkboxes.length) {
    selections = Array.from(checkboxes).filter(cb => cb.checked).map(cb => cb.dataset.itemLabel || '');
    selection = selections.join(', ');
  } else {
    // Single-select submits a flat selection = the chosen item label.
    const selectedOption = elix && elix.querySelector('.ac-elix-option-selected');
    if (selectedOption) selection = selectedOption.dataset.itemLabel || '';
  }

  // Multi-field form submits { form_values: { <field label>: value } }.
  // select/text fields → string; multi_select fields → array of option values.
  let formValues = undefined;
  const fieldEls = elix ? elix.querySelectorAll('.ac-elix-field-select, .ac-elix-field-text') : [];
  const multiGroups = elix ? elix.querySelectorAll('.ac-elix-options.ac-elix-multi[data-field-key]') : [];
  if (fieldEls.length || multiGroups.length) {
    formValues = {};
    fieldEls.forEach(fe => { formValues[fe.dataset.fieldKey] = String(fe.value || '').trim(); });
    multiGroups.forEach(g => {
      const checked = g.querySelectorAll('.ac-elix-field-checkbox:checked');
      formValues[g.dataset.fieldKey] = Array.from(checked).map(cb => cb.dataset.optionValue || '');
    });
  }

  const eventType = sends === 'action_cancelled' ? 'action_cancelled' : 'action_completed';
  const success   = eventType === 'action_completed';

  const result = {
    success,
    action_id: actionId,
    ...(yaml ? { yaml, entity_type: entityType, entity_info: entityInfo, request_action: requestAction, tool_input: toolInput } : {}),
    ...(freeText !== undefined ? { free_text: freeText } : {}),
    ...(selection !== undefined ? { selection } : {}),
    ...(selections !== undefined ? { selections } : {}),
    ...(formValues !== undefined ? { form_values: formValues } : {}),
  };

  const systemEvent = {
    event_type: eventType,
    capability_id: reviewId,
    result,
  };

  // Lock the whole card once submitted — buttons, option pills, and form fields —
  // so editing a value afterward can't re-enable Submit.
  if (elix) {
    elix.querySelectorAll('.ac-elix-btn, .ac-elix-option, .ac-elix-checkbox, .ac-elix-field-checkbox, .ac-elix-field-select, .ac-elix-field-text, .ac-elix-input')
      .forEach(node => { node.disabled = true; });
  }

  sendMessage('', conversationId, systemEvent);
}

// ── Feedback clicks ───────────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.ac-feedback-btn');
  if (!btn) return;
  const row = btn.closest('.ac-feedback');
  if (!row) return;
  row.querySelectorAll('.ac-feedback-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const sentiment = btn.dataset.sentiment;
  const reasons = sentiment === 'negative' ? JSON.parse(row.dataset.reasons || '[]') : [];
  vscode.postMessage({
    type: 'SUBMIT_FEEDBACK',
    sentiment,
    reasons,
    conversationId: row.dataset.conversationId,
    interactionId:  row.dataset.interactionId,
    sessionId:      row.dataset.sessionId,
  });
});

// ── Reasoning toggle ──────────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  const trigger = e.target.closest('.ac-reasoning-trigger');
  if (!trigger) return;
  const contentId = trigger.getAttribute('aria-controls');
  const content   = contentId && document.getElementById(contentId);
  const expanded  = trigger.getAttribute('aria-expanded') === 'true';
  trigger.setAttribute('aria-expanded', String(!expanded));
  if (content) content.hidden = expanded;
});

// ── Quick chips ───────────────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  const chip = e.target.closest('.ac-quick-chip');
  if (!chip) return;
  const prompt = chip.dataset.prompt;
  if (prompt) {
    textarea.value = prompt;
    sendBtn.disabled = false;
    form.requestSubmit();
  }
});

// ── Send state ────────────────────────────────────────────────────────────────
function setSendState(streaming) {
  isStreaming = streaming;
  textarea.disabled = streaming;
  sendBtn.disabled  = streaming || !textarea.value.trim();
  sendBtn.classList.toggle('ac-send-stop', streaming);
  sendBtn.innerHTML  = streaming ? getStopSvg() : getSendSvg();
  sendBtn.title      = streaming ? 'Stop' : 'Send';
}

// ── Markdown renderer (simple) ────────────────────────────────────────────────
function renderMarkdown(md) {
  if (!md) return '';
  // Prefer the bundled marked parser (full GFM: tables, links, ordered/nested lists, etc.)
  if (typeof window.__harnessMarkdown === 'function') {
    try {
      const out = window.__harnessMarkdown(md);
      if (out) return out;
    } catch (e) { /* fall through to basic renderer */ }
  }
  return basicMarkdown(md);
}

// Fallback used only if the marked bundle failed to load.
function basicMarkdown(md) {
  if (!md) return '';
  let html = esc(md);

  // Code blocks
  html = html.replace(new RegExp('\x60\x60\x60([\\s\\S]*?)\x60\x60\x60', 'g'), '<pre><code>$1</code></pre>');
  // Inline code
  html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
  // Bold
  html = html.replace(/\\*\\*([^\\*]+)\\*\\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\\*([^\\*]+)\\*/g, '<em>$1</em>');
  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Unordered lists
  html = html.replace(/^[\\-\\*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\\/li>[\\n]?)+/g, '<ul>$&</ul>');
  // Paragraphs (double newlines)
  html = html.replace(/\\n{2,}/g, '</p><p>');
  html = '<p>' + html + '</p>';
  // Single newlines to <br>
  html = html.replace(/\\n/g, '<br>');
  // Clean up empty paragraphs
  html = html.replace(/<p><\\/p>/g, '');
  html = html.replace(/<p>(<h[1-3]>)/g, '$1');
  html = html.replace(/(<\\/h[1-3]>)<\\/p>/g, '$1');
  html = html.replace(/<p>(<ul>)/g, '$1');
  html = html.replace(/(<\\/ul>)<\\/p>/g, '$1');
  html = html.replace(/<p>(<pre>)/g, '$1');
  html = html.replace(/(<\\/pre>)<\\/p>/g, '$1');

  return html;
}

function renderTable(table) {
  if (!table || !table.columns || !table.rows) return '';
  const thead = '<thead><tr>' +
    table.columns.map(c => '<th>' + esc(c.label) + '</th>').join('') +
    '</tr></thead>';
  const tbody = '<tbody>' +
    table.rows.map(row =>
      '<tr>' + table.columns.map(c => '<td>' + esc(String(row[c.key] || '')) + '</td>').join('') + '</tr>'
    ).join('') +
    '</tbody>';
  return '<table>' + thead + tbody + '</table>';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

function getLoadingHtml() {
  return '<div class="ac-loading">' +
    '<div class="ac-loading-logo">' + getDiamondSvg(18) + '</div>' +
    '<div class="ac-dots"><span></span><span></span><span></span></div>' +
  '</div>';
}

// ── SVG icons (inlined) ───────────────────────────────────────────────────────
function getDiamondSvg(size) {
  return '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 16 16" width="' + size + '" height="' + size + '">' +
    '<path fill="currentColor" d="m13.905 5.621-3.487-3.51a4 4 0 0 0-1.443-.879c-1.194-.4-2.383-.094-3.349.865l-3.515 3.49a4 4 0 0 0-.878 1.445c-.402 1.193-.095 2.383.865 3.347l3.49 3.51c.413.393.905.693 1.443.879.326.111.668.169 1.012.171.84.003 1.645-.35 2.336-1.036l3.51-3.49c.392-.414.692-.906.879-1.445.4-1.193.094-2.381-.866-3.347zm-5.621-2.5c.264.085.507.225.714.41l1.031 1.04-2.022 2.01-2.012-2.024L7.038 3.52c.28-.277.674-.57 1.249-.4zm-5.16 4.594c.086-.264.226-.508.413-.714L4.574 5.97l2.011 2.022-2.024 2.012-1.037-1.045c-.278-.278-.57-.672-.401-1.247zm4.594 5.16a1.95 1.95 0 0 1-.714-.41l-1.028-1.027 2.023-2.012 2.01 2.022-1.042 1.039c-.28.277-.673.57-1.249.4zm5.163-4.584a2 2 0 0 1-.41.714l-1.038 1.018L9.422 8l2.022-2.011 1.037 1.043c.279.278.57.673.402 1.247"/>' +
  '</svg>';
}
function getSendSvg() {
  return '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 16 16" width="14" height="14"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M8 14V2M2.333 7.667 8 2l5.667 5.667"/></svg>';
}
function getStopSvg() {
  return '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 16 16" width="14" height="14"><rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor"/></svg>';
}
function getChevronSvg() {
  return '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 16 16" width="12" height="12" class="ac-reasoning-chevron"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="m3 5.5 5 5 5-5"/></svg>';
}
function getThumbsUpSvg() {
  return '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 16 16" width="14" height="14"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M5 14V7.31M2 8.6v4.2c0 .663.55 1.2 1.23 1.2h8.261c.911 0 1.686-.648 1.825-1.526l.662-4.2c.172-1.09-.693-2.074-1.824-2.074H9.998a.61.61 0 0 1-.615-.6V3.48c0-.818-.68-1.48-1.517-1.48-.2 0-.38.115-.462.293l-2.165 4.75a.62.62 0 0 1-.563.357H3.231C2.55 7.4 2 7.937 2 8.6"/></svg>';
}
function getThumbsDownSvg() {
  return '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 16 16" width="14" height="14"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M5.076 2v6.744M2 7.4V3.2C2 2.537 2.55 2 3.23 2h8.261c.911 0 1.686.648 1.825 1.526l.662 4.2c.172 1.09-.693 2.074-1.824 2.074H9.998a.61.61 0 0 0-.615.6v2.12c0 .818-.68 1.48-1.517 1.48a.51.51 0 0 1-.462-.293l-2.165-4.75a.62.62 0 0 0-.563-.357H3.231C2.55 8.6 2 8.063 2 7.4"/></svg>';
}
</script>
</body>
</html>`;
}

// ── CSS string ─────────────────────────────────────────────────────────────────

const CSS = `
/* ── Harness Intelligence Chat Panel ─────────────────────────────────────────
   Uses the same fixed Harness design tokens as the sidebar enhanced theme so
   VS Code, Cursor, and any other host show identical colors in dark/light mode.
   ─────────────────────────────────────────────────────────────────────────── */

/* ── Brand accents (shared) ───────────────────────────────────────────────── */
:root {
  --ac-font:      'IBM Plex Sans', -apple-system, system-ui, sans-serif;
  --ac-font-mono: 'JetBrains Mono', 'SF Mono', Consolas, monospace;
  --ac-ai-stop-1: lch(65% 58 255);
  --ac-ai-stop-2: lch(51% 85 280);
  --ac-ai-stop-3: lch(65% 61 290);
  --ac-radius:    6px;
  --ac-radius-pill: 16px;
  --ac-angle: 131deg;
}

/* ── Light palette — matches sidebar .theme-enhanced.theme-light ──────────── */
[data-theme="light"], .vscode-light, .vscode-high-contrast-light {
  --ac-bg:        #FAFAF7;
  --ac-fg:        #1A1C1F;
  --ac-fg-muted:  #6B7079;
  --ac-fg-dim:    #8C909A;
  --ac-border:    #D2CEC2;
  --ac-input-bg:  #FFFFFF;
  --ac-code-bg:   #F4F3EE;
  --ac-code-fg:   oklch(48% 0.16 245);
  --ac-hover:     #ECEAE3;
  --ac-focus:     oklch(48% 0.16 245);
  --ac-logo:      oklch(48% 0.16 245);
  --ac-btn-bg:    oklch(48% 0.16 245);
  --ac-btn-fg:    #FAFAF7;
  --ac-bubble-from: lch(91% 15 255 / 0.45);
  --ac-bubble-to:   lch(79% 6  272 / 0.20);
  --ac-reasoning-border: #E4E1D8;
  --ac-input-divider: #E4E1D8;
  --vscode-focusBorder: oklch(48% 0.16 245);
}

/* ── Dark palette — matches sidebar .theme-enhanced (default dark) ───────── */
[data-theme="dark"], .vscode-dark, .vscode-high-contrast {
  --ac-bg:        #0E1013;
  --ac-fg:        #EDF1F7;
  --ac-fg-muted:  #8D96A5;
  --ac-fg-dim:    #616978;
  --ac-border:    #323947;
  --ac-input-bg:  #1B1F26;
  --ac-code-bg:   #14171C;
  --ac-code-fg:   oklch(78% 0.13 200);
  --ac-hover:     #232832;
  --ac-focus:     oklch(78% 0.13 200);
  --ac-logo:      oklch(78% 0.13 200);
  --ac-btn-bg:    oklch(78% 0.13 200);
  --ac-btn-fg:    #0E1013;
  --ac-ai-stop-2: lch(55% 85 280);
  --ac-bubble-from: lch(35% 20 255 / 0.35);
  --ac-bubble-to:   lch(25% 8  272 / 0.25);
  --ac-reasoning-border: #323947;
  --ac-input-divider: #242933;
  --vscode-focusBorder: oklch(78% 0.13 200);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ac-bg:        #0E1013;
    --ac-fg:        #EDF1F7;
    --ac-fg-muted:  #8D96A5;
    --ac-fg-dim:    #616978;
    --ac-border:    #323947;
    --ac-input-bg:  #1B1F26;
    --ac-code-bg:   #14171C;
    --ac-code-fg:   oklch(78% 0.13 200);
    --ac-hover:     #232832;
    --ac-focus:     oklch(78% 0.13 200);
    --ac-logo:      oklch(78% 0.13 200);
    --ac-btn-bg:    oklch(78% 0.13 200);
    --ac-btn-fg:    #0E1013;
    --ac-reasoning-border: #323947;
    --ac-input-divider: #242933;
    --vscode-focusBorder: oklch(78% 0.13 200);
  }
}

/* ── Reset ───────────────────────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: var(--ac-font);
  font-size: 14px;
  font-weight: 400;
  line-height: 1.5;
  color: var(--ac-fg);
  background: var(--ac-bg);
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
  font-feature-settings: 'cv02', 'cv03', 'cv04';
}

/* ── Header ──────────────────────────────────────────────────────────────── */
.ac-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  height: 48px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--ac-border);
}
.ac-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ac-logo);
}
.ac-header-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ac-fg);
  max-width: min(380px, 42vw);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ac-header-title.is-empty { display: none; }
.ac-context-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ac-context-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px; height: 16px;
  padding: 0;
  border: none;
  border-radius: 9999px;
  background: transparent;
  color: inherit;
  opacity: 0.7;
  cursor: pointer;
  flex-shrink: 0;
}
.ac-context-remove:hover { opacity: 1; background: rgba(127,127,127,0.25); }
/* Brief pulse when context auto-updates on navigation. */
@keyframes ac-context-flash {
  0%   { box-shadow: 0 0 0 0 var(--ac-btn-bg); }
  30%  { box-shadow: 0 0 0 3px color-mix(in srgb, var(--ac-btn-bg) 45%, transparent); }
  100% { box-shadow: 0 0 0 0 transparent; }
}
.ac-context-flash { animation: ac-context-flash 0.9s ease-out; }
.ac-header-actions { display: flex; gap: 2px; }
.ac-icon-btn {
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--ac-radius);
  color: var(--ac-fg);
  cursor: pointer;
  transition: background 0.1s;
  padding: 4px;
}
.ac-icon-btn:hover { background: var(--ac-hover); }

/* ── Messages scroll area ────────────────────────────────────────────────── */
.ac-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  scrollbar-width: thin;
  scrollbar-color: var(--ac-border) transparent;
}
.ac-messages::-webkit-scrollbar { width: 6px; }
.ac-messages::-webkit-scrollbar-track { background: transparent; }
.ac-messages::-webkit-scrollbar-thumb {
  background: var(--ac-hover);
  border-radius: 3px;
}
.ac-messages::-webkit-scrollbar-thumb:hover { background: var(--ac-border); }

/* ── Greeting (empty state) ──────────────────────────────────────────────────
   Matches the Harness UI: the greeting is centered vertically and the quick
   chips sit at the bottom near the input, filling the message-area height. */
.ac-greeting-wrap {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 28px;
  padding: 8px 0 4px;
}
/* Two auto top-margins split the free space evenly: the greeting lands near
   the vertical center and the chips sit at the bottom near the input,
   matching the Harness web chat. */
.ac-greeting {
  margin-top: auto;
}
.ac-chips {
  margin-top: auto;
}
.ac-greeting {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 18px;
  font-weight: 500;
  color: var(--ac-fg);
}
.ac-greeting-icon {
  color: var(--ac-logo);
  display: inline-flex;
}


/* ── Quick action chips ───────────────────────────────────────────────────────
   Auto-width (hug content), left-aligned, with a leading icon — like Harness. */
.ac-chips {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-self: stretch;
  align-items: flex-start;
}
.ac-quick-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  max-width: 100%;
  min-height: 36px;
  padding: 8px 14px;
  background: var(--ac-input-bg);
  color: var(--ac-fg);
  border: 1px solid var(--ac-border);
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s, border-color 0.1s;
}
.ac-quick-chip svg { flex-shrink: 0; color: var(--ac-fg-muted); }
.ac-quick-chip:hover {
  background: var(--ac-hover);
  border-color: var(--ac-focus);
}

/* ── Message rows ────────────────────────────────────────────────────────── */
.ac-msg-row { display: flex; flex-direction: column; max-width: 100%; }

/* ── User bubble ─────────────────────────────────────────────────────────── */
.ac-msg-user { align-items: flex-end; }
.ac-bubble-user {
  /* Exact gradient from se3.harness.io: 95deg, lch(91 15 255/0.45) → lch(79 6 272/0.20) */
  background: linear-gradient(95deg,
    var(--ac-bubble-from) -13.12%,
    var(--ac-bubble-to) 84.9%
  );
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--ac-fg);
  max-width: 85%;
}

/* ── Assistant row logo ──────────────────────────────────────────────────── */
.ac-msg-assistant::before {
  content: '';
  display: none;
}
.ac-assistant-logo {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  color: var(--ac-logo);
  font-size: 12px;
  font-weight: 500;
}

/* ── Loading state (while streaming, before first thought) ───────────────── */
.ac-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
}
.ac-loading-logo {
  color: var(--ac-logo);
  animation: ac-logo-pulse 1.6s ease-in-out infinite;
  display: flex;
}
@keyframes ac-logo-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.4; transform: scale(0.9); }
}
.ac-dots { display: flex; gap: 4px; align-items: center; }
.ac-dots span {
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--ac-logo);
  opacity: 0.5;
  animation: ac-dot-bounce 1.2s ease-in-out infinite;
}
.ac-dots span:nth-child(1) { animation-delay: 0s; }
.ac-dots span:nth-child(2) { animation-delay: 0.16s; }
.ac-dots span:nth-child(3) { animation-delay: 0.32s; }
@keyframes ac-dot-bounce {
  0%, 80%, 100% { transform: translateY(0); opacity: 0.35; }
  40%            { transform: translateY(-5px); opacity: 1; }
}

/* ── Reasoning / thinking block ──────────────────────────────────────────── */
.ac-reasoning {
  border-left: 2px solid var(--ac-reasoning-border);
  padding-left: 12px;
  margin-bottom: 10px;
}
.ac-reasoning-trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--ac-fg-muted);
  font: 12px/1.4 var(--ac-font);
  font-style: italic;
  padding: 0;
  width: 100%;
  text-align: left;
}
.ac-reasoning-trigger:hover { color: var(--ac-fg); }
.ac-reasoning-chevron { transition: transform 0.15s ease; flex-shrink: 0; }
.ac-reasoning-trigger[aria-expanded="true"] .ac-reasoning-chevron { transform: rotate(180deg); }
.ac-reasoning-content {
  margin-top: 8px;
  font-size: 13px;
  color: var(--ac-fg-muted);
  font-style: italic;
  line-height: 1.55;
  max-height: 200px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.ac-reasoning-content[hidden] { display: none; }
.ac-reasoning-text { white-space: pre-wrap; }

/* ── Message body (markdown) ─────────────────────────────────────────────── */
.ac-msg-body {
  font-size: 14px;
  font-weight: 400;
  line-height: 1.55;
  color: var(--ac-fg);
}
.ac-msg-body p { margin-bottom: 8px; }
.ac-msg-body p:last-child { margin-bottom: 0; }
.ac-msg-body h1, .ac-msg-body h2 { font-size: 14px; font-weight: 600; margin: 12px 0 6px; }
.ac-msg-body h3 { font-size: 13px; font-weight: 600; margin: 10px 0 4px; }
.ac-msg-body ul, .ac-msg-body ol { padding-left: 20px; margin-bottom: 8px; }
.ac-msg-body li { margin-bottom: 4px; }
.ac-msg-body strong { font-weight: 600; }
.ac-msg-body em { font-style: italic; }
.ac-msg-body a {
  color: var(--ac-code-fg);
  text-decoration: none;
}
.ac-msg-body a:hover { text-decoration: underline; }
.ac-msg-body blockquote {
  border-left: 3px solid var(--ac-border);
  margin: 8px 0;
  padding-left: 12px;
  color: var(--ac-fg-muted);
}
.ac-msg-body hr { border: none; border-top: 1px solid var(--ac-border); margin: 12px 0; }
.ac-msg-body code {
  background: var(--ac-code-bg);
  color: var(--ac-code-fg);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 12px;
  font-family: var(--ac-font-mono);
  font-weight: 400;
}
.ac-msg-body pre {
  background: var(--ac-code-bg);
  border-radius: var(--ac-radius);
  padding: 12px;
  overflow-x: auto;
  margin: 8px 0;
  scrollbar-width: thin;
}
.ac-msg-body pre code { background: transparent; padding: 0; color: var(--ac-fg); }

/* ── Table (from 'table' SSE event or markdown) ──────────────────────────── */
.ac-table-wrap { margin: 8px 0; overflow-x: auto; }
.ac-msg-body table,
.ac-table-wrap table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  margin: 6px 0;
}
.ac-msg-body th,
.ac-table-wrap th {
  color: var(--ac-fg);
  font-weight: 600;
  border: 1px solid var(--ac-border);
  padding: 6px 12px;
  text-align: left;
  background: transparent;
}
.ac-msg-body td,
.ac-table-wrap td {
  color: var(--ac-fg-muted);
  border: 1px solid var(--ac-border);
  padding: 6px 12px;
  font-weight: 400;
}

/* ── Error message ───────────────────────────────────────────────────────── */
.ac-msg-error {
  font-size: 13px;
  color: oklch(68% 0.21 22);
  padding: 6px 0;
}

/* ── Entity mutation badge ───────────────────────────────────────────────── */
.ac-mutation {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  padding: 8px 12px;
  border: 1px solid var(--ac-border);
  border-radius: var(--ac-radius);
  margin: 8px 0;
  background: var(--ac-hover);
}
.ac-mutation-icon { font-weight: 700; color: #4caf50; }
.ac-mutation-link { color: var(--ac-code-fg); font-size: 12px; margin-left: 4px; }

/* ── Elicitation cards ───────────────────────────────────────────────────── */
.ac-elicitation {
  border: 1px solid var(--ac-border);
  border-radius: var(--ac-radius);
  padding: 14px 16px;
  margin: 8px 0;
  background: var(--ac-input-bg);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ac-elix-title { font-size: 13px; font-weight: 600; color: var(--ac-fg); }
.ac-elix-subtitle { font-size: 12px; color: var(--ac-fg-muted); }
.ac-elix-summary { font-size: 13px; color: var(--ac-fg); }
.ac-elix-detail {
  display: flex;
  gap: 8px;
  font-size: 12px;
  color: var(--ac-fg-muted);
}
.ac-elix-label { font-weight: 600; min-width: 80px; color: var(--ac-fg); }
.ac-elix-question { font-size: 13px; color: var(--ac-fg); font-weight: 500; }
.ac-elix-input {
  width: 100%;
  background: var(--ac-input-bg);
  color: var(--ac-fg);
  border: 1px solid var(--ac-border);
  border-radius: var(--ac-radius);
  padding: 8px 10px;
  font: 13px/1.4 var(--ac-font);
  resize: none;
  min-height: 72px;
  outline: none;
}
.ac-elix-input:focus { border-color: var(--ac-focus); }
.ac-elix-yaml {
  font-family: var(--ac-font-mono);
  font-size: 11px;
  background: var(--ac-code-bg);
  border-radius: 4px;
  padding: 10px;
  overflow-x: auto;
  max-height: 180px;
  white-space: pre;
  color: var(--ac-fg-muted);
}
.ac-elix-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.ac-elix-btn {
  padding: 5px 14px;
  border-radius: var(--ac-radius);
  font: 13px/1 var(--ac-font);
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--ac-border);
  transition: opacity 0.1s, filter 0.1s;
}
.ac-elix-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.ac-elix-btn-primary   { background: var(--ac-btn-bg); color: var(--ac-btn-fg); border-color: var(--ac-btn-bg); }
.ac-elix-btn-ghost     { background: transparent; color: var(--ac-fg-muted); }
.ac-elix-btn-destructive { background: transparent; color: oklch(68% 0.21 22); border-color: oklch(68% 0.21 22); }
.ac-elix-btn:not(:disabled):hover { filter: brightness(1.1); }
/* Read-only history elicitations: the action the user actually took stays highlighted */
.ac-elix-btn-chosen { opacity: 1 !important; border-color: var(--ac-btn-bg); box-shadow: 0 0 0 1px var(--ac-btn-bg) inset; font-weight: 600; }
.ac-elix-resolved-note { margin-top: 8px; font-size: 11px; font-style: italic; color: var(--ac-fg-dim); }

/* Single-select option pills */
.ac-elix-options { display: flex; flex-direction: column; gap: 6px; }
.ac-elix-option {
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
  padding: 8px 12px;
  border: 1px solid var(--ac-border);
  border-radius: var(--ac-radius);
  background: var(--ac-input-bg);
  color: var(--ac-fg);
  cursor: pointer;
  transition: border-color 0.1s, background 0.1s;
}
.ac-elix-option:not(:disabled):hover { border-color: var(--ac-focus); background: var(--ac-hover); }
.ac-elix-option:disabled { opacity: 0.5; cursor: not-allowed; }
.ac-elix-option-selected {
  border-color: var(--ac-btn-bg);
  box-shadow: 0 0 0 1px var(--ac-btn-bg) inset;
  background: var(--ac-hover);
}
.ac-elix-option-chosen {
  border-color: var(--ac-btn-bg);
  box-shadow: 0 0 0 1px var(--ac-btn-bg) inset;
}
.ac-elix-option-label { font-size: 13px; font-weight: 500; }
.ac-elix-option-desc { font-size: 12px; color: var(--ac-fg-muted); }

/* Multi-select checkboxes */
.ac-elix-hint { font-size: 12px; color: var(--ac-fg-muted); }
.ac-elix-option-check {
  flex-direction: row;
  align-items: flex-start;
  gap: 10px;
}
.ac-elix-checkbox,
.ac-elix-field-checkbox {
  margin: 2px 0 0;
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  accent-color: var(--ac-btn-bg);
  cursor: pointer;
}
.ac-elix-checkbox:disabled,
.ac-elix-field-checkbox:disabled { cursor: not-allowed; }
.ac-elix-option-text { display: flex; flex-direction: column; gap: 2px; }

/* Multi-field form */
.ac-elix-fields { display: flex; flex-direction: column; gap: 12px; }
.ac-elix-field { display: flex; flex-direction: column; gap: 4px; }
.ac-elix-field-label { font-size: 13px; font-weight: 500; color: var(--ac-fg); }
.ac-elix-field-header { font-size: 11px; color: var(--ac-fg-muted); }
.ac-elix-field-select {
  width: 100%;
  background: var(--ac-input-bg);
  color: var(--ac-fg);
  border: 1px solid var(--ac-border);
  border-radius: var(--ac-radius);
  padding: 7px 10px;
  font: 13px/1.4 var(--ac-font);
  outline: none;
  cursor: pointer;
}
.ac-elix-field-select:focus { border-color: var(--ac-focus); }
.ac-elix-field-select:disabled { opacity: 0.5; cursor: not-allowed; }
.ac-elix-field-text {
  width: 100%;
  background: var(--ac-input-bg);
  color: var(--ac-fg);
  border: 1px solid var(--ac-border);
  border-radius: var(--ac-radius);
  padding: 8px 10px;
  font: 13px/1.4 var(--ac-font);
  resize: none;
  min-height: 56px;
  outline: none;
}
.ac-elix-field-text:focus { border-color: var(--ac-focus); }

/* ── Feedback buttons ────────────────────────────────────────────────────── */
.ac-feedback { display: flex; gap: 2px; margin-top: 8px; }
.ac-feedback-btn {
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--ac-radius);
  color: var(--ac-fg-muted);
  cursor: pointer;
  padding: 4px;
  transition: background 0.1s, border-color 0.1s, color 0.1s;
}
.ac-feedback-btn:hover { background: var(--ac-hover); border-color: var(--ac-border); color: var(--ac-fg); }
.ac-feedback-btn.active { color: var(--ac-btn-bg); border-color: var(--ac-btn-bg); }

/* ── Input wrapper ───────────────────────────────────────────────────────── */
.ac-input-wrapper {
  flex-shrink: 0;
  padding: 0 16px 14px;
}

/* ── Input form — Harness animated border ────────────────────────────────── */
/* On focus: conic gradient border spins (ac-spin) + glows (ac-glow) */
/* The spin uses @property --ac-angle to animate the conic gradient starting angle */
@property --ac-angle {
  syntax: "<angle>";
  initial-value: 131deg;
  inherits: false;
}

/* Keyframes from se3.harness.io (captured via DevTools) */
/* cn-spin: rotates --cn-angle 131deg → 491deg over 4s */
@keyframes ac-spin {
  0%   { --ac-angle: 131deg; }
  100% { --ac-angle: 491deg; }
}

/* cn-glow-in: 0.3s fade-in of box-shadow from transparent to stop-1 blue */
@keyframes ac-glow-in {
  0%   { box-shadow: 0 0 0 transparent; }
  100% { box-shadow:
    0 0 3px   color-mix(in srgb, var(--ac-ai-stop-1) 30%, transparent),
    0 0 12px 2px color-mix(in srgb, var(--ac-ai-stop-1) 15%, transparent),
    0 0 28px 6px color-mix(in srgb, var(--ac-ai-stop-1)  8%, transparent);
  }
}

/* cn-glow: 5s pulsing shadow cycling blue → indigo → violet → blue */
@keyframes ac-glow {
  0%, 100% { box-shadow:
    0 0 3px   color-mix(in srgb, var(--ac-ai-stop-1) 30%, transparent),
    0 0 12px 2px color-mix(in srgb, var(--ac-ai-stop-1) 15%, transparent),
    0 0 28px 6px color-mix(in srgb, var(--ac-ai-stop-1)  8%, transparent);
  }
  33% { box-shadow:
    0 0 3px   color-mix(in srgb, var(--ac-ai-stop-2) 30%, transparent),
    0 0 12px 2px color-mix(in srgb, var(--ac-ai-stop-2) 15%, transparent),
    0 0 28px 6px color-mix(in srgb, var(--ac-ai-stop-2)  8%, transparent);
  }
  66% { box-shadow:
    0 0 3px   color-mix(in srgb, var(--ac-ai-stop-3) 30%, transparent),
    0 0 12px 2px color-mix(in srgb, var(--ac-ai-stop-3) 15%, transparent),
    0 0 28px 6px color-mix(in srgb, var(--ac-ai-stop-3)  8%, transparent);
  }
}

.ac-form {
  background: linear-gradient(var(--ac-input-bg), var(--ac-input-bg)) padding-box,
              linear-gradient(var(--ac-border), var(--ac-border)) border-box;
  border: 1.5px solid transparent;
  border-radius: 12px;
  padding: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: box-shadow 0.3s ease;
}

.ac-form-body {
  padding: 12px 14px 10px;
}

.ac-form:hover:not(:focus-within) {
  background:
    linear-gradient(var(--ac-input-bg), var(--ac-input-bg)) padding-box,
    conic-gradient(from 131deg,
      var(--ac-ai-stop-3),
      var(--ac-ai-stop-2),
      var(--ac-ai-stop-1),
      var(--ac-ai-stop-2),
      var(--ac-ai-stop-3)
    ) border-box;
}

.ac-form:focus-within {
  animation:
    ac-spin   4s linear   0s   infinite normal none running,
    ac-glow-in 0.3s ease-out 0s 1       normal forwards running,
    ac-glow   5s ease-in-out 0.3s infinite normal none running;
  background:
    linear-gradient(var(--ac-input-bg), var(--ac-input-bg)) padding-box,
    conic-gradient(from var(--ac-angle),
      var(--ac-ai-stop-3),
      var(--ac-ai-stop-2),
      var(--ac-ai-stop-1),
      var(--ac-ai-stop-2),
      var(--ac-ai-stop-3)
    ) border-box;
}

.ac-textarea {
  width: 100%;
  background: transparent;
  color: var(--ac-fg);
  border: none;
  outline: none !important;
  outline-offset: 0 !important;
  box-shadow: none !important;
  font-family: var(--ac-font);
  font-size: 14px;
  font-weight: 400;
  line-height: 1.5;
  resize: none;
  min-height: 20px;
  max-height: 180px;
  overflow-y: auto;
  scrollbar-width: none;
  /* field-sizing: content — auto-grow without JS */
  field-sizing: content;
}
.ac-textarea:focus,
.ac-textarea:focus-visible {
  outline: none !important;
  outline-offset: 0 !important;
  box-shadow: none !important;
  border: none !important;
}
.ac-textarea::placeholder { color: var(--ac-fg-dim); }
.ac-textarea::-webkit-scrollbar { display: none; }

.ac-form-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-top: 1px solid var(--ac-input-divider);
  padding: 8px 10px 10px 12px;
  overflow: visible;
  position: relative;
  z-index: 2;
}
.ac-form-footer-pills {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  overflow: visible;
}

/* MCP connector pill — compact "MCP" + count badge */
.ac-mcp-pill {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--ac-fg-muted);
  padding: 3px 8px 3px 7px;
  border: 1px solid var(--ac-border);
  border-radius: 9999px;
  cursor: default;
  user-select: none;
  white-space: nowrap;
  flex-shrink: 0;
  outline: none;
}
.ac-mcp-pill:focus-visible {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ac-btn-bg) 35%, transparent);
}
.ac-mcp-dot {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  flex-shrink: 0;
  background: var(--ac-fg-dim);
}
.ac-mcp-pill.ac-mcp-on .ac-mcp-dot { background: #3fb950; }
.ac-mcp-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ac-fg-muted);
}
.ac-mcp-count {
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--ac-btn-bg) 16%, transparent);
  color: var(--ac-btn-bg);
  border: 1px solid color-mix(in srgb, var(--ac-btn-bg) 28%, transparent);
}
.ac-mcp-count.is-zero {
  background: var(--ac-hover);
  color: var(--ac-fg-dim);
  border-color: var(--ac-border);
}

/* Fixed popover — escapes the input box; scrollable table for long lists */
.ac-mcp-popover {
  position: fixed;
  z-index: 1000;
  display: none;
  min-width: 220px;
  max-width: min(340px, calc(100vw - 16px));
  max-height: min(320px, calc(100vh - 16px));
  background: var(--ac-input-bg);
  border: 1px solid var(--ac-border);
  border-radius: 10px;
  box-shadow:
    0 10px 32px rgba(0, 0, 0, 0.28),
    0 0 0 1px color-mix(in srgb, var(--ac-btn-bg) 10%, transparent);
  overflow: hidden;
  pointer-events: auto;
  opacity: 0;
  transform: translateY(5px);
  transition: opacity 0.14s ease, transform 0.14s ease;
}
.ac-mcp-popover.is-visible {
  opacity: 1;
  transform: translateY(0);
}
.ac-mcp-pop-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 4px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--ac-fg-muted);
}
.ac-mcp-pop-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 6px;
  border-radius: 9999px;
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0;
  text-transform: none;
  color: var(--ac-btn-bg);
  background: color-mix(in srgb, var(--ac-btn-bg) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--ac-btn-bg) 30%, transparent);
}
.ac-mcp-pop-sub {
  padding: 0 12px 10px;
  font-size: 11px;
  color: var(--ac-fg-dim);
  border-bottom: 1px solid var(--ac-border);
}
.ac-mcp-pop-empty {
  padding: 12px 14px 14px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--ac-fg-muted);
}
.ac-mcp-pop-scroll {
  max-height: 240px;
  overflow-y: auto;
  scrollbar-width: thin;
}
.ac-mcp-pop-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.ac-mcp-pop-table tbody tr {
  border-bottom: 1px solid color-mix(in srgb, var(--ac-border) 65%, transparent);
  transition: background 0.1s;
}
.ac-mcp-pop-table tbody tr:last-child { border-bottom: none; }
.ac-mcp-pop-table tbody tr:hover { background: var(--ac-hover); }
.ac-mcp-pop-ico {
  width: 32px;
  padding: 0;
  vertical-align: middle;
  text-align: center;
}
.ac-mcp-pop-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 9999px;
  background: var(--ac-btn-bg);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ac-btn-bg) 18%, transparent);
}
.ac-mcp-pop-name {
  padding: 9px 12px 9px 2px;
  color: var(--ac-fg);
  font-weight: 500;
  line-height: 1.35;
}

/* Pipeline context chip — highlighted accent pill after MCP */
.ac-context-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 4px 3px 9px;
  border-radius: 9999px;
  background: color-mix(in srgb, var(--ac-btn-bg) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--ac-btn-bg) 42%, transparent);
  color: var(--ac-btn-bg);
  flex-shrink: 1;
  min-width: 0;
  max-width: min(260px, 58%);
}

/* ── Send button (circular) / Stop button (rounded square) ──────────────── */
/* Send: fully round, blue fill, arrow-up icon */
/* Stop: rounded square (border-radius 6px), blue fill, square icon — shown while streaming */
.ac-send {
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  background: var(--ac-btn-bg);
  color: var(--ac-btn-fg);
  border: 1px solid var(--ac-btn-bg);
  border-radius: 9999px;
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
  transition: opacity 0.15s, filter 0.15s, border-radius 0.15s;
}
.ac-send:disabled { opacity: 0.35; cursor: not-allowed; }
.ac-send:not(:disabled):hover { filter: brightness(1.12); }

/* Stop state — square border-radius (from cn-rounded-4 = 8px in Harness) */
.ac-send.ac-send-stop { border-radius: 6px; }

/* ── Disclaimer ──────────────────────────────────────────────────────────── */
.ac-disclaimer {
  font-size: 11px;
  color: var(--ac-fg-dim);
  text-align: center;
  padding: 4px 18px 12px;
  flex-shrink: 0;
}

/* ── Back button ─────────────────────────────────────────────────────────── */
.ac-back-btn { margin-right: 2px; }

/* ── Overflow menu (··· → History) ───────────────────────────────────────── */
.ac-header-actions { position: relative; }
.ac-menu {
  position: absolute;
  top: 34px;
  right: 0;
  min-width: 168px;
  background: var(--ac-input-bg);
  border: 1px solid var(--ac-border);
  border-radius: 8px;
  box-shadow: 0 4px 16px color-mix(in srgb, var(--ac-fg) 18%, transparent);
  padding: 4px;
  z-index: 50;
}
.ac-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--ac-fg);
  font-family: var(--ac-font);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.ac-menu-item:hover { background: var(--ac-hover); }
.ac-menu-item.ac-menu-danger { color: lch(52% 68 25); }

/* ── History view ────────────────────────────────────────────────────────── */
.ac-history {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}
.ac-history-search-wrap {
  position: relative;
  padding: 12px 16px 8px;
  flex-shrink: 0;
}
.ac-history-search-icon {
  position: absolute;
  left: 28px;
  top: 50%;
  transform: translateY(-30%);
  color: var(--ac-fg-dim);
  pointer-events: none;
}
.ac-history-search {
  width: 100%;
  height: 36px;
  padding: 0 12px 0 34px;
  background: var(--ac-input-bg);
  border: 1px solid var(--ac-border);
  border-radius: var(--ac-radius-pill);
  color: var(--ac-fg);
  font-family: var(--ac-font);
  font-size: 13px;
  outline: none;
}
.ac-history-search:focus { border-color: var(--ac-focus); }
.ac-history-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 12px 12px;
  scrollbar-width: thin;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ac-history-item {
  position: relative;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 12px;
  border-radius: 8px;
  border: 1px solid var(--ac-border);
  background: var(--ac-input-bg);
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.ac-history-item:hover {
  background: var(--ac-hover);
  border-color: color-mix(in srgb, var(--ac-border) 60%, var(--ac-focus));
}
.ac-history-item-main { min-width: 0; flex: 1; }
.ac-history-item-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--ac-fg);
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ac-history-item-time {
  font-size: 12px;
  color: var(--ac-fg-dim);
  margin-top: 4px;
}
.ac-history-item-menu-btn {
  flex-shrink: 0;
  width: 26px; height: 26px;
  display: flex; align-items: center; justify-content: center;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--ac-fg-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity .1s, background .1s;
}
.ac-history-item:hover .ac-history-item-menu-btn { opacity: 1; }
.ac-history-item-menu-btn:hover { background: var(--ac-border); }
.ac-history-empty {
  text-align: center;
  color: var(--ac-fg-dim);
  font-size: 13px;
  padding: 40px 20px;
}
.ac-history-rename-input {
  width: 100%;
  padding: 4px 6px;
  background: var(--ac-input-bg);
  border: 1px solid var(--ac-focus);
  border-radius: 5px;
  color: var(--ac-fg);
  font-family: var(--ac-font);
  font-size: 13.5px;
  font-weight: 500;
  outline: none;
}

/* ── Focus ring isolation ────────────────────────────────────────────────────
   Cursor/VS Code inject textarea:focus { outline: 1px solid var(--vscode-focusBorder) }
   which leaks the IDE theme (often orange). Suppress on the chat input; keep our
   animated conic border as the only focus indicator on .ac-form. */
.ac-form,
.ac-form:focus,
.ac-form:focus-within,
.ac-form-body,
.ac-form-body:focus-within {
  outline: none !important;
  outline-offset: 0 !important;
}

.ac-textarea:focus,
.ac-textarea:focus-visible,
.ac-history-search:focus,
.ac-history-search:focus-visible,
.ac-history-rename-input:focus,
.ac-history-rename-input:focus-visible,
.ac-elix-input:focus,
.ac-elix-input:focus-visible,
.ac-elix-field-text:focus,
.ac-elix-field-text:focus-visible,
.ac-elix-field-select:focus,
.ac-elix-field-select:focus-visible {
  outline: none !important;
  outline-offset: 0 !important;
  box-shadow: none !important;
}

.ac-icon-btn:focus-visible,
.ac-send:focus-visible,
.ac-chip:focus-visible,
.ac-history-item-menu-btn:focus-visible {
  outline: 2px solid var(--ac-focus) !important;
  outline-offset: 2px;
}
`;

// ── Static HTML fragments ──────────────────────────────────────────────────────

const DIAMOND_SVG_20 = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 16 16" width="20" height="20">
  <path fill="currentColor" d="m13.905 5.621-3.487-3.51a4 4 0 0 0-1.443-.879c-1.194-.4-2.383-.094-3.349.865l-3.515 3.49a4 4 0 0 0-.878 1.445c-.402 1.193-.095 2.383.865 3.347l3.49 3.51c.413.393.905.693 1.443.879.326.111.668.169 1.012.171.84.003 1.645-.35 2.336-1.036l3.51-3.49c.392-.414.692-.906.879-1.445.4-1.193.094-2.381-.866-3.347zm-5.621-2.5c.264.085.507.225.714.41l1.031 1.04-2.022 2.01-2.012-2.024L7.038 3.52c.28-.277.674-.57 1.249-.4zm-5.16 4.594c.086-.264.226-.508.413-.714L4.574 5.97l2.011 2.022-2.024 2.012-1.037-1.045c-.278-.278-.57-.672-.401-1.247zm4.594 5.16a1.95 1.95 0 0 1-.714-.41l-1.028-1.027 2.023-2.012 2.01 2.022-1.042 1.039c-.28.277-.673.57-1.249.4zm5.163-4.584a2 2 0 0 1-.41.714l-1.038 1.018L9.422 8l2.022-2.011 1.037 1.043c.279.278.57.673.402 1.247"/>
</svg>`;

const HEADER_HTML = `<div class="ac-header">
  <div class="ac-header-left">
    <button class="ac-icon-btn ac-back-btn" id="ac-history-back" title="Back to chat" style="display:none">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 16 16" width="16" height="16">
        <path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M10 3 5 8l5 5"/>
      </svg>
    </button>
    <span class="ac-header-title" id="ac-header-title"></span>
  </div>
  <div class="ac-header-actions">
    <button class="ac-icon-btn" id="ac-new-chat" title="New chat">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 16 16" width="16" height="16">
        <path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M8 2v12M2 8h12"/>
      </svg>
    </button>
    <button class="ac-icon-btn" id="ac-overflow" title="More">
      <svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 16 16" width="16" height="16">
        <circle cx="3" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="13" cy="8" r="1.3"/>
      </svg>
    </button>
    <div class="ac-menu" id="ac-overflow-menu" style="display:none">
      <button class="ac-menu-item" id="ac-menu-history">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 16 16" width="15" height="15"><circle cx="8" cy="8" r="6" stroke="currentColor"/><path stroke="currentColor" stroke-linecap="round" d="M8 5v3l2 1.5"/></svg>
        History
      </button>
    </div>
  </div>
</div>`;

const CHIP_ICON_PIPELINE = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M12.75 7.254a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0M4.25 8.756a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0M4.25 11.856a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0M12.75 4.248a.5.5 0 1 1-1 0 .5.5 0 0 1 1 0"/><path stroke="currentColor" stroke-width="1" d="M3.75 8.75V4.267m0 0a1.767 1.767 0 0 1 1.767-1.767h.358m6.375 4.75v4.483m0 0a1.767 1.767 0 0 1-1.767 1.767h-.358M8 4.267v7.466"/></svg>';
const CHIP_ICON_QUESTION = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M6.2 6.2c0-2.1 3.3-2.1 3.3 0 0 1.5-1.5 1.2-1.5 3m0 2.406.006-.007M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12"/></svg>';

const GREETING_HTML = `<div class="ac-greeting-wrap">
  <div class="ac-greeting">
    <span class="ac-greeting-icon">${DIAMOND_SVG_20}</span>
    <span>How can I help you today?</span>
  </div>
  <div class="ac-chips">
    <button class="ac-quick-chip" data-prompt="List pipelines">${CHIP_ICON_PIPELINE}<span>List pipelines</span></button>
    <button class="ac-quick-chip" data-prompt="Ask a support question">${CHIP_ICON_QUESTION}<span>Ask a support question</span></button>
    <button class="ac-quick-chip" data-prompt="Analyze Pipeline Errors">${CHIP_ICON_PIPELINE}<span>Analyze Pipeline Errors</span></button>
  </div>
</div>`;

const INPUT_HTML = `<div class="ac-input-wrapper">
  <form class="ac-form" id="ac-form">
    <div class="ac-form-body">
      <textarea
        class="ac-textarea"
        id="ac-textarea"
        placeholder="Ask Harness AI…"
        rows="1"
      ></textarea>
    </div>
    <div class="ac-form-footer">
      <div class="ac-form-footer-pills">
        <span class="ac-mcp-pill" id="ac-mcp-pill" style="display:none" tabindex="0"></span>
        <span class="ac-context-chip" id="ac-context-chip" style="display:none"></span>
      </div>
      <button class="ac-send" id="ac-send" type="submit" disabled title="Send">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 16 16" width="14" height="14">
          <path stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" d="M8 14V2M2.333 7.667 8 2l5.667 5.667"/>
        </svg>
      </button>
    </div>
  </form>
</div>`;

// Full-panel History view — hidden by default, shown when the user opens History.
const HISTORY_HTML = `<div class="ac-history" id="ac-history" style="display:none">
  <div class="ac-history-search-wrap">
    <svg class="ac-history-search-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 16 16" width="15" height="15"><circle cx="7" cy="7" r="4.5" stroke="currentColor"/><path stroke="currentColor" stroke-linecap="round" d="m11 11 3 3"/></svg>
    <input type="text" class="ac-history-search" id="ac-history-search" placeholder="Search your chats…" />
  </div>
  <div class="ac-history-list" id="ac-history-list"></div>
</div>`;
