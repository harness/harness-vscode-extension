import * as vscode from 'vscode';
import { HarnessClient } from '../api/harnessClient';
import { HarnessConfig } from '../config/configManager';
import { DiagnosticsManager } from '../features/diagnosticsManager';
import { WebviewBridge } from '../ui/webviewBridge';
import { getGitContext, getGitApi, executionMatchesSha } from '../git/gitContext';
import { handleApiError } from '../utils/errorHandler';
import { dispatchModules } from './executionDispatcher';
import { ExecutionSummary, ExecutionDetail, ExecutionGraph } from '../api/types';
import { logger } from '../utils/logger';

const INTERVAL_ACTIVE_MS    = 1_000;   // while pipeline is running or waiting for execution
const INTERVAL_HEARTBEAT_MS = 120_000; // idle safety net
// After a new commit, keep polling at 1s for up to 5 minutes before giving up
const WAITING_TIMEOUT_MS    = 5 * 60 * 1000;

const TERMINAL_STATUSES = new Set([
  'SUCCESS', 'FAILED', 'ABORTED', 'EXPIRED', 'IGNOREFAILED', 'POLICY_EVALUATION_FAILURE'
]);

/**
 * Create a simple hash of execution graph to detect changes
 * Tracks status of all nodes to detect step-level updates
 */
function hashExecutionGraph(graph: ExecutionGraph | null): string {
  if (!graph?.nodeMap) return 'empty';

  const nodeStatuses = Object.entries(graph.nodeMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, node]) => `${id}:${node.status}`)
    .join('|');

  return nodeStatuses;
}

interface ExecutionSummaryResponse {
  data?: { content?: ExecutionSummary[] };
}
interface ExecutionDetailResponse {
  data?: {
    pipelineExecutionSummary?: ExecutionDetail;
    executionGraph?: ExecutionGraph;
  };
}

export class PipelinePoller implements vscode.Disposable {
  private timer: NodeJS.Timeout | null = null;
  private gitWatcher: vscode.Disposable | null = null;
  private lastPlanExecutionId: string | null = null;
  private lastStatus: string | null = null;
  private lastTrackedSha: string | null = null;
  private waitingSince: number | null = null; // when we started waiting for an execution
  private lastExecutionData: { execution: ExecutionDetail; executionGraph: ExecutionGraph | null } | null = null;
  private lastGraphHash: string | null = null; // Track execution graph changes

  // Track detail execution being viewed (for polling running executions in history detail mode)
  private detailExecutionId: string | null = null;
  private detailLastStatus: string | null = null;
  private detailLastGraphHash: string | null = null; // Track detail execution graph changes
  private detailWaitingSince: number | null = null; // when we started waiting for a detail execution to appear

  // Visibility tracking - pause polling when sidebar is hidden or window unfocused
  private isSidebarVisible: boolean = false;
  private isWindowFocused: boolean = true; // Assume focused initially

  // Re-entrancy guard - prevent concurrent tick() executions
  private isTickRunning: boolean = false;
  // Set when a tick is requested while one is already running (e.g. refresh()
  // right after a re-run/abort). The in-flight tick re-runs once on completion
  // so the requested refresh is never silently dropped.
  private pendingRefresh: boolean = false;

  constructor(
    private readonly client: HarnessClient,
    private readonly config: HarnessConfig,
    private readonly diagnostics: DiagnosticsManager,
    private readonly webview: WebviewBridge,
    private readonly outputChannel?: vscode.OutputChannel
  ) {}

  async start(): Promise<void> {
    this.watchGit();
    // Send initial GIT_CONTEXT when poller starts
    await this.sendGitContext();
    this.tick();
  }

  /** Called by the refresh button in the webview. */
  refresh(): void {
    this.lastStatus = null;
    this.lastGraphHash = null;
    // Reset detail tracking too so a forced refresh re-emits the current
    // detail execution state (e.g. right after an abort transitions to ABORTED).
    this.detailLastStatus = null;
    this.detailLastGraphHash = null;
    this.stopTimer();
    this.tick();
  }

  /**
   * Send GIT_CONTEXT to webview with current git state, config, and theme settings.
   * Called on initialization and when git/config/theme changes.
   */
  async sendGitContext(): Promise<void> {
    const ctx = await getGitContext();
    const defaultView = vscode.workspace.getConfiguration('harness').get<string>('defaultView', 'thisCommit');
    const { getLogViewerVariation, getWebviewThemeVariation, getAiChatEnabled } = await import('../fme/fmeClient');
    const logViewerVariation = await getLogViewerVariation();
    const webviewTheme = getWebviewThemeVariation();
    const aiChatEnabled = getAiChatEnabled();
    const ideThemeKind = vscode.window.activeColorTheme.kind;

    this.webview.send({
      type: 'GIT_CONTEXT',
      ctx,
      org: this.config.orgIdentifier,
      project: this.config.projectIdentifier,
      defaultView,
      logViewerVariation,
      webviewTheme,
      ideThemeKind,
      aiChatEnabled
    });
  }

  /**
   * Set sidebar visibility state - pauses polling when hidden, resumes when visible
   */
  setSidebarVisible(visible: boolean): void {
    const wasActive = this.isActive();
    this.isSidebarVisible = visible;
    const isActive = this.isActive();

    if (isActive && !wasActive) {
      // Becoming active - do immediate refresh to show fresh data
      logger.debug('Poller', 'Sidebar visible and window focused - resuming polling');
      this.lastStatus = null; // Force refresh
      this.stopTimer();
      this.tick();
    } else if (!isActive && wasActive) {
      // Becoming inactive - stop polling to save resources
      logger.debug('Poller', 'Sidebar hidden or window unfocused - pausing polling');
      this.stopTimer();
    }
  }

  /**
   * Set window focus state - pauses polling when unfocused, resumes when focused
   */
  setWindowFocused(focused: boolean): void {
    const wasActive = this.isActive();
    this.isWindowFocused = focused;
    const isActive = this.isActive();

    if (isActive && !wasActive) {
      // Becoming active - do immediate refresh to show fresh data
      logger.debug('Poller', 'Window focused and sidebar visible - resuming polling');
      this.lastStatus = null; // Force refresh
      this.stopTimer();
      this.tick();
    } else if (!isActive && wasActive) {
      // Becoming inactive - stop polling to save resources
      logger.debug('Poller', 'Window unfocused - pausing polling');
      this.stopTimer();
    }
  }

  /**
   * Check if polling should be active (sidebar visible AND window focused)
   */
  private isActive(): boolean {
    return this.isSidebarVisible && this.isWindowFocused;
  }

  private async watchGit(): Promise<void> {
    this.gitWatcher?.dispose();

    const api = await getGitApi();
    if (!api) return;

    const attachToRepo = (repo: {
      state: {
        HEAD?: { name?: string; commit?: string };
        onDidChange: (l: () => void) => vscode.Disposable;
      };
      rootUri: vscode.Uri;
    }) => {
      return repo.state.onDidChange(async () => {
        const newSha = repo.state.HEAD?.commit;
        if (!newSha || newSha === this.lastTrackedSha) return;

        this.lastTrackedSha = newSha;
        this.lastStatus = null;
        this.lastGraphHash = null;
        this.lastPlanExecutionId = null;
        this.waitingSince = Date.now();
        this.diagnostics.clearAll();

        // Send updated GIT_CONTEXT when git state changes
        await this.sendGitContext();

        this.stopTimer();
        this.tick();
      });
    };

    const disposables: vscode.Disposable[] = [];

    for (const repo of api.repositories) {
      disposables.push(attachToRepo(repo));
    }

    disposables.push(
      api.onDidOpenRepository(repo => {
        disposables.push(attachToRepo(repo));
        this.tick();
      })
    );

    this.gitWatcher = vscode.Disposable.from(...disposables);
  }

  private async tick(): Promise<void> {
    // Prevent concurrent executions - if tick is already running, queue a
    // follow-up instead of dropping it. Otherwise a refresh() issued during an
    // in-flight tick (e.g. right after a re-run/abort) is lost, and the stale
    // in-flight tick reschedules at the slow heartbeat — stranding the newly
    // registered detail execution on "loading" for up to 2 minutes.
    if (this.isTickRunning) {
      logger.debug('Poller', 'Tick already running - queueing pending refresh');
      this.pendingRefresh = true;
      return;
    }

    // Skip API calls if sidebar is not visible or window is unfocused
    if (!this.isActive()) {
      logger.debug('Poller', 'Skipping tick - sidebar hidden or window unfocused');
      return;
    }

    logger.debug('Poller', '▶ Tick starting');
    this.isTickRunning = true;
    try {
      const ctx = await getGitContext();

      // GIT_CONTEXT is sent only when something actually changes:
      // - On initialization (extension.ts startPoller)
      // - When FME flags update (fmeClient.ts SDK_UPDATE callback)
      // - When git changes (git watcher onDidChange)
      // - When theme changes (extension.ts theme listener)
      // - When config changes (extension.ts config handlers)
      // No need to spam it every tick when nothing has changed

      // Track if any execution is running (live or detail)
      let anyRunning = false;

      // Poll detail execution if one is being viewed (independent of git context)
      if (this.detailExecutionId) {
        try {
          const detailResp = await this.client.get<ExecutionDetailResponse>(
            `/pipeline/api/pipelines/execution/v2/${this.detailExecutionId}`,
            { renderFullBottomGraph: 'true' }
          );

          const detailExec = detailResp.data?.pipelineExecutionSummary;
          const detailGraph = detailResp.data?.executionGraph;

          if (detailExec) {
            this.detailWaitingSince = null; // Found it — stop waiting
            const currentStatus = (detailExec.status as string).toUpperCase();
            detailExec.status = currentStatus;
            const isTerminal = TERMINAL_STATUSES.has(currentStatus);
            const harnessUrl = this.buildExecutionUrl(detailExec);
            const currentGraphHash = hashExecutionGraph(detailGraph ?? null);

            // Send update if status OR graph changed (to catch step-level updates)
            if (currentStatus !== this.detailLastStatus || currentGraphHash !== this.detailLastGraphHash) {
              this.detailLastStatus = currentStatus;
              this.detailLastGraphHash = currentGraphHash;
              await dispatchModules(
                detailExec, detailGraph ?? null,
                this.client, this.config, this.diagnostics, this.webview,
                ctx, harnessUrl
              );
            } else {
              // Status unchanged, just send lightweight update
              this.webview.send({
                type: 'HISTORY_DETAIL',
                execution: detailExec,
                executionGraph: detailGraph,
                harnessUrl,
                commitWebUrl: undefined // Will be set by module dispatch if needed
              });

              // Send OPA update even when status unchanged
              if (detailExec.governanceMetadata) {
                const policyUrl = harnessUrl
                  ? harnessUrl.replace(/\/pipeline$/, '') + '/policy-evaluations'
                  : undefined;
                const policy = {
                  status: detailExec.governanceMetadata.status ?? 'UNKNOWN',
                  details: (detailExec.governanceMetadata.details ?? []).flatMap(policySet =>
                    (policySet.policyMetadata ?? []).map(p => ({
                      policyName: p.policyName ?? policySet.policySetName ?? 'Policy',
                      status:     p.status ?? 'UNKNOWN',
                      denyMessages: p.denyMessages,
                    }))
                  ),
                  policyUrl,
                };
                this.webview.send({ type: 'OPA_UPDATE', policy });
              }
            }

            // If detail execution became terminal, stop tracking it
            if (isTerminal) {
              this.clearDetailExecution();
            } else {
              anyRunning = true; // Keep polling active
            }
          } else {
            // 200 OK but no summary yet (execution not fully created).
            // Keep polling actively while inside the waiting window.
            if (this.detailWaitingSince && (Date.now() - this.detailWaitingSince) < WAITING_TIMEOUT_MS) {
              anyRunning = true;
            } else {
              this.detailWaitingSince = null;
            }
          }
        } catch (error) {
          // A freshly re-run execution may 404 until it is queryable. Keep
          // polling actively while inside the waiting window rather than
          // backing off to the slow heartbeat (which would strand it loading).
          if (this.detailWaitingSince && (Date.now() - this.detailWaitingSince) < WAITING_TIMEOUT_MS) {
            anyRunning = true;
            logger.debug('Poller', 'Detail fetch failed but within waiting window - keeping active poll');
          } else {
            this.detailWaitingSince = null;
            console.error('[PipelinePoller] Error fetching detail execution:', error);
          }
        }
      }

      if (!ctx) {
        logger.debug('Poller', 'No git context, sending NO_EXECUTION');
        this.webview.send({ type: 'NO_EXECUTION', ctx: null });

        // Schedule next poll based on whether detail execution is running
        logger.debug('Poller', 'No git context - scheduling based on anyRunning:', anyRunning);
        if (anyRunning) {
          this.scheduleActive();
        } else {
          this.scheduleHeartbeat();
        }
        return;
      }

      this.lastTrackedSha = ctx.commitSha;

      const executions = await this.client.post<ExecutionSummaryResponse>(
        '/pipeline/api/pipelines/execution/summary',
        {
          filterType: 'PipelineExecution',
          timeRange: { timeRangeFilterType: 'LAST_7_DAYS' },
        },
        { page: '0', size: '20', sort: 'startTs,DESC' }
      );

      const content = executions.data?.content ?? [];
      const matched = content.filter((e: ExecutionSummary) =>
        executionMatchesSha(e, ctx.commitSha)
      );

      if (!matched.length) {
        const lastKnown = content[0];
        if (lastKnown && this.lastPlanExecutionId) {
          this.webview.send({ type: 'SHA_MISMATCH', lastExecution: lastKnown });
        } else {
          this.webview.send({ type: 'NO_EXECUTION', ctx });
        }

        // If we recently got a new commit, keep polling at 1s for up to WAITING_TIMEOUT_MS
        // OR if detail execution is running, keep polling actively
        if ((this.waitingSince && (Date.now() - this.waitingSince) < WAITING_TIMEOUT_MS) || anyRunning) {
          this.scheduleActive();
        } else {
          this.waitingSince = null;
          this.scheduleHeartbeat();
        }
        return;
      }

      // Found an execution — stop the waiting timeout
      this.waitingSince = null;

      // Only show the MOST RECENT execution for this commit (first in the list since sorted by startTs DESC)
      const match = matched[0];
      if (match) {
        if (match.planExecutionId !== this.lastPlanExecutionId) {
          this.lastPlanExecutionId = match.planExecutionId;
          this.lastStatus = null;
          this.lastGraphHash = null;
          this.diagnostics.clearAll();
        }

        const detail = await this.client.get<ExecutionDetailResponse>(
          `/pipeline/api/pipelines/execution/v2/${match.planExecutionId}`,
          { renderFullBottomGraph: 'true' }
        );

        const execDetail   = detail.data?.pipelineExecutionSummary;
        const execGraph    = detail.data?.executionGraph;
        if (execDetail) {

        // Store raw execution data for export/debugging
        this.lastExecutionData = { execution: execDetail, executionGraph: execGraph ?? null };

        // Log full response to debug output channel
        if (this.outputChannel) {
          this.outputChannel.appendLine(`\n${'='.repeat(80)}`);
          this.outputChannel.appendLine(`[${new Date().toISOString()}] Pipeline Execution: ${execDetail.name ?? execDetail.pipelineIdentifier}`);
          this.outputChannel.appendLine(`Status: ${execDetail.status} | Plan ID: ${match.planExecutionId}`);
          this.outputChannel.appendLine(`${'='.repeat(80)}`);
          this.outputChannel.appendLine(JSON.stringify({ execution: execDetail, executionGraph: execGraph }, null, 2));
          this.outputChannel.appendLine(`${'='.repeat(80)}\n`);
        }

        // Harness returns mixed-case statuses — normalise for reliable set lookups
        const currentStatus = (execDetail.status as string).toUpperCase();
        execDetail.status   = currentStatus;
        const isTerminal    = TERMINAL_STATUSES.has(currentStatus);

        logger.debug('Poller', 'Status normalization:', {
          rawStatus: (detail.data?.pipelineExecutionSummary?.status as any),
          normalizedStatus: currentStatus,
          isTerminal,
          terminalStatuses: Array.from(TERMINAL_STATUSES)
        });

        const harnessUrl = this.buildExecutionUrl(execDetail);
        const currentGraphHash = hashExecutionGraph(execGraph ?? null);

        // Send update if status OR graph changed (to catch step-level updates)
        if (currentStatus !== this.lastStatus || currentGraphHash !== this.lastGraphHash) {
          this.lastStatus = currentStatus;
          this.lastGraphHash = currentGraphHash;
          await dispatchModules(
            execDetail, execGraph ?? null,
            this.client, this.config, this.diagnostics, this.webview,
            ctx, harnessUrl, match.executionTriggerInfo
          );
        } else {
          this.webview.send({
            type: 'EXECUTION_UPDATE',
            execution: { ...execDetail, executionTriggerInfo: match.executionTriggerInfo },
            executionGraph: execGraph,
            isTerminal,
            harnessUrl: this.buildExecutionUrl(execDetail),
            commitWebUrl: ctx.commitWebUrl,
          });

          // Send OPA update even when status unchanged (governanceMetadata may be populated after initial poll)
          if (execDetail.governanceMetadata) {
            const policyUrl = harnessUrl
              ? harnessUrl.replace(/\/pipeline$/, '') + '/policy-evaluations'
              : undefined;
            const policy = {
              status: execDetail.governanceMetadata.status ?? 'UNKNOWN',
              details: (execDetail.governanceMetadata.details ?? []).flatMap(policySet =>
                (policySet.policyMetadata ?? []).map(p => ({
                  policyName: p.policyName ?? policySet.policySetName ?? 'Policy',
                  status:     p.status ?? 'UNKNOWN',
                  denyMessages: p.denyMessages,
                }))
              ),
              policyUrl,
            };
            this.webview.send({ type: 'OPA_UPDATE', policy });
          }
        }

        logger.debug('Poller', 'Execution status check:', {
          planExecutionId: match.planExecutionId,
          status: currentStatus,
          isTerminal,
          willContinuePolling: !isTerminal
        });
        if (!isTerminal) anyRunning = true;
        }
      }

      logger.debug('Poller', 'Scheduling decision:', {
        anyRunning,
        hasDetailExec: !!this.detailExecutionId,
        action: anyRunning ? 'scheduleActive (1s)' : 'scheduleHeartbeat (120s)'
      });

      if (anyRunning) {
        this.scheduleActive();
      } else {
        // Terminal — schedule slow heartbeat to stay responsive for git changes, detail execution switches, etc.
        this.scheduleHeartbeat();
      }

    } catch (error) {
      console.error('[PipelinePoller] ✗ Tick error:', error);
      handleApiError(error, 'PipelinePoller.tick');
      this.scheduleHeartbeat();
    } finally {
      logger.debug('Poller', '◼ Tick complete, releasing lock');
      this.isTickRunning = false;
      // A refresh was requested while this tick was in flight — run it now so
      // the request (e.g. post re-run/abort) takes effect immediately rather
      // than waiting for the scheduled timer.
      if (this.pendingRefresh) {
        this.pendingRefresh = false;
        logger.debug('Poller', 'Running queued pending refresh');
        this.stopTimer();
        void this.tick();
      }
    }
  }

  buildExecutionUrl(exec: ExecutionDetail): string {
    const { baseUrl, accountIdentifier, orgIdentifier, projectIdentifier } = this.config;
    return `${baseUrl}/ng/account/${accountIdentifier}/all/orgs/${orgIdentifier}/projects/${projectIdentifier}/pipelines/${exec.pipelineIdentifier}/deployments/${exec.planExecutionId}/pipeline`;
  }

  private scheduleActive(): void {
    this.stopTimer();
    this.timer = setTimeout(() => this.tick(), INTERVAL_ACTIVE_MS);
  }

  private scheduleHeartbeat(): void {
    this.stopTimer();
    this.timer = setTimeout(() => this.tick(), INTERVAL_HEARTBEAT_MS);
  }

  private stopTimer(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  getLastExecutionData() {
    return this.lastExecutionData;
  }

  /**
   * Register a detail execution to poll (for running executions in history detail mode)
   */
  setDetailExecution(planExecutionId: string): void {
    this.detailExecutionId = planExecutionId;
    this.detailLastStatus = null;
    this.detailLastGraphHash = null;
    this.detailWaitingSince = Date.now(); // allow time for a freshly-created execution to appear
    // Start polling immediately
    this.refresh();
  }

  /**
   * Unregister detail execution (when user navigates away or execution completes)
   */
  clearDetailExecution(): void {
    this.detailExecutionId = null;
    this.detailLastStatus = null;
    this.detailLastGraphHash = null;
  }

  dispose(): void {
    this.stopTimer();
    this.gitWatcher?.dispose();
    this.gitWatcher = null;
  }
}
