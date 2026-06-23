// Webview renderer — browser context only, no vscode.* APIs
interface VsCodeApi { postMessage(msg: unknown): void; }
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

// ── Types ──────────────────────────────────────────────────────────────────
interface GitCtx { branch: string; shortSha: string; commitSha: string; commitWebUrl?: string; }

// ── Render Debounce ────────────────────────────────────────────────────────
let renderScheduled = false;
let lastRenderFingerprint = '';
let lastRenderTime = 0;
let timerInterval: NodeJS.Timeout | null = null;
const MIN_RENDER_INTERVAL_MS = 5000; // Minimum 5 seconds between automatic renders to reduce flicker

function getStateFingerprint(): string {
  // Generate a fingerprint of render-relevant state to detect actual changes
  const parts: string[] = [
    state.viewMode,
    state.detailExecId || '',
    state.historyPage.toString(),
    state.historyFilter,
    state.historyList.length.toString(),
    state.historyTotal.toString(),
    state.loadingExecution.toString(),
    state.configured.toString(),
    state.gitCtx ? `${state.gitCtx.branch}:${state.gitCtx.commitSha}` : '',
    state.pipelineList.length.toString(),
    state.loadingPipelines.toString(),
    state.pipelinesSort,
    state.pipelinesFilter,
    state.pipelinesSearch,
    state.pipelinesPage.toString(),
    Array.from(state.pinnedPipelines).sort().join(','),
    state.filteredPipelineId || '',
    state.currentCommitFilter.toString(),
    state.executionsSort,
    state.menuOpen.toString(),
    // AI state
    state.aiShowToolPicker.toString(),
    state.aiState,
    state.aiOverlay || '',
  ];

  // Add execution state with detailed stage/step tracking
  for (const [id, ex] of state.executions) {
    parts.push(`${id}:${ex.status}:${ex.startTs}:${ex.endTs || 0}:${Object.keys(ex.stepLogs).length}`);

    // Add active stage ID (changes when execution progresses to next stage)
    parts.push(`activeStage:${ex.activeStageId || ''}`);

    // Add stage statuses from layoutNodeMap (detects stage status changes)
    const stageStatuses = Object.entries(ex.layoutNodeMap)
      .filter(([, node]) => node.nodeGroup === 'STAGE')
      .map(([id, node]) => `${id}:${node.status}`)
      .sort()
      .join(',');
    parts.push(`stages:${stageStatuses}`);

    // Add step statuses from executionGraph (detects step status changes)
    if (ex.executionGraph?.nodeMap) {
      const stepStatuses = Object.entries(ex.executionGraph.nodeMap)
        .map(([id, node]) => `${id}:${node.status}`)
        .sort()
        .join(',');
      parts.push(`steps:${stepStatuses}`);
    }
  }

  // Add expanded state
  parts.push(Array.from(state.expandedNodes).sort().join(','));
  parts.push(Array.from(state.userToggledStagesOpen).sort().join(','));

  return parts.join('|');
}

// Update timer displays without full re-render
function updateTimers(): void {
  const now = Date.now();

  // Update all duration elements
  document.querySelectorAll('[data-start-ts]').forEach(el => {
    const startTs = parseInt(el.getAttribute('data-start-ts') || '0', 10);
    const endTs = parseInt(el.getAttribute('data-end-ts') || '0', 10);
    if (startTs > 0) {
      const duration = dur(startTs, endTs || now);
      if (el.textContent !== duration) {
        el.textContent = duration;
      }
    }
  });
}

function scheduleRender(immediate = false): void {
  // For immediate user actions, render synchronously (no requestAnimationFrame delay)
  // Skip fingerprint check for immediate renders since they're user-initiated
  if (immediate) {
    renderScheduled = false;
    lastRenderFingerprint = getStateFingerprint();
    lastRenderTime = Date.now();
    render();
    return;
  }

  // For automatic updates, use throttled async rendering
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;

    // Only render if state actually changed
    const currentFingerprint = getStateFingerprint();
    if (currentFingerprint !== lastRenderFingerprint) {
      const now = Date.now();
      const timeSinceLastRender = now - lastRenderTime;

      // Throttle automatic renders to reduce flicker
      if (timeSinceLastRender >= MIN_RENDER_INTERVAL_MS) {
        lastRenderFingerprint = currentFingerprint;
        lastRenderTime = now;
        render();
      } else {
        // Schedule a delayed render
        setTimeout(() => {
          const latestFingerprint = getStateFingerprint();
          if (latestFingerprint !== lastRenderFingerprint) {
            lastRenderFingerprint = latestFingerprint;
            lastRenderTime = Date.now();
            render();
          }
        }, MIN_RENDER_INTERVAL_MS - timeSinceLastRender);
      }
    }

    // Manage timer interval for running executions
    const hasRunning = [...state.executions.values()].some(ex => !ex.isTerminal);
    if (hasRunning && !timerInterval) {
      // Start timer to update durations every second WITHOUT re-rendering
      timerInterval = setInterval(() => updateTimers(), 1000);
    } else if (!hasRunning && timerInterval) {
      // Stop timer when no running executions
      clearInterval(timerInterval);
      timerInterval = null;
    }
  });
}

// ── Theme Management ───────────────────────────────────────────────────────

interface LayoutNode {
  nodeUuid: string;
  name: string;
  status: string;
  nodeGroup?: string;
  nodeType?: string;
  nodeIdentifier?: string;
  stepType?: string;
  module?: string;            // 'ci' | 'cd' | … — present on stage layout nodes
  moduleInfo?: Record<string, any>; // module rollup (cd.serviceInfo, cd.infraExecutionSummary, …)
  nodeRunInfo?: { whenCondition?: string; evaluatedCondition?: boolean; expressions?: unknown[] };
  startTs?: number;
  endTs?: number;
  edgeLayoutList?: { currentNodeChildren?: string[]; nextIds?: string[] };
  logBaseKey?: string;
  failureInfo?: { message?: string };
}

// Build (CI) tab shape — parsed client-side from moduleInfo.ci.
interface BuildInfo {
  repo: string;
  branches: { source: string; dest?: string };
  pr?: number | string;
  commits: { sha: string; msg: string; author: string; link?: string }[];
  artifacts: { name: string; type: 'docker' | 'sbom' | 'file'; version: string; registry: string; digest?: string; url?: string; failed?: boolean }[];
}

// Deploy (CD) tab shape — parsed client-side per CD stage from layoutNodeMap.
interface DeployStage {
  stageId: string;
  stageName: string;
  status: 'ok' | 'pending' | 'waiting' | 'blocked' | 'failed';
  blocked?: boolean;
  skipReason?: string;
  services: { name: string; identifier?: string; version: string; kind: string; manifests?: string[] }[];
  envs: { name: string; infraName?: string; type?: string; status: string; deployedAt?: string }[];
}

interface UnitProgress {
  unitName: string;
  status: string;
  startTime?: number;
  endTime?: number;
}

interface GraphNode {
  uuid?: string;
  name: string;
  identifier?: string;   // YAML step ID — the actual step name (e.g., "OWASP_1", "ShellScript_2")
  status: string;
  stepType?: string;
  startTs?: number;
  endTs?: number;
  logBaseKey?: string;
  failureInfo?: { message?: string };
  unitProgresses?: UnitProgress[];
}

interface StepInfo {
  name: string;
  status: string;
  startTs?: number;
  endTs?: number;
  nodeId?: string;       // graph node key — used to correlate LOG_CHUNK messages
  logBaseKey?: string;   // passed to log-service to fetch logs
  stepType?: string;     // step type (e.g., HarnessApproval, JiraApproval, ServiceNowApproval)
}

interface ExecGraph {
  rootNodeId?: string;
  nodeMap?: Record<string, GraphNode>;
  nodeAdjacencyListMap?: Record<string, { children?: string[]; nextIds?: string[] }>;
}

// STO scan summary — parsed host-side (src/api/stoScan.ts) from the execution
// graph and delivered via STO_SCAN. Kept in sync with that module's exports.
interface SevCount { total: number; new: number; }
interface StoScanner {
  name: string; stepType: string; total: number; new: number; status: string; consoleUrl?: string;
}
interface StoScanSummary {
  scanId: string;
  skipped?: boolean;
  running?: boolean;
  tools: string[];
  critical: SevCount; high: SevCount; medium: SevCount; low: SevCount; info: SevCount; exempted: SevCount;
  scanners: StoScanner[];
  stoUrl?: string;
}

interface ExecState {
  logsUnavailable?: boolean;  // set when all log fetches fail (FF not enabled)
  planExecutionId: string;
  pipelineIdentifier: string;
  name: string;
  status: string;
  startTs: number;
  endTs?: number;
  moduleInfo?: Record<string, unknown>;
  executionTriggerInfo?: {
    triggerType?: string;
    triggeredBy?: { triggerIdentifier?: string; identifier?: string; email?: string };
  };
  layoutNodeMap: Record<string, LayoutNode>;
  executionGraph?: ExecGraph | null;
  isTerminal: boolean;
  harnessUrl?: string;
  commitWebUrl?: string;
  activeStageId?: string;
  logLines: string[];           // legacy — stage-level fallback
  stepLogs: Record<string, string[]>;  // nodeId → lines
  aida?:  { stageId: string; cause?: string; summary?: string; deepDiveUrl?: string };
  opa?:   { policySetName?: string; details?: Array<{ policyName: string; status: string; denyMessages?: string[] }>; policyUrl?: string };
  approval?: { planExecutionId: string; approvers?: string[]; userGroups?: string[]; minimumCount?: number; deadline?: number; canApprove?: boolean; stageIdentifier?: string };
  externalApproval?: { planExecutionId: string; approvalType: 'Jira' | 'ServiceNow'; ticketId: string; ticketUrl?: string; projectKey?: string; issueType?: string; ticketType?: string; approvalCriteria?: string; rejectionCriteria?: string; stageIdentifier?: string };
  cost?:  { totalCost?: number; currency?: string; branchAvgCost?: number };
  sto?:   { count: number; critical: number; high: number; medium: number };
  stoScan?: StoScanSummary;
  ti?:    { total: number; failed: number; flaky: number; selected: number };
  ssca?:  { flagged: number };
  cd?:    Array<{ environment: string; status: string }>;
}

interface HistoryItem {
  planExecutionId: string;
  pipelineIdentifier: string;
  name: string;
  status: string;
  startTs: number;
  endTs?: number;
  moduleInfo?: Record<string, unknown>;
  triggerInfo?: {
    triggeredBy?: { identifier?: string; email?: string };
  };
  gitSha?: string;
  gitBranch?: string;
  isCurrentCommit?: boolean;
}

type ViewMode = 'pipelines' | 'executions' | 'detail';
type PipelineSortMode = 'recent' | 'name' | 'status';
type ExecutionsSortMode = 'recent' | 'oldest' | 'duration' | 'status';

interface PipelineItem {
  identifier: string;
  name: string;
  pipelineType?: string; // Extracted from gitDetails.filePath (e.g., "deploy", "build")
  lastStatus?: string;
  lastRunTime?: number;
  lastRunBranch?: string;
  lastRunActor?: string;
  recentExecutions?: Array<{ status: string; startTs: number }>;
  modules?: string[]; // e.g., ["ci", "cd", "sto"]
  tags?: Record<string, string>; // e.g., { "owner": "DemoCommittee" }
}

const TERMINAL_STATUSES_SET = new Set([
  'SUCCESS', 'FAILED', 'ABORTED', 'EXPIRED', 'IGNOREFAILED', 'POLICY_EVALUATION_FAILURE'
]);

const state = {
  initializing:  true, // true until we receive envDetection message
  gitCtx:        null as GitCtx | null,
  org:           '' as string,
  project:       '' as string,
  executions:    new Map<string, ExecState>(),
  shaMismatch:   null as { lastExecution: { name?: string } } | null,
  configured:    true,
  expandedNodes: new Set<string>(), // nodeIds of expanded steps
  userCollapsed: new Set<string>(), // nodeIds the user explicitly collapsed — never auto-expand these

  // Stage expansion tracking (§7.1 single-focus rule)
  userToggledStages:     new Set<string>(), // stageIds the user clicked
  userToggledStagesOpen: new Set<string>(), // of those toggled, which ones are open
  expandedStagesDefault: new Set<string>(), // auto-computed default (current stage only)

  // Navigation state
  viewMode:      'pipelines' as ViewMode,
  activeDetailTab: 'pipeline' as 'pipeline' | 'ci' | 'cd' | 'sec' | 'ti', // active tab within the detail card

  // Pipelines tab state
  pipelineList:  [] as PipelineItem[],
  pinnedPipelines: new Set<string>(), // pipeline identifiers
  pipelinesSort: 'recent' as PipelineSortMode,
  pipelinesFilter: 'all' as 'all' | 'failed' | 'running' | 'waiting',
  pipelinesSearch: '',
  loadingPipelines: false,
  pipelinesPage: 0,
  pipelinesPageSize: 15, // Match executions page size

  // Executions tab state (renamed from history)
  historyList:   [] as HistoryItem[],
  historyPage:   0,
  historyTotal:  0,
  historyPageSize: 15, // Will be calculated dynamically based on viewport height
  historyFilter: 'all' as 'all' | 'failed' | 'success' | 'waiting',
  currentCommitFilter: false, // when true, filter executions to current git commit
  executionsSort: 'recent' as ExecutionsSortMode,
  sortMenuOpen: false as boolean, // true while the executions sort popover is open
  sortMenuPos: { top: 0, left: 0 } as { top: number; left: number }, // menu position for fixed positioning
  filteredPipelineId: null as string | null, // when set, show only executions for this pipeline
  detailExecId:  null as string | null, // planExecutionId of execution being viewed in detail mode

  // Loading states
  loadingSteps:  new Set<string>(), // nodeIds currently loading logs
  stepsOpenedInTab: new Set<string>(), // nodeIds that had logs opened in editor tab
  loadingExecution: true, // true when fetching execution data (start as true, wait for first poll)
  executionError: null as string | null, // error message when execution fetch fails

  // Pin preference state (legacy - keeping for compatibility)
  pinnedView:    null as 'pipelines' | 'executions' | null,
  viewModeInitialized: false, // track if viewMode was initialized from defaultView

  // Log viewer preference (FME)
  logViewerVariation: 'inline' as 'inline' | 'expanded' | 'drawer',

  // Webview theme (FME vscode-bar-experience flag + IDE theme detection)
  webviewTheme: 'simple' as 'simple' | 'enhanced', // from FME flag
  ideThemeKind: 1 as number, // 1=Light, 2=Dark, 3=HighContrast, 4=HighContrastLight

  // AI chat feature flag (FME vscode-mcp-integration flag)
  aiChatEnabled: true as boolean, // from FME flag, default to enabled (fail-safe for FME failures)

  // App menu state
  menuOpen: false,

  // AI integration state
  aiDetection: null as { tools: Array<{ id: string; name: string; sub: string | null; mcpReady: boolean }>; activeTool: string | null; mcpConfigPath: string | null; mcpScope: { project: { path: string; configured: boolean } | null; global: { path: string; configured: boolean }; activeScope: 'project' | 'global' | null; conflict: boolean } } | null,
  aiState: 'detecting' as 'detecting' | 'none' | 'unconfigured' | 'ready' | 'sending' | 'error',
  aiQuestion: '',
  aiShowToolPicker: false,
  aiOverlay: null as 'mcp-setup' | 'mcp-existing' | 'mcp-conflict' | 'mcp-done' | 'response' | 'launched' | null,
  aiMcpConfiguring: false,
  aiMcpSetupScope: 'project' as 'project' | 'global',          // NEW — which radio is selected
  aiMcpDoneScope: null as 'project' | 'global' | null,         // NEW — which scope was just written (for the toast)
  aiResponse: null as { content: string; toolCalls?: Array<{ name: string }>; durationMs?: number } | null,
  aiError: null as string | null,

  // Env var onboarding state
  envDetection: null as { allPresent: boolean; baseUrl: string | null; apiKey: string | null; accountId: string | null } | null,
  envDisclosureOpen: false as boolean, // false → Panel D, true → Panel E
  envOnboardingChoice: 'env' as 'env' | 'pat', // which choice card is selected in Panel A
  authSource: 'pat' as 'pat' | 'env', // from settings - determines if we wait for env vars
};

// ── Dynamic page size calculation ──────────────────────────────────────────
/**
 * Calculate how many execution items fit in the viewport without scrolling
 * Based on: viewport height - fixed UI elements (header, tabs, toolbar, footer)
 */
function calculatePageSize(): number {
  const viewportHeight = window.innerHeight;

  // Fixed element heights (more accurate measurements)
  const headerHeight = 56;        // Harness header (blue gradient)
  const projectBarHeight = 34;    // Project bar
  const viewToggleHeight = 40;    // Tab switcher
  const toolbarHeight = 48;       // Filter toolbar + "100 runs" line
  const paginationHeight = 36;    // Pagination bar
  const pinFooterHeight = 28;     // Pin footer hint
  const aiFooterHeight = 48;      // AI input bar

  const fixedHeight = headerHeight + projectBarHeight + viewToggleHeight +
                     toolbarHeight + paginationHeight + pinFooterHeight + aiFooterHeight;

  const availableHeight = viewportHeight - fixedHeight;

  // Execution card height (compact, ~68px average with badges)
  const itemHeight = 68;

  // Calculate how many items fit, minimum 12, maximum 30
  const calculated = Math.floor(availableHeight / itemHeight);
  const pageSize = Math.max(12, Math.min(30, calculated));

  console.log('[calculatePageSize]', { viewportHeight, fixedHeight, availableHeight, itemHeight, calculated, pageSize });
  return pageSize;
}

// ── Theme Switching ────────────────────────────────────────────────────────
/**
 * Apply effective theme to document body based on FME flag and IDE theme.
 * Decision table:
 *   FF treatment  | IDE theme           | Result
 *   ------------- | ------------------- | -----------------------
 *   enhanced      | Dark (2)            | .theme-enhanced-dark
 *   enhanced      | Light (1)           | .theme-enhanced-light
 *   enhanced      | HighContrast (3)    | .theme-enhanced-dark
 *   enhanced      | HC Light (4)        | .theme-enhanced-light
 *   simple        | any                 | .theme-simple
 */
function applyEffectiveTheme(): void {
  const isLight = state.ideThemeKind === 1 || state.ideThemeKind === 4; // Light or HighContrastLight

  // Set base theme class (simple vs enhanced)
  document.body.classList.toggle('theme-enhanced', state.webviewTheme === 'enhanced');
  document.body.classList.toggle('theme-simple', state.webviewTheme !== 'enhanced');

  // Set light/dark modifier (only relevant for enhanced theme)
  if (state.webviewTheme === 'enhanced') {
    document.body.classList.toggle('theme-light', isLight);
    document.body.classList.toggle('theme-dark', !isLight);
  } else {
    // Remove light/dark classes in simple theme
    document.body.classList.remove('theme-light', 'theme-dark');
  }

  console.log('[Webview] Applied theme:', {
    ffTreatment: state.webviewTheme,
    ideThemeKind: state.ideThemeKind,
    ideThemeName: isLight ? 'Light' : 'Dark',
    bodyClasses: Array.from(document.body.classList).join(' '),
  });
}

// ── Message bus ────────────────────────────────────────────────────────────
window.addEventListener('message', ({ data: msg }) => {
  switch (msg.type) {

    case 'GIT_CONTEXT':
      console.log('[Webview] GIT_CONTEXT received:', { org: msg.org, project: msg.project, currentOrg: state.org, currentProject: state.project });
      state.gitCtx = msg.ctx;
      state.shaMismatch = null;
      // GIT_CONTEXT means we have config (org/project) - mark as configured
      state.configured = true;
      // Update authSource from settings if provided
      if (msg.authSource) {
        state.authSource = msg.authSource as 'pat' | 'env';
      }
      // Only consider it "changed" if we had a previous value AND it differs
      // (Don't treat initial set as a change)
      const orgChanged = state.org && msg.org && msg.org !== state.org;
      const projectChanged = state.project && msg.project && msg.project !== state.project;
      const wasEmptyOrgProject = !state.org || !state.project;
      if (msg.org)     state.org     = msg.org;
      if (msg.project) state.project = msg.project;

      // Initialize pinned view and default view mode from settings (only once on first load)
      // OR if we just got org/project for the first time (env var onboarding)
      if (!state.viewModeInitialized || wasEmptyOrgProject) {
        console.log('[Webview] Initializing view mode:', { wasEmptyOrgProject, viewModeInitialized: state.viewModeInitialized });
        // Handle both old ('thisCommit'/'allExecutions') and new ('pipelines'/'executions') setting values
        const defaultView = msg.defaultView ?? 'pipelines';
        const normalizedView =
          defaultView === 'allExecutions' ? 'executions' :
          defaultView === 'thisCommit' ? 'pipelines' :
          defaultView;

        state.pinnedView = normalizedView === 'pipelines' ? 'pipelines' : 'executions';
        state.viewMode = state.pinnedView;
        state.viewModeInitialized = true;

        // Fetch data for initial view
        console.log('[Webview] Fetching data for view:', state.viewMode);
        if (state.viewMode === 'executions') {
          state.loadingExecution = true;
          vscode.postMessage({ type: 'fetchHistory', page: 0, filter: state.historyFilter, pageSize: state.historyPageSize, pipelineId: state.filteredPipelineId });
        } else if (state.viewMode === 'pipelines') {
          state.loadingPipelines = true;
          vscode.postMessage({ type: 'fetchPipelines' });
        }
      } else if (msg.defaultView) {
        // Update pinnedView if it changed in settings, but don't override current viewMode
        const normalizedView =
          msg.defaultView === 'allExecutions' ? 'executions' :
          msg.defaultView === 'thisCommit' ? 'pipelines' :
          msg.defaultView;
        state.pinnedView = normalizedView === 'pipelines' ? 'pipelines' : 'executions';
      }

      // Store log viewer variation from FME
      if (msg.logViewerVariation) {
        state.logViewerVariation = msg.logViewerVariation as any;
        console.log('[Webview] Log viewer variation:', state.logViewerVariation);
      }

      // Store webview theme and IDE theme kind, then apply effective theme
      console.log('[Webview] GIT_CONTEXT received:', {
        hasWebviewTheme: msg.webviewTheme !== undefined,
        webviewTheme: msg.webviewTheme,
        hasIdeThemeKind: msg.ideThemeKind !== undefined,
        ideThemeKind: msg.ideThemeKind,
        hasAiChatEnabled: msg.aiChatEnabled !== undefined,
        aiChatEnabled: msg.aiChatEnabled
      });
      if (msg.webviewTheme !== undefined) {
        state.webviewTheme = msg.webviewTheme;
      }
      if (msg.ideThemeKind !== undefined) {
        state.ideThemeKind = msg.ideThemeKind;
      }
      if (msg.aiChatEnabled !== undefined) {
        state.aiChatEnabled = msg.aiChatEnabled;
        console.log('[Webview] AI chat enabled:', state.aiChatEnabled);
      }

      // If org/project changed, clear state and refetch data
      if (orgChanged || projectChanged) {
        console.log('[Webview] Org/project changed, refetching data');
        state.historyPage = 0;
        state.historyList = [];
        state.historyTotal = 0;
        state.detailExecId = null;
        state.executions.clear();
        state.pipelineList = [];

        // Fetch fresh data for current view
        if (state.viewMode === 'executions') {
          state.loadingExecution = true;
          vscode.postMessage({ type: 'fetchHistory', page: 0, filter: state.historyFilter, pageSize: state.historyPageSize, pipelineId: state.filteredPipelineId });
        } else if (state.viewMode === 'pipelines') {
          state.loadingPipelines = true;
          vscode.postMessage({ type: 'fetchPipelines' });
        }
      }
      break;

    case 'envDetection':
      state.envDetection = msg.envDetection;
      if (msg.authSource) {
        state.authSource = msg.authSource as 'pat' | 'env';
      }
      state.initializing = false; // Mark initialization complete
      console.log('[Webview] envDetection received:', { envDetection: state.envDetection, authSource: state.authSource });
      scheduleRender(true);
      applyEffectiveTheme();
      break;

    case 'EXECUTION_UPDATE': {
      state.loadingExecution = false; // Execution data arrived
      const ex = msg.execution;
      // Harness returns mixed-case statuses ("Success", "Failed") — normalise to uppercase
      const status = (ex.status as string).toUpperCase();
      const prev = state.executions.get(ex.planExecutionId);
      // Normalise layoutNodeMap statuses too
      const layoutNodeMap: Record<string, LayoutNode> = {};
      for (const [k, v] of Object.entries((ex.layoutNodeMap ?? {}) as Record<string, LayoutNode>)) {
        layoutNodeMap[k] = { ...v, status: (v.status as string).toUpperCase() };
      }
      // Normalise graph node statuses
      let executionGraph = (msg.executionGraph ?? prev?.executionGraph) as ExecGraph | null | undefined;
      if (executionGraph?.nodeMap) {
        const normNodeMap: Record<string, GraphNode> = {};
        for (const [k, v] of Object.entries(executionGraph.nodeMap)) {
          normNodeMap[k] = { ...v, status: (v.status as string).toUpperCase() };
        }
        executionGraph = { ...executionGraph, nodeMap: normNodeMap };
      }
      const isTerminal = TERMINAL_STATUSES_SET.has(status);
      // Auto-collapse all steps and stages when pipeline transitions to terminal
      if (!prev?.isTerminal && isTerminal) {
        state.expandedNodes.clear();
        state.userCollapsed.clear();
        state.userToggledStages.clear();
        state.userToggledStagesOpen.clear();
        state.expandedStagesDefault.clear();
      }

      // Extract OPA data from governanceMetadata if present
      let opaData = prev?.opa;
      if ((ex as any).governanceMetadata) {
        const gm = (ex as any).governanceMetadata;
        const policyUrl = msg.harnessUrl
          ? msg.harnessUrl.replace(/\/pipeline$/, '') + '/policy-evaluations'
          : undefined;
        opaData = {
          status: gm.status ?? 'UNKNOWN',
          details: (gm.details ?? []).flatMap((policySet: any) =>
            (policySet.policyMetadata ?? []).map((p: any) => ({
              policyName: p.policyName ?? policySet.policySetName ?? 'Policy',
              status: p.status ?? 'UNKNOWN',
              denyMessages: p.denyMessages,
            }))
          ),
          policyUrl,
        };
      }

      state.executions.set(ex.planExecutionId, {
        planExecutionId:   ex.planExecutionId,
        pipelineIdentifier: ex.pipelineIdentifier,
        name:              ex.name ?? ex.pipelineIdentifier ?? 'Pipeline',
        status,
        startTs:           ex.startTs,
        endTs:             ex.endTs,
        moduleInfo:        ex.moduleInfo,
        executionTriggerInfo: (ex as any).executionTriggerInfo ?? prev?.executionTriggerInfo,
        layoutNodeMap,
        executionGraph,
        isTerminal,
        harnessUrl:        msg.harnessUrl ?? prev?.harnessUrl,
        commitWebUrl:      msg.commitWebUrl ?? prev?.commitWebUrl,
        logLines:          prev?.logLines ?? [],
        stepLogs:          prev?.stepLogs ?? {},
        activeStageId:     prev?.activeStageId,
        aida: prev?.aida, opa: opaData, cost: prev?.cost,
        approval: isTerminal ? undefined : prev?.approval,
        externalApproval: isTerminal ? undefined : prev?.externalApproval,
        sto: prev?.sto,   ti: prev?.ti,   ssca: prev?.ssca, cd: prev?.cd,
      });
      // A status change (e.g. RUNNING → ABORTED after an abort) must reflect
      // immediately rather than waiting for the throttled auto-render window.
      if (prev && prev.status !== status) {
        scheduleRender(true);
        return;
      }
      break;
    }

    case 'LOG_CHUNK': {
      const nodeId = msg.nodeId as string;
      // Remove loading state when logs arrive
      state.loadingSteps.delete(nodeId);
      let foundExecution = false;

      // In detail mode, store logs only in the execution being viewed
      if (state.viewMode === 'detail' && state.detailExecId) {
        const ex = state.executions.get(state.detailExecId);
        if (ex) {
          const prev = ex.stepLogs[nodeId] ?? [];
          ex.stepLogs[nodeId] = [...prev, ...msg.lines].slice(-100);
          ex.activeStageId = nodeId;
          ex.logLines = [...ex.logLines, ...msg.lines].slice(-100);
          foundExecution = true;
        }
      } else {
        // In live mode, store in any execution (there should be only one)
        for (const [, ex] of state.executions) {
          const prev = ex.stepLogs[nodeId] ?? [];
          ex.stepLogs[nodeId] = [...prev, ...msg.lines].slice(-100);
          ex.activeStageId = nodeId;
          ex.logLines = [...ex.logLines, ...msg.lines].slice(-100);
          foundExecution = true;
          break;
        }
      }

      if (!foundExecution) {
        console.error('[Webview] No execution found to store logs!', {
          nodeId,
          viewMode: state.viewMode,
          detailExecId: state.detailExecId,
          executionIds: [...state.executions.keys()]
        });
      }
      // Auto-expand only when explicitly requested (target step) or when live streaming
      const shouldAutoExpand = msg.autoExpand !== false && !state.userCollapsed.has(nodeId);
      if (shouldAutoExpand) {
        state.expandedNodes.add(nodeId);
      }
      break;
    }

    case 'AIDA_UPDATE':
      for (const [, ex] of state.executions) { ex.aida = { stageId: msg.stageId, ...msg.rca }; }
      break;

    case 'OPA_UPDATE':
      for (const [, ex] of state.executions) { ex.opa = msg.policy; }
      break;

    case 'CCM_UPDATE':
      for (const [, ex] of state.executions) { ex.cost = msg.cost; }
      break;

    case 'APPROVAL_UPDATE':
      console.log('[Webview] APPROVAL_UPDATE received:', msg);
      // Set approval only on the execution that matches planExecutionId
      // (not all executions, which would incorrectly set approval on the wrong pipeline)
      let approvalEx = state.executions.get(msg.planExecutionId);
      if (!approvalEx) {
        // Execution doesn't exist yet (APPROVAL_UPDATE arrived before HISTORY_DETAIL)
        // Create a placeholder that will be updated when HISTORY_DETAIL arrives
        console.log('[Webview] Creating placeholder execution for APPROVAL_UPDATE:', msg.planExecutionId);
        approvalEx = {
          planExecutionId: msg.planExecutionId,
          pipelineIdentifier: '',
          name: '',
          status: 'APPROVALWAITING',
          startTs: 0,
          endTs: 0,
          moduleInfo: {},
          layoutNodeMap: {},
          executionGraph: null,
          isTerminal: false,
          logLines: [],
          stepLogs: {},
        };
        state.executions.set(msg.planExecutionId, approvalEx);
      }
      approvalEx.approval = {
        planExecutionId:  msg.planExecutionId,
        approvers:        msg.approvers,
        userGroups:       msg.userGroups,
        minimumCount:     msg.minimumCount,
        deadline:         msg.deadline,
        canApprove:       msg.canApprove ?? true,
        stageIdentifier:  msg.stageIdentifier,
      };
      console.log('[Webview] Set approval on execution:', {
        planExecutionId: approvalEx.planExecutionId,
        approval: approvalEx.approval
      });
      break;

    case 'EXTERNAL_APPROVAL_UPDATE':
      const extApprovalEx = state.executions.get(msg.planExecutionId);
      if (extApprovalEx) {
        extApprovalEx.externalApproval = {
          planExecutionId:    msg.planExecutionId,
          approvalType:       msg.approvalType,
          ticketId:           msg.ticketId,
          ticketUrl:          msg.ticketUrl,
          projectKey:         msg.projectKey,
          issueType:          msg.issueType,
          ticketType:         msg.ticketType,
          approvalCriteria:   msg.approvalCriteria,
          rejectionCriteria:  msg.rejectionCriteria,
          stageIdentifier:    msg.stageIdentifier,
        };
      }
      break;

    case 'STO_SUMMARY':
      for (const [, ex] of state.executions) {
        ex.sto = { count: msg.count, critical: msg.critical, high: msg.high, medium: msg.medium };
      }
      break;

    case 'STO_SCAN':
      for (const [, ex] of state.executions) { ex.stoScan = (msg as any).stoScan; }
      break;

    case 'TI_SUMMARY':
      for (const [, ex] of state.executions) {
        ex.ti = { total: msg.total, failed: msg.failed, flaky: msg.flaky, selected: msg.selected };
      }
      break;

    case 'SSCA_SUMMARY':
      for (const [, ex] of state.executions) { ex.ssca = { flagged: msg.flagged }; }
      break;

    case 'CD_UPDATE':
      for (const [, ex] of state.executions) { ex.cd = msg.deployments; }
      break;

    case 'PIPELINE_LIST':
      console.log('[Webview] PIPELINE_LIST received', { count: msg.pipelines?.length });
      state.loadingPipelines = false;

      // Always update pinned pipelines from message (reset to empty if not provided)
      state.pinnedPipelines = new Set(msg.pinnedPipelines ?? []);

      state.pipelineList = (msg.pipelines ?? []).map((p: any) => {
        // Extract pipeline type/folder from file path (e.g., ".harness/deploy.yaml" → "deploy")
        let pipelineType: string | undefined;
        if (p.gitDetails?.filePath) {
          const filePath = p.gitDetails.filePath;
          const fileName = filePath.split('/').pop() || '';
          pipelineType = fileName.replace(/\.(yaml|yml)$/, '');
        }

        return {
          identifier: p.identifier,
          name: p.name,
          pipelineType,
          lastStatus: p.executionSummaryInfo?.lastExecutionStatus?.toUpperCase(),
          lastRunTime: p.executionSummaryInfo?.lastExecutionTs,
          lastRunBranch: p.gitDetails?.branch,
          lastRunActor: p.recentExecutionsInfo?.[0]?.executorInfo?.username,
          recentExecutions: (p.recentExecutionsInfo ?? []).map((e: any) => ({
            status: e.status?.toUpperCase() ?? 'PENDING',
            startTs: e.startTs ?? 0,
          })),
          modules: p.modules ?? [],
          tags: p.tags ?? {},
        };
      });
      scheduleRender(true);
      return;

    case 'HISTORY_LIST':
      console.log('[Webview] HISTORY_LIST received', { count: msg.executions?.length, total: msg.total });
      state.loadingExecution = false; // History data arrived
      state.historyList = (msg.executions ?? []).map((item: any) => ({
        ...item,
        isCurrentCommit: item.isCurrentCommit ?? false,
      }));
      state.historyTotal = msg.total ?? state.historyList.length;
      // Force immediate render for history list updates (user-triggered)
      scheduleRender(true);
      return; // Skip the scheduleRender at the end

    case 'HISTORY_DETAIL': {
      state.loadingExecution = false; // Execution detail arrived
      state.executionError = null; // Clear any error
      // Store the detailed execution in state.executions for rendering
      const ex = msg.execution;
      const status = (ex.status as string).toUpperCase();
      const layoutNodeMap: Record<string, LayoutNode> = {};
      for (const [k, v] of Object.entries((ex.layoutNodeMap ?? {}) as Record<string, LayoutNode>)) {
        layoutNodeMap[k] = { ...v, status: (v.status as string).toUpperCase() };
      }
      let executionGraph = msg.executionGraph as ExecGraph | null | undefined;
      if (executionGraph?.nodeMap) {
        const normNodeMap: Record<string, GraphNode> = {};
        for (const [k, v] of Object.entries(executionGraph.nodeMap)) {
          normNodeMap[k] = { ...v, status: (v.status as string).toUpperCase() };
        }
        executionGraph = { ...executionGraph, nodeMap: normNodeMap };
      }
      const isTerminal = TERMINAL_STATUSES_SET.has(status);
      // Get trigger info from history list item (detail endpoint doesn't include it)
      const historyItem = state.historyList.find(item => item.planExecutionId === ex.planExecutionId);
      const executionTriggerInfo = historyItem?.triggerInfo ? {
        triggerType: (historyItem.triggerInfo as any).triggerType,
        triggeredBy: historyItem.triggerInfo.triggeredBy
      } : undefined;
      // Preserve approval/externalApproval from earlier messages if not in msg
      const prev = state.executions.get(ex.planExecutionId);

      // Extract OPA data from governanceMetadata if present
      let opaData = msg.opa ?? prev?.opa;
      if ((ex as any).governanceMetadata) {
        const gm = (ex as any).governanceMetadata;
        const policyUrl = msg.harnessUrl
          ? msg.harnessUrl.replace(/\/pipeline$/, '') + '/policy-evaluations'
          : undefined;
        opaData = {
          status: gm.status ?? 'UNKNOWN',
          details: (gm.details ?? []).flatMap((policySet: any) =>
            (policySet.policyMetadata ?? []).map((p: any) => ({
              policyName: p.policyName ?? policySet.policySetName ?? 'Policy',
              status: p.status ?? 'UNKNOWN',
              denyMessages: p.denyMessages,
            }))
          ),
          policyUrl,
        };
      }

      state.executions.set(ex.planExecutionId, {
        planExecutionId:   ex.planExecutionId,
        pipelineIdentifier: ex.pipelineIdentifier,
        name:              ex.name ?? ex.pipelineIdentifier ?? 'Pipeline',
        status,
        startTs:           ex.startTs,
        endTs:             ex.endTs,
        moduleInfo:        ex.moduleInfo,
        executionTriggerInfo,
        layoutNodeMap,
        executionGraph,
        isTerminal,
        harnessUrl:        msg.harnessUrl,
        commitWebUrl:      msg.commitWebUrl,
        logLines:          [],
        stepLogs:          {},
        aida: msg.aida, opa: opaData, cost: msg.cost,
        approval: msg.approval ?? prev?.approval,
        externalApproval: msg.externalApproval ?? prev?.externalApproval,
        sto: msg.sto,   ti: msg.ti,   ssca: msg.ssca, cd: msg.cd,
      });
      // Force an immediate render when the execution first loads (prev absent)
      // or its status changes (e.g. RUNNING → ABORTED), bypassing render throttle.
      if (!prev || prev.status !== status) {
        scheduleRender(true);
        return;
      }
      break;
    }

    case 'NO_EXECUTION':
      // In detail mode the viewed execution is polled separately. The live
      // poller's "no execution for this commit" signal must NOT clear the
      // loading state or executions, otherwise a freshly re-run execution
      // (not yet matched to the commit) renders as "Execution not found".
      if (state.viewMode !== 'detail') {
        state.loadingExecution = false;
      }
      // Only clear executions if we're in live mode
      // Don't interfere with history/detail view
      if (state.viewMode === 'pipelines') {
        state.executions.clear();
      }
      state.shaMismatch = null;
      if (msg.ctx) state.gitCtx = msg.ctx;
      break;

    case 'SHA_MISMATCH':
      state.shaMismatch = { lastExecution: msg.lastExecution };
      break;

    case 'AUTH_ERROR':
      state.configured = false;
      break;

    case 'LOGS_UNAVAILABLE':
      for (const [, ex] of state.executions) { ex.logsUnavailable = true; }
      break;

    case 'STEP_LOGS_LOADING':
      state.loadingSteps.add(msg.nodeId as string);
      // Don't auto-expand - let user's click action control expansion
      render(); // Re-render to show loading spinner
      break;

    case 'STEP_LOGS_EMPTY':
      state.loadingSteps.delete(msg.nodeId as string);
      render(); // Re-render to show "No logs available" message
      break;

    case 'STEP_LOGS_OPENED_IN_TAB':
      state.loadingSteps.delete(msg.nodeId as string);
      // Mark this step as "opened in tab" so we can show different message
      if (!state.stepsOpenedInTab) {
        state.stepsOpenedInTab = new Set();
      }
      state.stepsOpenedInTab.add(msg.nodeId as string);
      render(); // Re-render to show "✓ Logs opened in editor tab" message
      break;

    case 'STEP_LOGS_ERROR':
      console.error('[Webview] Step logs error', { nodeId: msg.nodeId, error: msg.error });
      state.loadingSteps.delete(msg.nodeId as string);
      break;

    case 'EXECUTION_ERROR':
      console.error('[Webview] Execution fetch error:', msg.message);
      state.loadingExecution = false; // Clear loading state
      state.executionError = msg.message; // Store error message to display to user
      scheduleRender(true); // Force immediate render
      return; // Skip the scheduleRender at the end

    case 'DEFAULT_VIEW_SAVED':
      // Update pinned view state when setting is saved
      state.pinnedView = msg.view === 'pipelines' ? 'pipelines' : 'executions';
      break;

    case 'STATE_UPDATE':
      console.log('[Webview] STATE_UPDATE received:', msg);
      // Handle configured state update
      if (msg.configured !== undefined) {
        const wasConfigured = state.configured;
        state.configured = msg.configured;
        console.log('[Webview] Configured state:', { wasConfigured, nowConfigured: state.configured });

        // If we just became configured, initialize the view and fetch data
        if (!wasConfigured && msg.configured) {
          console.log('[Webview] Just became configured - initializing view');
          // Initialize view mode if not done yet
          if (!state.viewModeInitialized) {
            state.pinnedView = 'pipelines';
            state.viewMode = 'pipelines';
            state.viewModeInitialized = true;
          }
          // Fetch data for current view
          if (state.viewMode === 'executions') {
            state.loadingExecution = true;
            vscode.postMessage({ type: 'fetchHistory', page: 0, filter: state.historyFilter, pageSize: state.historyPageSize, pipelineId: state.filteredPipelineId });
          } else if (state.viewMode === 'pipelines') {
            state.loadingPipelines = true;
            vscode.postMessage({ type: 'fetchPipelines' });
          }
        }
      }
      // Handle AI detection state update
      if (msg.aiDetection !== undefined) {
        state.aiDetection = msg.aiDetection;
        // Determine AI state from detection result
        if (!msg.aiDetection) {
          state.aiState = 'detecting';
        } else if (msg.aiDetection.tools.length === 0) {
          state.aiState = 'none';
        } else if (!msg.aiDetection.tools.some(t => t.mcpReady)) {
          state.aiState = 'unconfigured';
        } else {
          state.aiState = 'ready';
        }
      }
      scheduleRender(true); // Force immediate render for state changes
      return; // Skip the scheduleRender at the end

    case 'AI_RESPONSE':
      state.aiState = 'ready';
      state.aiResponse = {
        content: msg.content,
        toolCalls: msg.toolCalls,
        durationMs: msg.durationMs
      };
      state.aiOverlay = 'response';
      state.aiMcpConfiguring = false;
      scheduleRender(true); // Force immediate render
      return; // Skip the scheduleRender at the end

    case 'AI_LAUNCHED':
      state.aiState = 'ready';
      state.aiOverlay = 'launched';
      state.aiMcpConfiguring = false;
      scheduleRender(true); // Force immediate render
      return; // Skip the scheduleRender at the end

    case 'AI_CONFIG_DONE':
      state.aiState = 'ready';
      state.aiOverlay = 'mcp-done';
      state.aiMcpConfiguring = false;
      state.aiMcpDoneScope = (msg as any).scope || null;
      scheduleRender(true); // Force immediate render
      return; // Skip the scheduleRender at the end

    case 'AI_ERROR':
      state.aiState = 'error';
      state.aiError = msg.message;
      state.aiOverlay = null;
      state.aiMcpConfiguring = false;
      scheduleRender(true); // Force immediate render
      return; // Skip the scheduleRender at the end

    case 'RERUN_SUCCESS':
      console.log('[Webview] RERUN_SUCCESS received:', { newPlanExecutionId: (msg as any).newPlanExecutionId });
      // Re-enable rerun buttons and switch to detail view of new execution
      document.querySelectorAll<HTMLElement>('[data-action="rerunPipeline"]').forEach(el => {
        el.removeAttribute('disabled');
      });
      // Switch to detail view of the new execution with loading state
      state.viewMode = 'detail';
      state.activeDetailTab = 'pipeline'; // reset tab for the new execution
      state.detailExecId = (msg as any).newPlanExecutionId;
      state.loadingExecution = true; // Show loading while fetching data
      console.log('[Webview] Switched to detail view:', {
        viewMode: state.viewMode,
        detailExecId: state.detailExecId,
        loadingExecution: state.loadingExecution,
        executionInMap: state.executions.has((msg as any).newPlanExecutionId)
      });
      scheduleRender(true);
      return;

    case 'RERUN_CANCELLED':
    case 'RERUN_ERROR':
      // Re-enable rerun buttons
      document.querySelectorAll<HTMLElement>('[data-action="rerunPipeline"]').forEach(el => {
        el.removeAttribute('disabled');
      });
      scheduleRender(true);
      return;

    case 'ABORT_SUCCESS':
    case 'ABORT_CANCELLED':
    case 'ABORT_ERROR':
      // Re-enable abort buttons; on success the next poll swaps it to re-run
      document.querySelectorAll<HTMLElement>('[data-action="abortPipeline"]').forEach(el => {
        el.removeAttribute('disabled');
      });
      scheduleRender(true);
      return;
  }

  scheduleRender();
});

// ── Helpers ────────────────────────────────────────────────────────────────
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function dur(startTs?: number, endTs?: number): string {
  if (!startTs) return '';
  const ms = (endTs ?? Date.now()) - startTs;
  if (ms < 1000)    return '<1s';
  if (ms < 60_000)  return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function ago(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000)     return 'just now';
  if (d < 3_600_000)  return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function pipelinesGlyph(): string {
  // Same icon used in the view toggle tabs
  return `<svg viewBox="0 0 18 11" fill="currentColor" xmlns="http://www.w3.org/2000/svg" width="16" height="16"><g fill-rule="evenodd" clip-rule="evenodd"><path d="M9.871 1.01a1 1 0 011-1h5.25a1 1 0 011 1v2.125a1 1 0 01-1 1h-5.25a1 1 0 01-1-1V1.01zm6.25 0h-5.25v2.125h5.25V1.01zm-6.25 5.869a1 1 0 011-1h5.25a1 1 0 011 1v2.125a1 1 0 01-1 1h-5.25a1 1 0 01-1-1V6.879zm6.25 0h-5.25v2.125h5.25V6.879zM.889 1a1 1 0 011-1h5.25a1 1 0 011 1v2.125a1 1 0 01-1 1h-5.25a1 1 0 01-1-1V1zm6.25 0h-5.25v2.125h5.25V1z"></path><path d="M10.25 2.844h-2.5v-1h2.5v1zM5.125 3.906v1.875c0 .416.07.705.172.91.099.198.241.342.435.453.42.24 1.079.325 2.018.325h2.5v1h-2.5c-.936 0-1.84-.072-2.514-.457a2.045 2.045 0 01-.834-.874c-.19-.382-.277-.835-.277-1.357V3.906h1z"></path></g></svg>`;
}

function stageIcon(s: string): string {
  const status = (s || '').toUpperCase();
  switch (status) {
    case 'SUCCESS':                   return '✓';
    case 'FAILED':                    return '×';
    case 'IGNOREFAILED':              return '⚠';
    case 'RUNNING':
    case 'ASYNCWAITING':
    case 'ASYNC_WAITING':             return '▶';
    case 'ABORTED':                   return '⊗';
    case 'SKIPPED':                   return '⊝';
    default:                          return '◯';
  }
}

function statusBadge(status: string): string {
  const label = status === 'ASYNC_WAITING' ? 'RUNNING'
              : status === 'POLICY_EVALUATION_FAILURE' ? 'POLICY BLOCKED'
              : status;
  const cls   = status === 'SUCCESS'     ? 'badge-success'
              : status === 'FAILED'      ? 'badge-failed'
              : status === 'IGNOREFAILED'? 'badge-ignored'
              : status === 'ABORTED'     ? 'badge-aborted'
              : status === 'POLICY_EVALUATION_FAILURE' ? 'badge-policy'
              : 'badge-running';
  return `<span class="${cls}">${esc(label)}</span>`;
}

function dotClass(s: string, endTs?: number): string {
  // If endTs is set the pipeline has finished — never animate regardless of status string
  const done = TERMINAL_STATUSES_SET.has(s) || !!endTs;
  switch (s) {
    case 'SUCCESS':                    return 'dot-success';
    case 'FAILED':                     return 'dot-failed';
    case 'IGNOREFAILED':               return 'dot-ignored';
    case 'ABORTED':
    case 'EXPIRED':                    return 'dot-aborted';
    case 'POLICY_EVALUATION_FAILURE':  return 'dot-failed';
    default:                           return done ? 'dot-aborted' : 'dot-running';
  }
}

function getStages(layoutNodeMap: Record<string, LayoutNode>): LayoutNode[] {
  // Get all STAGE nodes - include looped iterations but filter STRATEGY containers
  // STRATEGY nodeGroup indicates loop/matrix wrappers, not actual executable stages
  const allEntries = Object.entries(layoutNodeMap).filter(([, n]) =>
    n.nodeGroup === 'STAGE'
  );
  if (!allEntries.length) return [];

  // Helper to check if stage should be excluded from output
  const shouldExclude = (s: LayoutNode): boolean => {
    // Skip parallel wrapper nodes (they're containers, not actual stages)
    if (s.nodeType === 'parallel') return true;

    // Check for rollback indicators
    const isRollback = s.stepType === 'PIPELINE_ROLLBACK' ||
                       s.stepType === 'STAGE_ROLLBACK' ||
                       s.nodeType === 'PIPELINE_ROLLBACK' ||
                       s.nodeType === 'STAGE_ROLLBACK' ||
                       s.name?.toLowerCase().includes('rollback');

    // Skip untriggered rollback stages
    if (isRollback) {
      const notExecuted = !s.startTs || s.status === 'NOT_STARTED' || s.status === 'SKIPPED';
      return notExecuted;
    }

    return false;
  };

  // Map by execution ID (unique even for looped stages) AND by nodeUuid (for nextIds lookup)
  const byExecutionId = new Map(allEntries);
  const byUuid = new Map<string, Array<[string, LayoutNode]>>();
  for (const [execId, stage] of allEntries) {
    if (!byUuid.has(stage.nodeUuid)) byUuid.set(stage.nodeUuid, []);
    byUuid.get(stage.nodeUuid)!.push([execId, stage]);
  }

  // Find roots - stages not referenced by any other stage's nextIds
  const referenced = new Set(allEntries.flatMap(([, s]) => s.edgeLayoutList?.nextIds ?? []));
  let roots = allEntries.filter(([execId]) => !referenced.has(execId));
  if (!roots.length) roots = [allEntries[0]];

  const ordered: LayoutNode[] = [];
  const visited = new Set<string>();
  const queue = roots.map(([execId]) => execId);

  while (queue.length) {
    const execId = queue.shift()!;
    if (visited.has(execId)) continue;
    visited.add(execId);

    const stage = byExecutionId.get(execId);
    if (!stage) continue;

    // Add to output only if not excluded
    if (!shouldExclude(stage)) {
      ordered.push(stage);
    }

    // Follow nextIds to continue traversal
    for (const nextId of stage.edgeLayoutList?.nextIds ?? []) {
      if (!visited.has(nextId)) queue.push(nextId);
    }
  }

  // Append any stages not reachable via chain (handles looped stages with shared nodeUuid)
  for (const [execId, stage] of allEntries) {
    if (!visited.has(execId) && !shouldExclude(stage)) {
      ordered.push(stage);
    }
  }

  // Sort by start time to ensure correct execution order (handles parallel stages correctly)
  // Stages without startTs (Skipped, NotStarted) sort to the end
  return ordered.sort((a, b) => {
    const aTime = a.startTs ?? Number.MAX_SAFE_INTEGER;
    const bTime = b.startTs ?? Number.MAX_SAFE_INTEGER;
    return aTime - bTime;
  });
}

function getFailureMessage(ex: ExecState): string | null {
  // Check failed stages in layoutNodeMap first
  for (const node of Object.values(ex.layoutNodeMap)) {
    const msg = node.failureInfo?.message;
    if (msg && node.status === 'FAILED') return msg;
  }
  // Fallback: check graph nodes
  if (ex.executionGraph?.nodeMap) {
    for (const node of Object.values(ex.executionGraph.nodeMap)) {
      const msg = node.failureInfo?.message;
      if (msg && node.status === 'FAILED') return msg;
    }
  }
  return null;
}

// ── Stage expansion logic (§7.1 single-focus rule) ────────────────────────────
/**
 * Recompute default stage expansion based on current execution state.
 * Only the "current" stage is expanded by default:
 * - First stage with status running/waiting/failed, OR
 * - Last stage if all are ok
 */
function recomputeStageDefaults(stages: LayoutNode[]): void {
  state.expandedStagesDefault.clear();

  // Find current stage index
  let currentIdx = stages.findIndex(s => {
    const status = s.status.toUpperCase();
    return status === 'RUNNING' ||
           status === 'ASYNC_WAITING' ||
           status === 'APPROVALWAITING' ||
           status === 'WAITING' ||
           status === 'FAILED';
  });

  // If no active/failed stage, use last stage
  if (currentIdx === -1) {
    currentIdx = stages.length - 1;
  }

  const cur = stages[currentIdx];
  if (cur?.nodeUuid) {
    state.expandedStagesDefault.add(cur.nodeUuid);
  }
}

/**
 * Check if a stage is expanded (user intent wins over defaults)
 */
function isStageExpanded(stageId: string): boolean {
  // User intent always wins
  if (state.userToggledStages.has(stageId)) {
    return state.userToggledStagesOpen.has(stageId);
  }
  // Otherwise use computed default
  return state.expandedStagesDefault.has(stageId);
}

// Stage boundary types — these mark the start of a NEW stage; stop traversal here.
const STAGE_TYPES = new Set([
  'IntegrationStageStepPMS',  // CI stage
  'PIPELINE_STAGE',           // generic stage
  'PIPELINE_ROLLBACK',        // rollback stage
  'STAGE_ROLLBACK',
  'DeploymentStageStepPMS',   // CD stage
  'ApprovalStageStepPMS',     // approval stage (PascalCase)
  'APPROVAL_STAGE',           // approval stage (SCREAMING_SNAKE_CASE)
  'CustomStageStepPMS',       // custom stage
  'IDPStage',                 // IDP stage
  'CUSTOM_STAGE',             // custom stage (SCREAMING_SNAKE_CASE)
]);

// Container node types — drill through these, don't surface as steps.
const CONTAINER_TYPES = new Set([
  'NG_SECTION', 'NG_SECTION_WITH_ROLLBACK_INFO', 'FORK', 'NG_FORK', 'ROLLBACK_OPTIONAL_CHILD_CHAIN',
  'PIPELINE', 'PIPELINE_SECTION',
  'BARRIER', 'QUEUE', 'STRATEGY',
  'STEP_GROUP', 'CI_STEP_GROUP',
  'INFRASTRUCTURE_SECTION', 'GITOPS_CLUSTERS', 'SPEC',
  'STAGES_STEP',       // top-level stages container
  'NG_EXECUTION',      // execution wrapper inside a stage
  'liteEngineTask',    // CI k8s/drone wrapper (camelCase from API)
  'LITEENGINE_TASK',
]);

function collectSteps(
  nodeId: string,
  nodeMap: Record<string, GraphNode>,
  adjList: Record<string, { children?: string[]; nextIds?: string[] }>,
  depth: number,
  visited: Set<string>
): StepInfo[] {
  if (depth > 15 || visited.has(nodeId)) return [];
  visited.add(nodeId);

  const node = nodeMap[nodeId];
  if (!node) return [];

  // Stop at stage boundaries — this node belongs to a different stage
  if (STAGE_TYPES.has(node.stepType ?? '')) return [];

  const adj      = adjList[nodeId] ?? {};
  const children = [...(adj.children ?? [])];
  const nextIds  = [...(adj.nextIds ?? [])];

  if (!CONTAINER_TYPES.has(node.stepType ?? '') && node.name) {
    // Leaf step — emit it, then follow sequential chain (but not into other stages)
    const step: StepInfo = {
      name: node.name,
      status: node.status,
      startTs: node.startTs,
      endTs: node.endTs,
      nodeId,
      logBaseKey: node.logBaseKey,
      stepType: node.stepType,
    };
    const rest = nextIds.flatMap(id => collectSteps(id, nodeMap, adjList, depth + 1, visited));
    return [step, ...rest];
  }

  // Container — drill into children and follow next chain
  const fromChildren = children.flatMap(id => collectSteps(id, nodeMap, adjList, depth + 1, visited));
  const fromNext     = nextIds.flatMap(id => collectSteps(id, nodeMap, adjList, depth + 1, visited));
  return [...fromChildren, ...fromNext];
}

function getStepsForStage(
  stage: LayoutNode,
  layoutNodeMap: Record<string, LayoutNode>,
  graph?: ExecGraph | null
): StepInfo[] {
  // Strategy 1: executionGraph — find stage by UUID then by name
  if (graph?.nodeMap && graph.nodeAdjacencyListMap) {
    let stageGraphId: string | undefined;

    // UUID match (most reliable)
    if (stage.nodeUuid && graph.nodeAdjacencyListMap[stage.nodeUuid]) {
      stageGraphId = stage.nodeUuid;
    }
    // Name match fallback - must match stage-level nodes only (baseFqn pattern: "pipeline.stages.StageName")
    // Not step-level nodes (baseFqn pattern: "pipeline.stages.StageName.spec.execution.steps.StepName")
    if (!stageGraphId) {
      stageGraphId = Object.entries(graph.nodeMap).find(
        ([, n]) => n.name === stage.name &&
                   n.baseFqn?.startsWith('pipeline.stages.') &&
                   !n.baseFqn?.includes('.spec.')
      )?.[0];
    }

    if (stageGraphId) {
      const visited = new Set<string>([stageGraphId]);
      const adj = graph.nodeAdjacencyListMap[stageGraphId] ?? {};
      // Only seed from children — nextIds at the stage level points to the NEXT
      // stage, not steps within this stage. collectSteps follows nextIds internally.
      const seeds = [...(adj.children ?? [])];
      const steps = seeds.flatMap(id =>
        collectSteps(id, graph.nodeMap!, graph.nodeAdjacencyListMap!, 0, visited)
      );
      if (steps.length) return steps;
    }
  }

  // Strategy 2: layoutNodeMap children (stage's edgeLayoutList)
  const childIds = stage.edgeLayoutList?.currentNodeChildren ?? [];
  const layoutSteps = childIds
    .map(id => layoutNodeMap[id])
    .filter((n): n is LayoutNode => !!n && n.nodeGroup !== 'STAGE')
    .map((n): StepInfo => ({ name: n.name, status: n.status, startTs: n.startTs, endTs: n.endTs }));
  if (layoutSteps.length) return layoutSteps;

  // Strategy 3: all non-STAGE nodes in layoutNodeMap that aren't other stages
  // (last resort — shows something even if parent-child relationship is missing)
  const allNonStage = Object.values(layoutNodeMap).filter(
    n => n.nodeGroup !== 'STAGE' && n.nodeGroup !== undefined && n.name
  ).map((n): StepInfo => ({ name: n.name, status: n.status, startTs: n.startTs, endTs: n.endTs }));
  return allNonStage;
}

// ── Debug panel — shows raw API data to diagnose step/status issues ──────────
function debugPanel(ex: ExecState): string {
  const stages = getStages(ex.layoutNodeMap);
  const layoutGroups = [...new Set(Object.values(ex.layoutNodeMap).map(n => n.nodeGroup ?? '—'))];
  const graphNodeTypes = ex.executionGraph?.nodeMap
    ? [...new Set(Object.values(ex.executionGraph.nodeMap).map((n: GraphNode) => n.stepType ?? '—'))].join(', ')
    : 'no graph';
  // Show children for ALL stages to help debug
  const stageChildInfo = stages.map(s =>
    `${s.name}(uuid=${s.nodeUuid?.slice(0,8)}, layoutChildren=[${(s.edgeLayoutList?.currentNodeChildren ?? []).join(',')}])`
  ).join(' | ');

  // Show adjacency for graph nodes matching stage names
  const adjInfo = ex.executionGraph?.nodeAdjacencyListMap
    ? stages.map(s => {
        const adj = ex.executionGraph!.nodeAdjacencyListMap![s.nodeUuid] ?? {};
        return `${s.name}: children=[${(adj.children ?? []).join(',')}] next=[${(adj.nextIds ?? []).join(',')}]`;
      }).join(' | ')
    : 'no adjList';

  return `<details class="debug-panel">
    <summary>Debug info (click to expand)</summary>
    <div class="debug-line">status: <b>${esc(ex.status)}</b> | isTerminal: ${ex.isTerminal} | endTs: ${ex.endTs ?? '—'}</div>
    <div class="debug-line">layoutNodeMap: ${Object.keys(ex.layoutNodeMap).length} nodes | groups: ${layoutGroups.join(', ')}</div>
    <div class="debug-line">stages: ${esc(stageChildInfo)}</div>
    <div class="debug-line">adjList by uuid: ${esc(adjInfo)}</div>
    <div class="debug-line">executionGraph nodeTypes: ${esc(graphNodeTypes)}</div>
    <div class="debug-line">executionGraph nodes: ${ex.executionGraph?.nodeMap ? Object.keys(ex.executionGraph.nodeMap).length : 0}</div>
    ${ex.executionGraph?.nodeMap ? `<div class="debug-line">graph node names: ${Object.values(ex.executionGraph.nodeMap).map((n: GraphNode) => esc(n.name)).join(', ').slice(0, 300)}</div>` : ''}
    ${ex.executionGraph?.nodeMap ? `<div class="debug-line">logBaseKeys: ${Object.values(ex.executionGraph.nodeMap).map((n: GraphNode) => n.logBaseKey ? `${esc(n.name)}=${esc(n.logBaseKey)}` : '').filter(Boolean).join(' | ').slice(0, 400)}</div>` : ''}
  </details>`;
}

function getModuleKeys(moduleInfo?: Record<string, unknown>): string[] {
  if (!moduleInfo) return [];
  return Object.keys(moduleInfo).filter(k => ['ci','cd','sto','ti','ssca','ccm'].includes(k));
}

// ── Render ─────────────────────────────────────────────────────────────────
function render(): void {
  // Preserve scroll position of the scrollable panel (not window)
  const scrollContainer = document.querySelector('.panel-scroll') as HTMLElement;
  const scrollY = scrollContainer ? scrollContainer.scrollTop : 0;

  // Preserve scroll position of AI response overlay
  const aiResponseBody = document.querySelector('.aix-response-body') as HTMLElement;
  const aiResponseScrollY = aiResponseBody ? aiResponseBody.scrollTop : 0;

  // Preserve focus state for inputs
  const activeElement = document.activeElement as HTMLInputElement;
  const wasSearchFocused = activeElement?.dataset?.action === 'searchPipelines';
  const wasAIFocused = activeElement?.dataset?.action === 'aiInput';
  const searchValue = wasSearchFocused ? activeElement.value : '';
  const aiValue = wasAIFocused ? activeElement.value : '';
  const searchSelectionStart = wasSearchFocused ? activeElement.selectionStart : null;
  const searchSelectionEnd = wasSearchFocused ? activeElement.selectionEnd : null;
  const aiSelectionStart = wasAIFocused ? activeElement.selectionStart : null;
  const aiSelectionEnd = wasAIFocused ? activeElement.selectionEnd : null;

  document.getElementById('root')!.innerHTML = build();
  bind();

  // Restore scroll position on the new panel-scroll container
  if (scrollY > 0) {
    const newScrollContainer = document.querySelector('.panel-scroll') as HTMLElement;
    if (newScrollContainer) {
      newScrollContainer.scrollTop = scrollY;
    }
  }

  // Restore scroll position on AI response overlay
  if (aiResponseScrollY > 0) {
    const newAiResponseBody = document.querySelector('.aix-response-body') as HTMLElement;
    if (newAiResponseBody) {
      newAiResponseBody.scrollTop = aiResponseScrollY;
    }
  }

  // Restore focus and cursor position for search input
  if (wasSearchFocused) {
    const newSearchInput = document.querySelector('[data-action="searchPipelines"]') as HTMLInputElement;
    if (newSearchInput) {
      newSearchInput.focus();
      if (searchSelectionStart !== null && searchSelectionEnd !== null) {
        newSearchInput.setSelectionRange(searchSelectionStart, searchSelectionEnd);
      }
    }
  }

  // Restore focus and cursor position for AI input
  if (wasAIFocused) {
    const newAIInput = document.querySelector('[data-action="aiInput"]') as HTMLInputElement;
    if (newAIInput) {
      newAIInput.focus();
      if (aiSelectionStart !== null && aiSelectionEnd !== null) {
        newAIInput.setSelectionRange(aiSelectionStart, aiSelectionEnd);
      }
    }
  }
}

function build(): string {
  // Show loading spinner during initialization
  if (state.initializing) {
    return `<div style="display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;color:var(--fg-2);font-size:11px">
      <span class="spinner" style="font-size:20px">⟳</span>
      <span>Loading...</span>
    </div>`;
  }

  // Show onboarding if not configured OR if we don't have org/project yet
  // BUT: if authSource='env', don't flash onboarding screen while waiting for config
  if (!state.configured || !state.org || !state.project) {
    // If using env vars and we're just waiting for config, show loading instead
    if (state.authSource === 'env' && state.envDetection?.allPresent) {
      return `<div style="display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:12px;color:var(--fg-2);font-size:11px">
        <span class="spinner" style="font-size:20px">⟳</span>
        <span>Loading Harness workspace...</span>
      </div>`;
    }
    return notConfigured();
  }

  const parts: string[] = [];

  // App menu (slide-out drawer)
  parts.push(appMenu());

  parts.push(harnessHeader(state.org, state.project));

  // View toggle tabs (always shown, regardless of git context)
  parts.push(viewToggleTabs());

  // Render content based on view mode
  if (state.viewMode === 'pipelines') {
    // Pipelines tab - show all pipelines in project
    parts.push(`<div class="panel-scroll">`);
    parts.push(pipelinesListView());
    parts.push(`</div>`);

    // Footer with pagination
    parts.push(`<div class="panel-footer">`);
    const totalPipelines = state.pipelineList.length;
    const paginationHtml = pipelinesPaginationBar(totalPipelines);
    if (paginationHtml) {
      parts.push(paginationHtml);
    }
    parts.push(pinFooter());
    if (state.aiChatEnabled) {
      parts.push(aiFooter());
    }
    parts.push(`</div>`);
  } else if (state.viewMode === 'executions') {
    // History list view with sticky footer
    parts.push(`<div class="panel-scroll">`);
    parts.push(historyListView());
    parts.push(`</div>`);
    parts.push(`<div class="panel-footer">`);
    parts.push(paginationBar());
    parts.push(pinFooter());
    if (state.aiChatEnabled) {
      parts.push(aiFooter());
    }
    parts.push(`</div>`);
  } else if (state.viewMode === 'detail') {
    // Detail view with sticky footer
    parts.push(`<div class="panel-scroll">`);
    parts.push(historyDetailView());
    parts.push(`</div>`);
    parts.push(`<div class="panel-footer">`);
    parts.push(adjacentNav());
    parts.push(pinFooter());
    if (state.aiChatEnabled) {
      parts.push(aiFooter());
    }
    parts.push(`</div>`);
  }

  // Accent glows for enhanced theme
  parts.push(`<div class="accent-glow-bottom-right"></div>`);
  parts.push(`<div class="accent-glow-top-left"></div>`);

  return parts.join('');
}

// ── Harness header ─────────────────────────────────────────────────────────
declare const __HARNESS_LOGO__: string;
declare const __THEME_VARIATION__: string;
function harnessHeader(org?: string, project?: string): string {
  // Menu button (3-dots icon)
  const menuButton = `<button class="header-menu-btn" data-action="toggleMenu" aria-label="Open menu">
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="3" cy="7" r="1.1" fill="currentColor"/>
      <circle cx="7" cy="7" r="1.1" fill="currentColor"/>
      <circle cx="11" cy="7" r="1.1" fill="currentColor"/>
    </svg>
  </button>`;

  // Enhanced theme uses the same blue gradient header as simple theme
  if (state.webviewTheme === 'enhanced') {
    const logoUrl = typeof __HARNESS_LOGO__ !== 'undefined' ? __HARNESS_LOGO__ : '';
    const projectBar = (org || project)
      ? `<div class="project-bar">
          <span class="project-bar-text">${org ? esc(org) : ''}${org && project ? ' / ' : ''}${project ? esc(project) : ''}</span>
          <button class="project-bar-btn" data-action="selectProject">Switch</button>
        </div>`
      : '';
    return `<div class="harness-header">
      ${logoUrl ? `<img class="harness-logo-img" src="${esc(logoUrl)}" alt="Harness" />` : ''}
      <span class="harness-subtitle">AI for Everything After Code</span>
      ${menuButton}
    </div>
    ${projectBar}`;
  }

  // Simple theme header: Harness logo + subtitle + menu button + project bar
  const logoUrl = typeof __HARNESS_LOGO__ !== 'undefined' ? __HARNESS_LOGO__ : '';
  const projectBar = (org || project)
    ? `<div class="project-bar">
        <span class="project-bar-text">${org ? esc(org) : ''}${org && project ? ' / ' : ''}${project ? esc(project) : ''}</span>
        <button class="project-bar-btn" data-action="selectProject">Switch</button>
      </div>`
    : '';
  return `<div class="harness-header">
    ${logoUrl ? `<img class="harness-logo-img" src="${esc(logoUrl)}" alt="Harness" />` : ''}
    <span class="harness-subtitle">AI for Everything After Code</span>
    ${menuButton}
  </div>
  ${projectBar}`;
}

// ── App Menu ───────────────────────────────────────────────────────────────
function appMenu(): string {
  if (!state.menuOpen) {
    return '';
  }

  // User icon for account section
  const userIcon = `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <circle cx="6" cy="4.2" r="2.1" fill="none" stroke="currentColor" stroke-width="1.2"/>
    <path d="M2 10.5 Q2 7.5 6 7.5 Q10 7.5 10 10.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
  </svg>`;

  // Chevron for account row
  const chevron = `<svg width="10" height="10" viewBox="0 0 12 12">
    <path d="M4 3 L8 6 L4 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/>
  </svg>`;

  // Account label
  const accountLabel = (state.org && state.project)
    ? `<span class="acct-org">${esc(state.org)}</span><span class="acct-sep"> / </span><span class="acct-proj">${esc(state.project)}</span>`
    : `<span class="acct-empty">Not connected</span>`;

  const accountDesc = (state.org && state.project)
    ? 'Change org &amp; project'
    : 'Connect your Harness account';

  const logoUrl = typeof __HARNESS_LOGO__ !== 'undefined' ? __HARNESS_LOGO__ : '';

  return `${state.menuOpen ? '<div class="menu-scrim" data-action="closeMenu"></div>' : ''}
    <aside class="app-menu ${state.menuOpen ? 'is-open' : ''}">
      <div class="app-menu-hdr">
        <div class="app-menu-brand">
          ${logoUrl ? `<img class="app-menu-logo" src="${esc(logoUrl)}" alt="Harness" />` : ''}
        </div>
        <button class="hdr-btn" data-action="closeMenu" aria-label="Close menu">
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
      <div class="app-menu-section">Products</div>
      <button class="app-menu-item on">
        <span class="app-menu-ico">${pipelinesGlyph()}</span>
        <span class="app-menu-text">
          <span class="app-menu-label">Pipelines</span>
          <span class="app-menu-desc">Execution status &amp; logs</span>
        </span>
        <span class="app-menu-dot"></span>
      </button>
      <div class="app-menu-section">Account</div>
      <button class="app-menu-item account-item" data-action="changeAccount">
        <span class="app-menu-ico account-ico">${userIcon}</span>
        <span class="app-menu-text">
          <span class="app-menu-label">${accountLabel}</span>
          <span class="app-menu-desc">${accountDesc}</span>
        </span>
        <span class="app-menu-chev">${chevron}</span>
      </button>
    </aside>`;
}

// ── Pin footer ────────────────────────────────────────────────────────────
function pinFooter(): string {
  if (!state.pinnedView) {
    return '';
  }
  const label = state.pinnedView === 'executions' ? 'Executions' : 'Pipelines';
  return `<div class="pin-footer">
    <span class="pf-icon">📌</span>
    <span>"${esc(label)}" opens by default</span>
    <span class="pf-link" data-action="openPinSettings">Change in settings</span>
  </div>`;
}

// ── AI Bar (Harness MCP integration) ──────────────────────────────────────

// Tool metadata
const AI_TOOL_META: Record<string, { name: string; sub: string | null }> = {
  'claudecode-cli': { name: 'Claude Code', sub: 'CLI' },
  'claudecode-ext': { name: 'Claude Code', sub: 'Extension' },
  'cursor': { name: 'Cursor', sub: null },
  'copilot': { name: 'GitHub Copilot', sub: null },
};

// Tool glyphs
function claudeCliGlyph(): string {
  return `<svg width="13" height="13" viewBox="0 -.01 39.5 39.53" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="m7.75 26.27 7.77-4.36.13-.38-.13-.21h-.38l-1.3-.08-4.44-.12-3.85-.16-3.73-.2-.94-.2-.88-1.16.09-.58.79-.53 1.13.1 2.5.17 3.75.26 2.72.16 4.03.42h.64l.09-.26-.22-.16-.17-.16-3.88-2.63-4.2-2.78-2.2-1.6-1.19-.81-.6-.76-.26-1.66 1.08-1.19 1.45.1.37.1 1.47 1.13 3.14 2.43 4.1 3.02.6.5.24-.17.03-.12-.27-.45-2.23-4.03-2.38-4.1-1.06-1.7-.28-1.02c-.1-.42-.17-.77-.17-1.2l1.23-1.67.68-.22 1.64.22.69.6 1.02 2.33 1.65 3.67 2.56 4.99.75 1.48.4 1.37.15.42h.26v-.24l.21-2.81.39-3.45.38-4.44.13-1.25.62-1.5 1.23-.81.96.46.79 1.13-.11.73-.47 3.05-.92 4.78-.6 3.2h.35l.4-.4 1.62-2.15 2.72-3.4 1.2-1.35 1.4-1.49.9-.71h1.7l1.25 1.86-.56 1.92-1.75 2.22-1.45 1.88-2.08 2.8-1.3 2.24.12.18.31-.03 4.7-1 2.54-.46 3.03-.52 1.37.64.15.65-.54 1.33-3.24.8-3.8.76-5.66 1.34-.07.05.08.1 2.55.24 1.09.06h2.67l4.97.37 1.3.86.78 1.05-.13.8-2 1.02-2.7-.64-6.3-1.5-2.16-.54h-.3v.18l1.8 1.76 3.3 2.98 4.13 3.84.21.95-.53.75-.56-.08-3.63-2.73-1.4-1.23-3.17-2.67h-.21v.28l.73 1.07 3.86 5.8.2 1.78-.28.58-1 .35-1.1-.2-2.26-3.17-2.33-3.57-1.88-3.2-.23.13-1.11 11.95-.52.61-1.2.46-1-.76-.53-1.23.53-2.43.64-3.17.52-2.52.47-3.13.28-1.04-.02-.07-.23.03-2.36 3.24-3.59 4.85-2.84 3.04-.68.27-1.18-.61.11-1.09.66-.97 3.93-5 2.37-3.1 1.53-1.79-.01-.26h-.09l-10.44 6.78-1.86.24-.8-.75.1-1.23.38-.4 3.14-2.16z" fill="#d97757"/>
  </svg>`;
}

function claudeExtGlyph(): string {
  return `<svg width="13" height="13" viewBox="0 -.01 39.5 39.53" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="m7.75 26.27 7.77-4.36.13-.38-.13-.21h-.38l-1.3-.08-4.44-.12-3.85-.16-3.73-.2-.94-.2-.88-1.16.09-.58.79-.53 1.13.1 2.5.17 3.75.26 2.72.16 4.03.42h.64l.09-.26-.22-.16-.17-.16-3.88-2.63-4.2-2.78-2.2-1.6-1.19-.81-.6-.76-.26-1.66 1.08-1.19 1.45.1.37.1 1.47 1.13 3.14 2.43 4.1 3.02.6.5.24-.17.03-.12-.27-.45-2.23-4.03-2.38-4.1-1.06-1.7-.28-1.02c-.1-.42-.17-.77-.17-1.2l1.23-1.67.68-.22 1.64.22.69.6 1.02 2.33 1.65 3.67 2.56 4.99.75 1.48.4 1.37.15.42h.26v-.24l.21-2.81.39-3.45.38-4.44.13-1.25.62-1.5 1.23-.81.96.46.79 1.13-.11.73-.47 3.05-.92 4.78-.6 3.2h.35l.4-.4 1.62-2.15 2.72-3.4 1.2-1.35 1.4-1.49.9-.71h1.7l1.25 1.86-.56 1.92-1.75 2.22-1.45 1.88-2.08 2.8-1.3 2.24.12.18.31-.03 4.7-1 2.54-.46 3.03-.52 1.37.64.15.65-.54 1.33-3.24.8-3.8.76-5.66 1.34-.07.05.08.1 2.55.24 1.09.06h2.67l4.97.37 1.3.86.78 1.05-.13.8-2 1.02-2.7-.64-6.3-1.5-2.16-.54h-.3v.18l1.8 1.76 3.3 2.98 4.13 3.84.21.95-.53.75-.56-.08-3.63-2.73-1.4-1.23-3.17-2.67h-.21v.28l.73 1.07 3.86 5.8.2 1.78-.28.58-1 .35-1.1-.2-2.26-3.17-2.33-3.57-1.88-3.2-.23.13-1.11 11.95-.52.61-1.2.46-1-.76-.53-1.23.53-2.43.64-3.17.52-2.52.47-3.13.28-1.04-.02-.07-.23.03-2.36 3.24-3.59 4.85-2.84 3.04-.68.27-1.18-.61.11-1.09.66-.97 3.93-5 2.37-3.1 1.53-1.79-.01-.26h-.09l-10.44 6.78-1.86.24-.8-.75.1-1.23.38-.4 3.14-2.16z" fill="#d97757"/>
  </svg>`;
}

function cursorGlyph(): string {
  // Official Cursor cube logo (CUBE_2D_DARK.svg)
  return `<svg width="13" height="13" viewBox="0 0 466.73 532.09" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path fill="currentColor" d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z"/>
  </svg>`;
}

function copilotGlyph(): string {
  // GitHub Copilot logo (GitHub mark)
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" fill="currentColor"/>
  </svg>`;
}

function getAIToolGlyph(toolId: string): string {
  if (toolId === 'claudecode-cli') return claudeCliGlyph();
  if (toolId === 'claudecode-ext') return claudeExtGlyph();
  if (toolId === 'cursor') return cursorGlyph();
  if (toolId === 'copilot') return copilotGlyph();
  return '';
}

// Icon helpers
function sendIcon(): string {
  return `<svg width="11" height="11" viewBox="0 0 12 12"><path d="M6 10 L6 2 M3 5 L6 2 L9 5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function chevDownIcon(): string {
  return `<svg width="8" height="8" viewBox="0 0 8 8"><path d="M1.5 3 L4 5.5 L6.5 3" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function warnIcon(): string {
  return `<svg width="11" height="11" viewBox="0 0 12 12"><path d="M6 1.5 L11 10 L1 10 Z M6 5 L6 7.5" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round"/><circle cx="6" cy="8.7" r="0.55" fill="currentColor"/></svg>`;
}

function checkIcon(): string {
  return `<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 6.2 L5 8.5 L9.5 3.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function closeIcon(): string {
  return `<svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 2 L8 8 M8 2 L2 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
}

function externalIcon(): string {
  return `<svg width="11" height="11" viewBox="0 0 12 12"><path d="M3 3 L7 3 L7 7 M7 3 L3 7" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function folderIcon(): string {
  return `<svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><path d="M1.5 4 L1.5 11 Q1.5 11.8 2.3 11.8 L11.7 11.8 Q12.5 11.8 12.5 11 L12.5 5.5 Q12.5 4.7 11.7 4.7 L6.8 4.7 L5.6 3.3 Q5.2 2.8 4.5 2.8 L2.3 2.8 Q1.5 2.8 1.5 3.6 Z" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linejoin="round"/></svg>`;
}

function homeIcon(): string {
  return `<svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true"><path d="M1.8 6.5 L7 2 L12.2 6.5 L12.2 11.5 Q12.2 12 11.7 12 L8.8 12 L8.8 8.8 L5.2 8.8 L5.2 12 L2.3 12 Q1.8 12 1.8 11.5 Z" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linejoin="round"/></svg>`;
}

function infoIcon(): string {
  return `<svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M6 5.4 L6 8.2 M6 3.8 L6 4.0" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>`;
}

function statusDot(dotState: 'ok' | 'warn' | 'err' | 'pulse'): string {
  return `<span class="ai-dot ai-dot-${dotState}" aria-hidden="true"></span>`;
}

// Render functions
function renderAIToolBadge(toolId: string | null, multi: boolean, warn: boolean): string {
  if (!toolId) {
    return `<div class="ai-badge is-warn">${warnIcon()}<span>No AI tool</span></div>`;
  }
  const glyph = getAIToolGlyph(toolId);

  // Only make it clickable if there are multiple tools to choose from
  if (multi) {
    const chevron = `<span class="ai-badge-chev">${chevDownIcon()}</span>`;
    // Show only icon in badge to save space
    return `<button type="button" class="ai-badge ${warn ? 'is-warn' : ''}" data-action="toggleAIToolPicker">${glyph}${chevron}</button>`;
  } else {
    // Single tool - show only icon to save space
    return `<div class="ai-badge ${warn ? 'is-warn' : ''}">${glyph}</div>`;
  }
}

function renderAIToolPicker(): string {
  if (!state.aiDetection || !state.aiShowToolPicker || (state.aiDetection.tools.length || 0) < 2) return '';
  const items = state.aiDetection.tools.map(tool => {
    const meta = AI_TOOL_META[tool.id];
    const glyph = getAIToolGlyph(tool.id);
    const isActive = tool.id === state.aiDetection?.activeTool;
    const statusClass = tool.mcpReady ? 'is-ok' : 'is-warn';
    const statusText = tool.mcpReady ? 'MCP ready' : 'MCP not configured';
    const check = isActive ? `<span class="aix-picker-check">${checkIcon()}</span>` : '';
    return `<button type="button" class="aix-picker-item ${isActive ? 'on' : ''}" data-action="selectAITool" data-tool="${tool.id}">
      <span class="aix-picker-ico">${glyph}</span>
      <span class="aix-picker-text">
        <span class="aix-picker-name">${esc(meta.name)}${meta.sub ? `<span class="aix-picker-sub">${esc(meta.sub)}</span>` : ''}</span>
        <span class="aix-picker-status ${statusClass}">${statusDot(tool.mcpReady ? 'ok' : 'warn')}${statusText}</span>
      </span>${check}
    </button>`;
  }).join('');
  return `<div class="aix-picker"><div class="aix-picker-head">Choose AI tool</div>${items}</div>`;
}

/**
 * Get MCP config path display for a given tool and scope
 */
function getMcpPathDisplay(toolId: string, scope: 'project' | 'global'): string {
  if (toolId === 'copilot') {
    if (scope === 'project') {
      return '<workspace>/.vscode/mcp.json';
    }
    // Global paths are OS-specific for Copilot
    if (navigator.platform.toLowerCase().includes('win')) {
      return '%APPDATA%\\Code\\User\\mcp.json';
    } else if (navigator.platform.toLowerCase().includes('mac')) {
      return '~/Library/Application Support/Code/User/mcp.json';
    } else {
      return '~/.config/Code/User/mcp.json';
    }
  }

  // Claude Code (CLI and Extension)
  return scope === 'project' ? '<workspace>/.mcp.json' : '~/.claude.json';
}

function renderAIMCPCard(): string {
  if (state.aiOverlay !== 'mcp-setup' && state.aiOverlay !== 'mcp-done' && state.aiOverlay !== 'mcp-existing' && state.aiOverlay !== 'mcp-conflict') return '';
  const activeTool = state.aiDetection?.activeTool;
  if (!activeTool) return '';

  // Never show MCP config card for Cursor (uses plugin instead)
  if (activeTool === 'cursor') {
    return '';
  }

  const meta = AI_TOOL_META[activeTool];
  const glyph = getAIToolGlyph(activeTool);

  // Existing config card
  if (state.aiOverlay === 'mcp-existing') {
    const scope = state.aiDetection?.mcpScope;
    if (!scope || !scope.activeScope) return '';
    const scopeInfo = scope.activeScope === 'project' ? scope.project : scope.global;
    if (!scopeInfo) return '';
    return `<div class="aix-overlay aix-overlay-existing"><div class="aix-existing-hdr"><span class="aix-existing-check">${checkIcon()}</span><div class="aix-existing-title"><strong>Harness MCP is already configured</strong><span>You're all set to use ${esc(meta.name)} with Harness.</span></div><button type="button" class="aix-overlay-x" data-action="closeAIMCPCard" aria-label="Dismiss">${closeIcon()}</button></div><div class="aix-existing-where"><span class="aix-scope-chip is-${scope.activeScope}"><span class="aix-scope-chip-ico">${scope.activeScope === 'project' ? folderIcon() : homeIcon()}</span>${scope.activeScope}</span><code class="aix-existing-path">${esc(scopeInfo.path)}</code><button type="button" class="aix-existing-open" data-action="openMCPConfig" data-scope="${scope.activeScope}">Open</button></div><div class="aix-setup-acts"><button type="button" class="aix-btn-ghost" data-action="closeAIMCPCard">Got it</button></div></div>`;
  }

  // Conflict card
  if (state.aiOverlay === 'mcp-conflict') {
    const scope = state.aiDetection?.mcpScope;
    if (!scope || !scope.conflict) return '';
    return `<div class="aix-overlay aix-overlay-conflict"><div class="aix-existing-hdr"><span class="aix-existing-warn">${warnIcon()}</span><div class="aix-existing-title"><strong>Harness MCP configured in both scopes</strong><span>Project scope takes precedence. Global config is ignored.</span></div><button type="button" class="aix-overlay-x" data-action="closeAIMCPCard" aria-label="Dismiss">${closeIcon()}</button></div><div class="aix-conflict-list"><div class="aix-conflict-row is-active"><span class="aix-scope-chip is-project"><span class="aix-scope-chip-ico">${folderIcon()}</span>project</span><code class="aix-existing-path">${esc(scope.project!.path)}</code><span class="aix-conflict-tag is-active">in use</span><button type="button" class="aix-conflict-open" data-action="openMCPConfig" data-scope="project">Open</button></div><div class="aix-conflict-row is-shadowed"><span class="aix-scope-chip is-global"><span class="aix-scope-chip-ico">${homeIcon()}</span>global</span><code class="aix-existing-path">${esc(scope.global.path)}</code><span class="aix-conflict-tag">ignored</span><button type="button" class="aix-conflict-open" data-action="openMCPConfig" data-scope="global">Open</button></div></div><div class="aix-conflict-foot"><span>${infoIcon()} To switch scopes, remove one config and run setup again.</span><button type="button" class="aix-btn-ghost is-small" data-action="closeAIMCPCard">Got it</button></div></div>`;
  }

  // Done toast
  if (state.aiOverlay === 'mcp-done') {
    const doneScope = state.aiMcpDoneScope || 'global';
    const pathDisplay = getMcpPathDisplay(activeTool, doneScope);
    return `<div class="aix-overlay aix-overlay-done"><span class="aix-overlay-check">${checkIcon()}</span><div class="aix-overlay-done-text"><strong>Harness MCP configured for ${esc(meta.name)}.</strong><span>Wrote <code class="mono">${esc(pathDisplay)}</code> · restart ${esc(meta.name)} to activate.</span></div><button type="button" class="aix-overlay-x" data-action="closeAIMCPCard" aria-label="Dismiss">${closeIcon()}</button></div>`;
  }

  // Setup card with scope picker
  const busyClass = state.aiMcpConfiguring ? 'is-busy' : '';
  const busyContent = state.aiMcpConfiguring ? `<span class="aix-send-spin"></span> Configuring…` : (state.aiMcpSetupScope === 'project' ? 'Configure for this project' : 'Configure globally');
  const writesTo = getMcpPathDisplay(activeTool, state.aiMcpSetupScope || 'global');
  const tipText = state.aiMcpSetupScope === 'project'
    ? (activeTool === 'copilot' ? 'Lives in .vscode/ folder.' : 'Lives in your workspace root.')
    : 'Lives in your home folder. Only you use it; applies to every project you open.';

  return `<div class="aix-overlay aix-overlay-setup"><div class="aix-setup-hdr"><span class="aix-setup-glyph">${glyph}</span><div class="aix-setup-title"><strong>Configure Harness MCP</strong><span>Lets ${esc(meta.name)} fetch pipeline data, logs &amp; executions.</span></div><button type="button" class="aix-overlay-x" data-action="closeAIMCPCard" aria-label="Dismiss">${closeIcon()}</button></div><div class="aix-scope-label-row"><span class="aix-setup-k">Where</span></div><div class="aix-scope"><button type="button" class="aix-scope-opt ${state.aiMcpSetupScope === 'project' ? 'on' : ''}" data-action="setMCPScope" data-scope="project"><span class="aix-scope-ico">${folderIcon()}</span><span class="aix-scope-text"><strong>This project</strong><span>shared with teammates if committed</span></span><span class="aix-scope-radio" aria-hidden></span></button><button type="button" class="aix-scope-opt ${state.aiMcpSetupScope === 'global' ? 'on' : ''}" data-action="setMCPScope" data-scope="global"><span class="aix-scope-ico">${homeIcon()}</span><span class="aix-scope-text"><strong>All my projects</strong><span>personal, every repo</span></span><span class="aix-scope-radio" aria-hidden></span></button></div><div class="aix-setup-meta"><div class="aix-setup-row"><span class="aix-setup-k">Writes to</span><code class="aix-setup-v mono">${esc(writesTo)}</code></div><div class="aix-setup-row"><span class="aix-setup-k">Auth</span><span class="aix-setup-v">Uses your stored Harness PAT</span></div></div><div class="aix-scope-tip"><span class="aix-scope-tip-ico">${infoIcon()}</span><span>${esc(tipText)}</span></div><div class="aix-setup-acts"><button type="button" class="aix-btn-primary ${busyClass}" data-action="configureAIMCP" ${state.aiMcpConfiguring ? 'disabled' : ''}>${busyContent}</button><button type="button" class="aix-btn-ghost" data-action="closeAIMCPCard">Not now</button></div></div>`;
}

function renderAIResponse(): string {
  if (state.aiOverlay !== 'response' || !state.aiResponse) return '';
  const activeTool = state.aiDetection?.activeTool;
  if (!activeTool) return '';
  const meta = AI_TOOL_META[activeTool];
  const glyph = getAIToolGlyph(activeTool);
  const { content, toolCalls, durationMs } = state.aiResponse;
  const duration = durationMs ? `${(durationMs / 1000).toFixed(1)}s` : '';
  const toolCallCount = toolCalls?.length || 0;
  const metaText = [toolCallCount > 0 ? `${toolCallCount} MCP call${toolCallCount > 1 ? 's' : ''}` : null, duration].filter(Boolean).join(' · ');
  const toolCallChips = toolCalls?.map(tc => `<span class="aix-tool-call">${esc(tc.name)}</span>`).join('') || '';

  // Enhanced markdown parsing
  let htmlContent = parseMarkdown(content);

  return `<div class="aix-response"><div class="aix-response-hdr"><span class="aix-response-tool">${glyph}<span>${esc(meta.name)}</span>${metaText ? `<span class="aix-response-meta">· ${esc(metaText)}</span>` : ''}</span><button type="button" class="aix-response-close" data-action="closeAIResponse" aria-label="Close">${closeIcon()}</button></div><div class="aix-response-body">${htmlContent}${toolCallChips ? `<div class="aix-response-tools">${toolCallChips}</div>` : ''}</div><div class="aix-response-foot"><button type="button" class="aix-chip" data-action="copyAIResponse">Copy answer</button><button type="button" class="aix-chip" data-action="rerunAI">Re-run</button></div></div>`;
}

function parseMarkdown(md: string): string {
  if (!md) return '';

  let html = esc(md);

  // Code blocks (```...```)
  html = html.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="mono">${code.trim()}</code></pre>`;
  });

  // Headers (## Header)
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');

  // Bold (**text**)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Inline code (`code`)
  html = html.replace(/`([^`]+)`/g, '<code class="mono">$1</code>');

  // Lists (- item or 1. item)
  const lines = html.split('\n');
  let inList = false;
  let listType = '';
  const processed: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ulMatch = line.match(/^(\s*)- (.+)$/);
    const olMatch = line.match(/^(\s*)\d+\. (.+)$/);

    if (ulMatch || olMatch) {
      const match = ulMatch || olMatch;
      const indent = match![1].length;
      const content = match![2];
      const type = ulMatch ? 'ul' : 'ol';

      if (!inList) {
        processed.push(`<${type}>`);
        inList = true;
        listType = type;
      } else if (listType !== type) {
        processed.push(`</${listType}>`);
        processed.push(`<${type}>`);
        listType = type;
      }
      processed.push(`<li>${content}</li>`);
    } else {
      if (inList) {
        processed.push(`</${listType}>`);
        inList = false;
      }
      processed.push(line);
    }
  }
  if (inList) {
    processed.push(`</${listType}>`);
  }
  html = processed.join('\n');

  // Paragraphs (blank lines)
  html = html.split('\n\n').map(para => {
    para = para.trim();
    if (!para) return '';
    if (para.startsWith('<h') || para.startsWith('<ul') || para.startsWith('<ol') || para.startsWith('<pre')) {
      return para;
    }
    return `<p>${para.replace(/\n/g, '<br>')}</p>`;
  }).join('');

  return html;
}

function renderAILaunched(): string {
  if (state.aiOverlay !== 'launched') return '';
  const activeTool = state.aiDetection?.activeTool;
  if (!activeTool) return '';
  const meta = AI_TOOL_META[activeTool];
  return `<div class="aix-overlay aix-overlay-launched"><span class="aix-overlay-check is-accent">${externalIcon()}</span><div class="aix-overlay-done-text"><strong>Opened in ${esc(meta.name)}</strong><span>Continue the conversation there.</span></div></div>`;
}

function aiFooter(): string {
  const aiState = state.aiState;
  const question = state.aiQuestion;
  const detection = state.aiDetection;

  // Calculate effective state based on active tool
  let effectiveState = aiState;
  const activeTool = detection?.tools.find(t => t.id === detection.activeTool);

  // Only override state for configuration-related states
  // Don't override dynamic states like 'sending', 'error', 'detecting'
  if (activeTool && (aiState === 'ready' || aiState === 'unconfigured')) {
    // Cursor-specific states
    if (activeTool.id === 'cursor') {
      if ((activeTool as any).cursorMcpMode === 'none') {
        effectiveState = 'cursor-no-plugin' as any;
      } else if ((activeTool as any).cursorMcpMode === 'plugin' && !(activeTool as any).cursorOAuthReady) {
        effectiveState = 'cursor-oauth-pending' as any;
      } else if (activeTool.mcpReady) {
        effectiveState = 'ready';
      } else {
        effectiveState = 'unconfigured';
      }
    }
    // Claude Code tools (CLI/Extension) - use mcpReady status
    else {
      effectiveState = activeTool.mcpReady ? 'ready' : 'unconfigured';
    }
  }

  const placeholders: Record<typeof aiState | 'cursor-no-plugin' | 'cursor-oauth-pending', string> = {
    detecting: 'Detecting AI tools…',
    none: 'Install Claude Code to ask questions',
    unconfigured: 'Configure MCP to ask questions',
    ready: 'Ask about this pipeline…',
    sending: question || 'Thinking…',
    error: 'Ask about this pipeline…',
    'cursor-no-plugin': 'Install Harness Plugin for Cursor to continue',
    'cursor-oauth-pending': 'Connect your Harness account in Cursor',
  };
  const inputDisabled = effectiveState === 'detecting' || effectiveState === 'none' || effectiveState === 'sending' || effectiveState === 'cursor-no-plugin' || effectiveState === 'cursor-oauth-pending';
  const sendDisabled = effectiveState !== 'ready' || !state.aiQuestion.trim();
  let badgeHtml = '';
  if (effectiveState === 'detecting') badgeHtml = `<div class="aix-detect"><span class="aix-spinner"></span></div>`;
  else if (effectiveState === 'none') badgeHtml = renderAIToolBadge(null, false, false);
  else if (detection?.activeTool) badgeHtml = renderAIToolBadge(detection.activeTool, (detection.tools.length || 0) > 1, effectiveState === 'unconfigured' || effectiveState === 'cursor-no-plugin' || effectiveState === 'cursor-oauth-pending');
  const sendContent = effectiveState === 'sending' ? '<span class="aix-send-spin"></span>' : sendIcon();
  let statusHtml = '';
  if (effectiveState !== 'none') {
    const statusLines: Record<typeof aiState | 'cursor-no-plugin' | 'cursor-oauth-pending', { dot: string; text: string; link?: string }> = {
      detecting: { dot: 'pulse', text: 'Detecting AI tools…' },
      none: { dot: 'err', text: 'No AI tool found', link: 'Install Claude Code ↗' },
      unconfigured: { dot: 'warn', text: `MCP not configured · ${AI_TOOL_META[detection?.activeTool || '']?.name || ''}`, link: 'Configure MCP ›' },
      ready: { dot: 'ok', text: `MCP ready · ${AI_TOOL_META[detection?.activeTool || '']?.name || ''}${AI_TOOL_META[detection?.activeTool || '']?.sub ? ` (${AI_TOOL_META[detection?.activeTool || ''].sub})` : ''}` },
      sending: { dot: 'pulse', text: `Querying ${AI_TOOL_META[detection?.activeTool || '']?.name || ''}…` },
      error: { dot: 'err', text: state.aiError || 'Request failed', link: 'Retry' },
      'cursor-no-plugin': { dot: 'warn', text: 'Harness Plugin not installed', link: 'Install Plugin ↗' },
      'cursor-oauth-pending': { dot: 'warn', text: 'Not authenticated in Harness · Cursor', link: 'Auth in Chat' },
    };
    const s = statusLines[effectiveState];
    const linkAction = effectiveState === 'cursor-no-plugin' ? 'cursorInstallPlugin' : effectiveState === 'cursor-oauth-pending' ? 'cursorConnectOAuth' : effectiveState === 'unconfigured' ? 'showAIMCPSetup' : 'retryAI';
    const linkHtml = s.link ? `<button type="button" class="aix-status-link ${effectiveState === 'unconfigured' || effectiveState === 'cursor-no-plugin' || effectiveState === 'cursor-oauth-pending' ? 'is-primary' : ''}" data-action="${linkAction}">${esc(s.link)}</button>` : '';
    const scopeChip = (effectiveState === 'ready' && detection?.mcpScope?.activeScope) ? `<span class="aix-scope-tag is-${detection.mcpScope.activeScope}">${detection.mcpScope.activeScope === 'project' ? folderIcon() : homeIcon()}${detection.mcpScope.activeScope}</span>` : '';
    statusHtml = `<div class="aix-status">${statusDot(s.dot as any)}<span class="aix-status-txt">${esc(s.text)}</span>${scopeChip}${linkHtml}</div>`;
  }
  return `<div class="aix aix-${effectiveState}">${renderAIToolPicker()}${renderAIMCPCard()}${renderAIResponse()}${renderAILaunched()}<div class="aix-bar">${badgeHtml}<input class="aix-inp" placeholder="${esc(placeholders[effectiveState])}" value="${esc(question)}" ${inputDisabled ? 'disabled' : ''} data-action="aiInput"/><button type="button" class="aix-send" ${sendDisabled ? 'disabled' : ''} data-action="sendAI">${sendContent}</button></div>${statusHtml}</div>`;
}

// ── Git bar ────────────────────────────────────────────────────────────────
function gitBar(ctx: GitCtx): string {
  if (state.webviewTheme === 'enhanced') {
    const branchIcon = '<svg width="11" height="11" viewBox="0 0 12 12"><circle cx="3" cy="2.5" r="1.2" stroke="currentColor" strokeWidth="1.1" fill="none"/><circle cx="3" cy="9.5" r="1.2" stroke="currentColor" strokeWidth="1.1" fill="none"/><circle cx="9" cy="5" r="1.2" stroke="currentColor" strokeWidth="1.1" fill="none"/><path d="M3 3.8 L3 8.2 M3 5.5 Q3 5 3.5 5 L7.8 5" stroke="currentColor" strokeWidth="1.1" fill="none"/></svg>';
    const clockIcon = '<svg width="11" height="11" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.1" fill="none"/><path d="M6 3.5 L6 6 L8 7.5" stroke="currentColor" strokeWidth="1.1" fill="none" strokeLinecap="round"/></svg>';

    const shaLink = ctx.commitWebUrl
      ? `<a class="git-sha" data-action="openUrl" data-url="${esc(ctx.commitWebUrl)}">${esc(ctx.shortSha)}</a>`
      : `<span class="git-sha">${esc(ctx.shortSha)}</span>`;

    return `<div class="git-bar">
      ${branchIcon}
      <span class="git-branch">${esc(ctx.branch)}</span>
      <span class="git-sep">·</span>
      ${shaLink}
      <span class="git-commit">latest commit</span>
      <span class="git-time">${clockIcon}${ago(Date.now())}</span>
    </div>`;
  }

  // Simple theme
  const shaHtml = ctx.commitWebUrl
    ? `<a class="sha-link" data-action="openUrl" data-url="${esc(ctx.commitWebUrl)}">${esc(ctx.shortSha)}</a>`
    : `<span class="sha">${esc(ctx.shortSha)}</span>`;

  return `<div class="git-bar">
    <div class="git-bar-row1">
      <span class="git-icon">⎇</span>
      <span class="branch">${esc(ctx.branch)}</span>
    </div>
    <div class="git-bar-row2">
      <span>commit</span>
      ${shaHtml}
      <span class="git-sep">·</span>
      <span>${ago(Date.now())}</span>
    </div>
  </div>`;
}

// ── View toggle tabs ───────────────────────────────────────────────────────
function viewToggleTabs(): string {
  const liveActive = state.viewMode === 'pipelines' ? ' on' : '';
  const historyActive = state.viewMode === 'executions' || state.viewMode === 'detail' ? ' on' : '';
  const activeView = state.viewMode === 'pipelines' ? 'pipelines' : 'executions';
  const isPinned = state.pinnedView === activeView;

  const pipelineIcon = `<svg class="vt-icon" viewBox="0 0 18 11" fill="currentColor" xmlns="http://www.w3.org/2000/svg" width="16" height="16"><g fill-rule="evenodd" clip-rule="evenodd"><path d="M9.871 1.01a1 1 0 011-1h5.25a1 1 0 011 1v2.125a1 1 0 01-1 1h-5.25a1 1 0 01-1-1V1.01zm6.25 0h-5.25v2.125h5.25V1.01zm-6.25 5.869a1 1 0 011-1h5.25a1 1 0 011 1v2.125a1 1 0 01-1 1h-5.25a1 1 0 01-1-1V6.879zm6.25 0h-5.25v2.125h5.25V6.879zM.889 1a1 1 0 011-1h5.25a1 1 0 011 1v2.125a1 1 0 01-1 1h-5.25a1 1 0 01-1-1V1zm6.25 0h-5.25v2.125h5.25V1z"></path><path d="M10.25 2.844h-2.5v-1h2.5v1zM5.125 3.906v1.875c0 .416.07.705.172.91.099.198.241.342.435.453.42.24 1.079.325 2.018.325h2.5v1h-2.5c-.936 0-1.84-.072-2.514-.457a2.045 2.045 0 01-.834-.874c-.19-.382-.277-.835-.277-1.357V3.906h1z"></path></g></svg>`;
  const executionIcon = `<svg class="vt-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><path fill-rule="evenodd" clip-rule="evenodd" d="M3.546 4.017a.5.5 0 00-.5.492v7.005a.5.5 0 00.5.507h8.98a.5.5 0 00.5-.5V6.61a.5.5 0 011 0v4.91a1.5 1.5 0 01-1.5 1.5h-8.98a1.5 1.5 0 01-1.5-1.522V4.495a1.5 1.5 0 011.5-1.478h6.804a.5.5 0 010 1H3.546z" fill="currentColor"></path><path fill-rule="evenodd" clip-rule="evenodd" d="M5.219 5.094a.467.467 0 01.48-.04l5.025 2.463c.18.088.296.284.296.5 0 .214-.116.41-.296.498l-5.026 2.463a.468.468 0 01-.479-.04.56.56 0 01-.23-.459V5.553a.56.56 0 01.23-.46zM5.994 6.4v3.233l3.3-1.617-3.3-1.616z" fill="currentColor"></path></svg>`;

  if (state.webviewTheme === 'enhanced') {
    return `<div class="vt">
      <button class="vt-btn${liveActive}" data-action="switchToLive">
        ${pipelineIcon}
        Pipelines
      </button>
      <button class="vt-btn${historyActive}" data-action="switchToHistory">
        ${executionIcon}
        Executions
      </button>
      <button class="vt-pin${isPinned ? ' on' : ''}" data-action="togglePin" aria-label="${isPinned ? 'Remove default pin' : 'Pin ' + (activeView === 'pipelines' ? 'Pipelines' : 'Executions') + ' as default'}">
        📌
      </button>
    </div>`;
  }

  // Simple theme
  return `<div class="view-toggle">
    <div class="vt-btn${liveActive}" data-action="switchToLive">
      ${pipelineIcon}
      Pipelines
    </div>
    <div class="vt-btn${historyActive}" data-action="switchToHistory">
      ${executionIcon}
      Executions
    </div>
    <div class="vt-pin-wrap">
      <button class="vt-pin${isPinned ? ' pinned' : ''}" id="vt-pin" data-action="togglePin">📌</button>
      <div class="vt-pin-tooltip" id="vt-pin-tooltip">${isPinned ? 'Remove default pin' : 'Pin ' + (activeView === 'pipelines' ? 'Pipelines' : 'Executions') + ' as default'}</div>
    </div>
  </div>`;
}

// ── Pipelines list view ────────────────────────────────────────────────────
function pipelinesListView(): string {
  const parts: string[] = [];

  // Apply search filter
  let filtered = state.pipelineList.filter(p => {
    if (!state.pipelinesSearch) return true;
    const searchLower = state.pipelinesSearch.toLowerCase();
    return p.name.toLowerCase().includes(searchLower) ||
           (p.pipelineType && p.pipelineType.toLowerCase().includes(searchLower));
  });

  // Apply status filter
  if (state.pipelinesFilter !== 'all') {
    filtered = filtered.filter(p => {
      const status = p.lastStatus?.toUpperCase();
      if (state.pipelinesFilter === 'failed') return status === 'FAILED';
      if (state.pipelinesFilter === 'running') return status === 'RUNNING' || status === 'ASYNC_WAITING';
      if (state.pipelinesFilter === 'waiting') return status === 'APPROVALWAITING';
      return true;
    });
  }

  // Calculate counts for filter badges
  const allCount = state.pipelineList.length;
  const failedCount = state.pipelineList.filter(p => p.lastStatus === 'FAILED').length;
  const runningCount = state.pipelineList.filter(p => p.lastStatus === 'RUNNING' || p.lastStatus === 'ASYNC_WAITING').length;
  const waitingCount = state.pipelineList.filter(p => p.lastStatus === 'APPROVALWAITING').length;

  // Sort pipelines
  let sorted = [...filtered];
  if (state.pipelinesSort === 'recent') {
    sorted.sort((a, b) => (b.lastRunTime ?? 0) - (a.lastRunTime ?? 0));
  } else if (state.pipelinesSort === 'name') {
    sorted.sort((a, b) => a.name.localeCompare(b.name));
  } else if (state.pipelinesSort === 'status') {
    const statusOrder = { FAILED: 0, RUNNING: 1, SUCCESS: 2, ABORTED: 3 };
    sorted.sort((a, b) => {
      const aOrder = statusOrder[a.lastStatus as keyof typeof statusOrder] ?? 99;
      const bOrder = statusOrder[b.lastStatus as keyof typeof statusOrder] ?? 99;
      return aOrder - bOrder;
    });
  }

  // Separate pinned from unpinned
  const pinned = sorted.filter(p => state.pinnedPipelines.has(p.identifier));
  const unpinned = sorted.filter(p => !state.pinnedPipelines.has(p.identifier));
  const allPipelines = [...pinned, ...unpinned];

  // Pagination
  const totalPipelines = allPipelines.length;
  const startIdx = state.pipelinesPage * state.pipelinesPageSize;
  const endIdx = Math.min(startIdx + state.pipelinesPageSize, totalPipelines);
  const paginatedPipelines = allPipelines.slice(startIdx, endIdx);

  // Search box
  parts.push(`<div class="pl-search-wrap">
    <input type="text" class="pl-search" placeholder="Search pipelines..." value="${esc(state.pipelinesSearch)}" data-action="searchPipelines">
  </div>`);

  // Sort toolbar
  const sortLabel = state.pipelinesSort === 'recent' ? 'Most recent'
                  : state.pipelinesSort === 'name' ? 'Name (A→Z)'
                  : state.pipelinesSort === 'status' ? 'Status'
                  : 'Sort';

  parts.push(`<div class="pl-toolbar">
    <button class="sort-btn" data-action="togglePipelinesSort">
      <span>↕</span>
      <span>${sortLabel}</span>
    </button>
    <span class="hist-count-chip">${paginatedPipelines.length} / ${totalPipelines} pipelines</span>
  </div>`);

  // Pipeline list
  parts.push(`<div class="pl-list">`);

  if (state.loadingPipelines) {
    parts.push(`<div class="loading">Loading pipelines...</div>`);
  } else if (allPipelines.length === 0) {
    parts.push(`<div class="empty-history">No pipelines found</div>`);
  } else {
    for (const pipeline of paginatedPipelines) {
      parts.push(pipelineRow(pipeline));
    }
  }

  parts.push(`</div>`);
  return parts.join('');
}

function pipelineRow(p: PipelineItem): string {
  const isPinned = state.pinnedPipelines.has(p.identifier);

  // Time ago helper
  const timeAgo = (ts?: number) => {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    const hrs = Math.floor(mins / 60);
    const days = Math.floor(hrs / 24);
    if (days > 0) return `${days}d ago`;
    if (hrs > 0) return `${hrs}h ago`;
    if (mins > 0) return `${mins}m ago`;
    return 'just now';
  };

  // Run history strip (last 5 executions as colored squares)
  // API returns newest first, so reverse to show oldest→newest (left to right)
  const runHistory = (p.recentExecutions ?? []).slice(0, 5).reverse();
  const historySquares = runHistory.map((e, idx) => {
    const sqClass = e.status === 'SUCCESS' ? 'rs-ok'
                  : e.status === 'FAILED' ? 'rs-err'
                  : e.status === 'RUNNING' || e.status === 'ASYNC_WAITING' ? 'rs-run'
                  : e.status === 'APPROVALWAITING' ? 'rs-wait'
                  : e.status === 'ABORTED' ? 'rs-abort'
                  : 'rs-pend';
    const isLatest = idx === runHistory.length - 1;
    const title = `${e.status} · ${timeAgo(e.startTs)}`;
    return `<span class="rs-cell ${sqClass}${isLatest ? ' rs-latest' : ''}" title="${esc(title)}"></span>`;
  }).join('');

  const author = p.lastRunActor ? esc(p.lastRunActor) : '';
  const time = p.lastRunTime ? timeAgo(p.lastRunTime) : '';

  // Tags display
  const tagEntries = Object.entries(p.tags ?? {});
  const tagsHtml = tagEntries.length > 0
    ? `<div class="pl-tags">🏷️ ${tagEntries.map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(' · ')}</div>`
    : '';

  // Meta info: clock icon + time · executor
  const metaParts: string[] = [];
  if (time) metaParts.push(`⏱ ${time}`);
  if (author) metaParts.push(author);
  const metaHtml = metaParts.length > 0 ? `<div class="ei-meta">${metaParts.join(' · ')}</div>` : '';

  const pipelineIcon = `<svg class="pl-icon" viewBox="0 0 18 11" fill="currentColor" xmlns="http://www.w3.org/2000/svg" width="20" height="20"><g fill-rule="evenodd" clip-rule="evenodd"><path d="M9.871 1.01a1 1 0 011-1h5.25a1 1 0 011 1v2.125a1 1 0 01-1 1h-5.25a1 1 0 01-1-1V1.01zm6.25 0h-5.25v2.125h5.25V1.01zm-6.25 5.869a1 1 0 011-1h5.25a1 1 0 011 1v2.125a1 1 0 01-1 1h-5.25a1 1 0 01-1-1V6.879zm6.25 0h-5.25v2.125h5.25V6.879zM.889 1a1 1 0 011-1h5.25a1 1 0 011 1v2.125a1 1 0 01-1 1h-5.25a1 1 0 01-1-1V1zm6.25 0h-5.25v2.125h5.25V1z"></path><path d="M10.25 2.844h-2.5v-1h2.5v1zM5.125 3.906v1.875c0 .416.07.705.172.91.099.198.241.342.435.453.42.24 1.079.325 2.018.325h2.5v1h-2.5c-.936 0-1.84-.072-2.514-.457a2.045 2.045 0 01-.834-.874c-.19-.382-.277-.835-.277-1.357V3.906h1z"></path></g></svg>`;

  return `<div class="exec-item pl-item" data-action="openPipeline" data-pipeline-id="${esc(p.identifier)}">
    ${pipelineIcon}
    <div class="ei-body">
      <div class="ei-top">
        <span class="ei-name">${esc(p.name)}</span>
      </div>
      ${metaHtml}
      ${tagsHtml}
      ${runHistory.length > 0 ? `<div class="rs-strip">${historySquares}</div>` : ''}
    </div>
    <button class="pl-pin${isPinned ? ' on' : ''}" data-action="togglePipelinePin" data-pipeline-id="${esc(p.identifier)}" title="${isPinned ? 'Unpin' : 'Pin to top'}">📌</button>
  </div>`;
}

// ── History list view ──────────────────────────────────────────────────────
function historyListView(): string {
  const parts: string[] = [];

  // Apply current commit filter if enabled
  let displayList = state.historyList;
  if (state.currentCommitFilter && state.gitCtx?.commitSha) {
    // Use the isCurrentCommit flag that's computed server-side with proper SHA matching
    displayList = state.historyList.filter(item => item.isCurrentCommit === true);
  }

  // Apply sorting
  displayList = [...displayList]; // Clone to avoid mutating original
  if (state.executionsSort === 'recent') {
    displayList.sort((a, b) => b.startTs - a.startTs);
  } else if (state.executionsSort === 'oldest') {
    displayList.sort((a, b) => a.startTs - b.startTs);
  } else if (state.executionsSort === 'duration') {
    displayList.sort((a, b) => {
      const aDur = (a.endTs ?? Date.now()) - a.startTs;
      const bDur = (b.endTs ?? Date.now()) - b.startTs;
      return bDur - aDur; // Longest first
    });
  } else if (state.executionsSort === 'status') {
    const statusOrder = { FAILED: 0, RUNNING: 1, APPROVALWAITING: 2, SUCCESS: 3, ABORTED: 4 };
    displayList.sort((a, b) => {
      const aStatus = a.status.toUpperCase();
      const bStatus = b.status.toUpperCase();
      const aOrder = statusOrder[aStatus as keyof typeof statusOrder] ?? 99;
      const bOrder = statusOrder[bStatus as keyof typeof statusOrder] ?? 99;
      return aOrder - bOrder;
    });
  }

  const totalCount = state.historyTotal || state.historyList.length;

  // Filter toolbar with run count chip
  const allActive = state.historyFilter === 'all' ? ' on' : '';
  const failedActive = state.historyFilter === 'failed' ? ' on' : '';
  const successActive = state.historyFilter === 'success' ? ' on' : '';
  const waitingActive = state.historyFilter === 'waiting' ? ' on' : '';

  // Sort button label
  const sortLabel = state.executionsSort === 'recent' ? 'Most recent'
                  : state.executionsSort === 'oldest' ? 'Oldest'
                  : state.executionsSort === 'duration' ? 'Duration'
                  : state.executionsSort === 'status' ? 'Status'
                  : 'Sort';

  // Find pipeline name if filtered
  const filteredPipelineName = state.filteredPipelineId
    ? state.pipelineList.find(p => p.identifier === state.filteredPipelineId)?.name
    : null;

  // Sort-mode metadata
  const sortMeta: Record<ExecutionsSortMode, { label: string; dir: string }> = {
    recent:   { label: 'Most recent', dir: 'newest ↓' },
    oldest:   { label: 'Oldest first', dir: 'oldest ↑' },
    duration: { label: 'Duration',     dir: 'longest ↓' },
    status:   { label: 'Status',       dir: 'failed ↑' },
  };
  const sortIsDefault = state.executionsSort === 'recent';
  const currentSortLabel = sortMeta[state.executionsSort].label;

  // SVG glyphs — inline, 14px, stroke: currentColor
  const SORT_GLYPHS = {
    recent:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 7 L12 12 L15.5 14"/></svg>',
    oldest:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 7 L12 12 L8.5 14"/></svg>',
    duration: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18 L4 13"/><path d="M10 18 L10 10"/><path d="M16 18 L16 6"/></svg>',
    status:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><circle cx="7" cy="12" r="2.6" fill="currentColor" opacity="0.95"/><circle cx="13" cy="12" r="2.6" fill="currentColor" opacity="0.55"/><circle cx="19" cy="12" r="2.6" fill="currentColor" opacity="0.25"/></svg>',
  };

  const sortOptHtml = (mode: ExecutionsSortMode) => {
    const isSel = state.executionsSort === mode;
    const m = sortMeta[mode];
    return `<button class="hist-sort-opt${isSel ? ' selected' : ''}" data-action="setExecutionsSort" data-sort-mode="${mode}" role="menuitemradio" aria-checked="${isSel}">
      <span class="opt-ico">${SORT_GLYPHS[mode]}</span>
      <span class="opt-lbl">${m.label}</span>
      <span class="opt-dir">${m.dir}</span>
      <svg class="opt-check" width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5 L5 9.5 L10 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>`;
  };

  const commitPillOn = state.currentCommitFilter ? ' on' : '';
  const commitPillDisabled = !state.gitCtx?.commitSha ? ' disabled' : '';

  parts.push(`<div class="hist-toolbar">
    <div class="hist-filters">
      <button class="f-pill${allActive}"     data-action="filterAll">All</button>
      <button class="f-pill${failedActive}"  data-action="filterFailed">✕ Failed</button>
      <button class="f-pill${successActive}" data-action="filterSuccess">✓ Success</button>
      <button class="f-pill${waitingActive}" data-action="filterWaiting">⏱ Waiting</button>
      <button class="f-pill commit-pill${commitPillOn}${commitPillDisabled}"
              data-action="toggleCurrentCommitFilter"
              title="${state.gitCtx?.commitSha ? 'Filter to current commit' : 'No git commit detected'}"
              aria-pressed="${state.currentCommitFilter ? 'true' : 'false'}">
        <span class="check-glyph" aria-hidden="true">
          <svg width="9" height="9" viewBox="0 0 9 9"><path d="M1.5 4.5 L3.5 6.5 L7.5 2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
        <span>Current commit</span>
      </button>
      ${filteredPipelineName ? `<span class="hist-pipeline-filter">
        <span class="hist-pf-label">⚡ ${esc(filteredPipelineName)}</span>
        <button class="hist-pf-clear" data-action="clearPipelineFilter" title="Clear pipeline filter">×</button>
      </span>` : ''}
      <div class="hist-sort-wrap">
        <button class="hist-sort-btn${sortIsDefault ? '' : ' modified'}${state.sortMenuOpen ? ' open' : ''}"
                data-action="toggleSortMenu"
                title="Sort: ${currentSortLabel}"
                aria-haspopup="menu"
                aria-expanded="${state.sortMenuOpen ? 'true' : 'false'}">
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3 L3 10 M3 3 L1.5 5 M3 3 L4.5 5 M9 9 L9 2 M9 9 L7.5 7 M9 9 L10.5 7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>
          ${sortIsDefault ? '' : '<span class="sort-dot" aria-hidden="true"></span>'}
        </button>
        ${state.sortMenuOpen ? `
          <div class="hist-sort-scrim" data-action="closeSortMenu"></div>
          <div class="hist-sort-menu" role="menu" aria-label="Sort executions by" style="top: ${state.sortMenuPos.top}px; left: ${state.sortMenuPos.left}px;">
            <div class="menu-hdr">Sort by</div>
            ${sortOptHtml('recent')}
            ${sortOptHtml('oldest')}
            <div class="menu-div" role="separator"></div>
            ${sortOptHtml('duration')}
            ${sortOptHtml('status')}
          </div>` : ''}
      </div>
      <span class="hist-count-chip"><span class="hc-n">${displayList.length}</span><span class="hc-sep">/</span><span class="hc-total">${totalCount}</span></span>
    </div>
  </div>`);

  // Execution list (scrollable area)
  parts.push(`<div class="exec-list-body">`);

  if (state.loadingExecution) {
    parts.push(`<div class="loading">Loading executions...</div>`);
  } else if (displayList.length === 0) {
    // Special message when current commit filter is on but no match
    if (state.currentCommitFilter && state.gitCtx?.commitSha) {
      const shortSha = state.gitCtx.commitSha.slice(0, 7);
      parts.push(`<div class="empty-history">
        <div class="empty-title">Waiting for pipeline...</div>
        <div class="empty-sub">No executions found for commit ${shortSha}. A pipeline may be queued or starting.</div>
        <div class="spinner-wrap"><span class="spinner">⟳</span></div>
      </div>`);
    } else {
      parts.push(`<div class="empty-history">No executions found</div>`);
    }
  } else {
    for (const item of displayList) {
      parts.push(historyItemRow(item));
    }
  }

  parts.push(`</div>`);

  return parts.join('');
}

// ── History item row ───────────────────────────────────────────────────────
function historyItemRow(item: HistoryItem): string {
  const statusNorm = item.status.toUpperCase();
  const dotClass = statusNorm === 'SUCCESS' ? 'ok'
                 : statusNorm === 'FAILED' ? 'f'
                 : statusNorm === 'RUNNING' || statusNorm === 'ASYNC_WAITING' ? 'r'
                 : statusNorm === 'ABORTED' ? 'ab'
                 : 'ok';

  const badgeClass = statusNorm === 'SUCCESS' ? 'ok'
                   : statusNorm === 'FAILED' ? 'f'
                   : statusNorm === 'RUNNING' || statusNorm === 'ASYNC_WAITING' ? 'r'
                   : statusNorm === 'ABORTED' ? 'ab'
                   : 'ok';

  const badgeText = statusNorm === 'RUNNING' || statusNorm === 'ASYNC_WAITING' ? '↻ Running'
                  : statusNorm === 'SUCCESS' ? 'Success'
                  : statusNorm === 'FAILED' ? 'Failed'
                  : statusNorm === 'ABORTED' ? 'Aborted'
                  : statusNorm === 'APPROVALWAITING' ? 'Approval Waiting'
                  : statusNorm;

  const duration = item.endTs ? dur(item.startTs, item.endTs) : `${Math.floor((Date.now() - item.startTs) / 1000)}s…`;

  const currentClass = item.isCurrentCommit ? ' current' : '';
  const currentTag = item.isCurrentCommit
    ? `<span class="ei-cur-tag">● your commit</span>`
    : '';

  // Module tags
  const modTags: string[] = [];
  const mi = item.moduleInfo as any;
  if (mi?.ci) modTags.push(`<span class="ei-tag et-ci">CI${statusNorm === 'RUNNING' ? ' ▶' : ''}</span>`);
  if (mi?.cd) modTags.push(`<span class="ei-tag et-cd">CD</span>`);
  if (mi?.sto) modTags.push(`<span class="ei-tag et-sto">STO ×${(mi.sto as any).count ?? 0}</span>`);
  if (mi?.ti) {
    const tiData = mi.ti as any;
    const selected = tiData.selected ?? 0;
    const total = tiData.total ?? 0;
    if (total > 0) modTags.push(`<span class="ei-tag et-ti">TI ${selected}/${total}</span>`);
  }
  if (mi?.aida) modTags.push(`<span class="ei-tag et-aida">AIDA</span>`);

  const sha = item.gitSha ? esc(item.gitSha.slice(0, 7)) : '';
  const branch = item.gitBranch ? esc(item.gitBranch) : '';
  const author = item.triggerInfo?.triggeredBy?.identifier || item.triggerInfo?.triggeredBy?.email || '';
  const timeAgo = ago(item.startTs);

  return `<div class="exec-item${currentClass}" data-action="viewExecution" data-exec-id="${esc(item.planExecutionId)}">
    <div class="ei-dot ${dotClass}"></div>
    <div class="ei-body">
      <div class="ei-top">
        <span class="ei-name">${esc(item.name)}</span>
        ${currentTag}
        <span class="ei-badge ${badgeClass}">${badgeText}</span>
        <span class="ei-dur">${duration}</span>
      </div>
      <div class="ei-meta">
        ${sha ? `<span class="ei-sha">${sha}</span>` : ''}
        ${branch ? `<span class="ei-branch">${branch}</span>` : ''}
        ${author ? `<span>${esc(author)}</span>` : ''}
        <span>${timeAgo}</span>
      </div>
      ${modTags.length ? `<div class="ei-tags">${modTags.join('')}</div>` : ''}
    </div>
  </div>`;
}

// ── Pagination bar ─────────────────────────────────────────────────────────
function paginationBar(): string {
  const totalPages = Math.ceil(state.historyTotal / state.historyPageSize);

  // Don't render pagination if only one page
  if (totalPages <= 1) {
    return '';
  }

  const currentPage = state.historyPage;
  const hasPrev = currentPage > 0;
  const hasNext = currentPage < totalPages - 1;

  const pages: string[] = [];

  // Logic: Show more page numbers to make navigation clearer
  // - Show all pages if 10 or fewer
  // - Otherwise: show first 7 pages, ellipsis, last page
  // - Also show current page neighborhood if beyond first 7

  if (totalPages <= 10) {
    // Show all pages if 10 or fewer
    for (let i = 0; i < totalPages; i++) {
      pages.push(`<span class="pg-num${currentPage === i ? ' on' : ''}" data-action="goToPage" data-page="${i}">${i + 1}</span>`);
    }
  } else {
    // Show first 7 pages
    const initialPageCount = Math.min(7, totalPages);
    for (let i = 0; i < initialPageCount; i++) {
      pages.push(`<span class="pg-num${currentPage === i ? ' on' : ''}" data-action="goToPage" data-page="${i}">${i + 1}</span>`);
    }

    // Show current page neighborhood if beyond first 7 pages
    if (currentPage >= 7 && currentPage < totalPages - 1) {
      pages.push(`<span style="font-size:10px;color:#ccc">…</span>`);

      const start = Math.max(7, currentPage - 1);
      const end = Math.min(totalPages - 1, currentPage + 2);

      for (let i = start; i < end; i++) {
        pages.push(`<span class="pg-num${currentPage === i ? ' on' : ''}" data-action="goToPage" data-page="${i}">${i + 1}</span>`);
      }
    }

    // Show ellipsis before last page if needed
    if (currentPage < totalPages - 2 && totalPages > 8) {
      pages.push(`<span style="font-size:10px;color:#ccc">…</span>`);
    }

    // Always show last page
    pages.push(`<span class="pg-num${currentPage === totalPages - 1 ? ' on' : ''}" data-action="goToPage" data-page="${totalPages - 1}">${totalPages}</span>`);
  }

  return `<div class="pag">
    <button class="pg-btn" data-action="prevPage"${hasPrev ? '' : ' disabled'}>←</button>
    ${pages.join('')}
    <button class="pg-btn" data-action="nextPage"${hasNext ? '' : ' disabled'}>→</button>
    <span class="pg-info">Page ${currentPage + 1} / ${totalPages}</span>
  </div>`;
}

function pipelinesPaginationBar(totalPipelines: number): string {
  const totalPages = Math.ceil(totalPipelines / state.pipelinesPageSize);

  // Don't render pagination if only one page
  if (totalPages <= 1) {
    return '';
  }

  const currentPage = state.pipelinesPage;
  const hasPrev = currentPage > 0;
  const hasNext = currentPage < totalPages - 1;

  const pages: string[] = [];

  if (totalPages <= 10) {
    for (let i = 0; i < totalPages; i++) {
      pages.push(`<span class="pg-num${currentPage === i ? ' on' : ''}" data-action="goToPipelinePage" data-page="${i}">${i + 1}</span>`);
    }
  } else {
    const initialPageCount = Math.min(7, totalPages);
    for (let i = 0; i < initialPageCount; i++) {
      pages.push(`<span class="pg-num${currentPage === i ? ' on' : ''}" data-action="goToPipelinePage" data-page="${i}">${i + 1}</span>`);
    }

    if (currentPage >= 7 && currentPage < totalPages - 1) {
      pages.push(`<span style="font-size:10px;color:#ccc">…</span>`);
      const start = Math.max(7, currentPage - 1);
      const end = Math.min(totalPages - 1, currentPage + 2);
      for (let i = start; i < end; i++) {
        pages.push(`<span class="pg-num${currentPage === i ? ' on' : ''}" data-action="goToPipelinePage" data-page="${i}">${i + 1}</span>`);
      }
    }

    if (currentPage < totalPages - 2 && totalPages > 8) {
      pages.push(`<span style="font-size:10px;color:#ccc">…</span>`);
    }

    pages.push(`<span class="pg-num${currentPage === totalPages - 1 ? ' on' : ''}" data-action="goToPipelinePage" data-page="${totalPages - 1}">${totalPages}</span>`);
  }

  return `<div class="pag">
    <button class="pg-btn" data-action="prevPipelinePage"${hasPrev ? '' : ' disabled'}>←</button>
    ${pages.join('')}
    <button class="pg-btn" data-action="nextPipelinePage"${hasNext ? '' : ' disabled'}>→</button>
    <span class="pg-info">Page ${currentPage + 1} / ${totalPages}</span>
  </div>`;
}

// ── History detail view ────────────────────────────────────────────────────
function historyDetailView(): string {
  const parts: string[] = [];

  // Get the execution being viewed
  const ex = state.detailExecId ? state.executions.get(state.detailExecId) : null;

  // Show loading state if execution is being fetched
  if (!ex) {
    parts.push(`<div class="back-bar">
      <div class="back-btn" data-action="backToHistory">← Executions</div>
      <div class="bc"><span>›</span> <span>Loading...</span></div>
    </div>`);

    if (state.loadingExecution) {
      return parts.join('') + `<div class="exec-loading">
        <span class="spinner">⟳</span>
        <span>Loading execution...</span>
      </div>`;
    } else if (state.executionError) {
      return parts.join('') + `<div class="empty-history">
        <div style="color: var(--vscode-errorForeground); font-weight: 600;">Failed to load execution</div>
        <div style="margin-top: 8px; font-size: 12px; opacity: 0.8;">${esc(state.executionError)}</div>
        <div style="margin-top: 12px;">
          <button class="back-btn" data-action="backToHistory" style="padding: 6px 12px; cursor: pointer;">← Back to Executions</button>
        </div>
      </div>`;
    } else {
      return parts.join('') + `<div class="empty-history">Execution not found</div>`;
    }
  }

  // Back navigation bar
  parts.push(`<div class="back-bar">
    <div class="back-btn" data-action="backToHistory">← Executions</div>
    <div class="bc"><span>›</span> <span>${esc(ex.name)}</span></div>
  </div>`);

  // Full execution card (commit info is shown within the card itself)
  parts.push(execCard(ex));

  return parts.join('');
}

// ── Adjacent navigation ────────────────────────────────────────────────────
function adjacentNav(): string {
  // Find current execution index in history list
  const currentIdx = state.historyList.findIndex(item => item.planExecutionId === state.detailExecId);
  if (currentIdx === -1) return '';

  const prevItem = currentIdx > 0 ? state.historyList[currentIdx - 1] : null;
  const nextItem = currentIdx < state.historyList.length - 1 ? state.historyList[currentIdx + 1] : null;

  const prevDisabled = !prevItem ? ' off' : '';
  const nextDisabled = !nextItem ? ' off' : '';

  const prevStatus = prevItem ? prevItem.status.toUpperCase() : '';
  const prevName = prevItem ? prevItem.name : '';
  const prevClass = prevStatus === 'SUCCESS' ? 'ok' : prevStatus === 'FAILED' ? 'f' : '';
  const prevBadge = prevStatus === 'SUCCESS' ? 'Success' : prevStatus === 'FAILED' ? 'Failed' : prevStatus === 'APPROVALWAITING' ? 'Approval Waiting' : prevStatus;
  const prevTooltip = prevItem ? `${prevName} · ${prevBadge}` : '';

  const nextStatus = nextItem ? nextItem.status.toUpperCase() : '';
  const nextName = nextItem ? nextItem.name : '';
  const nextClass = nextStatus === 'SUCCESS' ? 'ok' : nextStatus === 'FAILED' ? 'f' : nextStatus === 'RUNNING' ? 'r' : '';
  const nextBadge = nextStatus === 'SUCCESS' ? 'Success' : nextStatus === 'FAILED' ? 'Failed' : nextStatus === 'RUNNING' ? 'Running' : nextStatus === 'APPROVALWAITING' ? 'Approval Waiting' : nextStatus;
  const nextTooltip = nextItem ? `${nextName} · ${nextBadge}` : '';

  const posInfo = `${currentIdx + 1}/${state.historyList.length}`;

  return `<div class="adj-bar">
    <div class="adj-btn${prevDisabled}"${prevItem ? ` data-action="viewExecution" data-exec-id="${esc(prevItem.planExecutionId)}" title="${esc(prevTooltip)}"` : ''}>
      <span style="color:#bbb;flex-shrink:0">←</span>
      <div style="min-width:0;overflow:hidden;flex:1">
        <span class="adj-lbl">Previous</span>
        <span class="adj-n ${prevClass}">${esc(prevName)} · ${prevBadge}</span>
      </div>
    </div>
    <div class="adj-mid">${posInfo}</div>
    <div class="adj-btn${nextDisabled}"${nextItem ? ` data-action="viewExecution" data-exec-id="${esc(nextItem.planExecutionId)}" title="${esc(nextTooltip)}"` : ''} style="justify-content:flex-end">
      <div style="min-width:0;overflow:hidden;flex:1;text-align:right">
        <span class="adj-lbl" style="text-align:right;display:block">Next</span>
        <span class="adj-n ${nextClass}">${esc(nextName)} · ${nextBadge}</span>
      </div>
      <span style="color:#bbb;flex-shrink:0">→</span>
    </div>
  </div>`;
}

// ── Security tab body ──────────────────────────────────────────────────────
const SHIELD = '<svg width="13" height="13" viewBox="0 0 12 12"><path d="M6 1.5 L10 3 L10 6.2 Q10 9 6 10.5 Q2 9 2 6.2 L2 3 Z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>';
const EXT_LINK = '<svg width="11" height="11" viewBox="0 0 12 12"><path d="M4.5 2 H10 V7.5 M10 2 L5 7 M3 4 V10 H9" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function securityTabBody(ex: ExecState): string {
  const s = ex.stoScan;
  if (!s) {
    return `<div class="tb tb-sec"><div class="sec-skipped">${SHIELD}<div>
      <div class="sec-skipped-t">No security scan</div>
      <div class="sec-skipped-d">This pipeline has no security scan configured.</div>
    </div></div></div>`;
  }

  if (s.skipped) {
    return `<div class="tb tb-sec"><div class="sec-skipped">${SHIELD}<div>
      <div class="sec-skipped-t">Security scan skipped</div>
      <div class="sec-skipped-d">Earlier stage failed — scan did not run on this execution.</div>
    </div></div></div>`;
  }

  const cats: Array<['critical' | 'high' | 'medium' | 'low' | 'info' | 'exempted', string, string]> = [
    ['critical', 'Critical', 'crit'], ['high', 'High', 'high'], ['medium', 'Medium', 'med'],
    ['low', 'Low', 'low'], ['info', 'Info', 'info'], ['exempted', 'Exempted', 'exempt'],
  ];

  let totalFindings = 0, newCount = 0;
  const tiles = cats.map(([id, label, kind]) => {
    const v: SevCount = s[id] ?? { total: 0, new: 0 };
    totalFindings += v.total; newCount += v.new;
    const newBadge = v.new > 0
      ? `<span class="sev-new" title="${v.new} new in this scan"><span class="sev-new-arrow">▲</span>${v.new} new</span>` : '';
    return `<button class="sev sev-${kind} ${v.total === 0 ? 'is-empty' : ''}">
      <span class="sev-top"><span class="sev-lbl">${esc(label)}</span>${newBadge}</span>
      <span class="sev-n">${v.total}</span>
    </button>`;
  }).join('');

  const tools = s.tools.map(t => `<span class="sec-tool">${esc(t)}</span>`).join('');
  const live = s.running ? `<span class="sec-scan-live"><span class="sec-scan-live-dot"></span> scanning…</span>` : '';
  const newTotalRow = newCount > 0
    ? `<div class="sec-total-row sec-total-row-new"><span class="sec-total-l"><span class="sec-new-ic">▲</span>New in this scan</span><span class="sec-total-n sec-total-n-new">${newCount}</span></div>` : '';
  const stoBtn = s.stoUrl
    ? `<a class="sec-sto-btn" data-action="openUrl" data-url="${esc(s.stoUrl)}">${SHIELD}<span class="sec-sto-l">Open in Harness STO</span>${EXT_LINK}</a>`
    : '';

  return `<div class="tb tb-sec">
    <div class="sec-scan-bar">
      <div class="sec-scan-l">${SHIELD}<span class="sec-scan-ttl">Security scan</span>${live}</div>
      <div class="sec-scan-r">${tools}</div>
    </div>
    <div class="sec-grid">${tiles}</div>
    <div class="sec-total">
      <div class="sec-total-row"><span class="sec-total-l">Total findings</span><span class="sec-total-n">${totalFindings}</span></div>
      ${newTotalRow}
    </div>
    ${stoBtn}
    <div class="sec-meta">Scan triggered automatically by this pipeline. Findings include container images, IaC, SCA dependencies, and SAST.</div>
  </div>`;
}

// ── Build (CI) tab ─────────────────────────────────────────────────────────
function parseBuild(ex: ExecState): BuildInfo | null {
  const ci = (ex.moduleInfo as any)?.ci;
  if (!ci) return null;
  const info = ci.ciExecutionInfoDTO ?? {};
  const isPr = info.event === 'pullRequest';
  const src = isPr ? info.pullRequest : info.branch;
  const commits = (src?.commits ?? []).map((c: any) => ({
    sha: String(c.id ?? '').slice(0, 7),
    msg: String(c.message ?? '').split('\n')[0],
    author: c.ownerName || c.ownerEmail || '—',
    link: c.link,
  }));

  const ciInfo = ci.unifiedPipelineExecutionModuleInfo?.pipelineCIInfo ?? {};
  const mapImage = (a: any) => {
    const parts = String(a.imageName ?? '').split('/');
    return {
      name: parts[parts.length - 1] || a.imageName || 'image',
      type: 'docker' as const,
      version: a.tag ?? '—',
      registry: parts.length > 1 ? parts[parts.length - 2] : (a.imageName ?? ''),
      digest: a.digest ? String(a.digest).slice(0, 14) : undefined,
      url: a.url,
    };
  };
  let images = (ciInfo.imageArtifacts ?? []).map(mapImage);

  // Fallback: pull published images from per-step stepArtifacts when the
  // top-level rollup is empty (BuildAndPushDockerRegistry nodes).
  if (images.length === 0 && ex.executionGraph?.nodeMap) {
    for (const node of Object.values(ex.executionGraph.nodeMap) as any[]) {
      const outcomes = node?.outcomes ?? {};
      for (const oc of Object.values(outcomes) as any[]) {
        const published = oc?.stepArtifacts?.publishedImageArtifacts;
        if (Array.isArray(published)) images.push(...published.map(mapImage));
      }
    }
  }

  const sboms = (ciInfo.sbomArtifacts ?? []).map((a: any) => {
    const parts = String(a.imageName ?? a.name ?? '').split('/');
    return {
      name: `${parts[parts.length - 1] || 'artifact'} · SBOM`,
      type: 'sbom' as const,
      version: a.tag ?? '—',
      registry: parts.length > 1 ? parts[parts.length - 2] : '',
    };
  });

  // De-dupe images by name+version (stepArtifacts fallback can repeat the rollup).
  const seen = new Set<string>();
  images = images.filter(i => {
    const key = `${i.name}@${i.version}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    repo: ci.repoName ?? '—',
    branches: { source: ci.branch ?? info.branch?.name ?? '—', dest: isPr ? info.pullRequest?.targetBranch : undefined },
    pr: isPr ? (info.pullRequest?.id ?? info.pullRequest?.number) : undefined,
    commits,
    artifacts: [...images, ...sboms],
  };
}

const GIT_BRANCH_IC = '<svg width="11" height="11" viewBox="0 0 12 12"><path d="M4 2.5 V9.5 M4 4 Q4 6 7 6 Q9 6 9 4" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><circle cx="4" cy="2.2" r="1.1" fill="currentColor"/><circle cx="4" cy="9.8" r="1.1" fill="currentColor"/><circle cx="9" cy="3" r="1.1" fill="currentColor"/></svg>';
const ARTIFACT_IC = '<svg width="11" height="11" viewBox="0 0 12 12"><path d="M6 1.5 L10 3.5 V8 L6 10.5 L2 8 V3.5 Z M2 3.5 L6 5.5 L10 3.5 M6 5.5 V10.5" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg>';

function buildTabBody(ex: ExecState): string {
  const b = parseBuild(ex);
  if (!b) {
    return `<div class="tb tb-build"><div class="sec-skipped">${ARTIFACT_IC}<div>
      <div class="sec-skipped-t">No build info</div>
      <div class="sec-skipped-d">This pipeline has no CI build stage.</div>
    </div></div></div>`;
  }

  const prPill = b.pr
    ? `<span class="tb-pr-inline">#${esc(b.pr)}${b.branches.dest ? ` → ${esc(b.branches.dest)}` : ''}</span>`
    : '';

  const commitRows = b.commits.length
    ? b.commits.map(c => {
        const sha = c.link
          ? `<a class="tb-commit-sha" data-action="openUrl" data-url="${esc(c.link)}">${esc(c.sha)}</a>`
          : `<span class="tb-commit-sha">${esc(c.sha)}</span>`;
        return `<div class="tb-commit">${sha}<span class="tb-commit-msg">${esc(c.msg)}</span><span class="tb-commit-author">${esc(c.author)}</span></div>`;
      }).join('')
    : `<span class="tb-empty-line">No commits</span>`;

  const artRows = b.artifacts.length
    ? b.artifacts.map(a => {
        const sub = [a.registry, a.digest].filter(Boolean).map(x => esc(x as string)).join(' · ');
        const ver = a.version ? `<span class="tb-art-ver">${esc(a.version)}</span>` : '';
        const ext = a.url
          ? `<a class="tb-art-ext" data-action="openUrl" data-url="${esc(a.url)}" aria-label="Open artifact">${EXT_LINK}</a>`
          : '';
        return `<div class="tb-art tb-art-${a.type}${a.failed ? ' is-failed' : ''}">
          <span class="tb-art-ic">${ARTIFACT_IC}</span>
          <div class="tb-art-main">
            <div class="tb-art-top"><span class="tb-art-name">${esc(a.name)}</span>${ver}</div>
            <span class="tb-art-reg">${sub}</span>
          </div>
          ${ext}
        </div>`;
      }).join('')
    : `<span class="tb-empty-line">No artifacts published</span>`;

  return `<div class="tb tb-build">
    <div class="tb-stage">
      <div class="tb-kv"><span class="tb-k">Repository</span><span class="tb-v tb-v-repo"><svg width="11" height="11" viewBox="0 0 12 12" aria-hidden><path d="M3 1.5 L9 1.5 Q10 1.5 10 2.5 L10 10 L3 10 Q2 10 2 9 Q2 8 3 8 L10 8" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg><span class="mono">${esc(b.repo)}</span></span></div>
      <div class="tb-kv"><span class="tb-k">Branch</span><span class="tb-v">${GIT_BRANCH_IC}<span class="mono">${esc(b.branches.source)}</span>${prPill}</span></div>
      <div class="tb-kv tb-kv-stack"><span class="tb-k">Commits${b.commits.length ? ` <span class="tb-k-n">${b.commits.length}</span>` : ''}</span><div class="tb-commits">${commitRows}</div></div>
      <div class="tb-kv tb-kv-stack"><span class="tb-k">Artifacts${b.artifacts.length ? ` <span class="tb-k-n">${b.artifacts.length}</span>` : ''}</span><div class="tb-arts">${artRows}</div></div>
    </div>
  </div>`;
}

// ── Deploy (CD) tab ────────────────────────────────────────────────────────
function parseDeploy(ex: ExecState): DeployStage[] {
  const map = ex.layoutNodeMap ?? {};
  const S: Record<string, DeployStage['status']> = {
    SUCCESS: 'ok', NOTSTARTED: 'pending', NOT_STARTED: 'pending',
    APPROVALWAITING: 'waiting', SKIPPED: 'blocked', FAILED: 'failed',
  };
  return Object.values(map)
    .filter(n => n.module === 'cd' && (n.nodeType === 'Deployment' || !!n.moduleInfo?.cd))
    .map(n => {
      const cd = n.moduleInfo?.cd ?? {};
      const si = cd.serviceInfo, infra = cd.infraExecutionSummary;
      const rawStatus = String(n.status).toUpperCase();
      const status = S[rawStatus] ?? 'pending';
      const blocked = status === 'blocked';
      const skipReason = (n.nodeRunInfo && n.nodeRunInfo.evaluatedCondition === false)
        ? 'Skipped — when condition not met' : undefined;
      return {
        stageId: n.nodeUuid,
        stageName: n.name,
        status, blocked, skipReason,
        services: si ? [{
          name: si.displayName ?? si.identifier ?? 'service',
          identifier: si.identifier,
          version: si.artifacts?.primary?.tag ?? '—',
          kind: si.deploymentType ?? 'Deployment',
          manifests: si.manifestInfo?.paths ?? [],
        }] : [],
        envs: infra ? [{
          name: infra.name ?? infra.identifier ?? 'env',
          infraName: infra.infrastructureName,
          type: infra.type,
          status: rawStatus === 'SUCCESS' ? 'ok' : status,
          deployedAt: n.endTs ? ago(n.endTs) : undefined,
        }] : [],
      };
    });
}

const SVC_IC = '<svg width="12" height="12" viewBox="0 0 14 14"><path d="M7 1.5 L12 4 L7 6.5 L2 4 Z M2 4 L2 10 L7 12.5 L12 10 L12 4 M7 6.5 L7 12.5" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>';

const STAGE_CHIP_LABEL: Record<DeployStage['status'], string> = {
  ok: 'Deployed', pending: 'Pending', waiting: 'Waiting', blocked: 'Skipped', failed: 'Failed',
};

function deployTabBody(ex: ExecState): string {
  const stages = parseDeploy(ex);
  if (!stages.length) {
    return `<div class="tb tb-deploy"><div class="sec-skipped">${GIT_BRANCH_IC}<div>
      <div class="sec-skipped-t">No deploy info</div>
      <div class="sec-skipped-d">This pipeline has no CD deployment stage.</div>
    </div></div></div>`;
  }

  const totalEnv = stages.reduce((t, s) => t + s.envs.length, 0);
  const deployedEnv = stages.reduce((t, s) => t + s.envs.filter(e => e.status === 'ok').length, 0);

  const cards = stages.map(s => {
    const chip = `<span class="tb-stage-chip is-${s.status}">${STAGE_CHIP_LABEL[s.status]}</span>`;
    const skip = s.skipReason ? `<div class="tb-skip">${esc(s.skipReason)}</div>` : '';

    const services = s.services.map(svc => {
      const manifests = (svc.manifests ?? []).length
        ? `<div class="tb-manifests">${svc.manifests!.map(m => `<span class="tb-manifest">${esc(m.split('/').pop() || m)}</span>`).join('')}</div>`
        : '';
      return `<div class="tb-svc">
        <div class="tb-svc-row"><span class="tb-svc-ic">${SVC_IC}</span><span class="tb-svc-name">${esc(svc.name)}</span><span class="tb-svc-kind">${esc(svc.kind)}</span><span class="tb-svc-ver mono">${esc(svc.version)}</span></div>
        ${manifests}
      </div>`;
    }).join('');

    const envs = s.envs.map(e => {
      const meta = [e.type, e.infraName].filter(Boolean).map(x => esc(x as string)).join(' · ');
      const when = e.deployedAt ? `<span class="tb-env-at">${esc(e.deployedAt)}</span>` : '';
      return `<div class="tb-env">
        <span class="tb-env-dot is-${e.status}"></span>
        <span class="tb-env-name">${esc(e.name)}</span>
        <span class="tb-env-meta">${meta}</span>${when}
        <span class="tb-env-ext" aria-label="Open environment">${EXT_LINK}</span>
      </div>`;
    }).join('');

    return `<div class="tb-cd-stage">
      <div class="tb-cd-head"><span class="tb-cd-name">${esc(s.stageName)}</span>${chip}</div>
      ${skip}
      ${services ? `<div class="tb-svcs">${services}</div>` : ''}
      ${envs ? `<div class="tb-envs">${envs}</div>` : ''}
    </div>`;
  }).join('');

  return `<div class="tb tb-deploy">
    <div class="tb-cd-rollup">
      <span class="tb-cd-rollup-l">Stages</span>
      <span class="tb-cd-rollup-n">${stages.length}</span>
      <span class="tb-cd-rollup-sep">·</span>
      <span class="tb-cd-rollup-l">${deployedEnv}/${totalEnv} envs live</span>
    </div>
    ${cards}
  </div>`;
}

// ── Execution card ─────────────────────────────────────────────────────────
function execCard(ex: ExecState): string {
  const isRunning = !ex.isTerminal;
  const stages    = getStages(ex.layoutNodeMap);
  const modKeys   = getModuleKeys(ex.moduleInfo);
  const parts: string[] = [];
  const terminal = TERMINAL_STATUSES_SET.has(ex.status); // Used by both themes

  // ── Enhanced theme: Pipeline card with compact rerun ──
  if (state.webviewTheme === 'enhanced') {
    const MAX_COMMIT_CHARS = 60;

    // Extract git/trigger data from moduleInfo
    const mi = ex.moduleInfo as any;
    const ciDto = mi?.ci?.ciExecutionInfoDTO;
    const pr = ciDto?.pullRequest;
    const prNumber = pr?.id ?? pr?.number ?? '';
    const prTitle = pr?.title ?? '';

    // For PR executions, use PR-specific data
    const branch = mi?.ci?.branch ?? ciDto?.branch?.name ?? '';
    const sourceBranch = pr?.sourceBranch ?? '';
    const targetBranch = pr?.targetBranch ?? branch;

    // Extract commit data - try PR-specific fields first, then regular branch commits
    const commits = ciDto?.pullRequest?.commits ?? ciDto?.branch?.commits ?? [];
    let commitMsg = commits[0]?.message ?? '';
    let commitSha = commits[0]?.id ?? '';

    // Fallback: try other possible locations for PR commits
    if (!commitSha && pr) {
      commitSha = pr.sha ?? pr.headSha ?? pr.headCommit?.sha ?? '';
      commitMsg = pr.headCommit?.message ?? commitMsg;
    }

    const shortSha = commitSha.slice(0, 7);

    const statusClass = ex.status === 'SUCCESS' ? 'ok'
                      : ex.status === 'FAILED' ? 'failed'
                      : ex.status === 'IGNOREFAILED' ? 'waiting'
                      : isRunning ? 'running' : 'waiting';

    // Status icon + label
    const statusIconSvg = ex.status === 'SUCCESS'
      ? '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 6.2 L5 8.5 L9.5 3.8" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>'
      : ex.status === 'FAILED'
      ? '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round"/></svg>'
      : isRunning
      ? '<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeDasharray="6 14" strokeLinecap="round"/></svg>'
      : '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="3" y="2" width="1.5" height="6" fill="currentColor"/><rect x="5.5" y="2" width="1.5" height="6" fill="currentColor"/></svg>';

    const statusLabel = ex.status === 'ASYNC_WAITING' ? 'RUNNING'
                      : ex.status === 'POLICY_EVALUATION_FAILURE' ? 'POLICY BLOCKED'
                      : ex.status;

    // Re-run actions (terminal already declared at function start)
    const extIcon = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3.5 3.5 L8.5 3.5 L8.5 8.5 M8.5 3.5 L3.5 8.5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>';
    const refreshIcon = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M10 6 A4 4 0 1 1 6 2 L8.5 2 M8.5 2 L8.5 4.5 M8.5 2 L6.2 4.2" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>';
    const chevIcon = '<svg width="10" height="10" viewBox="0 0 10 10" style="transform:rotate(90deg)"><path d="M3 2 L6 5 L3 8" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>';

    // Extract first stage identifier for rerun (need YAML identifier, not UUID)
    // Try to get identifier from executionGraph first, then try stage name, fallback to nodeUuid
    let firstStageId = '';
    if (stages.length > 0 && ex.executionGraph?.nodeMap) {
      const firstStageUuid = stages[0].nodeUuid;
      const graphNode = ex.executionGraph.nodeMap[firstStageUuid];
      // Try identifier, then name, then UUID
      firstStageId = graphNode?.identifier || stages[0].name || firstStageUuid;
    } else if (stages.length > 0) {
      // No executionGraph, try stage name
      firstStageId = stages[0].name || stages[0].nodeUuid;
    }

    const stopIcon = '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="3" y="3" width="6" height="6" rx="1" fill="currentColor"/></svg>';
    const rerunButtons = terminal
      ? `<span class="tip-wrap"><button class="pip-ibtn" data-action="rerunPipeline" data-plan-execution-id="${esc(ex.planExecutionId)}" data-pipeline-identifier="${esc(ex.pipelineIdentifier)}" data-first-stage-id="${esc(firstStageId)}" aria-label="Re-run pipeline">${refreshIcon}</button><span class="tip">Re-run pipeline</span></span>
         <button class="pip-ibtn pip-ibtn-more" aria-label="More re-run options" disabled>${chevIcon}</button>`
      : `<span class="tip-wrap"><button class="pip-ibtn pip-ibtn-abort" data-action="abortPipeline" data-plan-execution-id="${esc(ex.planExecutionId)}" aria-label="Abort pipeline">${stopIcon}</button><span class="tip">Abort pipeline</span></span>`;

    const extLink = ex.harnessUrl
      ? `<span class="tip-wrap"><a class="pip-ibtn pip-ibtn-ext" data-action="openUrl" data-url="${esc(ex.harnessUrl)}" aria-label="Open in browser">${extIcon}</a><span class="tip">Open in browser</span></span>`
      : '';

    // Trigger icon (user/clock/branch based on triggerType)
    const triggerType = ex.executionTriggerInfo?.triggerType ?? 'MANUAL';
    const triggerIcon = triggerType.includes('SCHEDULER') || triggerType.includes('CRON')
      ? '<svg width="11" height="11" viewBox="0 0 11 11"><circle cx="5.5" cy="5.5" r="4.5" stroke="currentColor" strokeWidth="0.9" fill="none"/><path d="M5.5 2.5 L5.5 5.5 L7.5 7" stroke="currentColor" strokeWidth="0.9" fill="none" strokeLinecap="round"/></svg>'
      : triggerType.includes('WEBHOOK') || triggerType.includes('GIT')
      ? '<svg width="11" height="11" viewBox="0 0 11 11"><path d="M2 6 L2 3 Q2 2 3 2 L5 2 M9 5 L9 8 Q9 9 8 9 L6 9 M5 2 L7 2 M3 9 L5 9" stroke="currentColor" strokeWidth="0.9" fill="none" strokeLinecap="round"/><circle cx="7" cy="2" r="1" fill="currentColor"/><circle cx="4" cy="9" r="1" fill="currentColor"/></svg>'
      : '<svg width="11" height="11" viewBox="0 0 11 11"><circle cx="5.5" cy="3" r="2.2" stroke="currentColor" strokeWidth="0.9" fill="none"/><path d="M3.5 5 Q2 6 2 7.5 Q2 9 3.5 9 L7.5 9 Q9 9 9 7.5 Q9 6 7.5 5" stroke="currentColor" strokeWidth="0.9" fill="none"/></svg>';

    const triggerName = ex.executionTriggerInfo?.triggeredBy?.identifier
                     || ex.executionTriggerInfo?.triggeredBy?.email
                     || ex.executionTriggerInfo?.triggeredBy?.triggerIdentifier
                     || 'Unknown';

    // Commit icon
    const commitIcon = '<svg width="11" height="11" viewBox="0 0 11 11"><circle cx="5.5" cy="5.5" r="2.5" stroke="currentColor" strokeWidth="0.9" fill="none"/><path d="M1 5.5 L3 5.5 M8 5.5 L10 5.5" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round"/></svg>';

    // Branch icon
    const branchIcon = '<svg width="11" height="11" viewBox="0 0 11 11"><circle cx="3" cy="2" r="1.3" stroke="currentColor" strokeWidth="0.8" fill="none"/><circle cx="3" cy="9" r="1.3" stroke="currentColor" strokeWidth="0.8" fill="none"/><circle cx="8" cy="6" r="1.3" stroke="currentColor" strokeWidth="0.8" fill="none"/><path d="M3 3.3 L3 7.7 M3 5 Q3 6 4 6 L6.7 6" stroke="currentColor" strokeWidth="0.8" fill="none"/></svg>';

    // PR icon
    const prIcon = '<svg width="10" height="10" viewBox="0 0 10 10"><circle cx="2" cy="2" r="1.2" stroke="currentColor" strokeWidth="0.7" fill="none"/><circle cx="2" cy="8" r="1.2" stroke="currentColor" strokeWidth="0.7" fill="none"/><circle cx="8" cy="8" r="1.2" stroke="currentColor" strokeWidth="0.7" fill="none"/><path d="M2 3.2 L2 6.8 M8 6.8 L8 4 Q8 3 7 3 L4 3" stroke="currentColor" strokeWidth="0.7" fill="none"/></svg>';

    // Clock icon
    const clockIcon = '<svg width="10" height="10" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="0.8" fill="none"/><path d="M5 2 L5 5 L7 6.5" stroke="currentColor" strokeWidth="0.8" fill="none" strokeLinecap="round"/></svg>';

    // Build commit message row (with truncation)
    const truncatedCommit = commitMsg.length > MAX_COMMIT_CHARS
      ? commitMsg.slice(0, MAX_COMMIT_CHARS) + '…'
      : commitMsg;
    const commitRow = commitMsg
      ? `<div class="pip-ctx pip-ctx-commit" title="${esc(commitMsg)}">
          ${commitIcon}
          <span class="pip-ctx-txt">${esc(truncatedCommit)}</span>
        </div>`
      : '';

    // Build git context pill (branch · sha · pr chip · time)
    let prUrl = '';
    if (prNumber && ex.harnessUrl) {
      // Extract account from harnessUrl
      const accountMatch = ex.harnessUrl.match(/\/account\/([^/]+)/);
      const account = accountMatch ? accountMatch[1] : '';

      // Get repo name from CI data
      const repoName = mi?.ci?.repoName ?? '';

      // Clean repo name (remove org/project prefixes like "org.", "_project_")
      let cleanRepoName = repoName;
      if (cleanRepoName.startsWith('org.')) {
        cleanRepoName = cleanRepoName.substring(4);
      } else if (cleanRepoName.startsWith('_project_')) {
        cleanRepoName = cleanRepoName.substring(9);
      } else if (cleanRepoName.startsWith('account.')) {
        cleanRepoName = cleanRepoName.substring(8);
      }

      // Build Harness Code PR URL
      if (account && state.org && cleanRepoName) {
        prUrl = `https://app.harness.io/ng/account/${account}/module/code/orgs/${state.org}/repos/${cleanRepoName}/pulls/${prNumber}/conversation`;
      }
    }

    const prChip = prNumber && prUrl
      ? `<a class="pip-ctx-pr" data-action="openUrl" data-url="${esc(prUrl)}" title="${esc(prTitle.length > 100 ? prTitle.slice(0, 100) + '…' : prTitle || `PR #${prNumber}`)}">
          ${prIcon}
          <span>#${esc(prNumber)}</span>
        </a>`
      : (prNumber
          ? `<span class="pip-ctx-pr" title="${esc(prTitle)}">
              ${prIcon}
              <span>#${esc(prNumber)}</span>
            </span>`
          : '');

    const shaLink = shortSha
      ? (ex.commitWebUrl
          ? `<a class="pip-ctx-sha" data-action="openUrl" data-url="${esc(ex.commitWebUrl)}" title="${esc(commitSha)}">${esc(shortSha)}</a>`
          : `<span class="pip-ctx-sha" title="${esc(commitSha)}">${esc(shortSha)}</span>`)
      : '';

    // For PRs, show "sourceBranch → targetBranch" format; otherwise just branch
    const branchDisplay = prNumber && sourceBranch && targetBranch
      ? `<span class="pip-ctx-branch" title="PR: ${esc(sourceBranch)} → ${esc(targetBranch)}">${esc(sourceBranch)} → ${esc(targetBranch)}</span>`
      : `<span class="pip-ctx-branch" title="${esc(branch)}">${esc(branch || 'unknown')}</span>`;

    const gitRow = (branch || shortSha)
      ? `<div class="pip-ctx pip-ctx-git">
          ${branchIcon}
          ${branchDisplay}
          ${shaLink ? `<span class="pip-ctx-sep">·</span>${shaLink}` : ''}
          ${prChip ? `<span class="pip-ctx-sep">·</span>${prChip}` : ''}
          <span class="pip-ctx-git-time">
            ${clockIcon}
            <span>${ago(ex.startTs)}</span>
          </span>
        </div>`
      : '';

    parts.push(`<div class="pip-card is-${statusClass}">
      <div class="pip-bar"></div>
      <div class="pip-body">
        <div class="pip-row">
          <span class="pip-name" title="${esc(ex.planExecutionId)}">${esc(ex.name)}</span>
          <span class="pip-badge is-${statusClass}">
            ${statusIconSvg}
            ${esc(statusLabel)}
          </span>
        </div>
        <div class="pip-meta">
          <span data-start-ts="${ex.startTs}" data-end-ts="${ex.endTs || 0}">${dur(ex.startTs, ex.endTs)}</span>
          <span class="pip-sep">·</span>
          ${triggerIcon}
          <span>by ${esc(triggerName)}</span>
          <span class="pip-acts">
            ${rerunButtons}
            ${extLink}
          </span>
        </div>
        ${commitRow}
        ${gitRow}
      </div>
    </div>`);
  } else {
    // ── Simple theme: Header row with dot + name + badge ──
    const pipelineName = ex.harnessUrl
      ? `<a class="exec-name exec-name-link" data-action="openUrl" data-url="${esc(ex.harnessUrl)}" title="Open in Harness">${esc(ex.name)}</a>`
      : `<span class="exec-name">${esc(ex.name)}</span>`;
    // Extract first stage identifier for rerun (need YAML identifier, not UUID)
    // Try identifier, then name, then UUID
    let firstStageId = '';
    if (stages.length > 0 && ex.executionGraph?.nodeMap) {
      const firstStageUuid = stages[0].nodeUuid;
      const graphNode = ex.executionGraph.nodeMap[firstStageUuid];
      firstStageId = graphNode?.identifier || stages[0].name || firstStageUuid;
    } else if (stages.length > 0) {
      firstStageId = stages[0].name || stages[0].nodeUuid;
    }
    const rerunButton = terminal
      ? `<span class="tip-wrap"><button class="exec-rerun-btn" data-action="rerunPipeline" data-plan-execution-id="${esc(ex.planExecutionId)}" data-pipeline-identifier="${esc(ex.pipelineIdentifier)}" data-first-stage-id="${esc(firstStageId)}" aria-label="Re-run pipeline">↻</button><span class="tip">Re-run pipeline</span></span>`
      : `<span class="tip-wrap"><button class="exec-rerun-btn exec-abort-btn" data-action="abortPipeline" data-plan-execution-id="${esc(ex.planExecutionId)}" aria-label="Abort pipeline">◼</button><span class="tip">Abort pipeline</span></span>`;
    const harnessLink = ex.harnessUrl
      ? `<a class="exec-link" data-action="openUrl" data-url="${esc(ex.harnessUrl)}" title="Open in Harness">↗</a>`
      : '';
    parts.push(`<div class="exec-header">
      <span class="exec-dot ${dotClass(ex.status, ex.endTs)}"></span>
      ${pipelineName}
      ${statusBadge(ex.status)}
      <span class="exec-duration" data-start-ts="${ex.startTs}" data-end-ts="${ex.endTs || 0}">${dur(ex.startTs, ex.endTs)}</span>
      ${rerunButton}
      ${harnessLink}
    </div>`);
  }

  // ── Module tabs (enhanced) or badges (simple) ──
  if (state.webviewTheme === 'enhanced') {
    // Enhanced theme: module tabs for navigation
    const mi = ex.moduleInfo as any;
    const tabs: string[] = [];

    const at = state.activeDetailTab;
    const tabBtn = (tab: string, label: string, badge = '') =>
      `<button class="tab${at === tab ? ' on' : ''}" data-action="switchDetailTab" data-tab="${tab}">${label}${badge}</button>`;

    // Pipeline tab (always visible, default active)
    tabs.push(tabBtn('pipeline', 'Pipeline'));

    // Build tab (CI module)
    if (mi?.ci) {
      tabs.push(tabBtn('ci', 'Build'));
    }

    // Deploy tab (CD module)
    if (mi?.cd) {
      tabs.push(tabBtn('cd', 'Deploy'));
    }

    // Security tab (STO module) — badge shows NEW critical+high (design intent)
    if (mi?.sto || ex.stoScan) {
      const s = ex.stoScan;
      const newCritHigh = s ? s.critical.new + s.high.new : 0;
      const badge = newCritHigh > 0 ? `<span class="tab-badge">${newCritHigh}</span>` : '';
      tabs.push(tabBtn('sec', 'Security', badge));
    }

    // Tests tab (TI module)
    if (mi?.ti || ex.ti) {
      const failCount = ex.ti?.failed || 0;
      const badge = failCount > 0 ? `<span class="tab-badge warn">${failCount}</span>` : '';
      tabs.push(tabBtn('ti', 'Tests', badge));
    }

    if (tabs.length > 1) {
      parts.push(`<div class="tabs">${tabs.join('')}</div>`);
    }

    // Non-pipeline tab bodies — render and skip the pipeline body below.
    if (at === 'sec') {
      parts.push(securityTabBody(ex));
      return parts.join('');
    }
    if (at === 'ci') {
      parts.push(buildTabBody(ex));
      return parts.join('');
    }
    if (at === 'cd') {
      parts.push(deployTabBody(ex));
      return parts.join('');
    }
  } else {
    // Simple theme: module badges
    if (modKeys.length) {
      const mi = ex.moduleInfo as any;
      const badges: string[] = [];
      const pr = mi?.ci?.ciExecutionInfoDTO?.pullRequest;
      if (pr) badges.push(`<span class="mod-badge mod-pr">PR #${esc(pr.id ?? pr.number ?? '')}</span>`);
      const branch = mi?.ci?.branch ?? mi?.ci?.ciExecutionInfoDTO?.branch?.name;
      if (branch) badges.push(`<span class="mod-badge mod-ref">${esc(branch)}</span>`);
      modKeys.forEach(k => badges.push(`<span class="mod-badge mod-${k}">${k.toUpperCase()}</span>`));
      parts.push(`<div class="module-badges">${badges.join('')}</div>`);
    }
  }

  // ── OPA policy summary row ──
  if (ex.opa) parts.push(opaRow(ex));

  // ── Progress bar ── only while running
  if (isRunning) {
    parts.push(`<div class="progress-bar"><div class="fill"></div></div>`);
  }

  // ── Error banner ── (enhanced theme only)
  if (state.webviewTheme === 'enhanced' && ex.status === 'FAILED') {
    const failMsg = getFailureMessage(ex);
    if (failMsg) {
      const warnIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
      parts.push(`<div class="err-banner">
      <span class="err-ic">${warnIcon}</span>
      <div class="err-text">
        <strong>Pipeline failed</strong>
        <span>${esc(failMsg)}</span>
      </div>
    </div>`);
    }
  }

  // ── Stages + steps ──
  if (stages.length) {
    // Recompute default stage expansion (single-focus rule from §7.1)
    recomputeStageDefaults(stages);

    parts.push(`<div class="stages">`);
    for (const stage of stages) {
      const isActive = stage.nodeUuid === ex.activeStageId ||
                       stage.status === 'RUNNING' ||
                       stage.status === 'ASYNC_WAITING';
      const isFailed = stage.status === 'FAILED';
      const isWarning = stage.status === 'IGNOREFAILED';

      // Check if this stage is expanded (§7.1: user intent wins, else use default)
      const stageExpanded = isStageExpanded(stage.nodeUuid);

      // Enhanced theme: stage wrapper with chevron + rail + stat
      if (state.webviewTheme === 'enhanced') {
        const chevRotation = stageExpanded ? '90' : '0';
        const chevIcon = `<svg width="10" height="10" viewBox="0 0 10 10" style="transform:rotate(${chevRotation}deg); transition:transform .15s"><path d="M3 2 L6 5 L3 8" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>`;
        const statusClass = stage.status === 'SUCCESS' ? 'ok'
                          : stage.status === 'FAILED' ? 'failed'
                          : stage.status === 'IGNOREFAILED' ? 'warn'
                          : (stage.status === 'RUNNING' || stage.status === 'ASYNC_WAITING') ? 'running'
                          : stage.status === 'APPROVALWAITING' ? 'waiting'
                          : 'pending';
        const nameClass = stage.status === 'FAILED' ? 'is-failed'
                        : (stage.status === 'RUNNING' || stage.status === 'ASYNC_WAITING') ? 'is-running'
                        : stage.status === 'APPROVALWAITING' ? 'is-waiting'
                        : (!stage.startTs || stage.status === 'NOT_STARTED') ? 'is-pending'
                        : '';

        parts.push(`<div class="stage${isActive ? ' is-active' : ''}${stageExpanded ? ' is-open' : ''}">
          <button class="stage-row" data-action="toggleStage" data-stageid="${esc(stage.nodeUuid)}">
            <span class="stage-chev">${chevIcon}</span>
            <span class="stage-rail is-${statusClass}"></span>
            <span class="stage-stat">${stageIcon(stage.status)}</span>
            <span class="stage-name${nameClass ? ' ' + nameClass : ''}">${esc(stage.name)}</span>
            <span class="stage-dur" data-start-ts="${stage.startTs || 0}" data-end-ts="${stage.endTs || 0}">${dur(stage.startTs, stage.endTs)}</span>
          </button>`);
      } else {
        // Simple theme: flat stage-row (no collapse/expand in simple theme)
        parts.push(`<div class="stage-row${isActive ? ' active' : ''}${isFailed ? ' failed' : ''}${isWarning ? ' warning' : ''}">
          <span class="stage-icon">${stageIcon(stage.status)}</span>
          <span class="stage-name">${esc(stage.name)}</span>
          <span class="stage-dur" data-start-ts="${stage.startTs || 0}" data-end-ts="${stage.endTs || 0}">${dur(stage.startTs, stage.endTs)}</span>
        </div>`);
      }

      // Approval cards are now rendered inside the approval step (not at stage level)
      // See step rendering logic below where isApprovalStep is checked

      // Show steps — §7.1: in enhanced theme, only if stage is expanded
      // In simple theme: same old logic (show for active/terminal/approval)
      const normalizedExecStatus = ex.status.toUpperCase().replace(/\s+/g, '');
      const showSteps = state.webviewTheme === 'enhanced'
        ? stageExpanded  // Enhanced: only show if expanded
        : (isActive || ex.isTerminal || normalizedExecStatus === 'APPROVALWAITING'); // Simple: old logic

      if (showSteps) {
        const steps = getStepsForStage(stage, ex.layoutNodeMap, ex.executionGraph);

        // Enhanced theme: wrap steps in container with tree connector
        if (state.webviewTheme === 'enhanced' && steps.length > 0) {
          parts.push(`<div class="steps">`);
        }

        for (const step of steps) {
          const stepActive   = step.status === 'RUNNING' || step.status === 'ASYNC_WAITING';
          const stepFailed   = step.status === 'FAILED';
          const stepWarning  = step.status === 'IGNOREFAILED';
          const stepLogs     = step.nodeId ? (ex.stepLogs[step.nodeId] ?? []) : [];
          const hasLogs      = stepLogs.length > 0 || (stepActive && ex.logLines.length > 0);

          // Check if this is an approval step
          const isApprovalStep = step.stepType === 'HarnessApproval' || step.stepType === 'HARNESS_APPROVAL';
          const isExternalApprovalStep = step.stepType === 'JiraApproval' || step.stepType === 'ServiceNowApproval';

          // Only show approval card if the step is actively waiting for approval (not completed)
          // Normalize status to handle variations (ApprovalWaiting, APPROVALWAITING, etc.)
          const normalizedStatus = step.status.toUpperCase().replace(/\s+/g, '');
          const isWaitingForApproval = normalizedStatus === 'APPROVALWAITING' ||
                                       normalizedStatus === 'ASYNCWAITING' ||
                                       normalizedStatus === 'RUNNING';
          const hasApprovalCard = ((isApprovalStep && ex.approval && !ex.isTerminal) ||
                                   (isExternalApprovalStep && ex.externalApproval && !ex.isTerminal)) &&
                                   isWaitingForApproval;

          // Auto-expand approval steps to show the approval card
          const isExpanded   = step.nodeId ? (state.expandedNodes.has(step.nodeId) || hasApprovalCard) : false;
          const isLoading    = step.nodeId ? state.loadingSteps.has(step.nodeId) : false;
          const canExpand    = step.logBaseKey || hasLogs || hasApprovalCard;  // Approval steps are expandable
          const toggleIcon   = isLoading ? '⟳' : canExpand ? (isExpanded ? '▾' : '▸') : '';
          const nodeAttr     = step.nodeId ? ` data-nodeid="${esc(step.nodeId)}"` : '';
          const logKeyAttr   = step.logBaseKey ? ` data-logbasekey="${esc(step.logBaseKey)}"` : '';
          const clickable    = canExpand ? ' step-clickable' : '';

          // Add metadata attributes for expanded log viewer
          const stepNameAttr = ` data-stepname="${esc(step.name)}"`;
          const stageNameAttr = ` data-stagename="${esc(stage.name)}"`;
          const pipelineNameAttr = ` data-pipelinename="${esc(ex.name)}"`;
          const planIdAttr = ` data-planexecutionid="${esc(ex.planExecutionId)}"`;
          const statusAttr = ` data-status="${esc(step.status)}"`;
          const durationMs = (step.startTs && step.endTs) ? (step.endTs - step.startTs) : 0;
          const durationAttr = ` data-durationms="${durationMs}"`;

          // Enhanced theme: status classes and external link icon
          if (state.webviewTheme === 'enhanced') {
            const extIcon = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M3 3 L7 3 L7 7 M7 3 L3 7" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>';
            const stepStatusClass = step.status === 'FAILED' ? 'is-failed'
                                  : step.status === 'IGNOREFAILED' ? 'is-failed'
                                  : (!step.startTs || step.status === 'NOT_STARTED') ? 'is-pending'
                                  : '';

            parts.push(`<button class="step-row${isExpanded ? ' on' : ''}${stepStatusClass ? ' ' + stepStatusClass : ''}${clickable}" data-action="toggleStep"${nodeAttr}${logKeyAttr}${stepNameAttr}${stageNameAttr}${pipelineNameAttr}${planIdAttr}${statusAttr}${durationAttr}>
              <span class="step-stat">${stageIcon(step.status)}</span>
              <span class="step-name">${esc(step.name)}</span>
              <span class="step-dur" data-start-ts="${step.startTs || 0}" data-end-ts="${step.endTs || 0}">${dur(step.startTs, step.endTs)}</span>
              ${canExpand ? `<span class="tip-wrap"><span class="step-ext">${extIcon}</span><span class="tip">View step logs</span></span>` : ''}
            </button>`);
          } else {
            // Simple theme
            const showExtIcon = state.logViewerVariation === 'expanded' && canExpand;
            const extIcon = showExtIcon ? '<span class="tip-wrap"><span class="step-ext-ic">↗</span><span class="tip">View step logs</span></span>' : '';

            parts.push(`<div class="step-row${stepActive ? ' step-running' : ''}${stepFailed ? ' failed' : ''}${stepWarning ? ' warning' : ''}${clickable}" data-action="toggleStep"${nodeAttr}${logKeyAttr}${stepNameAttr}${stageNameAttr}${pipelineNameAttr}${planIdAttr}${statusAttr}${durationAttr}>
              <span class="step-toggle${isLoading ? ' step-loading' : ''}">${toggleIcon}</span>
              <span class="step-icon">${stageIcon(step.status)}</span>
              <span class="step-name">${esc(step.name)}${extIcon}</span>
              <span class="step-dur" data-start-ts="${step.startTs || 0}" data-end-ts="${step.endTs || 0}">${dur(step.startTs, step.endTs)}</span>
            </div>`);
          }

          if (isApprovalStep && ex.approval && !ex.isTerminal && isWaitingForApproval) {
            // Render Harness approval card inside the approval step (only if actively waiting)
            parts.push(approvalCard(ex.approval, ex.harnessUrl));
          } else if (isExternalApprovalStep && ex.externalApproval && !ex.isTerminal && isWaitingForApproval) {
            // Render external approval card inside the approval step (only if actively waiting)
            parts.push(externalApprovalCard(ex.externalApproval));
          } else if (isExpanded) {
            // Regular log display for non-approval steps
            if (isLoading) {
              // Show loading spinner while fetching logs
              parts.push(`<div class="log-tail">
                <div class="log-loading">
                  <span class="spinner">⟳</span>
                  <span>Loading logs...</span>
                </div>
              </div>`);
            } else if (hasLogs) {
              const lines = stepLogs.length > 0 ? stepLogs : ex.logLines;
              parts.push(`<div class="log-tail">`);
              for (const line of lines) {
                const cls = /error|ERR|FAIL/i.test(line) ? ' log-error'
                          : /warn|WARN/i.test(line)       ? ' log-warn'
                          : /✓|→ 2\d\d/i.test(line)       ? ' log-ok'
                          : '';
                parts.push(`<div class="log-line${cls}">${esc(line)}</div>`);
              }
              parts.push(`</div>`);
            } else if (step.nodeId && state.stepsOpenedInTab.has(step.nodeId)) {
              // Logs were opened in editor tab
              parts.push(`<div class="log-unavailable">✓ Logs opened in editor tab</div>`);
            } else if (ex.logsUnavailable) {
              parts.push(`<div class="log-unavailable">Logs unavailable — enable feature flag <code>SPG_LOG_SERVICE_ENABLE_DOWNLOAD_LOGS</code> in Harness support.</div>`);
            } else if (stepActive) {
              parts.push(`<div class="log-unavailable">Fetching logs…</div>`);
            } else {
              // Show retry button for steps that have logBaseKey
              const retryBtn = step.logBaseKey && step.nodeId
                ? ` <button class="log-retry-btn" data-action="retryLogs" data-nodeid="${esc(step.nodeId)}" data-logbasekey="${esc(step.logBaseKey)}">↻ Retry</button>`
                : '';
              parts.push(`<div class="log-unavailable">No logs available${retryBtn}</div>`);
            }
          }
        }

        // Enhanced theme: close steps wrapper
        if (state.webviewTheme === 'enhanced' && steps.length > 0) {
          parts.push(`</div>`); // close .steps
        }
      }

      // Enhanced theme: close stage wrapper
      if (state.webviewTheme === 'enhanced') {
        parts.push(`</div>`); // close .stage
      }
    }
    parts.push(`</div>`); // close .stages
  }

  // ── AIDA inline card (below failed stage) ──
  if (ex.aida) {
    parts.push(`<div class="aida-card">
      <div class="aida-header">
        <span class="aida-diamond">◆</span>
        <span class="aida-title">AIDA Root Cause — ${esc(ex.aida.stageId)}</span>
      </div>
      <div class="aida-body">${esc(ex.aida.cause ?? ex.aida.summary ?? 'Analysing...')}</div>
      ${ex.aida.deepDiveUrl
        ? `<a class="link" data-action="openUrl" data-url="${esc(ex.aida.deepDiveUrl)}">Ask AIDA ↗</a>`
        : ''}
    </div>`);
  }

  // ── Footer: refresh button ──
  if (ex.isTerminal) {
    parts.push(`<div class="exec-footer">
      <button class="refresh-btn" data-action="refresh">↺ Refresh</button>
    </div>`);
  }

  return parts.join('');
}

// ── Module summary grid ────────────────────────────────────────────────────
function moduleSummary(ex: ExecState): string {
  const cells: string[] = [];

  if (ex.sto) {
    const v = ex.sto.count === 0
      ? `<span class="mod-ok">No findings</span>`
      : [
          ex.sto.critical ? `<span class="mod-error">${ex.sto.critical} CRIT</span>` : '',
          ex.sto.high     ? `<span class="mod-error">${ex.sto.high} HIGH</span>`     : '',
          ex.sto.medium   ? `<span class="mod-warn">${ex.sto.medium} MED</span>`     : '',
        ].filter(Boolean).join(' · ');
    cells.push(cell('STO · PREV RUN', v, 'openProblems'));
  }

  if (ex.ti) {
    const v = ex.ti.failed
      ? `<span class="mod-error">${ex.ti.failed} failed</span> · <span class="mod-dim">${ex.ti.selected || ex.ti.total} sel</span>`
      : `<span class="mod-ok">passed</span> · <span class="mod-dim">${ex.ti.selected || ex.ti.total} sel</span>`;
    const flaky = ex.ti.flaky ? ` <span class="mod-warn">${ex.ti.flaky} flaky</span>` : '';
    cells.push(cell('TI · PREV RUN', v + flaky, 'openProblems'));
  }

  if (ex.cd && Array.isArray(ex.cd) && ex.cd.length) {
    const envs = ex.cd.map(d => {
      const icon = d.status === 'SUCCESS' ? `<span class="mod-ok">✓</span>`
                 : d.status === 'FAILED'  ? `<span class="mod-error">✗</span>`
                 : `<span class="mod-warn">⟳</span>`;
      return `${esc(d.environment.slice(0, 3))} ${icon}`;
    }).join(' ');
    cells.push(cell('CD · LAST MERGE', envs, ''));
  }

  if (ex.cost?.totalCost != null) {
    const pct = ex.cost.branchAvgCost
      ? ` · <span class="mod-dim">${ex.cost.totalCost <= ex.cost.branchAvgCost ? '−' : '+'}${Math.abs(Math.round((1 - ex.cost.totalCost / ex.cost.branchAvgCost) * 100))}% avg</span>`
      : '';
    cells.push(cell('CCM · PREV RUN', `<span class="mod-blue">$${ex.cost.totalCost.toFixed(2)}</span>${pct}`, ''));
  }

  if (ex.ssca && ex.ssca.flagged > 0) {
    cells.push(cell('SSCA · PREV RUN', `<span class="mod-warn">${ex.ssca.flagged} components flagged in diff</span>`, 'openProblems'));
  }

  if (!cells.length) return '';
  // Pad to even number for grid
  if (cells.length % 2 !== 0) cells.push(`<div class="module-cell"></div>`);
  return `<div class="module-grid">${cells.join('')}</div>`;
}

function cell(label: string, value: string, action: string): string {
  return `<div class="module-cell"${action ? ` data-action="${action}"` : ''}>
    <div class="module-cell-label">${esc(label)}</div>
    <div class="module-cell-value">${value}</div>
  </div>`;
}

function aidaCard(ex: ExecState): string {
  const a = ex.aida!;
  return `<div class="aida-card">
    <div class="aida-header">
      <span class="aida-diamond">◆</span>
      <span class="aida-title">Root cause — stage: ${esc(a.stageId)}</span>
    </div>
    <div class="aida-body">${esc(a.cause ?? a.summary ?? 'Analysing failure...')}</div>
    ${a.deepDiveUrl ? `<a class="link" data-action="openUrl" data-url="${esc(a.deepDiveUrl)}">Ask AIDA ↗</a>` : ''}
  </div>`;
}

function approvalCard(a: NonNullable<ExecState['approval']>, harnessUrl?: string): string {
  const who: string[] = [];
  if (a.userGroups?.length)  who.push(...a.userGroups);
  if (a.approvers?.length)   who.push(...a.approvers);

  if (state.webviewTheme === 'enhanced') {
    const shieldIcon = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 1 L10 2.5 L10 6 Q10 9 6 11 Q2 9 2 6 L2 2.5 Z" stroke="currentColor" strokeWidth="1.1" fill="none" strokeLinejoin="round"/></svg>';
    const checkIcon = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 6.2 L5 8.5 L9.5 3.8" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>';
    const xIcon = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 3 L9 9 M9 3 L3 9" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round"/></svg>';

    const groupsHtml = who.length
      ? who.map(w => `<span class="approval-chip">${esc(w)}</span>`).join('')
      : '';

    const countHtml = a.minimumCount && a.minimumCount > 1
      ? `<span class="approval-count">0 of ${a.minimumCount}</span>`
      : '';

    const actionsHtml = a.canApprove !== false
      ? `<div class="approval-acts">
          <button class="btn-approve" data-action="approve" data-id="${esc(a.planExecutionId)}">${checkIcon} Approve</button>
          <button class="btn-reject" data-action="reject" data-id="${esc(a.planExecutionId)}">${xIcon} Reject</button>
        </div>`
      : `<div style="padding: 6px 10px; font-size: 11px; color: var(--fg-2); font-style: italic;">You are not in the approver list for this step.</div>`;

    return `<div class="approval">
      <div class="approval-hdr">
        ${shieldIcon}
        <span>APPROVAL REQUIRED</span>
        ${countHtml}
      </div>
      <div class="approval-body">
        ${groupsHtml ? `<div class="approval-groups">${groupsHtml}</div>` : ''}
        ${actionsHtml}
      </div>
    </div>`;
  }

  // Simple theme
  const whoHtml = who.length
    ? who.map(w => `<span class="approval-who-tag">${esc(w)}</span>`).join('')
    : '<span class="approval-who-none">Anyone with permission</span>';

  const minHtml = a.minimumCount && a.minimumCount > 1
    ? `<span class="approval-min">${a.minimumCount} approvals required</span>`
    : '';

  const deadlineHtml = a.deadline
    ? `<span class="approval-deadline">Expires ${ago(a.deadline)}</span>`
    : '';

  const approvalUrl = harnessUrl ? harnessUrl.replace(/\/pipeline$/, '') : undefined;
  const openLink = approvalUrl
    ? `<a class="approval-open-link" data-action="openUrl" data-url="${esc(approvalUrl)}">Open in Harness to approve ↗</a>`
    : '';

  const actionsHtml = a.canApprove !== false
    ? `<div class="approval-actions">
        <button class="approval-btn approval-approve" data-action="approve" data-id="${esc(a.planExecutionId)}">✓ Approve</button>
        <button class="approval-btn approval-reject"  data-action="reject"  data-id="${esc(a.planExecutionId)}">✕ Reject</button>
      </div>`
    : `<div class="approval-no-permission">You are not in the approver list for this step.</div>`;

  return `<div class="approval-card">
    <div class="approval-header">
      <span class="approval-icon">⏳</span>
      <span class="approval-title">Waiting for Approval</span>
      ${deadlineHtml}
    </div>
    <div class="approval-who">${whoHtml}${minHtml}</div>
    ${actionsHtml}
    ${openLink}
  </div>`;
}

function externalApprovalCard(a: NonNullable<ExecState['externalApproval']>): string {
  const icon = a.approvalType === 'Jira' ? '🎫' : '📋';
  const ticketLink = a.ticketUrl
    ? `<a class="approval-open-link" data-action="openUrl" data-url="${esc(a.ticketUrl)}">${esc(a.ticketId)} ↗</a>`
    : `<span class="approval-ticket-id">${esc(a.ticketId)}</span>`;

  const metaInfo: string[] = [];
  if (a.approvalType === 'Jira') {
    if (a.projectKey) metaInfo.push(`<span class="approval-meta">Project: ${esc(a.projectKey)}</span>`);
    if (a.issueType)  metaInfo.push(`<span class="approval-meta">Type: ${esc(a.issueType)}</span>`);
  } else if (a.approvalType === 'ServiceNow') {
    if (a.ticketType) metaInfo.push(`<span class="approval-meta">Type: ${esc(a.ticketType)}</span>`);
  }

  const criteriaHtml = a.approvalCriteria
    ? `<div class="approval-criteria">
        <span class="approval-criteria-label">Approval condition:</span>
        <span class="approval-criteria-value">${esc(a.approvalCriteria)}</span>
      </div>`
    : '';

  const rejectionHtml = a.rejectionCriteria
    ? `<div class="approval-criteria">
        <span class="approval-criteria-label">Rejection condition:</span>
        <span class="approval-criteria-value">${esc(a.rejectionCriteria)}</span>
      </div>`
    : '';

  return `<div class="approval-card external-approval-card">
    <div class="approval-header">
      <span class="approval-icon">${icon}</span>
      <span class="approval-title">Waiting for ${esc(a.approvalType)} Approval</span>
    </div>
    <div class="approval-ticket">
      <span class="approval-ticket-label">Ticket:</span>
      ${ticketLink}
    </div>
    ${metaInfo.length ? `<div class="approval-meta-row">${metaInfo.join(' · ')}</div>` : ''}
    ${criteriaHtml}
    ${rejectionHtml}
    <div class="approval-external-note">Update the ticket in ${esc(a.approvalType)} to proceed</div>
  </div>`;
}

function opaRow(ex: ExecState): string {
  const o = ex.opa!;
  const details = o.details ?? [];
  const success = details.filter(d => d.status?.toUpperCase() === 'PASS' || d.status?.toUpperCase() === 'SUCCESS').length;
  const warn    = details.filter(d => d.status?.toUpperCase() === 'WARNING' || d.status?.toUpperCase() === 'WARN').length;
  const error   = details.filter(d => d.status?.toUpperCase() === 'ERROR' || d.status?.toUpperCase() === 'FAIL' || d.status?.toUpperCase() === 'FAILURE').length;
  const total   = details.length;

  const counts: string[] = [];
  if (total === 0) {
    counts.push(`<span class="opa-count-dim">No evaluations</span>`);
  } else {
    if (success) counts.push(`<span class="opa-count-ok">${success} passed</span>`);
    if (warn)    counts.push(`<span class="opa-count-warn">${warn} warning${warn > 1 ? 's' : ''}</span>`);
    if (error)   counts.push(`<span class="opa-count-error">${error} error${error > 1 ? 's' : ''}</span>`);
  }

  // HTML tooltip — one row per policy entry
  const tooltipRows = details.map(d => {
    const st = (d.status ?? '').toUpperCase();
    const icon  = st === 'PASS' || st === 'SUCCESS' ? '✓'
                : st === 'WARNING' || st === 'WARN'  ? '⚠'
                : '×';
    const cls   = st === 'PASS' || st === 'SUCCESS' ? 'opa-tt-ok'
                : st === 'WARNING' || st === 'WARN'  ? 'opa-tt-warn'
                : 'opa-tt-error';
    const msgs  = (d.denyMessages ?? []).map(m => `<div class="opa-tt-msg">${esc(m)}</div>`).join('');
    return `<div class="opa-tt-row">
      <span class="${cls} opa-tt-icon">${icon}</span>
      <div class="opa-tt-body">
        <div class="opa-tt-name">${esc(d.policyName ?? 'Policy')}</div>
        ${msgs}
      </div>
    </div>`;
  }).join('');

  const tooltip = details.length
    ? `<div class="opa-tooltip"><div class="opa-tt-header">Policy Evaluations</div>${tooltipRows}</div>`
    : '';

  const url = o.policyUrl ?? ex.harnessUrl;
  const link = url ? `<span class="tip-wrap"><a class="opa-link" data-action="openUrl" data-url="${esc(url)}">↗</a><span class="tip">View policy evaluations</span></span>` : '';

  return `<div class="opa-row">
    <span class="opa-row-label">Policy Evaluations</span>
    <span class="opa-tooltip-anchor">
      <span class="opa-row-counts">${counts.join('<span class="opa-sep"> · </span>')}</span>
      ${tooltip}
    </span>
    ${link}
  </div>`;
}

function notConfigured(): string {
  // If env vars are all present, show Panel A (choice between env vs manual)
  if (state.envDetection?.allPresent) {
    return renderPanelA();
  }

  // If disclosure is open, show Panel E (instructions)
  if (state.envDisclosureOpen) {
    return renderPanelE();
  }

  // Otherwise, show Panel D (existing setup screen) with disclosure link
  return renderPanelD();
}

function renderPanelA(): string {
  const isEnv = state.envOnboardingChoice === 'env';
  const isPat = state.envOnboardingChoice === 'pat';
  const buttonLabel = isEnv ? 'Connect with env vars' : 'Start setup';
  const buttonAction = isEnv ? 'connectWithEnv' : 'configure';

  return `<div class="onboarding-empty">
    <!-- Title row with logo tile -->
    <div style="display:flex;gap:10px;margin-bottom:14px;align-items:flex-start">
      <div style="width:38px;height:38px;border-radius:10px;background:var(--accent-soft);border:1px solid var(--accent-ring);display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <svg width="22" height="22" viewBox="0 0 124 124" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M103.948 42.1496L75.6373 13.6339C72.2845 10.4453 68.291 8.01733 63.9263 6.51369C54.2541 3.27405 44.6282 5.80282 36.8325 13.6339L8.45273 42.1496C5.28327 45.5226 2.86981 49.5401 1.37519 53.9313C-1.85662 63.662 0.657009 73.3457 8.45273 81.1768L36.7977 109.693C40.1449 112.882 44.135 115.311 48.4971 116.813C51.1397 117.712 53.9086 118.176 56.6981 118.188C63.4976 118.188 70.0076 115.298 75.5909 109.693L103.924 81.1768C107.098 77.8053 109.515 73.7875 111.013 69.3954C114.234 59.6647 111.72 49.9926 103.924 42.1496H103.948ZM58.3777 21.9078C60.5191 22.5984 62.4922 23.734 64.1695 25.2407L72.5443 33.6777L56.2117 50.0972L39.8788 33.6661L48.3 25.1824C50.5588 22.9217 53.7442 20.5211 58.4009 21.8961L58.3777 21.9078ZM16.7002 59.4551C17.3889 57.2992 18.5217 55.314 20.0247 53.6284L28.3996 45.203L44.7323 61.6342L28.388 78.0654L19.9668 69.5818C17.708 67.321 15.3334 64.1163 16.6886 59.4317L16.7002 59.4551ZM54.0225 101.384C51.8784 100.699 49.9039 99.5633 48.2307 98.051L39.8788 89.719L56.2117 73.2759L72.5443 89.7071L64.1231 98.191C61.8643 100.452 58.6905 102.852 54.0225 101.477V101.384ZM95.7231 63.9183C95.0346 66.0715 93.9061 68.0565 92.4102 69.745L84.0353 78.0654L67.7024 61.6342L84.0353 45.203L92.4565 53.675C94.7153 55.9356 97.09 59.1403 95.7347 63.8249" fill="#00ADE4"/>
        </svg>
      </div>
      <div style="display:flex;flex-direction:column">
        <div style="font-size:13px;font-weight:600;color:var(--fg-0);line-height:1.3">Connect to Harness</div>
        <div style="font-size:11px;color:var(--fg-2);line-height:1.3">How would you like to sign in?</div>
      </div>
    </div>

    <!-- Detected banner -->
    <div style="padding:9px 11px;background:var(--bg-2);border:1px solid var(--line);border-radius:var(--r);margin-bottom:14px;font-size:11px;line-height:1.5;color:var(--fg-1)">
      <strong style="color:var(--fg-0)">Environment variables detected.</strong> We can use them directly — nothing gets stored or copied.
    </div>

    <!-- Choice card 1 (env) -->
    <div data-action="selectEnvChoice" data-choice="env" style="border:1px solid ${isEnv ? 'var(--accent)' : 'var(--line)'};background:${isEnv ? 'var(--accent-soft)' : 'var(--bg-2)'};border-radius:var(--r-lg);padding:11px 12px;margin-bottom:10px;cursor:pointer;transition:all 100ms ease">
      <div style="font-size:12px;font-weight:600;color:var(--fg-0);margin-bottom:2px">Use environment variables</div>
      <div style="font-size:11px;color:var(--fg-2);line-height:1.45">Reads <code style="font-family:var(--font-mono);background:var(--bg-3);padding:1px 4px;border-radius:3px;color:var(--fg-2)">HARNESS_API_KEY</code>, <code style="font-family:var(--font-mono);background:var(--bg-3);padding:1px 4px;border-radius:3px;color:var(--fg-2)">HARNESS_BASE_URL</code> and <code style="font-family:var(--font-mono);background:var(--bg-3);padding:1px 4px;border-radius:3px;color:var(--fg-2)">HARNESS_ACCOUNT_ID</code> from your shell.</div>
    </div>

    <!-- Choice card 2 (manual) -->
    <div data-action="selectEnvChoice" data-choice="pat" style="border:1px solid ${isPat ? 'var(--accent)' : 'var(--line)'};background:${isPat ? 'var(--accent-soft)' : 'var(--bg-2)'};border-radius:var(--r-lg);padding:11px 12px;margin-bottom:14px;cursor:pointer;transition:all 100ms ease">
      <div style="font-size:12px;font-weight:600;color:var(--fg-0);margin-bottom:2px">Set up manually</div>
      <div style="font-size:11px;color:var(--fg-2);line-height:1.45">Enter a Personal Access Token and Account ID. Stored in IDE secret storage.</div>
    </div>

    <!-- Primary button -->
    <button style="width:100%;padding:8px 14px;background:var(--accent);color:#0E1013;border:none;border-radius:var(--r);font-family:var(--font-sans);font-size:11.5px;font-weight:600;letter-spacing:0.1px;cursor:pointer;margin-bottom:12px" data-action="${buttonAction}" onmouseover="this.style.filter='brightness(1.08)'" onmouseout="this.style.filter=''" onmousedown="this.style.filter='brightness(0.95)'" onmouseup="this.style.filter='brightness(1.08)'">${buttonLabel}</button>

    <!-- Switch-later hint -->
    <div style="font-size:10.5px;color:var(--fg-2);text-align:center;line-height:1.5">
      You can switch later via <code style="font-family:var(--font-mono);color:var(--fg-2)">Harness: Configure Access</code>.
    </div>
  </div>`;
}

function renderPanelE(): string {
  const hasVars = state.envDetection?.allPresent ?? false;
  const statusText = hasVars
    ? '<strong style="color:var(--fg-0)">All detected.</strong> Click Connect below to proceed.'
    : '<strong style="color:var(--fg-0)">None detected yet.</strong> After exporting, click reload below — or run <code style="font-family:var(--font-mono);color:var(--accent)">Developer: Reload Window</code>.';

  return `<div class="onboarding-empty">
    <!-- Back link -->
    <div style="margin-bottom:14px">
      <a href="#" data-action="closeEnvDisclosure" style="font-size:11px;color:var(--accent);text-decoration:none;cursor:pointer">← Back</a>
    </div>

    <!-- Heading -->
    <div style="font-size:13px;font-weight:600;color:var(--fg-0);margin-bottom:10px">Use <code style="font-family:var(--font-mono);background:var(--bg-3);padding:1px 5px;border-radius:3px;color:var(--fg-2);font-size:12px">HARNESS_*</code> environment variables</div>

    <!-- Intro -->
    <div style="font-size:11.5px;color:var(--fg-2);line-height:1.55;margin-bottom:14px">
      The Harness Extension supports these three variables. Set them in your shell profile, then reload the IDE window and we'll pick them up automatically.
    </div>

    <!-- Code block -->
    <div style="background:var(--bg-2);border:1px solid var(--line);border-radius:var(--r-lg);padding:11px 12px;margin-bottom:12px;font-family:var(--font-mono);font-size:10.5px;color:var(--fg-1);line-height:1.7;position:relative">
      <div>export HARNESS_BASE_URL=https://app.harness.io</div>
      <div>export HARNESS_API_KEY=pat.xxxxx</div>
      <div>export HARNESS_ACCOUNT_ID=xxxxx</div>
      <button data-action="copyEnvVars" style="position:absolute;top:8px;right:8px;padding:4px 8px;background:var(--bg-3);border:1px solid var(--line);border-radius:4px;font-family:var(--font-sans);font-size:10px;font-weight:500;color:var(--fg-1);cursor:pointer" onmouseover="this.style.background='var(--bg-4)'" onmouseout="this.style.background='var(--bg-3)'">Copy</button>
    </div>

    <!-- Status block -->
    <div style="padding:9px 11px;background:var(--bg-2);border:1px solid var(--line);border-radius:var(--r);margin-bottom:12px;font-size:11px;line-height:1.5;color:var(--fg-1)">
      ${statusText}
    </div>

    <!-- Reload button -->
    <button style="width:100%;padding:8px 14px;background:var(--accent);color:#0E1013;border:none;border-radius:var(--r);font-family:var(--font-sans);font-size:11.5px;font-weight:600;letter-spacing:0.1px;cursor:pointer;margin-bottom:14px" data-action="reloadWindowEnv" onmouseover="this.style.filter='brightness(1.08)'" onmouseout="this.style.filter=''" onmousedown="this.style.filter='brightness(0.95)'" onmouseup="this.style.filter='brightness(1.08)'">Reload window and re-check</button>

    <!-- About card -->
    <div style="padding:10px 12px;background:var(--bg-2);border:1px solid var(--line);border-radius:var(--r);display:flex;flex-direction:column;gap:4px">
      <div style="font-size:11px;font-weight:600;color:var(--fg-0)">About env vars</div>
      <div style="font-size:10.5px;color:var(--fg-2);line-height:1.5">Vars are read once per session and never written to disk. The PAT setup path stores your token in IDE secret storage — both are equally secure, just different lifetimes.</div>
    </div>
  </div>`;
}

function renderPanelD(): string {
  // Shield icon for footnote (11x11)
  const shieldIcon = `<svg width="11" height="11" viewBox="0 0 12 12" style="flex-shrink:0;margin-top:1px">
    <path d="M6 1.5 L10 3 L10 6.2 Q10 9 6 10.5 Q2 9 2 6.2 L2 3 Z"
          stroke="currentColor" stroke-width="1.1" fill="none" stroke-linejoin="round"/>
  </svg>`;

  return `<div class="onboarding-empty">
    <!-- Title row with logo tile -->
    <div style="display:flex;gap:10px;margin-bottom:14px;align-items:flex-start">
      <div style="width:38px;height:38px;border-radius:10px;background:var(--accent-soft);border:1px solid var(--accent-ring);display:flex;align-items:center;justify-content:center;flex-shrink:0">
        <svg width="22" height="22" viewBox="0 0 124 124" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M103.948 42.1496L75.6373 13.6339C72.2845 10.4453 68.291 8.01733 63.9263 6.51369C54.2541 3.27405 44.6282 5.80282 36.8325 13.6339L8.45273 42.1496C5.28327 45.5226 2.86981 49.5401 1.37519 53.9313C-1.85662 63.662 0.657009 73.3457 8.45273 81.1768L36.7977 109.693C40.1449 112.882 44.135 115.311 48.4971 116.813C51.1397 117.712 53.9086 118.176 56.6981 118.188C63.4976 118.188 70.0076 115.298 75.5909 109.693L103.924 81.1768C107.098 77.8053 109.515 73.7875 111.013 69.3954C114.234 59.6647 111.72 49.9926 103.924 42.1496H103.948ZM58.3777 21.9078C60.5191 22.5984 62.4922 23.734 64.1695 25.2407L72.5443 33.6777L56.2117 50.0972L39.8788 33.6661L48.3 25.1824C50.5588 22.9217 53.7442 20.5211 58.4009 21.8961L58.3777 21.9078ZM16.7002 59.4551C17.3889 57.2992 18.5217 55.314 20.0247 53.6284L28.3996 45.203L44.7323 61.6342L28.388 78.0654L19.9668 69.5818C17.708 67.321 15.3334 64.1163 16.6886 59.4317L16.7002 59.4551ZM54.0225 101.384C51.8784 100.699 49.9039 99.5633 48.2307 98.051L39.8788 89.719L56.2117 73.2759L72.5443 89.7071L64.1231 98.191C61.8643 100.452 58.6905 102.852 54.0225 101.477V101.384ZM95.7231 63.9183C95.0346 66.0715 93.9061 68.0565 92.4102 69.745L84.0353 78.0654L67.7024 61.6342L84.0353 45.203L92.4565 53.675C94.7153 55.9356 97.09 59.1403 95.7347 63.8249" fill="#00ADE4"/>
        </svg>
      </div>
      <div style="display:flex;flex-direction:column">
        <div style="font-size:13px;font-weight:600;color:var(--fg-0);line-height:1.3">Set up Harness</div>
        <div style="font-size:11px;color:var(--fg-2);line-height:1.3">Takes about a minute.</div>
      </div>
    </div>

    <!-- Intro paragraph -->
    <div style="font-size:11.5px;color:var(--fg-2);line-height:1.55;margin-bottom:14px">
      The extension needs three things to talk to your Harness account. To get a personal access token, open your profile in the Harness web app → My API Keys, and generate one from there.
    </div>

    <!-- Step list -->
    <div style="border:1px solid var(--line);border-radius:var(--r-lg);background:var(--bg-2);overflow:hidden;margin-bottom:18px">
      <!-- Step 1 -->
      <div style="display:flex;gap:11px;padding:11px 12px;align-items:flex-start">
        <div style="width:22px;height:22px;border-radius:50%;background:var(--bg-3);color:var(--accent);font-family:var(--font-mono);font-size:10.5px;font-weight:600;border:1px solid var(--line-2);display:flex;align-items:center;justify-content:center;flex-shrink:0">1</div>
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0">
          <div style="font-size:12px;font-weight:600;color:var(--fg-0)">Base URL</div>
          <div style="font-size:11px;color:var(--fg-2);line-height:1.45">app.harness.io or your self-hosted instance</div>
        </div>
      </div>
      <!-- Step 2 -->
      <div style="border-top:1px solid var(--line);display:flex;gap:11px;padding:11px 12px;align-items:flex-start">
        <div style="width:22px;height:22px;border-radius:50%;background:var(--bg-3);color:var(--accent);font-family:var(--font-mono);font-size:10.5px;font-weight:600;border:1px solid var(--line-2);display:flex;align-items:center;justify-content:center;flex-shrink:0">2</div>
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0">
          <div style="font-size:12px;font-weight:600;color:var(--fg-0)">Personal access token</div>
          <div style="font-size:11px;color:var(--fg-2);line-height:1.45">Open your profile in Harness → My API Keys → generate a new token</div>
        </div>
      </div>
      <!-- Step 3 -->
      <div style="border-top:1px solid var(--line);display:flex;gap:11px;padding:11px 12px;align-items:flex-start">
        <div style="width:22px;height:22px;border-radius:50%;background:var(--bg-3);color:var(--accent);font-family:var(--font-mono);font-size:10.5px;font-weight:600;border:1px solid var(--line-2);display:flex;align-items:center;justify-content:center;flex-shrink:0">3</div>
        <div style="display:flex;flex-direction:column;gap:2px;min-width:0">
          <div style="font-size:12px;font-weight:600;color:var(--fg-0)">Account ID</div>
          <div style="font-size:11px;color:var(--fg-2);line-height:1.45">Found under Account Settings → Overview</div>
        </div>
      </div>
    </div>

    <!-- Primary button -->
    <button style="width:100%;padding:8px 14px;background:var(--accent);color:#0E1013;border:none;border-radius:var(--r);font-family:var(--font-sans);font-size:11.5px;font-weight:600;letter-spacing:0.1px;cursor:pointer;margin-bottom:14px" data-action="configure" onmouseover="this.style.filter='brightness(1.08)'" onmouseout="this.style.filter=''" onmousedown="this.style.filter='brightness(0.95)'" onmouseup="this.style.filter='brightness(1.08)'">Start setup</button>

    <!-- Env disclosure link -->
    <div style="text-align:center;margin-bottom:18px">
      <a href="#" data-action="openEnvDisclosure" style="font-size:10.5px;color:var(--fg-2);text-decoration:none;cursor:pointer">
        Already have <code style="font-family:var(--font-mono);color:var(--fg-2)">HARNESS_*</code> env vars?
      </a>
    </div>

    <!-- Footnote card -->
    <div style="padding:10px 12px;background:var(--bg-2);border:1px solid var(--line);border-radius:var(--r);display:flex;gap:8px;align-items:flex-start">
      <div style="color:var(--accent)">${shieldIcon}</div>
      <div style="font-size:10.5px;color:var(--fg-2);line-height:1.5">Your personal access token is stored in VS Code secret storage — never written to settings.</div>
    </div>
  </div>`;
}

function emptyState(): string {
  // This is only called in live mode when gitCtx exists
  const ctx = state.gitCtx!;
  return `<div class="empty-state">
    <div class="empty-title">No pipeline execution found</div>
    <div class="empty-sub">Branch <strong>${esc(ctx.branch)}</strong> @ <code>${esc(ctx.shortSha)}</code><br>Waiting for pipeline trigger...</div>
  </div>`;
}

// ── Pin UI helpers ─────────────────────────────────────────────────────────
function updatePinUI(): void {
  const btn = document.getElementById('vt-pin');
  const tooltip = document.getElementById('vt-pin-tooltip');
  if (!btn || !tooltip) return;

  const activeView = state.viewMode === 'pipelines' ? 'pipelines' : 'executions';
  const isPinned = state.pinnedView === activeView;

  btn.classList.toggle('pinned', isPinned);

  if (isPinned) {
    tooltip.textContent = 'Remove default pin';
  } else {
    const label = activeView === 'executions' ? 'Executions' : 'Pipelines';
    tooltip.textContent = `Pin "${label}" as default`;
  }
}

function togglePin(): void {
  const activeView = state.viewMode === 'pipelines' ? 'pipelines' : 'executions';

  if (state.pinnedView === activeView) {
    // Unpin - reset to default
    state.pinnedView = null;
    vscode.postMessage({ type: 'setDefaultView', view: 'pipelines' });
  } else {
    // Pin current tab
    state.pinnedView = activeView;
    vscode.postMessage({ type: 'setDefaultView', view: activeView });
  }

  scheduleRender();
}

// ── Bind ───────────────────────────────────────────────────────────────────
let aiEventDelegationSetup = false;

function bind(): void {
  q('[data-action="configure"]',     () => vscode.postMessage({ type: 'command', command: 'harness.configureApiKey' }));
  q('[data-action="openProblems"]',  () => vscode.postMessage({ type: 'command', command: 'workbench.actions.view.problems' }));
  q('[data-action="refresh"]',       () => vscode.postMessage({ type: 'command', command: 'harness.refreshNow' }));
  q('[data-action="selectProject"]', () => vscode.postMessage({ type: 'command', command: 'harness.selectProject' }));

  // App menu
  q('[data-action="toggleMenu"]', () => {
    state.menuOpen = !state.menuOpen;
    scheduleRender(true);
  });
  q('[data-action="closeMenu"]', () => {
    state.menuOpen = false;
    scheduleRender(true);
  });
  q('[data-action="changeAccount"]', () => {
    state.menuOpen = false;
    scheduleRender(true);
    vscode.postMessage({ type: 'command', command: 'harness.switchProject' });
  });

  // Pin button
  q('[data-action="togglePin"]', () => togglePin());
  q('[data-action="openPinSettings"]', () => vscode.postMessage({ type: 'openSettings', key: 'harness.defaultView' }));

  // View mode toggle
  q('[data-action="switchToLive"]', () => {
    state.viewMode = 'pipelines';
    state.detailExecId = null;
    state.loadingPipelines = true;
    state.filteredPipelineId = null; // Clear any pipeline filter
    state.executions.clear();
    scheduleRender(true); // User action
    // Fetch pipeline list
    vscode.postMessage({ type: 'fetchPipelines' });
  });
  q('[data-action="switchToHistory"]', () => {
    console.log('[Webview] switchToHistory clicked', { currentMode: state.viewMode });
    state.viewMode = 'executions';
    state.historyPage = 0;
    state.detailExecId = null;
    state.loadingExecution = true; // Show loading state while fetching
    // Clear live executions when switching to history mode
    state.executions.clear();
    // Request history data from extension host (using initial calculated page size)
    console.log('[Webview] Sending fetchHistory message', { page: 0, filter: state.historyFilter, pageSize: state.historyPageSize });
    vscode.postMessage({ type: 'fetchHistory', page: 0, filter: state.historyFilter, pageSize: state.historyPageSize });
    scheduleRender(true); // User action
  });

  // Update pin UI after render (handles tab switches)
  updatePinUI();

  // Pipelines tab handlers
  document.querySelectorAll<HTMLElement>('[data-action="togglePipelinePin"]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation(); // Don't trigger row click
      const pipelineId = el.dataset['pipelineId'];
      if (!pipelineId) return;

      if (state.pinnedPipelines.has(pipelineId)) {
        state.pinnedPipelines.delete(pipelineId);
      } else {
        state.pinnedPipelines.add(pipelineId);
      }

      // Persist pinned pipelines (send to extension to save in globalState)
      vscode.postMessage({
        type: 'setPinnedPipelines',
        pinnedPipelines: Array.from(state.pinnedPipelines)
      });

      scheduleRender(true);
    });
  });

  document.querySelectorAll<HTMLElement>('[data-action="openPipeline"]').forEach(el => {
    el.addEventListener('click', () => {
      const pipelineId = el.dataset['pipelineId'];
      if (!pipelineId) return;

      // Switch to executions tab with this pipeline filtered
      state.viewMode = 'executions';
      state.filteredPipelineId = pipelineId;
      state.historyPage = 0;
      state.loadingExecution = true;

      // Fetch executions for this pipeline
      vscode.postMessage({
        type: 'fetchHistory',
        page: 0,
        filter: state.historyFilter,
        pageSize: state.historyPageSize,
        pipelineId: pipelineId
      });

      scheduleRender(true);
    });
  });

  q('[data-action="togglePipelinesSort"]', () => {
    // Cycle through sort modes
    const modes: PipelineSortMode[] = ['recent', 'name', 'status'];
    const currentIdx = modes.indexOf(state.pipelinesSort);
    state.pipelinesSort = modes[(currentIdx + 1) % modes.length];
    scheduleRender(true);
  });

  // Pipeline search
  document.querySelectorAll<HTMLInputElement>('[data-action="searchPipelines"]').forEach(el => {
    el.addEventListener('input', () => {
      state.pipelinesSearch = el.value;
      state.pipelinesPage = 0; // Reset to first page
      scheduleRender(true);
    });
  });

  // Pipeline status filters
  q('[data-action="filterPipelinesAll"]', () => {
    state.pipelinesFilter = 'all';
    state.pipelinesPage = 0;
    scheduleRender(true);
  });
  q('[data-action="filterPipelinesFailed"]', () => {
    state.pipelinesFilter = 'failed';
    state.pipelinesPage = 0;
    scheduleRender(true);
  });
  q('[data-action="filterPipelinesRunning"]', () => {
    state.pipelinesFilter = 'running';
    state.pipelinesPage = 0;
    scheduleRender(true);
  });
  q('[data-action="filterPipelinesWaiting"]', () => {
    state.pipelinesFilter = 'waiting';
    state.pipelinesPage = 0;
    scheduleRender(true);
  });

  // Open/close the executions sort popover
  q('[data-action="toggleSortMenu"]', () => {
    if (!state.sortMenuOpen) {
      // Calculate menu position before opening
      const btn = document.querySelector('[data-action="toggleSortMenu"]') as HTMLElement;
      if (btn) {
        const rect = btn.getBoundingClientRect();
        const menuWidth = 220; // min-width from CSS
        const viewportWidth = window.innerWidth;
        const spaceOnRight = viewportWidth - rect.right;

        // If not enough space on the right, align menu's right edge with button's right edge
        // Otherwise, position menu to the right of the button
        let left: number;
        if (spaceOnRight < menuWidth + 6) {
          // Not enough space - align right edges
          left = rect.right - menuWidth;
        } else {
          // Enough space - show to the right
          left = rect.right + 6;
        }

        state.sortMenuPos = {
          top: rect.bottom + 6,
          left: Math.max(8, left)  // Don't go past left edge of viewport
        };
      }
    }
    state.sortMenuOpen = !state.sortMenuOpen;
    scheduleRender(true);
  });
  q('[data-action="closeSortMenu"]', () => {
    state.sortMenuOpen = false;
    scheduleRender(true);
  });

  // Select a sort mode
  document.querySelectorAll<HTMLElement>('[data-action="setExecutionsSort"]').forEach(el => {
    el.addEventListener('click', () => {
      const mode = el.getAttribute('data-sort-mode') as ExecutionsSortMode;
      if (mode) {
        state.executionsSort = mode;
        state.sortMenuOpen = false;
        scheduleRender(true);
      }
    });
  });

  // History filters
  q('[data-action="filterAll"]', () => {
    state.historyFilter = 'all';
    state.historyPage = 0;
    state.loadingExecution = true; // Show loading state while fetching
    vscode.postMessage({ type: 'fetchHistory', page: 0, filter: 'all', pageSize: state.historyPageSize });
    scheduleRender(true); // User action
  });
  q('[data-action="filterFailed"]', () => {
    state.historyFilter = 'failed';
    state.historyPage = 0;
    state.loadingExecution = true; // Show loading state while fetching
    vscode.postMessage({ type: 'fetchHistory', page: 0, filter: 'failed', pageSize: state.historyPageSize });
    scheduleRender(true); // User action
  });
  q('[data-action="filterSuccess"]', () => {
    state.historyFilter = 'success';
    state.historyPage = 0;
    state.loadingExecution = true; // Show loading state while fetching
    vscode.postMessage({ type: 'fetchHistory', page: 0, filter: 'success', pageSize: state.historyPageSize });
    scheduleRender(true); // User action
  });
  q('[data-action="filterWaiting"]', () => {
    state.historyFilter = 'waiting';
    state.historyPage = 0;
    state.loadingExecution = true; // Show loading state while fetching
    vscode.postMessage({ type: 'fetchHistory', page: 0, filter: 'waiting', pageSize: state.historyPageSize });
    scheduleRender(true); // User action
  });

  // Current commit filter checkbox
  q('[data-action="toggleCurrentCommitFilter"]', () => {
    state.currentCommitFilter = !state.currentCommitFilter;
    scheduleRender(true); // User action
  });

  // Clear pipeline filter
  q('[data-action="clearPipelineFilter"]', () => {
    state.filteredPipelineId = null;
    state.historyPage = 0;
    state.loadingExecution = true;
    vscode.postMessage({ type: 'fetchHistory', page: 0, filter: state.historyFilter, pageSize: state.historyPageSize });
    scheduleRender(true); // User action
  });

  // Pagination
  q('[data-action="prevPage"]', () => {
    if (state.historyPage > 0) {
      state.historyPage--;
      state.loadingExecution = true; // Show loading state while fetching
      vscode.postMessage({ type: 'fetchHistory', page: state.historyPage, filter: state.historyFilter, pageSize: state.historyPageSize, pipelineId: state.filteredPipelineId });
      scheduleRender(true); // User action
    }
  });
  q('[data-action="nextPage"]', () => {
    const totalPages = Math.ceil(state.historyTotal / state.historyPageSize);
    if (state.historyPage < totalPages - 1) {
      state.historyPage++;
      state.loadingExecution = true; // Show loading state while fetching
      vscode.postMessage({ type: 'fetchHistory', page: state.historyPage, filter: state.historyFilter, pageSize: state.historyPageSize, pipelineId: state.filteredPipelineId });
      scheduleRender(true); // User action
    }
  });

  document.querySelectorAll<HTMLElement>('[data-action="goToPage"]').forEach(el => {
    el.addEventListener('click', () => {
      const page = parseInt(el.dataset['page'] ?? '0', 10);
      state.historyPage = page;
      state.loadingExecution = true; // Show loading state while fetching
      vscode.postMessage({ type: 'fetchHistory', page, filter: state.historyFilter, pageSize: state.historyPageSize, pipelineId: state.filteredPipelineId });
      scheduleRender(true); // User action
    });
  });

  // Pipelines pagination
  q('[data-action="prevPipelinePage"]', () => {
    if (state.pipelinesPage > 0) {
      state.pipelinesPage--;
      scheduleRender(true); // User action
    }
  });
  q('[data-action="nextPipelinePage"]', () => {
    const totalPages = Math.ceil(state.pipelineList.length / state.pipelinesPageSize);
    if (state.pipelinesPage < totalPages - 1) {
      state.pipelinesPage++;
      scheduleRender(true); // User action
    }
  });

  document.querySelectorAll<HTMLElement>('[data-action="goToPipelinePage"]').forEach(el => {
    el.addEventListener('click', () => {
      const page = parseInt(el.dataset['page'] ?? '0', 10);
      state.pipelinesPage = page;
      scheduleRender(true); // User action
    });
  });

  // View execution detail
  document.querySelectorAll<HTMLElement>('[data-action="viewExecution"]').forEach(el => {
    el.addEventListener('click', () => {
      const execId = el.dataset['execId'];
      if (!execId) return;

      // Clear previous execution details when viewing a different execution
      // This ensures LOG_CHUNK messages are stored in the correct execution
      state.executions.clear();
      state.expandedNodes.clear();
      state.userCollapsed.clear();
      state.userToggledStages.clear();
      state.userToggledStagesOpen.clear();
      state.expandedStagesDefault.clear();
      state.loadingSteps.clear();
      state.stepsOpenedInTab.clear();

      state.detailExecId = execId;
      state.viewMode = 'detail';
      state.activeDetailTab = 'pipeline'; // reset tab when switching executions
      state.loadingExecution = true; // Show loading state while fetching
      state.executionError = null; // Clear any previous error
      // Request full execution detail from extension host
      vscode.postMessage({ type: 'fetchExecutionDetail', planExecutionId: execId });
      scheduleRender(true); // User action
    });
  });

  // Back to history
  q('[data-action="backToHistory"]', () => {
    state.viewMode = 'executions';
    state.activeDetailTab = 'pipeline'; // reset tab when leaving detail view
    // Clear the detail execution when going back to history list
    if (state.detailExecId) {
      state.executions.delete(state.detailExecId);
      state.detailExecId = null;
    }
    state.executionError = null; // Clear any error message
    // Notify extension host to clear tracked execution
    vscode.postMessage({ type: 'clearExecution' });
    scheduleRender(true); // User action
  });

  document.querySelectorAll<HTMLElement>('[data-action="toggleStep"]').forEach(el => {
    el.addEventListener('click', () => {
      const nodeId = el.dataset['nodeid'];
      if (!nodeId) return;
      if (state.expandedNodes.has(nodeId)) {
        // User explicitly collapsing — remember this so auto-expand won't fight them
        state.expandedNodes.delete(nodeId);
        state.userCollapsed.add(nodeId);
      } else {
        // User explicitly expanding — clear any previous collapse intent
        state.userCollapsed.delete(nodeId);
        state.expandedNodes.add(nodeId);
        // Request logs if needed
        const logBaseKey = el.dataset['logbasekey'];
        const hasLogs = [...state.executions.values()].some(ex => (ex.stepLogs[nodeId] ?? []).length > 0);

        // For expanded mode: always fetch on-demand (opens in editor)
        // For inline mode: only fetch if we don't have logs yet
        const shouldFetch = state.logViewerVariation === 'expanded' || !hasLogs;

        if (logBaseKey && shouldFetch) {
          // Extract step metadata for expanded log viewer
          const stepName = el.dataset['stepname'];
          const stageName = el.dataset['stagename'];
          const pipelineName = el.dataset['pipelinename'];
          const planExecutionId = el.dataset['planexecutionid'];
          const status = el.dataset['status'];
          const durationMs = parseInt(el.dataset['durationms'] ?? '0', 10);
          console.log('[Webview] Fetching logs on-demand', { nodeId, logBaseKey, stepName, stageName, variation: state.logViewerVariation });
          vscode.postMessage({
            type: 'fetchStepLogs',
            nodeId,
            logBaseKey,
            stepName,
            stageName,
            pipelineName,
            planExecutionId,
            status,
            durationMs
          });
        }
      }
      scheduleRender(true); // User action - render immediately
    });
  });

  // Retry logs button
  document.querySelectorAll<HTMLElement>('[data-action="retryLogs"]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation(); // Don't trigger parent step toggle
      // Get step row parent to extract metadata
      const stepRow = el.closest('[data-action="toggleStep"]') as HTMLElement;
      const nodeId = el.dataset['nodeid'];
      const logBaseKey = el.dataset['logbasekey'];
      if (!nodeId || !logBaseKey || !stepRow) return;
      // Extract step metadata for expanded log viewer
      const stepName = stepRow.dataset['stepname'];
      const stageName = stepRow.dataset['stagename'];
      const pipelineName = stepRow.dataset['pipelinename'];
      const planExecutionId = stepRow.dataset['planexecutionid'];
      const status = stepRow.dataset['status'];
      const durationMs = parseInt(stepRow.dataset['durationms'] ?? '0', 10);
      console.log('[Webview] Retrying log fetch', { nodeId, logBaseKey, stepName, stageName });
      vscode.postMessage({
        type: 'fetchStepLogs',
        nodeId,
        logBaseKey,
        stepName,
        stageName,
        pipelineName,
        planExecutionId,
        status,
        durationMs
      });
      scheduleRender(true); // User action - render immediately
    });
  });

  // Stage toggle (§7.1 single-focus collapse/expand)
  document.querySelectorAll<HTMLElement>('[data-action="toggleStage"]').forEach(el => {
    el.addEventListener('click', () => {
      const stageId = el.dataset['stageid'];
      if (!stageId) return;

      // Mark as user-toggled
      state.userToggledStages.add(stageId);

      // Toggle open/closed state
      if (state.userToggledStagesOpen.has(stageId)) {
        state.userToggledStagesOpen.delete(stageId);
      } else {
        state.userToggledStagesOpen.add(stageId);
      }

      scheduleRender(true); // User action - render immediately
    });
  });

  document.querySelectorAll<HTMLElement>('[data-action="approve"],[data-action="reject"]').forEach(el => {
    el.addEventListener('click', () => {
      const id     = el.dataset['id'];
      const action = el.dataset['action'] === 'reject' ? 'REJECT' : 'APPROVE';
      if (!id) return;
      el.setAttribute('disabled', 'true');
      vscode.postMessage({ type: 'approval', planExecutionId: id, action });
    });
  });

  document.querySelectorAll<HTMLElement>('[data-action="rerunPipeline"]').forEach(el => {
    el.addEventListener('click', () => {
      const planExecutionId = el.dataset['planExecutionId'];
      const pipelineIdentifier = el.dataset['pipelineIdentifier'];
      const firstStageId = el.dataset['firstStageId'];
      if (!planExecutionId || !pipelineIdentifier) return;
      el.setAttribute('disabled', 'true');
      vscode.postMessage({ type: 'rerunPipeline', planExecutionId, pipelineIdentifier, firstStageId });
    });
  });

  document.querySelectorAll<HTMLElement>('[data-action="abortPipeline"]').forEach(el => {
    el.addEventListener('click', () => {
      const planExecutionId = el.dataset['planExecutionId'];
      if (!planExecutionId) return;
      el.setAttribute('disabled', 'true');
      vscode.postMessage({ type: 'abortPipeline', planExecutionId });
    });
  });

  document.querySelectorAll<HTMLElement>('[data-action="switchDetailTab"]').forEach(el => {
    el.addEventListener('click', () => {
      const tab = el.dataset['tab'] as typeof state.activeDetailTab;
      state.activeDetailTab = tab || 'pipeline';
      scheduleRender(true);
    });
  });

  document.querySelectorAll<HTMLElement>('[data-action="openUrl"]').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const url = el.dataset['url'];
      if (url) {
        console.log('[Webview] Opening URL:', url);
        vscode.postMessage({ type: 'command', command: 'harness.openUrl', url });
      }
    });
  });

  // Exec header click → open in Harness
  document.querySelectorAll<HTMLElement>('.exec-header[data-action="openUrl"]').forEach(el => {
    el.style.cursor = 'pointer';
  });

  // AI bar interactions - use event delegation to avoid re-binding issues
  // Only set up once to prevent duplicate listeners
  if (!aiEventDelegationSetup) {
    aiEventDelegationSetup = true;
    const root = document.getElementById('root')!;

    console.log('[Webview] Setting up AI event delegation');

    // Input handler
    root.addEventListener('input', (e) => {
    const target = e.target as HTMLInputElement;
    if (target.dataset?.action === 'aiInput') {
      state.aiQuestion = target.value;
      // Update send button disabled state without full re-render
      const sendBtn = document.querySelector('[data-action="sendAI"]') as HTMLButtonElement;
      if (sendBtn) {
        const shouldEnable = state.aiState === 'ready' && target.value.trim().length > 0;
        if (shouldEnable) {
          sendBtn.removeAttribute('disabled');
        } else {
          sendBtn.setAttribute('disabled', 'true');
        }
      }
    }
  });

  // Keydown handler for Enter key
  root.addEventListener('keydown', (e) => {
    // Close sort menu on Escape
    if (e.key === 'Escape' && state.sortMenuOpen) {
      state.sortMenuOpen = false;
      scheduleRender(true);
      return;
    }

    const target = e.target as HTMLInputElement;
    if (target.dataset?.action === 'aiInput' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAIMessage();
    }
  });

  // Click handlers using event delegation for AI bar
  root.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const button = target.closest('[data-action]') as HTMLElement;
    if (!button) return;

    const action = button.dataset.action;
    console.log('[Webview] Click delegation caught:', action);

    // AI bar actions
    if (action === 'sendAI') {
      e.preventDefault();
      e.stopPropagation();
      console.log('[AI] Send button clicked!');
      console.log('[AI] Current state:', {
        aiState: state.aiState,
        question: state.aiQuestion,
        activeTool: state.aiDetection?.activeTool,
        mcpReady: state.aiDetection?.tools.find(t => t.id === state.aiDetection?.activeTool)?.mcpReady
      });
      sendAIMessage();
    } else if (action === 'toggleAIToolPicker') {
      e.preventDefault();
      e.stopPropagation();
      console.log('[AI] Toggle picker');
      state.aiShowToolPicker = !state.aiShowToolPicker;
      scheduleRender(true);
    } else if (action === 'selectAITool') {
      e.preventDefault();
      e.stopPropagation();
      const toolId = button.dataset['tool'];
      console.log('[AI] Select tool:', toolId);
      if (!toolId) return;
      state.aiShowToolPicker = false;
      vscode.postMessage({ type: 'AI_SWITCH_TOOL', toolId });
      scheduleRender(true);
    } else if (action === 'showAIMCPSetup') {
      e.preventDefault();
      e.stopPropagation();
      state.aiOverlay = 'mcp-setup';
      scheduleRender(true);
    } else if (action === 'closeAIMCPCard') {
      e.preventDefault();
      e.stopPropagation();
      state.aiOverlay = null;
      scheduleRender(true);
    } else if (action === 'setMCPScope') {
      e.preventDefault();
      e.stopPropagation();
      const scope = (e.target as HTMLElement).closest('[data-scope]')?.getAttribute('data-scope') as 'project' | 'global';
      if (scope) {
        state.aiMcpSetupScope = scope;
        scheduleRender(true);
      }
    } else if (action === 'configureAIMCP') {
      e.preventDefault();
      e.stopPropagation();
      state.aiMcpConfiguring = true;
      scheduleRender(true);
      vscode.postMessage({ type: 'AI_CONFIGURE_MCP', scope: state.aiMcpSetupScope });
    } else if (action === 'openMCPConfig') {
      e.preventDefault();
      e.stopPropagation();
      const scope = (e.target as HTMLElement).closest('[data-scope]')?.getAttribute('data-scope') as 'project' | 'global';
      if (scope) {
        vscode.postMessage({ type: 'AI_OPEN_MCP_CONFIG', scope });
      }
    } else if (action === 'closeAIOverlay') {
      e.preventDefault();
      e.stopPropagation();
      state.aiOverlay = null;
      state.aiResponse = null;
      state.aiError = null;
      scheduleRender(true);
    } else if (action === 'retryAI') {
      e.preventDefault();
      e.stopPropagation();
      state.aiError = null;
      sendAIMessage();
    } else if (action === 'closeAIResponse') {
      e.preventDefault();
      e.stopPropagation();
      state.aiOverlay = null;
      state.aiResponse = null;
      scheduleRender(true);
    } else if (action === 'copyAIResponse') {
      e.preventDefault();
      e.stopPropagation();
      if (state.aiResponse?.content) {
        navigator.clipboard.writeText(state.aiResponse.content);
      }
    } else if (action === 'rerunAI') {
      e.preventDefault();
      e.stopPropagation();
      state.aiOverlay = null;
      state.aiResponse = null;
      scheduleRender(true);
    } else if (action === 'cursorInstallPlugin') {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: 'AI_CURSOR_INSTALL_PLUGIN' });
    } else if (action === 'cursorConnectOAuth') {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: 'AI_CURSOR_CONNECT_OAUTH' });
    } else if (action === 'openEnvDisclosure') {
      e.preventDefault();
      e.stopPropagation();
      state.envDisclosureOpen = true;
      scheduleRender(true);
    } else if (action === 'closeEnvDisclosure') {
      e.preventDefault();
      e.stopPropagation();
      state.envDisclosureOpen = false;
      scheduleRender(true);
    } else if (action === 'selectEnvChoice') {
      e.preventDefault();
      e.stopPropagation();
      const choice = (e.target as HTMLElement).closest('[data-choice]')?.getAttribute('data-choice') as 'env' | 'pat';
      if (choice) {
        state.envOnboardingChoice = choice;
        scheduleRender(true);
      }
    } else if (action === 'connectWithEnv') {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: 'startEnvVarOnboarding' });
    } else if (action === 'reloadWindowEnv') {
      e.preventDefault();
      e.stopPropagation();
      vscode.postMessage({ type: 'command', command: 'workbench.action.reloadWindow' });
    } else if (action === 'copyEnvVars') {
      e.preventDefault();
      e.stopPropagation();
      const text = `export HARNESS_BASE_URL=https://app.harness.io
export HARNESS_API_KEY=pat.xxxxx
export HARNESS_ACCOUNT_ID=xxxxx`;
      navigator.clipboard.writeText(text);
    }
  });

  } // end AI event delegation setup
}

function q(sel: string, handler: () => void): void {
  document.querySelectorAll(sel).forEach(el => el.addEventListener('click', handler));
}

function sendAIMessage(): void {
  console.log('[AI] sendAIMessage() called');
  console.log('[AI] Question:', state.aiQuestion);
  console.log('[AI] State:', state.aiState);
  console.log('[AI] Detection:', state.aiDetection);

  if (!state.aiQuestion.trim()) {
    console.log('[AI] ❌ Send blocked - question is empty');
    return;
  }

  if (state.aiState !== 'ready') {
    console.log('[AI] ❌ Send blocked - state is not ready, current state:', state.aiState);
    return;
  }

  console.log('[AI] ✅ Validation passed, sending message...');
  const question = state.aiQuestion.trim();
  state.aiQuestion = '';
  state.aiState = 'sending';
  state.aiError = null;
  state.aiResponse = null;
  scheduleRender(true);

  // Build execution context from current view
  let executionContext: any = null;
  if (state.detailExecId) {
    const ex = state.executions.get(state.detailExecId);
    if (ex) {
      executionContext = {
        pipelineIdentifier: ex.pipelineIdentifier,
        planExecutionId: ex.planExecutionId,
      };
    }
  } else if (state.executions.size > 0) {
    const [firstExecId, ex] = Array.from(state.executions.entries())[0];
    if (ex) {
      executionContext = {
        pipelineIdentifier: ex.pipelineIdentifier,
        planExecutionId: ex.planExecutionId,
      };
    }
  }

  console.log('[Webview AI] Sending AI_SEND_MESSAGE with execution context:', executionContext);
  console.log('[Webview AI] Current state.executions:', state.executions.size);
  console.log('[Webview AI] Current state.detailExecId:', state.detailExecId);

  const message = {
    type: 'AI_SEND_MESSAGE',
    question,
    executionContext
  };
  console.log('[Webview AI] Posting message to extension:', message);
  vscode.postMessage(message);
  console.log('[Webview AI] ✅ Message posted to extension host');
}

// Read theme variation from initial HTML injection (set by FME evaluation during sidebar init)
// This prevents flash from simple → enhanced on first load
if (typeof __THEME_VARIATION__ !== 'undefined' && __THEME_VARIATION__) {
  state.webviewTheme = __THEME_VARIATION__ as 'simple' | 'enhanced';
}

// Detect initial IDE theme kind from body classes (before GIT_CONTEXT arrives with official value)
const cls = document.body.classList;
if (cls.contains('vscode-light')) {
  state.ideThemeKind = 1;
} else if (cls.contains('vscode-dark')) {
  state.ideThemeKind = 2;
} else if (cls.contains('vscode-high-contrast')) {
  state.ideThemeKind = 3;
} else if (cls.contains('vscode-high-contrast-light')) {
  state.ideThemeKind = 4;
}

// Apply initial theme before first render (will be updated when GIT_CONTEXT arrives)
applyEffectiveTheme();

// Calculate initial page size based on viewport (before first render)
// This ensures the first history fetch uses the correct page size for the current screen
state.historyPageSize = calculatePageSize();
console.log('[Webview] Initial page size calculated:', state.historyPageSize);

// Signal to the extension host that the webview script is loaded and the
// message listener is active. The bridge will flush its queued messages now.
vscode.postMessage({ type: 'WEBVIEW_READY' });

render();
