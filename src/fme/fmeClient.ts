import * as vscode from 'vscode';
import type * as http from 'node:http';
import type * as net from 'node:net';
import { SplitFactory } from '@splitsoftware/splitio';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { HarnessConfig } from '../config/configManager';
import { logger } from '../utils/logger';
import { resolveProxyUrl, redactProxyUrl, resolveTrustedCaCertificates } from '../utils/proxy';

type AgentConnectOpts = Parameters<HttpsProxyAgent<string>['connect']>[1];

/** Applies the trusted CA set to both the proxy connection and the tunneled TLS connection. */
class TrustedHttpsProxyAgent extends HttpsProxyAgent<string> {
  constructor(proxyUrl: string, private readonly ca: string[]) {
    super(proxyUrl, { ca });
  }

  override connect(req: http.ClientRequest, opts: AgentConnectOpts): Promise<net.Socket> {
    return super.connect(req, { ...opts, ca: this.ca } as AgentConnectOpts);
  }
}

// Default FME SDK key shipped with extension (for all end users)
// This is a client-side SDK key - safe to embed in client apps
// Users can override via VS Code settings (harness.fmeSdkKey) for testing/development
const DEFAULT_FME_SDK_KEY = 'ilh4fn4r0omg8asdjkn75i3uq39i3d1lndm6';

/** Must match a traffic type defined in the Harness FME project. */
const FME_TRAFFIC_TYPE = 'user';
const FME_EVENT_EXTENSION_ACTIVATED = 'extension_activated';

let splitClient: SplitIO.IClient | null = null;
let userKey: string | null = null;
let cachedFmeAttributes: FmeAttributes | null = null;
let cachedLogViewerVariation: 'inline' | 'expanded' | 'drawer' = 'expanded';
let cachedWebviewThemeVariation: 'simple' | 'enhanced' = 'enhanced';
let cachedAiChatEnabled: boolean = true; // Default to enabled (fail-safe for FME failures)
let readyPromise: Promise<void> | null = null;
let onUpdateCallback: (() => void) | null = null;
let activationEventSent = false;

type FmeAttributes = {
  extension_version: string;
  vscode_version: string;
  app_host: 'cursor' | 'vscode';
};

function buildFmeAttributes(context: vscode.ExtensionContext): FmeAttributes {
  const appName = vscode.env.appName.toLowerCase();
  return {
    extension_version: context.extension.packageJSON.version ?? 'unknown',
    vscode_version: vscode.version,
    app_host: appName.includes('cursor') ? 'cursor' : 'vscode',
  };
}

function cacheFmeAttributes(context: vscode.ExtensionContext): FmeAttributes {
  cachedFmeAttributes = buildFmeAttributes(context);
  logger.debug('FME', '✓ Cached attributes for targeting:', cachedFmeAttributes);
  return cachedFmeAttributes;
}

function getEvaluationAttributes(): SplitIO.Attributes | undefined {
  return cachedFmeAttributes ?? undefined;
}

function trackExtensionActivation(client: SplitIO.IClient, context: vscode.ExtensionContext): void {
  if (activationEventSent || !userKey) {
    return;
  }

  const properties = cacheFmeAttributes(context);
  // Node/server SDK: track(key, trafficType, eventType, value?, properties?)
  const queued = client.track(
    userKey,
    FME_TRAFFIC_TYPE,
    FME_EVENT_EXTENSION_ACTIVATED,
    undefined,
    properties,
  );
  activationEventSent = true;
  logger.info('FME', '✓ Tracked extension_activated', { queued, ...properties });
}

function onSdkReady(context: vscode.ExtensionContext): void {
  if (!splitClient) {
    return;
  }

  try {
    cacheFmeAttributes(context);
  } catch (err) {
    logger.warn('FME', 'Failed to cache attributes:', err);
  }

  try {
    updateCachedVariations();
  } catch (err) {
    logger.warn('FME', 'Failed to cache flag variations:', err);
  }

  try {
    trackExtensionActivation(splitClient, context);
  } catch (err) {
    logger.warn('FME', 'Failed to track extension_activated:', err);
  }
}

/** Resolve FME init immediately; run attribute/track setup without blocking activation. */
function scheduleSdkReadyWork(context: vscode.ExtensionContext, resolve: () => void, source: string): void {
  logger.info('FME', `✓ ${source}`);
  resolve();

  setImmediate(() => {
    try {
      onSdkReady(context);
      logger.info('FME', '✓ Post-ready FME setup complete');
    } catch (err) {
      logger.warn('FME', 'Post-ready FME setup failed:', err);
    }
  });
}

/**
 * Update cached variation values from FME
 * Called on SDK_READY and SDK_UPDATE to avoid evaluating flags on every access
 */
function updateCachedVariations(): void {
  if (!splitClient || !userKey) return;

  const attrs = getEvaluationAttributes();

  // Node/server SDK: getTreatment(key, flagName, attributes?)
  const logViewerTreatment = splitClient.getTreatment(userKey, 'vscode-log-experience', attrs);
  if (logViewerTreatment === 'inline') {
    cachedLogViewerVariation = 'inline';
  } else if (logViewerTreatment === 'drawer') {
    cachedLogViewerVariation = 'drawer';
  } else {
    // 'expanded', 'control', and unknown → expanded (product default)
    cachedLogViewerVariation = 'expanded';
  }

  const webviewThemeTreatment = splitClient.getTreatment(userKey, 'vscode-bar-experience', attrs);
  if (webviewThemeTreatment === 'enhanced') {
    cachedWebviewThemeVariation = 'enhanced';
  } else {
    cachedWebviewThemeVariation = 'simple';
  }

  const aiChatTreatment = splitClient.getTreatment(userKey, 'vscode-mcp-integration', attrs);
  logger.debug('FME', 'vscode-mcp-integration treatment received:', aiChatTreatment);
  // Default to enabled (true) unless explicitly set to 'off'
  // This ensures AI bar is ON by default if FME fails or returns 'control'
  cachedAiChatEnabled = aiChatTreatment !== 'off';

  logger.debug('FME', '✓ Cached log viewer variation:', cachedLogViewerVariation);
  logger.debug('FME', '✓ Cached webview theme variation:', cachedWebviewThemeVariation);
  logger.debug('FME', '✓ Cached AI chat enabled:', cachedAiChatEnabled, '(treatment was:', aiChatTreatment + ')');
}

export async function initFmeClient(
  sdkKey: string | undefined,
  config: HarnessConfig,
  extensionContext: vscode.ExtensionContext,
  onUpdate?: () => void,
): Promise<void> {
  // Store the callback for SDK_UPDATE events
  if (onUpdate) {
    onUpdateCallback = onUpdate;
  }
  // Use provided key, or fall back to default embedded key for all users
  const finalSdkKey = sdkKey || DEFAULT_FME_SDK_KEY;

  if (!finalSdkKey || finalSdkKey.trim() === '' || finalSdkKey === 'YOUR_PUBLIC_CLIENT_SDK_KEY_HERE') {
    logger.info('FME', 'No SDK key configured, FME features disabled');
    readyPromise = Promise.resolve(); // Resolve immediately if no SDK
    return;
  }

  try {
    // Get Harness user email for targeting
    const { getCurrentUser } = await import('../api/userService');
    let userIdentifier = vscode.env.machineId; // Fallback

    try {
      const user = await getCurrentUser(config);
      userIdentifier = user.email || user.uuid || vscode.env.machineId;
      logger.debug('FME', '✓ Using Harness user for targeting:', userIdentifier);
    } catch (err) {
      logger.warn('FME', 'Failed to get Harness user, using machine ID');
    }

    userKey = userIdentifier;

    logger.info('FME', '🚀 Initializing Harness FME (Split.io) SDK');
    logger.debug('FME', '   SDK Key:', finalSdkKey.substring(0, 15) + '...');
    logger.debug('FME', '   User Key:', userKey);

    if (sdkKey && sdkKey !== DEFAULT_FME_SDK_KEY) {
      logger.debug('FME', '   Using custom SDK key from settings/env');
    } else {
      logger.debug('FME', '   Using default embedded SDK key');
    }

    // Read log level from settings to control Split.io debug logs
    const logLevel = vscode.workspace.getConfiguration('harness').get<string>('logLevel', 'info');
    const enableSdkDebug = logLevel === 'debug';

    // Split's Node SDK uses node-fetch, which doesn't read HTTPS_PROXY/HTTP_PROXY itself —
    // route it through the same proxy as everything else via a custom agent.
    const proxyUrl = resolveProxyUrl();
    if (proxyUrl) {
      logger.info('FME', `Routing Split.io SDK traffic through proxy: ${redactProxyUrl(proxyUrl)}`);
    }
    const proxyAgent = proxyUrl
      ? new TrustedHttpsProxyAgent(proxyUrl, resolveTrustedCaCertificates())
      : undefined;

    // Typed separately (vs. inline) so the conditional spread doesn't upset SplitFactory's overload resolution.
    const syncSettings: SplitIO.INodeSettings['sync'] = {
      impressionsMode: 'OPTIMIZED', // Reduce spam
      ...(proxyAgent ? { requestOptions: { agent: proxyAgent } } : {}),
    };

    // Initialize Split.io factory (FME uses Split.io as engine)
    const factory = SplitFactory({
      core: {
        authorizationKey: finalSdkKey,
        key: userKey, // User identifier for targeting
      },
      startup: {
        readyTimeout: 5, // Wait up to 5 seconds for SDK to be ready
      },
      scheduler: {
        featuresRefreshRate: 60, // Poll every 60 seconds
        impressionsRefreshRate: 60, // Send impressions every 60 seconds
      },
      sync: syncSettings,
      debug: enableSdkDebug, // Enable debug logs when logLevel is 'debug'
    });

    splitClient = factory.client();

    // Wait for SDK to be ready (never block activation on post-ready attribute/track work)
    readyPromise = Promise.race([
      new Promise<void>((resolve) => {
        let settled = false;
        const settle = (source: string): void => {
          if (settled) {
            return;
          }
          settled = true;
          scheduleSdkReadyWork(extensionContext, resolve, source);
        };

        splitClient!.on(splitClient!.Event.SDK_READY, () => {
          settle('SDK ready');
        });

        splitClient!.on(splitClient!.Event.SDK_READY_TIMED_OUT, () => {
          logger.warn('FME', '⚠ SDK ready timeout - falling back to control');
          if (!settled) {
            settled = true;
            resolve();
          }
        });

        splitClient!.on(splitClient!.Event.SDK_UPDATE, () => {
          try {
            updateCachedVariations();
          } catch (err) {
            logger.warn('FME', 'Failed to refresh cached variations:', err);
          }
          if (onUpdateCallback) {
            onUpdateCallback();
          }
        });

        splitClient!.on(splitClient!.Event.SDK_READY_FROM_CACHE, () => {
          settle('SDK ready from cache (offline mode)');
        });
      }),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          logger.warn('FME', '⚠ FME init safety timeout - continuing with defaults');
          resolve();
        }, 6000);
      }),
    ]);

    await readyPromise;
    logger.info('FME', '✓ Harness FME client initialized');
  } catch (error) {
    logger.error('FME', '✗ Initialization error:', error);
    readyPromise = Promise.resolve(); // Resolve on error
    // Silent failure - fall back to inline mode
  }
}

/**
 * Wait for FME to be ready (with timeout)
 * @param timeoutMs Maximum time to wait (default: 1000ms)
 */
export async function waitForFmeReady(timeoutMs: number = 1000): Promise<void> {
  if (!readyPromise) {
    return; // FME not initialized, continue with defaults
  }

  return Promise.race([
    readyPromise,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

/**
 * Get the log viewer variation from cache
 * Returns immediately without FME API call - cache is updated by SDK events
 */
export async function getLogViewerVariation(): Promise<'inline' | 'expanded' | 'drawer'> {
  return cachedLogViewerVariation;
}

/**
 * Get the webview theme variation from cache
 * Returns immediately without FME API call - cache is updated by SDK events
 */
export function getWebviewThemeVariation(): 'simple' | 'enhanced' {
  return cachedWebviewThemeVariation;
}

/**
 * Get the AI chat enabled state from cache
 * Returns immediately without FME API call - cache is updated by SDK events
 */
export function getAiChatEnabled(): boolean {
  return cachedAiChatEnabled;
}

export function refreshFmeClient(): void {
  if (splitClient && userKey) {
    logger.debug('FME', '🔄 Forcing flag refresh...');
    try {
      const attrs = getEvaluationAttributes();
      const treatments = splitClient.getTreatments(userKey, [
        'vscode-log-experience',
        'vscode-bar-experience',
        'vscode-mcp-integration',
      ], attrs);
      logger.debug('FME', '📋 Current flag states:', treatments);
    } catch (err) {
      logger.warn('FME', 'Error refreshing flags:', err);
    }
  } else {
    logger.warn('FME', 'Cannot refresh - client not initialized');
  }
}

export function destroyFmeClient(): void {
  if (splitClient) {
    logger.debug('FME', 'Destroying client');
    try {
      splitClient.destroy();
    } catch (err) {
      logger.warn('FME', 'Error destroying client:', err);
    }
    splitClient = null;
    userKey = null;
    cachedFmeAttributes = null;
    activationEventSent = false;
  }
}
