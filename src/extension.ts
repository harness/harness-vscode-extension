import * as vscode from 'vscode';
import { SecretStore } from './auth/secretStore';
import { runOnboardingIfNeeded, runOnboarding, runWorkspaceSetup, runWorkspaceOverride } from './auth/onboarding';
import { ConfigManager } from './config/configManager';
import { HarnessClient } from './api/harnessClient';
import { PipelinePoller } from './pipeline/pipelinePoller';
import { SidebarProvider } from './ui/sidebarProvider';
import { WebviewBridge } from './ui/webviewBridge';
import { StatusBarItem } from './ui/statusBar';
import { DiagnosticsManager } from './features/diagnosticsManager';
import { TiCodeActionProvider } from './features/tiAnnotations';
import { registerFfDecorations } from './features/ffDecorations';
import { submitApproval } from './api/approvalService';
import { rerunPipeline } from './api/rerunService';
import { dispatchModules } from './pipeline/executionDispatcher';
import { initFmeClient, destroyFmeClient, getLogViewerVariation } from './fme/fmeClient';
import { LogContentProvider, LOG_SCHEME } from './logs/logContentProvider';
import { openLogAsEditorTab } from './logs/logEditorTab';
import { detectAITools } from './ai/detector';
import { configureMCP } from './ai/mcpConfigurer';
import { buildPrompt } from './ai/promptBuilder';
import { launchAI } from './ai/launcher';
import { logger } from './utils/logger';

// Global state key for AI tool preference
const AI_TOOL_PREFERENCE_KEY = 'harness.aiToolPreference';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const secretStore    = new SecretStore(context.secrets);
  const configManager  = new ConfigManager(secretStore);
  const diagnostics    = new DiagnosticsManager();
  const bridge         = new WebviewBridge();
  const statusBar      = new StatusBarItem();
  const outputChannel  = vscode.window.createOutputChannel('Harness');

  // Initialize logger with OutputChannel
  logger.initialize(outputChannel);

  context.subscriptions.push(diagnostics, statusBar, outputChannel);

  // Helper to get/set AI tool preference
  const getAIToolPreference = (): string | undefined => {
    return context.globalState.get<string>(AI_TOOL_PREFERENCE_KEY);
  };
  const setAIToolPreference = async (toolId: string): Promise<void> => {
    await context.globalState.update(AI_TOOL_PREFERENCE_KEY, toolId);
  };

  // ── Log Content Provider (for editor tab logs) ────
  const logProvider = new LogContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(LOG_SCHEME, logProvider),
    logProvider
  );

  // ── TI Code Actions ───────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider('*', new TiCodeActionProvider(), {
      providedCodeActionKinds: TiCodeActionProvider.providedCodeActionKinds,
    })
  );

  // ── Poller state ──────────────────────────────────
  let poller: PipelinePoller | undefined;
  let currentClient: HarnessClient | null = null;
  let currentConfig = await configManager.getConfig();

  // ── FME Client (Feature Management) ───────────────
  // Initialize BEFORE sidebar so theme variation is ready when webview loads
  // Priority: VS Code settings > environment variable > default embedded key
  // Default key enables feature flags for all end users (client SDK keys are public)
  const userSdkKey = vscode.workspace.getConfiguration('harness').get<string>('fmeSdkKey', '');
  const envSdkKey = process.env.HARNESS_FME_SDK_KEY;
  const fmeSdkKey = userSdkKey || envSdkKey || undefined; // undefined = use default in fmeClient

  if (currentConfig) {
    // Wait for FME to be ready (with timeout) so sidebar gets correct theme
    try {
      await initFmeClient(fmeSdkKey, currentConfig, () => {
        // Callback when FME flags update - send new GIT_CONTEXT to webview
        // Run in background to avoid blocking poller or creating race conditions
        (async () => {
          logger.debug('FME', 'Flags updated, sending new GIT_CONTEXT to webview');
          const ctx = await gitCtx.getGitContext();
          const config = await configManager.getConfig();
          if (config) {
            const defaultView = vscode.workspace.getConfiguration('harness').get<string>('defaultView', 'pipelines');
            const { getLogViewerVariation, getWebviewThemeVariation, getAiChatEnabled } = await import('./fme/fmeClient');
            const logViewerVariation = await getLogViewerVariation();
            const webviewTheme = getWebviewThemeVariation();
            const aiChatEnabled = getAiChatEnabled();
            const ideThemeKind = vscode.window.activeColorTheme.kind;
            bridge.send({
              type: 'GIT_CONTEXT',
              ctx,
              org: config.orgIdentifier,
              project: config.projectIdentifier,
              defaultView,
              logViewerVariation,
              webviewTheme,
              ideThemeKind,
              aiChatEnabled,
            });
          }
        })().catch(err => {
          logger.warn('FME', 'Failed to send updated GIT_CONTEXT:', err);
        });
      });
    } catch (err) {
      logger.warn('FME', 'Failed to initialize:', err);
    }
  }

  // ── Sidebar ───────────────────────────────────────
  // Registered AFTER FME init so theme variation is available immediately
  const sidebarProvider = new SidebarProvider(context.extensionUri, bridge);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('harness.sidebar', sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // Wire up visibility tracking to pause/resume polling
  sidebarProvider.onVisibilityChange((visible) => {
    logger.debug('Extension', `Sidebar visibility changed: ${visible}`);
    poller?.setSidebarVisible(visible);
  });

  // Wire up window focus tracking to pause/resume polling
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      logger.debug('Extension', `Window focus changed: ${state.focused}`);
      poller?.setWindowFocused(state.focused);
    })
  );

  async function startPoller(): Promise<void> {
    poller?.dispose();
    poller = undefined;
    currentClient = null;

    const config = await configManager.getConfig();
    if (!config) {
      statusBar.setNotConfigured();
      bridge.send({ type: 'AUTH_ERROR' });
      return;
    }

    currentConfig = config;
    currentClient = new HarnessClient(config);
    poller = new PipelinePoller(currentClient, config, diagnostics, bridge, outputChannel);
    poller.start();

    // Initialize poller with current window focus state
    poller.setWindowFocused(vscode.window.state.focused);
  }

  // Route webview messages back to VS Code commands
  bridge.onMessage(async (msg: unknown) => {
    const m = msg as { type: string; command?: string; url?: string; approvalInstanceId?: string; action?: string; comments?: string; page?: number; filter?: string; planExecutionId?: string; pipelineIdentifier?: string; pipelineId?: string; pinnedPipelines?: string[] };

    logger.debug('Extension', 'Bridge received message:', m.type);

    if (m.type === 'command') {
      if (m.command === 'harness.openUrl' && m.url) {
        vscode.env.openExternal(vscode.Uri.parse(m.url));
      } else if (m.command) {
        vscode.commands.executeCommand(m.command);
      }
    } else if (m.type === 'approval' && (m as any).planExecutionId && currentConfig) {
      const planExecutionId = (m as any).planExecutionId as string;
      const action = m.action === 'REJECT' ? 'REJECT' : 'APPROVE';
      try {
        await submitApproval(currentConfig, planExecutionId, action, m.comments);
        vscode.window.showInformationMessage(`Harness: Approval ${action.toLowerCase()}d successfully.`);
        poller?.refresh();
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Harness: Failed to ${action.toLowerCase()} — ${msg}`);
      }
    } else if (m.type === 'rerunPipeline' && m.planExecutionId && m.pipelineIdentifier && currentConfig) {
      const planExecutionId = m.planExecutionId;
      const pipelineIdentifier = m.pipelineIdentifier;
      try {
        const result = await rerunPipeline(currentConfig, pipelineIdentifier, planExecutionId);
        const newPlanExecutionId = result.planExecutionId;
        vscode.window.showInformationMessage(`Harness: Pipeline re-run triggered successfully.`);

        // Wait a moment for the new execution to be created, then fetch and display it
        setTimeout(async () => {
          if (currentConfig && newPlanExecutionId) {
            await fetchExecutionDetail(currentConfig, bridge, diagnostics, newPlanExecutionId);
            // Register with poller for continuous updates
            if (poller) {
              poller.setDetailExecution(newPlanExecutionId);
            }
          }
        }, 2000);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Harness: Failed to re-run pipeline — ${msg}`);
      }
    } else if (m.type === 'fetchHistory') {
      logger.debug('Extension', 'fetchHistory message received', { page: m.page, filter: m.filter, pageSize: m.pageSize, pipelineId: m.pipelineId, hasConfig: !!currentConfig });
      if (!currentConfig) {
        // Silent return - empty state in webview will handle unconfigured state
        return;
      }
      await fetchExecutionHistory(currentConfig, bridge, m.page ?? 0, m.filter ?? 'all', m.pageSize ?? 15, m.pipelineId);
    } else if (m.type === 'fetchExecutionDetail') {
      logger.debug('Extension', 'fetchExecutionDetail message received', { planExecutionId: m.planExecutionId, hasConfig: !!currentConfig });
      if (!currentConfig || !m.planExecutionId) {
        vscode.window.showErrorMessage('Harness: Cannot fetch execution detail');
        return;
      }
      await fetchExecutionDetail(currentConfig, bridge, diagnostics, m.planExecutionId);
      // Register with poller for continuous updates if execution is running
      if (poller) {
        poller.setDetailExecution(m.planExecutionId);
      }
    } else if (m.type === 'fetchStepLogs') {
      if (!currentConfig) {
        return;
      }
      const msg = m as any;
      if (msg.logBaseKey && msg.nodeId) {
        // Run log fetch in background - don't block message handler or poller
        fetchStepLogsOnDemand(currentConfig, bridge, logProvider, msg.logBaseKey, msg.nodeId, msg.stepName, msg.stageName, msg.pipelineName, msg.planExecutionId, msg.status, msg.durationMs);
      }
    } else if (m.type === 'setDefaultView') {
      const msg = m as any;
      await vscode.workspace.getConfiguration('harness').update(
        'defaultView',
        msg.view,
        vscode.ConfigurationTarget.Global
      );
      bridge.send({
        type: 'DEFAULT_VIEW_SAVED',
        view: msg.view
      });
    } else if (m.type === 'clearExecution') {
      // Clear tracked execution when user navigates away from execution detail
      logger.debug('Extension', 'Clearing tracked execution (user navigated away)');
      currentViewedExecution = null;
      // Stop polling the detail execution
      if (poller) {
        poller.clearDetailExecution();
      }
    } else if (m.type === 'openSettings') {
      const msg = m as any;
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        msg.key
      );
    } else if (m.type === 'fetchPipelines') {
      logger.debug('Extension', 'fetchPipelines message received', { hasConfig: !!currentConfig });
      if (!currentConfig) {
        // Silent return - empty state in webview will handle unconfigured state
        return;
      }
      try {
        const { getPipelineList } = await import('./api/pipelineService');
        const client = new (await import('./api/harnessClient')).HarnessClient(currentConfig);
        const pipelines = await getPipelineList(client, currentConfig);

        // Load pinned pipelines from globalState
        const key = `${currentConfig.orgIdentifier}.${currentConfig.projectIdentifier}.pinnedPipelines`;
        const pinnedPipelines = context.globalState.get<string[]>(key, []);

        logger.debug('Extension', 'Fetched pipelines:', { count: pipelines.length, pinnedCount: pinnedPipelines.length });
        bridge.send({ type: 'PIPELINE_LIST', pipelines, pinnedPipelines });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error('Extension', 'Failed to fetch pipelines:', msg);
        vscode.window.showErrorMessage(`Harness: Failed to fetch pipelines — ${msg}`);
        bridge.send({ type: 'PIPELINE_LIST', pipelines: [] });
      }
    } else if (m.type === 'setPinnedPipelines') {
      const pipelines = m.pinnedPipelines ?? [];
      const key = `${currentConfig?.orgIdentifier}.${currentConfig?.projectIdentifier}.pinnedPipelines`;
      await context.globalState.update(key, pipelines);
      logger.debug('Extension', 'Saved pinned pipelines:', { count: pipelines.length, key });
    } else if (m.type === 'AI_SEND_MESSAGE') {
      // Handle AI question from webview
      logger.debug('Extension', 'AI_SEND_MESSAGE received!', msg);
      const aiMsg = m as any;

      if (!aiMsg.question) {
        logger.debug('Extension', 'No question in message, returning early');
        return;
      }

      logger.info('AI', 'Sending question to AI tool:', { question: aiMsg.question.substring(0, 50) + '...' });
      logger.debug('AI', 'Execution context from webview:', aiMsg.executionContext);

      try {
        // Build execution context for prompt building (minimal - let MCP fetch details)
        // Use the execution context sent from the webview (includes planExecutionId)
        let executionContext: any = undefined;

        if (aiMsg.executionContext?.planExecutionId) {
          // Webview sent execution context - use it!
          logger.debug('AI', 'Using execution context from webview message');
          executionContext = {
            pipelineIdentifier: aiMsg.executionContext.pipelineIdentifier || aiMsg.executionContext.pipelineName?.replace(/\s+/g, '_'),
            planExecutionId: aiMsg.executionContext.planExecutionId,
            accountId: currentConfig?.accountIdentifier,
            org: currentConfig?.orgIdentifier,
            project: currentConfig?.projectIdentifier,
            baseUrl: currentConfig?.baseUrl,
          };
        } else if (currentViewedExecution) {
          // Fallback to tracked execution
          logger.debug('AI', 'Using tracked execution (fallback)');
          const ex = currentViewedExecution.execution;
          executionContext = {
            pipelineIdentifier: ex?.pipelineIdentifier,
            planExecutionId: ex?.planExecutionId,
            accountId: currentConfig?.accountIdentifier,
            org: currentConfig?.orgIdentifier,
            project: currentConfig?.projectIdentifier,
            baseUrl: currentConfig?.baseUrl,
          };
        }

        const prompt = buildPrompt(aiMsg.question, executionContext);

        // Debug: Log the actual prompt being sent
        logger.debug('AI', 'Generated prompt:', prompt);
        logger.debug('AI', 'Execution context:', executionContext);

        // Detect which tool to use (with user preference)
        const detection = await detectAITools(getAIToolPreference());
        if (!detection.activeTool) {
          bridge.send({
            type: 'AI_ERROR',
            message: 'No AI tool detected. Please install Claude Code.',
          });
          return;
        }

        // Cursor-specific handling - simplified for compatibility
        const tool = detection.tools.find(t => t.id === detection.activeTool);
        if (tool && tool.id === 'cursor') {
          logger.info('AI', 'Cursor tool detected, launching...');
          // Just launch - Cursor will handle plugin/OAuth prompts automatically
          // Don't check cursorMcpMode or cursorOAuthReady - let Cursor handle it
        }

        // Launch AI tool
        // Pass workspace folder so CLI uses project-specific MCP config
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const result = await launchAI({
          prompt,
          toolId: detection.activeTool as any,
          timeout: 60000, // 60 seconds for MCP calls
          cwd: workspaceFolder,
        });

        if (result.type === 'response') {
          bridge.send({
            type: 'AI_RESPONSE',
            content: result.content || '',
            toolCalls: result.toolCalls,
            durationMs: result.durationMs,
          });
        } else if (result.type === 'launched') {
          bridge.send({
            type: 'AI_LAUNCHED',
            tool: detection.activeTool,
          });
        } else {
          bridge.send({
            type: 'AI_ERROR',
            message: result.error || 'Unknown error',
          });
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error('AI', 'Failed to process question:', msg);
        bridge.send({
          type: 'AI_ERROR',
          message: msg,
        });
      }
    } else if (m.type === 'AI_CONFIGURE_MCP') {
      // Configure Harness MCP server
      logger.info('AI', 'Configuring MCP...');

      // Cursor uses the Harness Plugin — never show the MCP configure panel for Cursor
      const detection = await detectAITools(getAIToolPreference());
      const tool = detection.tools.find(t => t.id === detection.activeTool);
      if (tool && tool.id === 'cursor') {
        logger.debug('AI', 'Skipping MCP configuration for Cursor (uses plugin)');
        return;
      }

      if (!currentConfig) {
        bridge.send({
          type: 'AI_ERROR',
          message: 'Extension not configured. Please configure Harness first.',
        });
        return;
      }

      try {
        const apiKey = await secretStore.getApiKey();
        if (!apiKey) {
          bridge.send({
            type: 'AI_ERROR',
            message: 'No API key found. Please configure Harness API key first.',
          });
          return;
        }

        await configureMCP({
          apiKey,
          baseUrl: currentConfig.baseUrl,
          accountId: currentConfig.accountIdentifier,
          orgId: currentConfig.orgIdentifier,
          projectId: currentConfig.projectIdentifier,
        });

        // Get active tool to send back in confirmation
        const detection = await detectAITools(getAIToolPreference());
        const activeTool = detection.activeTool || 'claudecode-cli';

        logger.info('AI', 'MCP configured successfully');
        bridge.send({
          type: 'AI_CONFIG_DONE',
          tool: activeTool,
        });

        // Re-detect to update MCP readiness state
        setTimeout(async () => {
          const updated = await detectAITools(getAIToolPreference());
          bridge.send({
            type: 'STATE_UPDATE',
            aiDetection: updated,
          });
        }, 500);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error('AI', 'MCP configuration failed:', msg);
        bridge.send({
          type: 'AI_ERROR',
          message: `Failed to configure MCP: ${msg}`,
        });
      }
    } else if (m.type === 'AI_SWITCH_TOOL') {
      // Switch active AI tool
      const aiMsg = m as any;
      if (!aiMsg.toolId) return;

      logger.debug('AI', 'Switching to tool:', aiMsg.toolId);

      // Save preference
      await setAIToolPreference(aiMsg.toolId);

      // Re-detect with new preference
      const detection = await detectAITools(aiMsg.toolId);

      if (detection.activeTool === aiMsg.toolId) {
        logger.debug('AI', 'Tool preference saved:', aiMsg.toolId);
        bridge.send({
          type: 'STATE_UPDATE',
          aiDetection: detection,
        });
      } else {
        logger.warn('AI', 'Selected tool not available:', aiMsg.toolId);
      }
    } else if (m.type === 'AI_CURSOR_INSTALL_PLUGIN') {
      // Open Cursor Marketplace for plugin installation
      logger.debug('AI', 'Opening Cursor Marketplace for Harness Plugin');
      await vscode.env.openExternal(
        vscode.Uri.parse('https://cursor.com/marketplace/harness')
      );
    } else if (m.type === 'AI_CURSOR_CONNECT_OAUTH') {
      // Send prompt to Cursor to help user with authentication
      logger.info('AI', 'Sending authentication help prompt to Cursor');

      try {
        const prompt = 'Authenticate to the Harness MCP server';

        const result = await launchAI({
          prompt,
          toolId: 'cursor',
          timeout: 60000,
        });

        if (result.type === 'launched') {
          bridge.send({
            type: 'AI_LAUNCHED',
            tool: 'cursor',
          });
        } else if (result.type === 'error') {
          bridge.send({
            type: 'AI_ERROR',
            message: result.error || 'Failed to open Cursor',
          });
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error('AI', 'Failed to launch Cursor for authentication help:', msg);
        bridge.send({
          type: 'AI_ERROR',
          message: msg,
        });
      }
    }
  });

  // When sidebar becomes visible, trigger a fresh poll so data appears immediately
  bridge.onReady(() => {
    if (poller) {
      poller.refresh();
    }
  });

  // Listen for VS Code theme changes and notify webview
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(async (theme) => {
      logger.debug('Extension', 'IDE theme changed:', {
        kind: theme.kind,
        kindName: theme.kind === 1 ? 'Light' : theme.kind === 2 ? 'Dark' : theme.kind === 3 ? 'HighContrast' : 'HighContrastLight'
      });
      const { getWebviewThemeVariation } = await import('./fme/fmeClient');
      const webviewTheme = getWebviewThemeVariation();
      const ideThemeKind = vscode.window.activeColorTheme.kind;
      // Send updated theme to webview via GIT_CONTEXT message
      const gitCtx = await import('./git/gitContext');
      const ctx = await gitCtx.getGitContext();
      const config = await configManager.getConfig();
      if (config) {
        const defaultView = vscode.workspace.getConfiguration('harness').get<string>('defaultView', 'pipelines');
        const { getLogViewerVariation, getAiChatEnabled } = await import('./fme/fmeClient');
        const logViewerVariation = await getLogViewerVariation();
        const aiChatEnabled = getAiChatEnabled();
        logger.debug('Extension', 'Sending theme update to webview:', { webviewTheme, ideThemeKind });
        bridge.send({
          type: 'GIT_CONTEXT',
          ctx,
          org: config.orgIdentifier,
          project: config.projectIdentifier,
          defaultView,
          logViewerVariation,
          webviewTheme,
          ideThemeKind,
          aiChatEnabled,
        });
      }
    })
  );

  // Track currently viewed execution for export
  let currentViewedExecution: { execution: any; executionGraph?: any; source: 'live' | 'history' } | null = null;

  // Update status bar from execution messages + track current execution
  const origSend = bridge.send.bind(bridge);
  bridge.send = (message) => {
    // Debug: Log all messages to see what's being sent
    logger.debug('Bridge', 'Sending message:', message.type);

    origSend(message);
    if (message.type === 'EXECUTION_UPDATE') {
      const ex = message.execution;
      statusBar.updateFromStatus(ex.status, ex.name ?? ex.pipelineIdentifier ?? 'Pipeline');
      // Track execution being viewed from live mode
      currentViewedExecution = {
        execution: ex,
        executionGraph: message.executionGraph,
        source: 'live',
      };
      logger.debug('Extension', 'Tracked EXECUTION_UPDATE:', {
        name: ex.name,
        planExecutionId: ex.planExecutionId,
        hasGraph: !!message.executionGraph,
      });
    } else if (message.type === 'HISTORY_DETAIL') {
      // Track execution when viewing from history
      currentViewedExecution = {
        execution: message.execution,
        executionGraph: message.executionGraph,
        source: 'history',
      };
      logger.debug('Extension', 'Tracked HISTORY_DETAIL:', {
        name: message.execution.name,
        planExecutionId: message.execution.planExecutionId,
        hasGraph: !!message.executionGraph,
      });
    } else if (message.type === 'NO_EXECUTION') {
      statusBar.setIdle();
      // Only clear tracked execution if it's from live mode
      // History detail executions should persist even when live poller sends NO_EXECUTION
      logger.debug('Extension', 'NO_EXECUTION received, currentViewedExecution:', currentViewedExecution?.source || 'null');
      if (currentViewedExecution?.source === 'live') {
        currentViewedExecution = null;
        logger.debug('Extension', 'Cleared live execution (NO_EXECUTION)');
      } else {
        logger.debug('Extension', 'Keeping execution (not from live mode)');
      }
    } else if (message.type === 'AUTH_ERROR') {
      statusBar.setNotConfigured();
    }
  };

  // ── Commands ──────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('harness.configureApiKey', async () => {
      const success = await runOnboarding(secretStore, configManager);
      if (success) {
        await startPoller();
        // Force webview to re-render by sending a refresh signal
        const ctx = await (await import('./git/gitContext')).getGitContext();
        const config = await configManager.getConfig();
        if (config) {
          const defaultView = vscode.workspace.getConfiguration('harness').get<string>('defaultView', 'pipelines');
          const { getLogViewerVariation, getWebviewThemeVariation, getAiChatEnabled } = await import('./fme/fmeClient');
          const logViewerVariation = await getLogViewerVariation();
          const webviewTheme = getWebviewThemeVariation();
          const aiChatEnabled = getAiChatEnabled();
          const ideThemeKind = vscode.window.activeColorTheme.kind;
          bridge.send({
            type: 'GIT_CONTEXT',
            ctx,
            org: config.orgIdentifier,
            project: config.projectIdentifier,
            defaultView,
            logViewerVariation,
            webviewTheme,
            ideThemeKind,
            aiChatEnabled,
          });
        }
      }
    }),

    vscode.commands.registerCommand('harness.selectProject', async () => {
      const ok = await runWorkspaceSetup(secretStore);
      if (ok) {
        // Clear current state and refresh with new org/project
        const newConfig = await configManager.getConfig();
        if (newConfig) {
          const defaultView = vscode.workspace.getConfiguration('harness').get<string>('defaultView', 'pipelines');
          const { getLogViewerVariation, getWebviewThemeVariation, getAiChatEnabled } = await import('./fme/fmeClient');
          const logViewerVariation = await getLogViewerVariation();
          const webviewTheme = getWebviewThemeVariation();
          const aiChatEnabled = getAiChatEnabled();
          const ideThemeKind = vscode.window.activeColorTheme.kind;
          bridge.send({
            type: 'GIT_CONTEXT',
            ctx: null,
            org: newConfig.orgIdentifier,
            project: newConfig.projectIdentifier,
            defaultView,
            logViewerVariation,
            webviewTheme,
            ideThemeKind,
            aiChatEnabled,
          });
        }
        await startPoller();
      }
    }),

    vscode.commands.registerCommand('harness.switchProject', async () => {
      const ok = await runWorkspaceOverride(secretStore);
      if (ok) {
        // Clear current state and refresh with new org/project
        const newConfig = await configManager.getConfig();
        if (newConfig) {
          const defaultView = vscode.workspace.getConfiguration('harness').get<string>('defaultView', 'pipelines');
          const { getLogViewerVariation, getWebviewThemeVariation, getAiChatEnabled } = await import('./fme/fmeClient');
          const logViewerVariation = await getLogViewerVariation();
          const webviewTheme = getWebviewThemeVariation();
          const aiChatEnabled = getAiChatEnabled();
          const ideThemeKind = vscode.window.activeColorTheme.kind;
          bridge.send({
            type: 'GIT_CONTEXT',
            ctx: null,
            org: newConfig.orgIdentifier,
            project: newConfig.projectIdentifier,
            defaultView,
            logViewerVariation,
            webviewTheme,
            ideThemeKind,
            aiChatEnabled,
          });
        }
        await startPoller();
      }
    }),

    vscode.commands.registerCommand('harness.clearApiKey', async () => {
      await secretStore.deleteApiKey();
      poller?.dispose();
      poller = undefined;
      statusBar.setNotConfigured();
      bridge.send({ type: 'AUTH_ERROR' });
      vscode.window.showInformationMessage('Harness: API key cleared.');
    }),

    vscode.commands.registerCommand('harness.refreshNow', () => {
      // If a poller exists, do a lightweight single tick refresh
      // otherwise restart the full poller
      if (poller) {
        poller.refresh();
      } else {
        startPoller();
      }
    }),

    vscode.commands.registerCommand('harness.openInHarness', () => {
      // Opens the execution in browser using base URL
      if (currentConfig) {
        vscode.env.openExternal(vscode.Uri.parse(
          `${currentConfig.baseUrl}/ng/account/${currentConfig.accountIdentifier}/pipelines`
        ));
      }
    }),

    vscode.commands.registerCommand('harness.rerunStage', () => {
      vscode.window.showInformationMessage('Harness: Re-run stage — open the execution in Harness to trigger a re-run.');
    }),

    vscode.commands.registerCommand('harness.rerunTest', () => {
      vscode.window.showInformationMessage('Harness: Re-run test — open the execution in Harness to trigger a re-run.');
    }),

    vscode.commands.registerCommand('harness.exportLastExecution', async () => {
      // Export the currently viewed execution (from live mode or history detail)
      logger.debug('Extension', 'Export command triggered.');
      logger.debug('Extension', 'Current execution:', currentViewedExecution ? {
        hasExecution: !!currentViewedExecution.execution,
        hasGraph: !!currentViewedExecution.executionGraph,
        planExecutionId: currentViewedExecution.execution?.planExecutionId,
        name: currentViewedExecution.execution?.name
      } : 'null');

      const executionData = currentViewedExecution;
      if (!executionData) {
        logger.debug('Extension', 'No execution data available for export');
        vscode.window.showWarningMessage('Harness: No execution is currently being viewed. Open a pipeline execution first.');
        return;
      }

      const pipelineName = executionData.execution.name || executionData.execution.pipelineIdentifier || 'execution';
      const fileName = `${pipelineName.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.json`;

      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(fileName),
        filters: { 'JSON Files': ['json'] },
      });

      if (uri) {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(executionData, null, 2)));
        vscode.window.showInformationMessage(`Harness: Execution data exported to ${uri.fsPath}`);
        await vscode.commands.executeCommand('vscode.open', uri);
      }
    }),

    vscode.commands.registerCommand('harness.showDebugOutput', () => {
      outputChannel.show();
    }),

    vscode.commands.registerCommand('harness.debugFmeFlags', async () => {
      const { refreshFmeClient } = await import('./fme/fmeClient');
      refreshFmeClient();
      vscode.window.showInformationMessage('FME: Flag states logged to Output panel (View → Output → Harness). Set logLevel=debug for details.');
    }),
  );

  // ── Config / secret change listeners ─────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('harness')) {
        startPoller();
      }
    }),

    secretStore.onDidChange(() => {
      startPoller();
    })
  );

  // ── FF Decorations (passive) ──────────────────────
  registerFfDecorations(
    context,
    () => currentClient,
    () => currentConfig
  );

  // ── Initial start ─────────────────────────────────
  // Check if configured without prompting - user will see empty state in sidebar
  const configured = await configManager.isConfigured();
  if (configured) {
    await startPoller();
  } else {
    statusBar.setNotConfigured();
    bridge.send({ type: 'AUTH_ERROR' });
  }

  // ── AI Tool Detection (non-blocking) ──────────────
  // Detect Claude Code CLI/Extension and check MCP readiness
  // Runs in background, won't block extension activation
  detectAITools(getAIToolPreference()).then(detection => {
    logger.debug('AI', 'Detection complete:', { tools: detection.tools.map(t => `${t.id} (MCP: ${t.mcpReady})`).join(', '), activeTool: detection.activeTool });
    bridge.send({
      type: 'STATE_UPDATE',
      aiDetection: detection,
    });
  }).catch(err => {
    logger.error('AI', 'Detection failed:', err);
    // Send empty detection result on error
    bridge.send({
      type: 'STATE_UPDATE',
      aiDetection: { tools: [], activeTool: null, mcpConfigPath: null },
    });
  });
}

// ── History fetch helpers ──────────────────────────────────────────────────

async function fetchExecutionHistory(
  config: { baseUrl: string; accountIdentifier: string; orgIdentifier: string; projectIdentifier: string; apiKey: string },
  bridge: WebviewBridge,
  page: number,
  filter: string,
  pageSize: number,
  pipelineId?: string
): Promise<void> {
  logger.debug('Extension', 'fetchExecutionHistory called', { page, filter, pageSize, pipelineId, org: config.orgIdentifier, project: config.projectIdentifier });
  try {
    const client = new HarnessClient(config);

    // Fetch ALL executions (up to 100 from API) - we'll filter client-side
    const requestBody: any = {
      filterType: 'PipelineExecution',
      timeRange: { timeRangeFilterType: 'LAST_7_DAYS' },
    };

    logger.debug('Extension', 'fetchExecutionHistory request', { page, filter });

    // Fetch a larger page size to have enough data for client-side filtering
    const response = await client.post<{
      data?: {
        content?: Array<{
          planExecutionId: string;
          pipelineIdentifier: string;
          name: string;
          status: string;
          startTs: number;
          endTs?: number;
          moduleInfo?: Record<string, unknown>;
          executionTriggerInfo?: {
            triggeredBy?: { identifier?: string; email?: string };
          };
        }>;
        totalElements?: number;
      };
    }>(
      '/pipeline/api/pipelines/execution/summary',
      requestBody,
      {
        accountIdentifier: config.accountIdentifier,
        orgIdentifier: config.orgIdentifier,
        projectIdentifier: config.projectIdentifier,
        page: '0',
        size: '100', // Fetch more so we have data to filter
        sort: 'startTs,DESC',
      }
    );

    let executions = response.data?.content ?? [];

    logger.debug('Extension', 'Received executions from API', {
      count: executions.length,
      filter,
      statuses: executions.map(e => e.status).slice(0, 5)
    });

    // Client-side filtering by status
    if (filter === 'failed') {
      executions = executions.filter(ex => {
        const status = ex.status.toUpperCase();
        return status === 'FAILED' || status === 'FAILURE';
      });
    } else if (filter === 'success' || filter === 'passed') {
      executions = executions.filter(ex => {
        const status = ex.status.toUpperCase();
        return status === 'SUCCESS' || status === 'SUCCEEDED';
      });
    } else if (filter === 'waiting') {
      executions = executions.filter(ex => {
        const status = ex.status.toUpperCase();
        return status === 'APPROVALWAITING' || status === 'APPROVAL_WAITING';
      });
    }

    logger.debug('Extension', 'After client-side status filter', {
      count: executions.length,
      filter
    });

    // Filter by pipeline if specified
    if (pipelineId) {
      executions = executions.filter(ex => ex.pipelineIdentifier === pipelineId);
      logger.debug('Extension', 'After pipeline filter', {
        count: executions.length,
        pipelineId
      });
    }

    // Client-side pagination
    const total = executions.length;
    const start = page * pageSize;
    const end = start + pageSize;
    const paginatedExecutions = executions.slice(start, end);

    // Get current git context to mark current commit
    const { getGitContext, extractTriggerShas, shaMatch } = await import('./git/gitContext');
    const gitCtx = await getGitContext();

    const enhancedExecutions = paginatedExecutions.map(ex => {
      // Extract git info
      const shas = extractTriggerShas(ex);
      const gitSha = shas[0];
      const mi = ex.moduleInfo as any;

      // Try multiple possible branch locations in the response
      let gitBranch = mi?.ci?.branch;
      if (!gitBranch && mi?.ci?.ciExecutionInfoDTO?.branch) {
        // Could be object with name property or string
        gitBranch = typeof mi.ci.ciExecutionInfoDTO.branch === 'string'
          ? mi.ci.ciExecutionInfoDTO.branch
          : mi.ci.ciExecutionInfoDTO.branch.name;
      }

      const isCurrentCommit = gitCtx ? shas.some(sha => shaMatch(gitCtx.commitSha, sha)) : false;

      return {
        planExecutionId: ex.planExecutionId,
        pipelineIdentifier: ex.pipelineIdentifier,
        name: ex.name,
        status: ex.status,
        startTs: ex.startTs,
        endTs: ex.endTs,
        moduleInfo: ex.moduleInfo,
        triggerInfo: ex.executionTriggerInfo,
        gitSha,
        gitBranch,
        isCurrentCommit,
      };
    });

    logger.debug('Extension', 'Sending HISTORY_LIST', { count: enhancedExecutions.length, total, page });
    bridge.send({
      type: 'HISTORY_LIST',
      executions: enhancedExecutions as any,
      total,
      page,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('Extension', 'fetchExecutionHistory error', error);
    vscode.window.showErrorMessage(`Harness: Failed to fetch execution history — ${msg}`);
    // Send empty list to clear loading state
    bridge.send({
      type: 'HISTORY_LIST',
      executions: [],
      total: 0,
      page: 0,
    });
  }
}

async function fetchExecutionDetail(
  config: { baseUrl: string; accountIdentifier: string; orgIdentifier: string; projectIdentifier: string; apiKey: string },
  bridge: WebviewBridge,
  diagnostics: DiagnosticsManager,
  planExecutionId: string
): Promise<void> {
  try {
    const client = new HarnessClient(config);

    const response = await client.get<{
      data?: {
        pipelineExecutionSummary?: any;
        executionGraph?: any;
      };
    }>(
      `/pipeline/api/pipelines/execution/v2/${planExecutionId}`,
      {
        accountIdentifier: config.accountIdentifier,
        orgIdentifier: config.orgIdentifier,
        projectIdentifier: config.projectIdentifier,
        renderFullBottomGraph: 'true',
      }
    );

    const execution = response.data?.pipelineExecutionSummary;
    const executionGraph = response.data?.executionGraph;

    if (!execution) {
      vscode.window.showErrorMessage('Harness: Execution not found');
      return;
    }

    // Build Harness URL
    const harnessUrl = `${config.baseUrl}/ng/account/${config.accountIdentifier}/all/orgs/${config.orgIdentifier}/projects/${config.projectIdentifier}/pipelines/${execution.pipelineIdentifier}/deployments/${planExecutionId}/pipeline`;

    // Build commit URL from execution data (not local git context)
    const { extractTriggerShas, buildCommitUrl } = await import('./git/gitContext');
    const shas = extractTriggerShas(execution);
    const commitSha = shas[0];
    let commitWebUrl: string | undefined;

    if (commitSha) {
      const ci = execution.moduleInfo?.ci as any;

      // Try to get repo URL from execution data first
      let repoUrl = ci?.repoUrl;

      // If not in ci.repoUrl, check if we can extract from logBaseKey or other fields
      // logBaseKey format: accountId:X/orgId:Y/projectId:Z/pipelineId:P/...
      if (!repoUrl && ci?.repoName) {
        // Strip scope prefixes from repo name (Harness uses these internally)
        // Examples: "org.MyRepo" → "MyRepo", "_project_MyRepo" → "MyRepo"
        let cleanRepoName = ci.repoName;
        if (cleanRepoName.startsWith('org.')) {
          cleanRepoName = cleanRepoName.substring(4);
        } else if (cleanRepoName.startsWith('_project_')) {
          cleanRepoName = cleanRepoName.substring(9);
        } else if (cleanRepoName.startsWith('account.')) {
          cleanRepoName = cleanRepoName.substring(8);
        }

        // For Harness Code repos, we need to construct the git URL
        // Try to extract org/project from the execution's own context
        const logBaseKey = Object.values(executionGraph?.nodeMap ?? {}).find((n: any) => n.logBaseKey)?.logBaseKey as string | undefined;
        if (logBaseKey) {
          const orgMatch = logBaseKey.match(/orgId:([^/]+)/);
          const projectMatch = logBaseKey.match(/projectId:([^/]+)/);

          if (orgMatch) {
            const execOrg = orgMatch[1];

            // Check if repo is org-level or project-level
            // If repoName starts with "org.", it's an org-level repo
            if (ci.repoName.startsWith('org.')) {
              // Org-level repo: git.harness.io/{account}/{org}/{repo}
              repoUrl = `https://git.harness.io/${config.accountIdentifier}/${execOrg}/${cleanRepoName}`;
            } else if (projectMatch) {
              // Project-level repo: git.harness.io/{account}/{org}/{project}/{repo}
              const execProject = projectMatch[1];
              repoUrl = `https://git.harness.io/${config.accountIdentifier}/${execOrg}/${execProject}/${cleanRepoName}`;
            }
          }
        }

        // Fallback: use current config (might be wrong if user switched)
        if (!repoUrl) {
          repoUrl = `https://git.harness.io/${config.accountIdentifier}/${config.orgIdentifier}/${config.projectIdentifier}/${cleanRepoName}`;
        }
      }

      if (repoUrl) {
        commitWebUrl = buildCommitUrl(repoUrl, commitSha);
      }
    }

    logger.debug('Extension', 'Dispatching modules for history detail:', {
      planExecutionId,
      status: execution.status,
      hasGraph: !!executionGraph
    });

    // Dispatch modules to detect approvals, STO, TI, etc.
    await dispatchModules(
      execution,
      executionGraph ?? null,
      client,
      config,
      diagnostics,
      bridge,
      undefined, // no git context for history view
      harnessUrl
    );

    // Send execution detail (logs will be fetched on-demand when user clicks steps)
    bridge.send({
      type: 'HISTORY_DETAIL',
      execution,
      executionGraph: executionGraph ?? null,
      harnessUrl,
      commitWebUrl,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('Extension', 'fetchExecutionDetail error', error);
    vscode.window.showErrorMessage(`Harness: Failed to fetch execution detail — ${msg}`);
    // Clear loading state in webview
    bridge.send({
      type: 'EXECUTION_ERROR',
      message: msg,
    });
  }
}

async function fetchStepLogsOnDemand(
  config: { baseUrl: string; accountIdentifier: string; orgIdentifier: string; projectIdentifier: string; apiKey: string },
  bridge: WebviewBridge,
  logProvider: LogContentProvider,
  logBaseKey: string,
  nodeId: string,
  stepName?: string,
  stageName?: string,
  pipelineName?: string,
  planExecutionId?: string,
  status?: string,
  durationMs?: number
): Promise<void> {
  const startTime = Date.now();
  try {
    logger.debug('Extension', 'Fetching logs on-demand', { logBaseKey, nodeId });

    // Send loading state
    bridge.send({
      type: 'STEP_LOGS_LOADING',
      nodeId,
    });

    const { fetchStepLogs } = await import('./api/logService');
    let lines: string[] = [];
    let attempts = 0;

    // Try immediately first
    try {
      lines = await fetchStepLogs(config as any, logBaseKey);
      attempts++;
      logger.debug('Extension', `Initial fetch: ${lines.length} lines`, { nodeId });
    } catch (err) {
      logger.error('Extension', 'Initial fetch error:', err);
    }

    // Retry with exponential backoff if no logs found (logs might not be indexed yet)
    const retryDelays = [3000, 5000, 7000, 10000]; // 3s, 5s, 7s, 10s (total 25s)
    for (let i = 0; i < retryDelays.length && lines.length === 0; i++) {
      logger.debug('Extension', `Retry ${i + 1}/${retryDelays.length} in ${retryDelays[i]}ms...`, {
        nodeId,
        logBaseKey,
        elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s`
      });
      await new Promise<void>(resolve => {
        (globalThis as any).setTimeout(() => resolve(), retryDelays[i]);
      });

      try {
        lines = await fetchStepLogs(config as any, logBaseKey);
        attempts++;
        logger.debug('Extension', `Retry ${i + 1} result: ${lines.length} lines`, { nodeId });
        if (lines.length > 0) {
          logger.debug('Extension', `✓ Logs found after ${attempts} attempts (${((Date.now() - startTime) / 1000).toFixed(1)}s)`, {
            nodeId,
            lineCount: lines.length
          });
        }
      } catch (err) {
        logger.error('Extension', `Retry ${i + 1} error:`, err);
      }
    }

    if (lines.length > 0) {
      // Check FME variation to decide how to display logs
      const variation = await getLogViewerVariation();
      logger.debug('Extension', `Log viewer variation: ${variation}`, { nodeId });

      if (variation === 'expanded' && stepName && stageName) {
        // Open logs in editor tab
        logger.debug('Extension', 'Opening logs in editor tab', {
          stepName,
          stageName,
          pipelineName,
          planExecutionId,
          status,
          linesCount: lines.length,
          firstLine: lines[0]?.substring(0, 50),
        });
        await openLogAsEditorTab(
          {
            stepName: stepName,
            stageName: stageName,
            pipelineName: pipelineName || 'Pipeline',
            planExecutionId: planExecutionId || '',
            status: (status?.toUpperCase() as any) || 'SUCCESS',
            durationMs: durationMs,
            logLines: lines,
          },
          logProvider
        );
        // Notify webview that logs were opened in editor tab
        bridge.send({
          type: 'STEP_LOGS_OPENED_IN_TAB',
          nodeId,
        });
      } else {
        // Inline mode (control) - send logs to webview
        logger.debug('Extension', `✓ Sending ${lines.length} log lines to webview`, { nodeId });
        bridge.send({
          type: 'LOG_CHUNK',
          nodeId,
          lines,
          autoExpand: false, // Don't auto-expand in detail view - let user click to expand
        });
        logger.debug('Extension', '✓ LOG_CHUNK message sent', { nodeId });
      }
    } else {
      logger.debug('Extension', `✗ No logs found after ${attempts} attempts (${((Date.now() - startTime) / 1000).toFixed(1)}s)`, {
        nodeId,
        logBaseKey
      });
      bridge.send({
        type: 'STEP_LOGS_EMPTY',
        nodeId,
      });
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('Extension', 'Fatal error fetching step logs:', { error: msg, nodeId, logBaseKey });
    bridge.send({
      type: 'STEP_LOGS_ERROR',
      nodeId,
      error: msg,
    });
  }
}

export function deactivate(): void {
  // Cleanup FME client
  destroyFmeClient();
  // All disposables are registered in context.subscriptions — nothing to do here
}
