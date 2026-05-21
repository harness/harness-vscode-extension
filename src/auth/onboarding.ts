import * as vscode from 'vscode';
import { SecretStore } from './secretStore';
import { ConfigManager } from '../config/configManager';
import { fetchOrgs, fetchProjects } from '../api/accountService';
import { logger } from '../utils/logger';
import { readEnvCredentials, EnvCredentials } from './envCredentials';

/**
 * Harness PATs and SATs have the structure `pat.<accountId>.<userId>.<random>`
 * (or `sat.…` for service account tokens). The account ID is the second segment.
 * Returns null when the token doesn't match this shape.
 */
function extractAccountIdFromToken(token: string): string | null {
  const match = token.trim().match(/^(?:pat|sat)\.([^.\s]+)\.[^.\s]+\.[^.\s]+$/i);
  return match ? match[1] : null;
}

/**
 * Verifies that an (accountId, apiKey) pair is valid by making a low-cost API call.
 * Returns true on success, false otherwise — used to confirm extracted account IDs
 * before we trust them.
 */
async function verifyAccountCredentials(baseUrl: string, accountId: string, apiKey: string): Promise<boolean> {
  try {
    await fetchOrgs(baseUrl, accountId, apiKey);
    return true;
  } catch (e) {
    logger.warn('Onboarding', 'Account credential verification failed:', e);
    return false;
  }
}

export async function runOnboardingIfNeeded(
  secretStore: SecretStore,
  configManager: ConfigManager
): Promise<boolean> {
  if (await configManager.isConfigured()) return true;

  const hasGlobal = await configManager.hasGlobalCredentials();
  // configManager used above — referenced via parameter
  const msg = hasGlobal
    ? 'Harness: Select an org and project for this workspace.'
    : 'Harness: Configure your account to enable the extension.';

  const action = await vscode.window.showInformationMessage(msg, 'Configure now', 'Later');
  if (action !== 'Configure now') return false;

  return hasGlobal ? runWorkspaceSetup(secretStore, configManager) : runOnboarding(secretStore, configManager);
}

/** Step 1 — Global: PAT + Account ID. Run once, stored globally. */
export async function runOnboarding(secretStore: SecretStore, configManager?: ConfigManager): Promise<boolean> {
  const baseUrl = await vscode.window.showInputBox({
    title: 'Harness Base URL (1/2)',
    prompt: 'Your Harness instance URL. Leave as default for Harness SaaS.',
    ignoreFocusOut: true,
    value: vscode.workspace.getConfiguration('harness').get<string>('baseUrl', 'https://app.harness.io'),
    validateInput: v => (!v || !v.startsWith('http')) ? 'Must be a valid URL' : null,
  });
  if (!baseUrl) return false;
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  await vscode.workspace.getConfiguration('harness')
    .update('baseUrl', normalizedBaseUrl, vscode.ConfigurationTarget.Global);

  const apiKey = await vscode.window.showInputBox({
    title: 'Personal Access Token (2/2)',
    prompt: 'Open your profile in Harness → My API Keys → generate a new token',
    password: true,
    ignoreFocusOut: true,
    validateInput: v => (!v || v.trim().length < 10) ? 'Personal access token appears too short' : null,
  });
  if (!apiKey) return false;
  const trimmedApiKey = apiKey.trim();

  // Try to extract the account ID from the PAT itself (format: pat.<accountId>.<userId>.<random>).
  // If extraction + validation succeed, we skip the manual prompt entirely.
  let accountId: string | null = null;
  const extracted = extractAccountIdFromToken(trimmedApiKey);
  if (extracted) {
    const verified = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Harness: Verifying credentials…' },
      () => verifyAccountCredentials(normalizedBaseUrl, extracted, trimmedApiKey)
    );
    if (verified) {
      accountId = extracted;
      logger.info('Onboarding', 'Account ID extracted from token and verified');
    } else {
      logger.warn('Onboarding', 'Account ID extracted from token but verification failed; prompting manually');
    }
  }

  if (!accountId) {
    const entered = await vscode.window.showInputBox({
      title: 'Harness Account ID',
      prompt: "We couldn't read your account ID from the token. Find it in Account Settings → Overview → Account ID.",
      ignoreFocusOut: true,
      validateInput: v => (!v || v.trim().length < 5) ? 'Account ID required' : null,
    });
    if (!entered) return false;
    accountId = entered.trim();
  }

  await secretStore.setApiKey(trimmedApiKey);
  const cfg = vscode.workspace.getConfiguration('harness');
  await cfg.update('accountIdentifier', accountId, vscode.ConfigurationTarget.Global);
  // Mark that we're using PAT for auth
  await cfg.update('authSource', 'pat', vscode.ConfigurationTarget.Global);

  // Proceed immediately to workspace setup
  return runWorkspaceSetup(secretStore);
}

/** Step 2 — Workspace: pick Org → pick Project via API dropdowns. */
export async function runWorkspaceSetup(secretStore: SecretStore, _configManager?: ConfigManager): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration('harness');

  // Try env vars first, fall back to settings
  const envCreds = readEnvCredentials();
  const baseUrl = envCreds.baseUrl || cfg.get<string>('baseUrl', 'https://app.harness.io').replace(/\/$/, '');
  const accountId = envCreds.accountId || cfg.get<string>('accountIdentifier', '');
  const apiKey = envCreds.apiKey || await secretStore.getApiKey();

  if (!apiKey || !accountId) {
    vscode.window.showErrorMessage('Harness: Global credentials not set. Run "Harness: Configure API Key" first, or set environment variables.');
    return false;
  }

  const result = await pickOrgAndProject(baseUrl, accountId, apiKey);
  if (!result) return false;

  // Save to global settings (persists across all workspaces)
  // Clear any workspace-specific overrides first so global settings take effect
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    await cfg.update('orgIdentifier',     undefined, vscode.ConfigurationTarget.Workspace);
    await cfg.update('projectIdentifier', undefined, vscode.ConfigurationTarget.Workspace);
  }
  await cfg.update('orgIdentifier',     result.org,     vscode.ConfigurationTarget.Global);
  await cfg.update('projectIdentifier', result.project, vscode.ConfigurationTarget.Global);

  vscode.window.showInformationMessage(
    `Harness: Connected. Open the Harness panel to see your pipelines.`
  );
  return true;
}

/**
 * Switch Project (This Workspace) — Override global org/project for the current workspace.
 * Saves to Workspace settings, which take precedence over Global settings.
 * Use case: Working on different projects in different workspace folders.
 */
export async function runWorkspaceOverride(secretStore: SecretStore): Promise<boolean> {
  // Check if a workspace is open
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    vscode.window.showWarningMessage(
      'Harness: No workspace is open. This command sets project-specific overrides for the current workspace. ' +
      'To change your global settings, use "Harness: Select Org & Project" instead.'
    );
    return false;
  }

  const cfg = vscode.workspace.getConfiguration('harness');

  // Try env vars first, fall back to settings
  const envCreds = readEnvCredentials();
  const baseUrl = envCreds.baseUrl || cfg.get<string>('baseUrl', 'https://app.harness.io').replace(/\/$/, '');
  const accountId = envCreds.accountId || cfg.get<string>('accountIdentifier', '');
  const apiKey = envCreds.apiKey || await secretStore.getApiKey();

  if (!apiKey || !accountId) {
    vscode.window.showErrorMessage('Harness: Global credentials not set. Run "Harness: Configure API Key" first, or set environment variables.');
    return false;
  }

  const result = await pickOrgAndProject(baseUrl, accountId, apiKey);
  if (!result) return false;

  // Save to WORKSPACE settings (overrides global for this workspace only)
  await cfg.update('orgIdentifier',     result.org,     vscode.ConfigurationTarget.Workspace);
  await cfg.update('projectIdentifier', result.project, vscode.ConfigurationTarget.Workspace);

  vscode.window.showInformationMessage(
    `Harness: This workspace is now using a project override. ` +
    `Other workspaces will continue using your global settings.`
  );
  return true;
}

/**
 * Private helper: org + project quick-pick flow.
 * Extracted so both runWorkspaceSetup and runEnvVarOnboarding can reuse it.
 */
async function pickOrgAndProject(
  baseUrl: string,
  accountId: string,
  apiKey: string
): Promise<{ org: string; project: string } | null> {
  // ── Pick Org ──
  const orgPick = vscode.window.createQuickPick();
  orgPick.title        = 'Harness: Select Organization';
  orgPick.placeholder  = 'Loading organizations…';
  orgPick.busy         = true;
  orgPick.ignoreFocusOut = true;
  orgPick.show();

  let orgs;
  try {
    orgs = await fetchOrgs(baseUrl, accountId, apiKey);
  } catch (e: any) {
    orgPick.hide();
    vscode.window.showErrorMessage(`Harness: Failed to fetch organizations — ${e.message}. Check your API key and Account ID.`);
    return null;
  }

  if (!orgs.length) {
    orgPick.hide();
    vscode.window.showErrorMessage('Harness: No organizations found for this account.');
    return null;
  }

  orgPick.items = orgs.map(o => ({ label: o.name, description: o.identifier, identifier: o.identifier }));
  orgPick.busy  = false;
  orgPick.placeholder = 'Select an organization';

  const orgSelected = await new Promise<(typeof orgPick.items[0] & { identifier: string }) | undefined>(resolve => {
    orgPick.onDidAccept(() => resolve(orgPick.selectedItems[0] as any));
    orgPick.onDidHide(()   => resolve(undefined));
  });
  orgPick.hide();
  if (!orgSelected) return null;

  // ── Pick Project ──
  const projPick = vscode.window.createQuickPick();
  projPick.title        = `Harness: Select Project (${orgSelected.label})`;
  projPick.placeholder  = 'Loading projects…';
  projPick.busy         = true;
  projPick.ignoreFocusOut = true;
  projPick.show();

  let projects;
  try {
    projects = await fetchProjects(baseUrl, accountId, orgSelected.identifier, apiKey);
  } catch (e: any) {
    projPick.hide();
    vscode.window.showErrorMessage(`Harness: Failed to fetch projects — ${e.message}`);
    return null;
  }

  if (!projects.length) {
    projPick.hide();
    vscode.window.showErrorMessage(`Harness: No projects found in org "${orgSelected.label}".`);
    return null;
  }

  projPick.items = projects.map(p => ({ label: p.name, description: p.identifier, identifier: p.identifier }));
  projPick.busy  = false;
  projPick.placeholder = 'Select a project';

  const projSelected = await new Promise<(typeof projPick.items[0] & { identifier: string }) | undefined>(resolve => {
    projPick.onDidAccept(() => resolve(projPick.selectedItems[0] as any));
    projPick.onDidHide(()   => resolve(undefined));
  });
  projPick.hide();
  if (!projSelected) return null;

  return { org: orgSelected.identifier, project: projSelected.identifier };
}

/**
 * Environment variable onboarding — skips PAT prompts, uses env vars instead.
 * Does NOT write apiKey to secret storage or accountIdentifier to global settings.
 * Only writes workspace org/project metadata.
 */
export async function runEnvVarOnboarding(
  creds: EnvCredentials,
  _configManager?: ConfigManager
): Promise<boolean> {
  if (!creds.allPresent || !creds.baseUrl || !creds.apiKey || !creds.accountId) {
    vscode.window.showWarningMessage(
      'Harness: Environment variables are no longer set. Try reloading the window.'
    );
    return false;
  }

  const result = await pickOrgAndProject(creds.baseUrl, creds.accountId, creds.apiKey);
  if (!result) return false;

  // Save org/project to global settings (workspace metadata, not credentials)
  const cfg = vscode.workspace.getConfiguration('harness');
  // Clear workspace overrides if a workspace is open
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    await cfg.update('orgIdentifier',     undefined, vscode.ConfigurationTarget.Workspace);
    await cfg.update('projectIdentifier', undefined, vscode.ConfigurationTarget.Workspace);
  }
  await cfg.update('orgIdentifier',     result.org,     vscode.ConfigurationTarget.Global);
  await cfg.update('projectIdentifier', result.project, vscode.ConfigurationTarget.Global);
  // Mark that we're using env vars for auth
  await cfg.update('authSource', 'env', vscode.ConfigurationTarget.Global);

  vscode.window.showInformationMessage(
    `Harness: Connected using environment variables. Open the Harness panel to see your pipelines.`
  );
  return true;
}
