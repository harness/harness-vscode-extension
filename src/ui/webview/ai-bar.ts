// AI Bar - DOM rendering and event handlers for Harness AI integration
// Handles all 6 states: detecting, none, unconfigured, ready, sending, error

interface DetectedTool {
  id: 'claudecode-cli' | 'claudecode-ext';
  name: string;
  sub: string | null;
  mcpReady: boolean;
}

interface DetectionResult {
  tools: DetectedTool[];
  activeTool: string | null;
  mcpConfigPath: string | null;
}

interface AIState {
  detection: DetectionResult | null;
  state: 'detecting' | 'none' | 'unconfigured' | 'ready' | 'sending' | 'error';
  question: string;
  showToolPicker: boolean;
  overlay: 'mcp-setup' | 'mcp-done' | 'response' | 'launched' | null;
  mcpConfiguring: boolean;
  response: {
    content: string;
    toolCalls?: Array<{ name: string }>;
    durationMs?: number;
  } | null;
  error: string | null;
}

const aiState: AIState = {
  detection: null,
  state: 'detecting',
  question: '',
  showToolPicker: false,
  overlay: null,
  mcpConfiguring: false,
  response: null,
  error: null,
};

// Tool metadata
const TOOL_META: Record<string, { name: string; sub: string | null }> = {
  'claudecode-cli': { name: 'Claude Code', sub: 'Terminal' },
  'claudecode-ext': { name: 'Claude Code', sub: 'Extension' },
};

// ── Tool glyphs ─────────────────────────────────────────────────

function claudeCliGlyph(): string {
  return `<svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
    <rect x="1.5" y="2.5" width="11" height="9" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/>
    <path d="M3.8 6 L5.5 7.5 L3.8 9 M6.5 9 L9.5 9" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function claudeExtGlyph(): string {
  return `<svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M7 1.5 L11.5 4 L11.5 10 L7 12.5 L2.5 10 L2.5 4 Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
    <circle cx="7" cy="7" r="1.6" fill="currentColor"/>
  </svg>`;
}

function getToolGlyph(toolId: string): string {
  switch (toolId) {
    case 'claudecode-cli': return claudeCliGlyph();
    case 'claudecode-ext': return claudeExtGlyph();
    default: return '';
  }
}

// ── Icon helpers ────────────────────────────────────────────────

function sendIcon(): string {
  return `<svg width="11" height="11" viewBox="0 0 12 12">
    <path d="M6 10 L6 2 M3 5 L6 2 L9 5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function chevDownIcon(): string {
  return `<svg width="8" height="8" viewBox="0 0 8 8">
    <path d="M1.5 3 L4 5.5 L6.5 3" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function warnIcon(): string {
  return `<svg width="11" height="11" viewBox="0 0 12 12">
    <path d="M6 1.5 L11 10 L1 10 Z M6 5 L6 7.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/>
    <circle cx="6" cy="8.7" r="0.55" fill="currentColor"/>
  </svg>`;
}

function checkIcon(): string {
  return `<svg width="12" height="12" viewBox="0 0 12 12">
    <path d="M2.5 6.2 L5 8.5 L9.5 3.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function closeIcon(): string {
  return `<svg width="10" height="10" viewBox="0 0 10 10">
    <path d="M2 2 L8 8 M8 2 L2 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
  </svg>`;
}

function externalIcon(): string {
  return `<svg width="11" height="11" viewBox="0 0 12 12">
    <path d="M3 3 L7 3 L7 7 M7 3 L3 7" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

// ── Status dot ──────────────────────────────────────────────────

function statusDot(state: 'ok' | 'warn' | 'err' | 'pulse'): string {
  return `<span class="ai-dot ai-dot-${state}" aria-hidden="true"></span>`;
}

// ── Escape HTML ─────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Tool badge ──────────────────────────────────────────────────

function renderToolBadge(toolId: string | null, multi: boolean, warn: boolean): string {
  if (!toolId) {
    return `<div class="ai-badge is-warn">
      ${warnIcon()}
      <span>No AI tool</span>
    </div>`;
  }

  const meta = TOOL_META[toolId];
  const glyph = getToolGlyph(toolId);
  const chevron = multi ? `<span class="ai-badge-chev">${chevDownIcon()}</span>` : '';

  return `<button class="ai-badge ${warn ? 'is-warn' : ''}" data-action="toggleToolPicker">
    ${glyph}
    <span class="ai-badge-name">${esc(meta.name)}</span>
    ${chevron}
  </button>`;
}

// ── Tool picker ─────────────────────────────────────────────────

function renderToolPicker(): string {
  if (!aiState.detection || !aiState.showToolPicker) {
    return '';
  }

  const { tools, activeTool } = aiState.detection;
  if (tools.length < 2) {
    return ''; // Only show picker if multiple tools detected
  }

  const items = tools.map(tool => {
    const meta = TOOL_META[tool.id];
    const glyph = getToolGlyph(tool.id);
    const isActive = tool.id === activeTool;
    const statusClass = tool.mcpReady ? 'is-ok' : 'is-warn';
    const statusText = tool.mcpReady ? 'MCP ready' : 'MCP not configured';
    const check = isActive ? `<span class="aix-picker-check">${checkIcon()}</span>` : '';

    return `<button class="aix-picker-item ${isActive ? 'on' : ''}" data-action="switchTool" data-tool-id="${tool.id}">
      <span class="aix-picker-ico">${glyph}</span>
      <span class="aix-picker-text">
        <span class="aix-picker-name">
          ${esc(meta.name)}
          ${meta.sub ? `<span class="aix-picker-sub">${esc(meta.sub)}</span>` : ''}
        </span>
        <span class="aix-picker-status ${statusClass}">
          ${statusDot(tool.mcpReady ? 'ok' : 'warn')}
          ${statusText}
        </span>
      </span>
      ${check}
    </button>`;
  }).join('');

  return `<div class="aix-picker">
    <div class="aix-picker-head">Choose AI tool</div>
    ${items}
    <div class="aix-picker-foot">
      <span class="aix-picker-foot-k">Priority</span>
      <span class="aix-picker-foot-v mono">Terminal › Extension</span>
    </div>
  </div>`;
}

// ── MCP setup card ──────────────────────────────────────────────

function renderMCPSetupCard(): string {
  if (aiState.overlay !== 'mcp-setup' && aiState.overlay !== 'mcp-done') {
    return '';
  }

  const activeTool = aiState.detection?.activeTool;
  if (!activeTool) return '';

  const meta = TOOL_META[activeTool];
  const glyph = getToolGlyph(activeTool);

  if (aiState.overlay === 'mcp-done') {
    return `<div class="aix-overlay aix-overlay-done">
      <span class="aix-overlay-check">${checkIcon()}</span>
      <div class="aix-overlay-done-text">
        <strong>Harness MCP configured for ${esc(meta.name)}.</strong>
        <span>Restart ${esc(meta.name)} to activate.</span>
      </div>
      <button class="aix-overlay-x" data-action="closeMCPCard" aria-label="Dismiss">${closeIcon()}</button>
    </div>`;
  }

  const busyClass = aiState.mcpConfiguring ? 'is-busy' : '';
  const busyContent = aiState.mcpConfiguring
    ? `<span class="aix-send-spin"></span> Configuring…`
    : 'Configure automatically';

  return `<div class="aix-overlay aix-overlay-setup">
    <div class="aix-setup-hdr">
      <span class="aix-setup-glyph">${glyph}</span>
      <div class="aix-setup-title">
        <strong>Configure Harness MCP</strong>
        <span>Lets ${esc(meta.name)} fetch pipeline data, logs &amp; executions.</span>
      </div>
      <button class="aix-overlay-x" data-action="closeMCPCard" aria-label="Dismiss">${closeIcon()}</button>
    </div>
    <div class="aix-setup-meta">
      <div class="aix-setup-row">
        <span class="aix-setup-k">Writes to</span>
        <code class="aix-setup-v mono">~/.claude/claude_desktop_config.json</code>
      </div>
      <div class="aix-setup-row">
        <span class="aix-setup-k">Auth</span>
        <span class="aix-setup-v">Uses your stored Harness PAT</span>
      </div>
    </div>
    <div class="aix-setup-acts">
      <button class="aix-btn-primary ${busyClass}" data-action="configureMCP" ${aiState.mcpConfiguring ? 'disabled' : ''}>
        ${busyContent}
      </button>
      <button class="aix-btn-ghost" data-action="closeMCPCard">Not now</button>
    </div>
  </div>`;
}

// ── Response panel ──────────────────────────────────────────────

function renderResponsePanel(): string {
  if (aiState.overlay !== 'response' || !aiState.response) {
    return '';
  }

  const activeTool = aiState.detection?.activeTool;
  if (!activeTool) return '';

  const meta = TOOL_META[activeTool];
  const glyph = getToolGlyph(activeTool);
  const { content, toolCalls, durationMs } = aiState.response;

  // Format duration
  const duration = durationMs ? `${(durationMs / 1000).toFixed(1)}s` : '';
  const toolCallCount = toolCalls?.length || 0;
  const metaText = [
    toolCallCount > 0 ? `${toolCallCount} MCP call${toolCallCount > 1 ? 's' : ''}` : null,
    duration,
  ].filter(Boolean).join(' · ');

  // Render tool call chips
  const toolCallChips = toolCalls?.map(tc =>
    `<span class="aix-tool-call">${esc(tc.name)}</span>`
  ).join('') || '';

  // Simple markdown-lite rendering (bold, code, lists)
  let htmlContent = esc(content)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code class="mono">$1</code>')
    .replace(/\n- (.*)/g, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/g, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');

  htmlContent = `<p>${htmlContent}</p>`;

  return `<div class="aix-response">
    <div class="aix-response-hdr">
      <span class="aix-response-tool">
        ${glyph}
        <span>${esc(meta.name)}</span>
        ${metaText ? `<span class="aix-response-meta">· ${esc(metaText)}</span>` : ''}
      </span>
      <button class="aix-response-close" data-action="closeResponse" aria-label="Close">${closeIcon()}</button>
    </div>
    <div class="aix-response-body">
      ${htmlContent}
      ${toolCallChips ? `<div class="aix-response-tools">${toolCallChips}</div>` : ''}
    </div>
    <div class="aix-response-foot">
      <button class="aix-chip" data-action="copyResponse">Copy answer</button>
      <button class="aix-chip" data-action="rerun">Re-run</button>
    </div>
  </div>`;
}

// ── Launched confirmation ───────────────────────────────────────

function renderLaunchedConfirm(): string {
  if (aiState.overlay !== 'launched') {
    return '';
  }

  const activeTool = aiState.detection?.activeTool;
  if (!activeTool) return '';

  const meta = TOOL_META[activeTool];

  return `<div class="aix-overlay aix-overlay-launched">
    <span class="aix-overlay-check is-accent">${externalIcon()}</span>
    <div class="aix-overlay-done-text">
      <strong>Opened in ${esc(meta.name)}</strong>
      <span>Continue the conversation there.</span>
    </div>
  </div>`;
}

// ── Main AI bar rendering ───────────────────────────────────────

export function renderAIBar(): string {
  const { state, question, detection } = aiState;

  // Determine placeholder text
  const placeholders: Record<typeof state, string> = {
    detecting: 'Detecting AI tools…',
    none: 'Install Claude Code to ask questions',
    unconfigured: 'Configure MCP to ask questions',
    ready: 'Ask about this pipeline…',
    sending: question || 'Thinking…',
    error: 'Ask about this pipeline…',
  };

  // Input and send button states
  const inputDisabled = state === 'detecting' || state === 'none' || state === 'sending';
  const sendDisabled = inputDisabled || !question;

  // Badge rendering
  let badgeHtml = '';
  if (state === 'detecting') {
    badgeHtml = `<div class="aix-detect"><span class="aix-spinner"></span></div>`;
  } else if (state === 'none') {
    badgeHtml = renderToolBadge(null, false, false);
  } else if (detection?.activeTool) {
    const multi = (detection.tools.length || 0) > 1;
    const warn = state === 'unconfigured';
    badgeHtml = renderToolBadge(detection.activeTool, multi, warn);
  }

  // Send button content
  const sendContent = state === 'sending'
    ? '<span class="aix-send-spin"></span>'
    : sendIcon();

  // Status line
  let statusHtml = '';
  if (state !== 'none') {
    const statusLines: Record<typeof state, { dot: string; text: string; link?: string }> = {
      detecting: { dot: 'pulse', text: 'Detecting AI tools…' },
      none: { dot: 'err', text: 'No AI tool found', link: 'Install Claude Code ↗' },
      unconfigured: {
        dot: 'warn',
        text: `MCP not configured · ${TOOL_META[detection?.activeTool || '']?.name || ''}`,
        link: 'Configure MCP ›',
      },
      ready: {
        dot: 'ok',
        text: `MCP ready · ${TOOL_META[detection?.activeTool || '']?.name || ''}${TOOL_META[detection?.activeTool || '']?.sub ? ` (${TOOL_META[detection?.activeTool || ''].sub})` : ''}`,
      },
      sending: { dot: 'pulse', text: `Querying ${TOOL_META[detection?.activeTool || '']?.name || ''}…` },
      error: { dot: 'err', text: aiState.error || 'Request failed', link: 'Retry' },
    };

    const s = statusLines[state];
    const linkHtml = s.link
      ? `<button class="aix-status-link ${state === 'unconfigured' ? 'is-primary' : ''}" data-action="${state === 'unconfigured' ? 'showMCPSetup' : 'retry'}">${esc(s.link)}</button>`
      : '';

    statusHtml = `<div class="aix-status">
      ${statusDot(s.dot as any)}
      <span class="aix-status-txt">${esc(s.text)}</span>
      ${linkHtml}
    </div>`;
  }

  // Overlays
  const toolPickerHtml = renderToolPicker();
  const mcpCardHtml = renderMCPSetupCard();
  const responseHtml = renderResponsePanel();
  const launchedHtml = renderLaunchedConfirm();

  return `<div class="aix aix-${state}">
    ${toolPickerHtml}
    ${mcpCardHtml}
    ${responseHtml}
    ${launchedHtml}
    <div class="aix-bar">
      ${badgeHtml}
      <input class="aix-inp"
        placeholder="${esc(placeholders[state])}"
        value="${esc(question)}"
        ${inputDisabled ? 'disabled' : ''}
        data-action="aiInput"
      />
      <button class="aix-send" ${sendDisabled ? 'disabled' : ''} data-action="sendAI">
        ${sendContent}
      </button>
    </div>
    ${statusHtml}
  </div>`;
}

// ── Event handlers ──────────────────────────────────────────────

export function bindAIBarEvents(postMessage: (msg: unknown) => void): void {
  // Input change
  const input = document.querySelector('[data-action="aiInput"]') as HTMLInputElement;
  if (input) {
    input.addEventListener('input', () => {
      aiState.question = input.value;
      // Re-render to update send button disabled state
      updateAIBar();
    });

    // Enter key to send
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && aiState.question.trim()) {
        e.preventDefault();
        sendQuestion(postMessage);
      }
    });
  }

  // Send button
  const sendBtn = document.querySelector('[data-action="sendAI"]');
  if (sendBtn) {
    sendBtn.addEventListener('click', () => {
      if (aiState.state === 'unconfigured') {
        // Show MCP setup if not configured
        aiState.overlay = 'mcp-setup';
        updateAIBar();
      } else {
        sendQuestion(postMessage);
      }
    });
  }

  // Toggle tool picker
  const badgeBtn = document.querySelector('[data-action="toggleToolPicker"]');
  if (badgeBtn) {
    badgeBtn.addEventListener('click', () => {
      aiState.showToolPicker = !aiState.showToolPicker;
      updateAIBar();
    });
  }

  // Switch tool
  document.querySelectorAll('[data-action="switchTool"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const toolId = (btn as HTMLElement).dataset.toolId;
      if (toolId) {
        postMessage({ type: 'AI_SWITCH_TOOL', toolId });
        aiState.showToolPicker = false;
        updateAIBar();
      }
    });
  });

  // Show MCP setup
  const mcpSetupBtn = document.querySelector('[data-action="showMCPSetup"]');
  if (mcpSetupBtn) {
    mcpSetupBtn.addEventListener('click', () => {
      aiState.overlay = 'mcp-setup';
      updateAIBar();
    });
  }

  // Configure MCP
  const configureMCPBtn = document.querySelector('[data-action="configureMCP"]');
  if (configureMCPBtn) {
    configureMCPBtn.addEventListener('click', () => {
      aiState.mcpConfiguring = true;
      updateAIBar();
      postMessage({ type: 'AI_CONFIGURE_MCP' });
    });
  }

  // Close MCP card
  document.querySelectorAll('[data-action="closeMCPCard"]').forEach(btn => {
    btn.addEventListener('click', () => {
      aiState.overlay = null;
      aiState.mcpConfiguring = false;
      updateAIBar();
    });
  });

  // Close response
  const closeResponseBtn = document.querySelector('[data-action="closeResponse"]');
  if (closeResponseBtn) {
    closeResponseBtn.addEventListener('click', () => {
      aiState.overlay = null;
      aiState.response = null;
      updateAIBar();
    });
  }

  // Copy response
  const copyBtn = document.querySelector('[data-action="copyResponse"]');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      if (aiState.response?.content) {
        await navigator.clipboard.writeText(aiState.response.content);
        // Could show a brief "Copied!" toast here
      }
    });
  }

  // Re-run
  const rerunBtn = document.querySelector('[data-action="rerun"]');
  if (rerunBtn) {
    rerunBtn.addEventListener('click', () => {
      if (aiState.question) {
        sendQuestion(postMessage);
      }
    });
  }

  // Retry (on error)
  const retryBtn = document.querySelector('[data-action="retry"]');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      if (aiState.question) {
        sendQuestion(postMessage);
      }
    });
  }

  // Close picker when clicking outside
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (aiState.showToolPicker && !target.closest('.ai-badge') && !target.closest('.aix-picker')) {
      aiState.showToolPicker = false;
      updateAIBar();
    }
  });
}

function sendQuestion(postMessage: (msg: unknown) => void): void {
  if (!aiState.question.trim()) return;

  aiState.state = 'sending';
  aiState.overlay = null; // Close any open overlays
  updateAIBar();

  postMessage({
    type: 'AI_SEND_MESSAGE',
    question: aiState.question,
  });
}

function updateAIBar(): void {
  const container = document.querySelector('.aix');
  if (container?.parentElement) {
    container.parentElement.innerHTML = renderAIBar();
    // Re-bind events after re-render
    const postMessage = (window as any).__aiPostMessage;
    if (postMessage) {
      bindAIBarEvents(postMessage);
    }
  }
}

// ── Message handlers (called from main.ts) ──────────────────────

export function handleAIStateUpdate(detection: DetectionResult): void {
  aiState.detection = detection;

  if (!detection.activeTool) {
    aiState.state = 'none';
  } else {
    const activeTool = detection.tools.find(t => t.id === detection.activeTool);
    if (activeTool?.mcpReady) {
      aiState.state = 'ready';
    } else {
      aiState.state = 'unconfigured';
    }
  }

  updateAIBar();
}

export function handleAIResponse(content: string, toolCalls?: Array<{ name: string }>, durationMs?: number): void {
  aiState.state = 'ready';
  aiState.response = { content, toolCalls, durationMs };
  aiState.overlay = 'response';
  updateAIBar();
}

export function handleAILaunched(tool: string): void {
  aiState.state = 'ready';
  aiState.overlay = 'launched';
  updateAIBar();

  // Auto-dismiss after 3 seconds
  setTimeout(() => {
    if (aiState.overlay === 'launched') {
      aiState.overlay = null;
      updateAIBar();
    }
  }, 3000);
}

export function handleAIConfigDone(tool: string): void {
  aiState.mcpConfiguring = false;
  aiState.overlay = 'mcp-done';

  // Update detection to mark MCP as ready
  if (aiState.detection) {
    const toolIdx = aiState.detection.tools.findIndex(t => t.id === tool);
    if (toolIdx !== -1) {
      aiState.detection.tools[toolIdx].mcpReady = true;
    }
  }

  aiState.state = 'ready';
  updateAIBar();

  // Auto-dismiss after 5 seconds
  setTimeout(() => {
    if (aiState.overlay === 'mcp-done') {
      aiState.overlay = null;
      updateAIBar();
    }
  }, 5000);
}

export function handleAIError(message: string): void {
  aiState.state = 'error';
  aiState.error = message;
  aiState.overlay = null;
  updateAIBar();
}

export function setAIDetecting(): void {
  aiState.state = 'detecting';
  updateAIBar();
}
