import * as vscode from 'vscode';
import { HarnessClient } from '../api/harnessClient';
import { HarnessConfig } from '../config/configManager';
import { DiagnosticsManager } from '../features/diagnosticsManager';
import { WebviewBridge } from '../ui/webviewBridge';
import { getGitContext, getGitApi, executionMatchesSha } from '../git/gitContext';
import { handleApiError } from '../utils/errorHandler';
import { dispatchModules } from './executionDispatcher';
import { ExecutionSummary, ExecutionDetail, ExecutionGraph } from '../api/types';

const INTERVAL_ACTIVE_MS    = 1_000;   // while pipeline is running or waiting for execution
const INTERVAL_HEARTBEAT_MS = 120_000; // idle safety net
// After a new commit, keep polling at 1s for up to 5 minutes before giving up
const WAITING_TIMEOUT_MS    = 5 * 60 * 1000;

const TERMINAL_STATUSES = new Set([
  'SUCCESS', 'FAILED', 'ABORTED', 'EXPIRED', 'IGNOREFAILED', 'POLICY_EVALUATION_FAILURE'
]);

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

  // Track detail execution being viewed (for polling running executions in history detail mode)
  private detailExecutionId: string | null = null;
  private detailLastStatus: string | null = null;

  // Visibility tracking - pause polling when sidebar is hidden or window unfocused
  private isSidebarVisible: boolean = false;
  private isWindowFocused: boolean = true; // Assume focused initially

  constructor(
    private readonly client: HarnessClient,
    private readonly config: HarnessConfig,
    private readonly diagnostics: DiagnosticsManager,
    private readonly webview: WebviewBridge,
    private readonly outputChannel?: vscode.OutputChannel
  ) {}

  start(): void {
    this.watchGit();
    this.tick();
  }

  /** Called by the refresh button in the webview. */
  refresh(): void {
    this.lastStatus = null;
    this.stopTimer();
    this.tick();
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
      console.log('[PipelinePoller] Sidebar visible and window focused - resuming polling');
      this.lastStatus = null; // Force refresh
      this.stopTimer();
      this.tick();
    } else if (!isActive && wasActive) {
      // Becoming inactive - stop polling to save resources
      console.log('[PipelinePoller] Sidebar hidden or window unfocused - pausing polling');
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
      console.log('[PipelinePoller] Window focused and sidebar visible - resuming polling');
      this.lastStatus = null; // Force refresh
      this.stopTimer();
      this.tick();
    } else if (!isActive && wasActive) {
      // Becoming inactive - stop polling to save resources
      console.log('[PipelinePoller] Window unfocused - pausing polling');
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
      return repo.state.onDidChange(() => {
        const newSha = repo.state.HEAD?.commit;
        if (!newSha || newSha === this.lastTrackedSha) return;

        this.lastTrackedSha = newSha;
        this.lastStatus = null;
        this.lastPlanExecutionId = null;
        this.waitingSince = Date.now();
        this.diagnostics.clearAll();

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
    // Skip API calls if sidebar is not visible or window is unfocused
    if (!this.isActive()) {
      console.log('[PipelinePoller] Skipping tick - sidebar hidden or window unfocused');
      return;
    }

    try {
      const ctx = await getGitContext();

      // Always send GIT_CONTEXT with org/project info (even without git repo)
      const defaultView = vscode.workspace.getConfiguration('harness').get<string>('defaultView', 'thisCommit');
      const { getLogViewerVariation, getWebviewThemeVariation, getAiChatEnabled } = await import('../fme/fmeClient');
      const logViewerVariation = await getLogViewerVariation();
      const webviewTheme = getWebviewThemeVariation();
      const aiChatEnabled = getAiChatEnabled();
      const ideThemeKind = vscode.window.activeColorTheme.kind;
      console.log('[Poller] Sending GIT_CONTEXT with theme:', {
        webviewTheme,
        ideThemeKind,
        ideThemeName: ideThemeKind === 1 ? 'Light' : ideThemeKind === 2 ? 'Dark' : ideThemeKind === 3 ? 'HighContrast' : 'HighContrastLight',
        hasGitContext: !!ctx,
        aiChatEnabled
      });
      this.webview.send({ type: 'GIT_CONTEXT', ctx, org: this.config.orgIdentifier, project: this.config.projectIdentifier, defaultView, logViewerVariation, webviewTheme, ideThemeKind, aiChatEnabled });

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
            const currentStatus = (detailExec.status as string).toUpperCase();
            detailExec.status = currentStatus;
            const isTerminal = TERMINAL_STATUSES.has(currentStatus);
            const harnessUrl = this.buildExecutionUrl(detailExec);

            // Only send update if status changed (to avoid constant re-renders)
            if (currentStatus !== this.detailLastStatus) {
              this.detailLastStatus = currentStatus;
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
          }
        } catch (error) {
          console.error('[PipelinePoller] Error fetching detail execution:', error);
          // Don't fail the whole tick if detail fetch fails
        }
      }

      if (!ctx) {
        this.webview.send({ type: 'NO_EXECUTION', ctx: null });

        // Schedule next poll based on whether detail execution is running
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
        if (this.waitingSince && (Date.now() - this.waitingSince) < WAITING_TIMEOUT_MS) {
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

        console.log('[PipelinePoller] Status normalization:', {
          rawStatus: (detail.data?.pipelineExecutionSummary?.status as any),
          normalizedStatus: currentStatus,
          isTerminal,
          terminalStatuses: Array.from(TERMINAL_STATUSES)
        });

        const harnessUrl = this.buildExecutionUrl(execDetail);

        if (currentStatus !== this.lastStatus) {
          this.lastStatus = currentStatus;
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

        console.log('[PipelinePoller] Execution status check:', {
          planExecutionId: match.planExecutionId,
          status: currentStatus,
          isTerminal,
          willContinuePolling: !isTerminal
        });
        if (!isTerminal) anyRunning = true;
        }
      }

      console.log('[PipelinePoller] Scheduling decision:', {
        anyRunning,
        action: anyRunning ? 'scheduleActive (1s)' : 'stopTimer'
      });

      if (anyRunning) {
        this.scheduleActive();
      } else {
        // Terminal — stop polling. Webview will show a refresh button.
        this.stopTimer();
      }

    } catch (error) {
      handleApiError(error, 'PipelinePoller.tick');
      this.scheduleHeartbeat();
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
    // Start polling immediately
    this.refresh();
  }

  /**
   * Unregister detail execution (when user navigates away or execution completes)
   */
  clearDetailExecution(): void {
    this.detailExecutionId = null;
    this.detailLastStatus = null;
  }

  dispose(): void {
    this.stopTimer();
    this.gitWatcher?.dispose();
    this.gitWatcher = null;
  }
}
