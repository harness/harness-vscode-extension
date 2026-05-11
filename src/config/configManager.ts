import * as vscode from 'vscode';
import { SecretStore } from '../auth/secretStore';
import { logger } from '../utils/logger';

export interface HarnessConfig {
  baseUrl: string;
  accountIdentifier: string;
  orgIdentifier: string;
  projectIdentifier: string;
  pollingIntervalSeconds: number;
  diffAwareSTO: boolean;
  apiKey: string;
}

export class ConfigManager {
  constructor(private readonly secretStore: SecretStore) {}

  async getConfig(): Promise<HarnessConfig | null> {
    const cfg = vscode.workspace.getConfiguration('harness');
    const apiKey = await this.secretStore.getApiKey();
    if (!apiKey) {
      logger.debug('ConfigManager', 'No API key found');
      return null;
    }

    const accountIdentifier = cfg.get<string>('accountIdentifier', '').trim();
    if (!accountIdentifier) {
      logger.debug('ConfigManager', 'No account identifier found');
      return null;
    }

    const orgIdentifier = cfg.get<string>('orgIdentifier', 'default').trim();
    const projectIdentifier = cfg.get<string>('projectIdentifier', '').trim();

    logger.debug('ConfigManager', 'Config loaded:', {
      accountIdentifier,
      orgIdentifier,
      projectIdentifier,
      hasWorkspace: !!vscode.workspace.workspaceFolders?.length
    });

    return {
      baseUrl:                cfg.get<string>('baseUrl', 'https://app.harness.io').replace(/\/$/, ''),
      accountIdentifier,
      orgIdentifier,
      projectIdentifier,
      pollingIntervalSeconds: cfg.get<number>('pollingIntervalSeconds', 10),
      diffAwareSTO:           cfg.get<boolean>('diffAwareSTO', true),
      apiKey,
    };
  }

  /** True when PAT + accountIdentifier are set globally — workspace org/project may still be missing. */
  async hasGlobalCredentials(): Promise<boolean> {
    const hasKey = await this.secretStore.hasApiKey();
    if (!hasKey) return false;
    const cfg = vscode.workspace.getConfiguration('harness');
    return !!cfg.get<string>('accountIdentifier', '').trim();
  }

  async isConfigured(): Promise<boolean> {
    const hasKey = await this.secretStore.hasApiKey();
    if (!hasKey) return false;
    const cfg = vscode.workspace.getConfiguration('harness');
    return (
      !!cfg.get<string>('accountIdentifier', '').trim() &&
      !!cfg.get<string>('projectIdentifier', '').trim()
    );
  }
}
