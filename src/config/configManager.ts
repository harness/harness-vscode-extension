import * as vscode from 'vscode';
import { SecretStore } from '../auth/secretStore';
import { logger } from '../utils/logger';
import { readEnvCredentials } from '../auth/envCredentials';

export interface HarnessConfig {
  baseUrl: string;
  accountIdentifier: string;
  orgIdentifier: string;
  projectIdentifier: string;
  pollingIntervalSeconds: number;
  diffAwareSTO: boolean;
  claudeCliTimeoutSeconds: number;
  apiKey: string;
}

export class ConfigManager {
  constructor(private readonly secretStore: SecretStore) {}

  async getConfig(): Promise<HarnessConfig | null> {
    const cfg = vscode.workspace.getConfiguration('harness');

    // Try env vars first, fall back to settings
    const envCreds = readEnvCredentials();
    const apiKey = envCreds.apiKey || await this.secretStore.getApiKey();
    if (!apiKey) {
      logger.debug('ConfigManager', 'No API key found in env or secret storage');
      return null;
    }

    const accountIdentifier = envCreds.accountId || cfg.get<string>('accountIdentifier', '').trim();
    if (!accountIdentifier) {
      logger.debug('ConfigManager', 'No account identifier found in env or settings');
      return null;
    }

    const baseUrl = envCreds.baseUrl || cfg.get<string>('baseUrl', 'https://app.harness.io');
    const orgIdentifier = cfg.get<string>('orgIdentifier', 'default').trim();
    const projectIdentifier = cfg.get<string>('projectIdentifier', '').trim();

    logger.debug('ConfigManager', 'Config loaded:', {
      source: envCreds.allPresent ? 'env vars' : 'settings',
      accountIdentifier,
      orgIdentifier,
      projectIdentifier,
      hasWorkspace: !!vscode.workspace.workspaceFolders?.length
    });

    return {
      baseUrl: baseUrl.replace(/\/$/, ''),
      accountIdentifier,
      orgIdentifier,
      projectIdentifier,
      pollingIntervalSeconds:   cfg.get<number>('pollingIntervalSeconds', 10),
      diffAwareSTO:             cfg.get<boolean>('diffAwareSTO', true),
      claudeCliTimeoutSeconds:  cfg.get<number>('claudeCliTimeoutSeconds', 90),
      apiKey,
    };
  }

  /** True when PAT + accountIdentifier are set globally (settings or env vars) — workspace org/project may still be missing. */
  async hasGlobalCredentials(): Promise<boolean> {
    // Check env vars first
    const envCreds = readEnvCredentials();
    if (envCreds.apiKey && envCreds.accountId) return true;

    // Fall back to settings
    const hasKey = await this.secretStore.hasApiKey();
    if (!hasKey) return false;
    const cfg = vscode.workspace.getConfiguration('harness');
    return !!cfg.get<string>('accountIdentifier', '').trim();
  }

  async isConfigured(): Promise<boolean> {
    // Check env vars first
    const envCreds = readEnvCredentials();
    if (envCreds.allPresent) {
      // With env vars, we still need org/project from settings
      const cfg = vscode.workspace.getConfiguration('harness');
      return (
        !!cfg.get<string>('orgIdentifier', '').trim() &&
        !!cfg.get<string>('projectIdentifier', '').trim()
      );
    }

    // Fall back to settings
    const hasKey = await this.secretStore.hasApiKey();
    if (!hasKey) return false;
    const cfg = vscode.workspace.getConfiguration('harness');
    return (
      !!cfg.get<string>('accountIdentifier', '').trim() &&
      !!cfg.get<string>('projectIdentifier', '').trim()
    );
  }
}
