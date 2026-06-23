import * as vscode from 'vscode';
import { GitContext } from '../git/gitContext';
import { ExecutionDetail, ExecutionSummary, ExecutionGraph, AidaRca, PolicyEvaluation, BuildCost } from '../api/types';
import { PipelineListItem } from '../api/pipelineService';
import { logger } from '../utils/logger';

export type WebviewMessage =
  | { type: 'GIT_CONTEXT';      ctx: GitContext | null; org?: string; project?: string; defaultView?: string; logViewerVariation?: string; webviewTheme?: 'simple' | 'enhanced'; ideThemeKind?: number; aiChatEnabled?: boolean }
  | { type: 'EXECUTION_UPDATE'; execution: ExecutionDetail; executionGraph?: ExecutionGraph | null; isTerminal?: boolean; harnessUrl?: string; commitWebUrl?: string }
  | { type: 'LOG_CHUNK';        nodeId: string; lines: string[]; autoExpand?: boolean }
  | { type: 'CD_UPDATE';        deployments: unknown }
  | { type: 'STO_SUMMARY';      count: number; high: number; medium: number; critical: number }
  | { type: 'TI_SUMMARY';       failed: number; flaky: number; selected: number; total: number }
  | { type: 'SSCA_SUMMARY';     flagged: number }
  | { type: 'AIDA_UPDATE';      stageId: string; rca: AidaRca }
  | { type: 'OPA_UPDATE';       policy: PolicyEvaluation }
  | { type: 'CCM_UPDATE';       cost: BuildCost }
  | { type: 'NO_EXECUTION';     ctx: GitContext | null }
  | { type: 'SHA_MISMATCH';     lastExecution: ExecutionSummary }
  | { type: 'AUTH_ERROR' }
  | { type: 'LOGS_UNAVAILABLE' }
  | { type: 'APPROVAL_UPDATE'; planExecutionId: string; approvers?: string[]; userGroups?: string[]; deadline?: number; minimumCount?: number; canApprove?: boolean; stageIdentifier?: string }
  | { type: 'EXTERNAL_APPROVAL_UPDATE'; planExecutionId: string; approvalType: 'Jira' | 'ServiceNow'; ticketId: string; ticketUrl?: string; projectKey?: string; issueType?: string; ticketType?: string; approvalCriteria?: string; rejectionCriteria?: string; stageIdentifier?: string }
  | { type: 'PIPELINE_LIST';   pipelines: PipelineListItem[]; pinnedPipelines?: string[] }
  | { type: 'HISTORY_LIST';    executions: ExecutionSummary[]; total: number; page: number }
  | { type: 'HISTORY_DETAIL';  execution: ExecutionDetail; executionGraph?: ExecutionGraph | null; harnessUrl?: string; commitWebUrl?: string; aida?: unknown; opa?: unknown; cost?: unknown; sto?: unknown; ti?: unknown; ssca?: unknown; cd?: unknown; approval?: unknown; externalApproval?: unknown }
  | { type: 'STEP_LOGS_LOADING'; nodeId: string }
  | { type: 'STEP_LOGS_EMPTY'; nodeId: string }
  | { type: 'STEP_LOGS_ERROR'; nodeId: string; error: string }
  | { type: 'STEP_LOGS_OPENED_IN_TAB'; nodeId: string }
  | { type: 'DEFAULT_VIEW_SAVED'; view: string }
  | { type: 'EXECUTION_ERROR'; message: string }
  | { type: 'STATE_UPDATE'; aiDetection: { tools: Array<{ id: string; name: string; sub: string | null; mcpReady: boolean }>; activeTool: string | null; mcpConfigPath: string | null; mcpScope: { project: { path: string; configured: boolean } | null; global: { path: string; configured: boolean }; activeScope: 'project' | 'global' | null; conflict: boolean } } }
  | { type: 'AI_RESPONSE'; content: string; toolCalls?: Array<{ name: string; args?: unknown }>; durationMs?: number }
  | { type: 'AI_LAUNCHED'; tool: string }
  | { type: 'AI_CONFIG_DONE'; tool: string; scope: 'project' | 'global'; path: string }
  | { type: 'AI_ERROR'; message: string }
  | { type: 'RERUN_SUCCESS'; newPlanExecutionId: string }
  | { type: 'RERUN_CANCELLED' }
  | { type: 'RERUN_ERROR' }
  | { type: 'ABORT_SUCCESS'; planExecutionId: string }
  | { type: 'ABORT_CANCELLED' }
  | { type: 'ABORT_ERROR' };

export class WebviewBridge {
  private view: vscode.WebviewView | undefined;
  private queue: WebviewMessage[] = [];
  private messageHandler: ((msg: unknown) => void) | undefined;
  private handlerDisposable: vscode.Disposable | undefined;
  private readyCallback: (() => void) | undefined;
  private webviewReady = false;

  /**
   * Called by SidebarProvider when the webview view is created.
   * HTML must be set on the view BEFORE calling setView so that the script
   * loads and the WEBVIEW_READY handshake can fire before we flush the queue.
   */
  setView(view: vscode.WebviewView): void {
    this.view = view;
    this.webviewReady = false;

    // Single combined handler: catches WEBVIEW_READY (once) and routes all
    // subsequent messages to the registered extension handler.
    this.handlerDisposable?.dispose();
    this.handlerDisposable = view.webview.onDidReceiveMessage((msg: unknown) => {
      const m = msg as { type?: string };

      logger.debug('WebviewBridge', 'Received message from webview:', m?.type);

      if (!this.webviewReady && m?.type === 'WEBVIEW_READY') {
        logger.debug('WebviewBridge', 'WEBVIEW_READY received, setting webviewReady = true');
        this.webviewReady = true;
        this.flushQueue(view);
        return; // don't forward WEBVIEW_READY to extension handler
      }

      logger.debug('WebviewBridge', 'Forwarding message to extension handler, webviewReady:', this.webviewReady, 'hasHandler:', !!this.messageHandler);
      this.messageHandler?.(msg);
    });
  }

  private flushQueue(view: vscode.WebviewView): void {
    // Keep only the latest message per type to avoid sending stale state
    // For step-related messages, key by type+nodeId so each step gets its own message
    const seen = new Set<string>();
    const toSend = [...this.queue].reverse().filter(m => {
      const stepMessageTypes = ['LOG_CHUNK', 'STEP_LOGS_LOADING', 'STEP_LOGS_EMPTY', 'STEP_LOGS_ERROR', 'STEP_LOGS_OPENED_IN_TAB'];
      const key = stepMessageTypes.includes(m.type) ? `${m.type}:${(m as any).nodeId}` : m.type;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).reverse();

    logger.debug('WebviewBridge', 'Flushing queue', { queueSize: this.queue.length, toSendSize: toSend.length, types: toSend.map(m => m.type) });

    this.queue = [];
    for (const msg of toSend) {
      view.webview.postMessage(msg);
    }

    // Tell extension.ts the sidebar is ready so it can trigger a fresh poll
    this.readyCallback?.();
  }

  send(message: WebviewMessage): void {
    if (this.view && this.webviewReady) {
      this.view.webview.postMessage(message);
      if (message.type === 'HISTORY_LIST') {
        logger.debug('WebviewBridge', 'Sent HISTORY_LIST directly', { count: (message as any).executions?.length });
      }
      return;
    }
    // Queue until the webview is ready; keep only latest per type
    // Step-related messages (LOG_CHUNK, STEP_LOGS_*) are per-nodeId, so don't deduplicate
    const stepMessageTypes = ['LOG_CHUNK', 'STEP_LOGS_LOADING', 'STEP_LOGS_EMPTY', 'STEP_LOGS_ERROR', 'STEP_LOGS_OPENED_IN_TAB'];
    if (!stepMessageTypes.includes(message.type)) {
      this.queue = this.queue.filter(m => m.type !== message.type);
    }
    this.queue.push(message);
    if (message.type === 'HISTORY_LIST') {
      logger.debug('WebviewBridge', 'Queued HISTORY_LIST (webviewReady:', this.webviewReady, 'hasView:', !!this.view, ')');
    }
  }

  onMessage(handler: (msg: unknown) => void): void {
    logger.debug('WebviewBridge', 'onMessage handler registered');
    this.messageHandler = handler;
    // The combined handler in setView calls this.messageHandler dynamically,
    // so no re-registration needed even if onMessage is called after setView.
  }

  /** Invoked once when the sidebar webview signals it is ready. */
  onReady(cb: () => void): void {
    this.readyCallback = cb;
  }

  dispose(): void {
    this.handlerDisposable?.dispose();
  }
}
