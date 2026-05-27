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

  /**
   * Determine which auth source to use, validating that it's properly configured
   */
  private getAuthSource(): 'env' | 'pat' {
    const cfg = vscode.workspace.getConfiguration('harness');
    const authSource = cfg.get<string>('authSource', 'pat');

    if (authSource === 'env') {
      const envCreds = readEnvCredentials();
      if (envCreds.allPresent) {
        return 'env';
      }
      logger.warn('ConfigManager', 'authSource is "env" but environment variables are missing, falling back to PAT');
    }

    return 'pat';
  }

  async getConfig(): Promise<HarnessConfig | null> {
    const cfg = vscode.workspace.getConfiguration('harness');
    const authSource = this.getAuthSource();

    let apiKey: string | undefined;
    let accountIdentifier: string;
    let baseUrl: string;

    if (authSource === 'env') {
      // Strict env mode: use ONLY environment variables for credentials
      const envCreds = readEnvCredentials();
      apiKey = envCreds.apiKey || undefined;
      accountIdentifier = envCreds.accountId || '';
      baseUrl = envCreds.baseUrl || 'https://app.harness.io';

      logger.debug('ConfigManager', 'Using environment variable credentials');
    } else {
      // Strict PAT mode: use ONLY secret store + settings for credentials
      apiKey = await this.secretStore.getApiKey();
      accountIdentifier = cfg.get<string>('accountIdentifier', '').trim();
      baseUrl = cfg.get<string>('baseUrl', 'https://app.harness.io');

      logger.debug('ConfigManager', 'Using PAT credentials from secret store');
    }

    if (!apiKey) {
      logger.debug('ConfigManager', 'No API key found for authSource:', authSource);
      return null;
    }

    if (!accountIdentifier) {
      logger.debug('ConfigManager', 'No account identifier found for authSource:', authSource);
      return null;
    }

    const orgIdentifier = cfg.get<string>('orgIdentifier', 'default').trim();
    const projectIdentifier = cfg.get<string>('projectIdentifier', '').trim();

    logger.debug('ConfigManager', 'Config loaded:', {
      authSource,
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
