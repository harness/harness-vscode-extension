import * as vscode from 'vscode';
import { SplitFactory } from '@splitsoftware/splitio';
import type { HarnessConfig } from '../config/configManager';

// Default FME SDK key shipped with extension (for all end users)
// This is a client-side SDK key - safe to embed in client apps
// Users can override via VS Code settings (harness.fmeSdkKey) for testing/development
const DEFAULT_FME_SDK_KEY = 'ilh4fn4r0omg8asdjkn75i3uq39i3d1lndm6';

let splitClient: SplitIO.IClient | null = null;
let userKey: string | null = null;
let cachedLogViewerVariation: 'inline' | 'expanded' | 'drawer' = 'expanded';
let cachedWebviewThemeVariation: 'simple' | 'enhanced' = 'enhanced';
let cachedAiChatEnabled: boolean = false; // Default to disabled until flag confirms
let readyPromise: Promise<void> | null = null;
let onUpdateCallback: (() => void) | null = null;

/**
 * Update cached variation values from FME
 * Called on SDK_READY and SDK_UPDATE to avoid evaluating flags on every access
 */
function updateCachedVariations(): void {
  if (!splitClient || !userKey) return;

  const logViewerTreatment = splitClient.getTreatment(userKey, 'vscode-log-experience');
  if (logViewerTreatment === 'expanded' || logViewerTreatment === 'drawer') {
    cachedLogViewerVariation = logViewerTreatment;
  } else {
    cachedLogViewerVariation = 'inline';
  }

  const webviewThemeTreatment = splitClient.getTreatment(userKey, 'vscode-bar-experience');
  if (webviewThemeTreatment === 'enhanced') {
    cachedWebviewThemeVariation = 'enhanced';
  } else {
    cachedWebviewThemeVariation = 'simple';
  }

  const aiChatTreatment = splitClient.getTreatment(userKey, 'vscode-mcp-integration');
  console.log('[FME] vscode-mcp-integration treatment received:', aiChatTreatment);
  // Only enable if explicitly set to 'on', otherwise disable
  // (handles 'off', 'control', or any other treatment as disabled)
  cachedAiChatEnabled = aiChatTreatment === 'on';

  console.log('[FME] ✓ Cached log viewer variation:', cachedLogViewerVariation);
  console.log('[FME] ✓ Cached webview theme variation:', cachedWebviewThemeVariation);
  console.log('[FME] ✓ Cached AI chat enabled:', cachedAiChatEnabled, '(treatment was:', aiChatTreatment + ')');
}

export async function initFmeClient(sdkKey: string | undefined, config: HarnessConfig, onUpdate?: () => void): Promise<void> {
  // Store the callback for SDK_UPDATE events
  if (onUpdate) {
    onUpdateCallback = onUpdate;
  }
  // Use provided key, or fall back to default embedded key for all users
  const finalSdkKey = sdkKey || DEFAULT_FME_SDK_KEY;

  if (!finalSdkKey || finalSdkKey.trim() === '' || finalSdkKey === 'YOUR_PUBLIC_CLIENT_SDK_KEY_HERE') {
    console.log('[FME] No SDK key configured, FME features disabled');
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
      console.log('[FME] ✓ Using Harness user for targeting:', userIdentifier);
    } catch (err) {
      console.warn('[FME] Failed to get Harness user, using machine ID');
    }

    userKey = userIdentifier;

    console.log('[FME] 🚀 Initializing Harness FME (Split.io) SDK');
    console.log('[FME]    SDK Key:', finalSdkKey.substring(0, 15) + '...');
    console.log('[FME]    User Key:', userKey);

    if (sdkKey && sdkKey !== DEFAULT_FME_SDK_KEY) {
      console.log('[FME]    Using custom SDK key from settings/env');
    } else {
      console.log('[FME]    Using default embedded SDK key');
    }

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
      sync: {
        impressionsMode: 'OPTIMIZED', // Reduce spam
      },
      debug: false, // Disable debug logs
    });

    splitClient = factory.client();

    // Wait for SDK to be ready
    readyPromise = new Promise<void>((resolve) => {
      splitClient!.on(splitClient!.Event.SDK_READY, () => {
        console.log('[FME] ✓ SDK ready');

        // Cache initial flag values
        updateCachedVariations();

        resolve();
      });

      splitClient!.on(splitClient!.Event.SDK_READY_TIMED_OUT, () => {
        console.warn('[FME] ⚠ SDK ready timeout - falling back to control');
        resolve();
      });

      splitClient!.on(splitClient!.Event.SDK_UPDATE, () => {
        // Update cached variations when flags change
        updateCachedVariations();
        // Notify extension that flags have updated
        if (onUpdateCallback) {
          onUpdateCallback();
        }
      });

      splitClient!.on(splitClient!.Event.SDK_READY_FROM_CACHE, () => {
        console.log('[FME] ✓ SDK ready from cache (offline mode)');
        updateCachedVariations();
        resolve();
      });
    });

    await readyPromise;
    console.log('[FME] ✓ Harness FME client initialized');
  } catch (error) {
    console.error('[FME] ✗ Initialization error:', error);
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
    console.log('[FME] 🔄 Forcing flag refresh...');
    try {
      // Get fresh treatments
      const treatments = splitClient.getTreatments(userKey, ['vscode-log-experience', 'vscode-bar-experience', 'vscode-mcp-integration']);
      console.log('[FME] 📋 Current flag states:', treatments);
    } catch (err) {
      console.warn('[FME] Error refreshing flags:', err);
    }
  } else {
    console.warn('[FME] Cannot refresh - client not initialized');
  }
}

export function destroyFmeClient(): void {
  if (splitClient) {
    console.log('[FME] Destroying client');
    try {
      splitClient.destroy();
    } catch (err) {
      console.warn('[FME] Error destroying client:', err);
    }
    splitClient = null;
    userKey = null;
  }
}
