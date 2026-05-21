// MCP configuration for Harness server in Claude Desktop and GitHub Copilot
// Safely writes/updates ~/.claude/claude_desktop_config.json and VS Code MCP configs

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { getProjectMCPConfigPath, getGlobalMCPConfigPath, detectMCPScope } from './detector';
import { logger } from '../utils/logger';
import { MCPScope } from './types';

interface MCPServerConfig {
  type: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface ClaudeProjectConfig {
  mcpServers?: Record<string, MCPServerConfig>;
  [key: string]: unknown;
}

interface ClaudeDesktopConfig {
  mcpServers?: Record<string, MCPServerConfig>;
  projects?: Record<string, ClaudeProjectConfig>;
  [key: string]: unknown;
}

export interface ConfigureOptions {
  apiKey: string;
  baseUrl: string;
  accountId?: string;
  orgId?: string;
  projectId?: string;
  scope: MCPScope;
  credentialSource?: 'env' | 'pat';  // NEW — default 'pat'
}

/**
 * Build Harness MCP server config for Claude Code
 * When credentialSource === 'env', emits ${HARNESS_*} literals for passthrough
 */
function buildHarnessServerConfig(options: ConfigureOptions): MCPServerConfig {
  const useEnvPassthrough = options.credentialSource === 'env';

  return {
    type: 'stdio',
    command: 'npx',
    args: ['harness-mcp-v2'],
    env: {
      HARNESS_API_KEY: useEnvPassthrough ? '${HARNESS_API_KEY}' : options.apiKey,
      HARNESS_BASE_URL: useEnvPassthrough ? '${HARNESS_BASE_URL}' : (options.baseUrl || 'https://app.harness.io'),
      ...(options.accountId && {
        HARNESS_ACCOUNT_ID: useEnvPassthrough ? '${HARNESS_ACCOUNT_ID}' : options.accountId,
      }),
      ...(options.orgId && { HARNESS_ORG_ID: options.orgId }),
      ...(options.projectId && { HARNESS_PROJECT_ID: options.projectId }),
    },
  };
}

/**
 * Build Harness MCP server config for GitHub Copilot
 * - When credentialSource === 'env': Only include org/project IDs (API key, base URL, account ID inherited from VS Code process)
 * - When credentialSource === 'pat': Include all credentials explicitly (no environment variables available)
 */
function buildCopilotServerConfig(options: ConfigureOptions): MCPServerConfig {
  const useEnvAuth = options.credentialSource === 'env';

  return {
    type: 'stdio',
    command: 'npx',
    args: ['harness-mcp-v2'],
    env: {
      // If using PAT auth, include credentials explicitly (no env vars available)
      // If using env auth, omit credentials (inherited from VS Code process)
      ...(!useEnvAuth && {
        HARNESS_API_KEY: options.apiKey,
        HARNESS_BASE_URL: options.baseUrl || 'https://app.harness.io',
        ...(options.accountId && { HARNESS_ACCOUNT_ID: options.accountId }),
      }),
      // Always include org/project IDs
      ...(options.orgId && { HARNESS_ORG_ID: options.orgId }),
      ...(options.projectId && { HARNESS_PROJECT_ID: options.projectId }),
    },
  };
}

/**
 * Write Harness MCP config to global scope (~/.claude.json)
 * Only writes to top-level mcpServers (truly global, no project-specific entries)
 */
function writeGlobalScope(globalPath: string, harnessConfig: MCPServerConfig): void {
  let config: ClaudeDesktopConfig = {};

  // Read existing config if it exists
  if (fs.existsSync(globalPath)) {
    try {
      const content = fs.readFileSync(globalPath, 'utf-8');
      config = JSON.parse(content);
    } catch (error) {
      // Invalid JSON - back it up
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPathWithTime = `${globalPath}.${timestamp}.bak`;
      fs.copyFileSync(globalPath, backupPathWithTime);
      logger.warn('MCP', `Backed up invalid config to ${backupPathWithTime}`);
      config = {};
    }
  }

  // Configure GLOBAL mcpServers (applies to all projects)
  if (!config.mcpServers) {
    config.mcpServers = {};
  }
  const existingGlobalHarness = config.mcpServers.harness;
  const existingGlobalEnv = existingGlobalHarness?.env || {};
  config.mcpServers.harness = {
    ...harnessConfig,
    command: existingGlobalHarness?.command || harnessConfig.command,
    args: existingGlobalHarness?.args || harnessConfig.args,
    env: { ...existingGlobalEnv, ...harnessConfig.env },
  };

  // Write config with pretty formatting (preserves other top-level fields)
  const configJson = JSON.stringify(config, null, 2);
  fs.writeFileSync(globalPath, configJson, 'utf-8');

  if (existingGlobalHarness) {
    logger.info('MCP', `Updated Harness MCP server configuration at ${globalPath}`);
  } else {
    logger.info('MCP', `Created Harness MCP server configuration at ${globalPath}`);
  }
  logger.info('MCP', 'IMPORTANT: Restart Claude Code to activate MCP server');

  // Log the config for debugging
  logger.debug('MCP', 'Global configuration:', JSON.stringify(config.mcpServers?.harness, null, 2));
}

/**
 * Write Harness MCP config to project scope (.mcp.json)
 */
function writeProjectScope(filePath: string, harness: MCPServerConfig): void {
  let config: { mcpServers?: Record<string, MCPServerConfig> } = {};
  if (fs.existsSync(filePath)) {
    try {
      config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(filePath, `${filePath}.${ts}.bak`);
      logger.warn('MCP', `Backed up invalid .mcp.json`);
      config = {};
    }
  }

  if (!config.mcpServers) config.mcpServers = {};
  const existing = config.mcpServers.harness;
  config.mcpServers.harness = {
    ...harness,
    command: existing?.command || harness.command,
    args: existing?.args || harness.args,
    env: { ...(existing?.env || {}), ...harness.env },
  };

  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
  logger.info('MCP', existing ? `Updated Harness MCP at ${filePath}` : `Created Harness MCP at ${filePath}`);
}

/**
 * Configure Harness MCP server in the chosen scope
 * Backs up invalid JSON before writing
 * Merges with existing servers (never overwrites other tools)
 */
export async function configureMCP(options: ConfigureOptions): Promise<{ scope: MCPScope; path: string }> {
  const harnessConfig: MCPServerConfig = buildHarnessServerConfig(options);

  if (options.scope === 'project') {
    const projectPath = getProjectMCPConfigPath();
    if (!projectPath) {
      throw new Error('No workspace folder is open. Open a folder before choosing project scope.');
    }
    writeProjectScope(projectPath, harnessConfig);
    return { scope: 'project', path: projectPath };
  }

  const globalPath = getGlobalMCPConfigPath();
  writeGlobalScope(globalPath, harnessConfig);
  return { scope: 'global', path: globalPath };
}

/**
 * Check if Harness MCP is already configured
 */
export function isMCPConfigured(scope?: MCPScope): boolean {
  const s = detectMCPScope();
  if (!scope) return s.activeScope !== null;
  if (scope === 'project') return !!s.project?.configured;
  return s.global.configured;
}

/**
 * Remove Harness MCP server from config (cleanup/uninstall)
 */
export async function removeMCPConfig(scope: MCPScope): Promise<void> {
  const configPath = scope === 'project' ? getProjectMCPConfigPath() : getGlobalMCPConfigPath();

  if (!configPath || !fs.existsSync(configPath)) {
    return;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config: ClaudeDesktopConfig = JSON.parse(content);

    if (config.mcpServers?.harness) {
      delete config.mcpServers.harness;

      // Write updated config
      const configJson = JSON.stringify(config, null, 2);
      fs.writeFileSync(configPath, configJson, 'utf-8');

      logger.info('MCP', `Removed Harness MCP server from ${scope} config`);
    }
  } catch (error) {
    logger.error('MCP', 'Failed to remove config:', error);
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub Copilot MCP Configuration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get GitHub Copilot MCP config paths (cross-platform)
 * - Local (project): .vscode/mcp.json
 * - Global (user):
 *   - macOS: ~/Library/Application Support/Code/User/mcp.json
 *   - Windows: %APPDATA%\Code\User\mcp.json
 *   - Linux: ~/.config/Code/User/mcp.json
 */
function getCopilotMcpPaths(): { local: string | null; global: string } {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const local = workspaceFolder ? path.join(workspaceFolder.uri.fsPath, '.vscode', 'mcp.json') : null;

  let global: string;
  if (process.platform === 'darwin') {
    global = path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    global = path.join(appData, 'Code', 'User', 'mcp.json');
  } else {
    // Linux
    global = path.join(os.homedir(), '.config', 'Code', 'User', 'mcp.json');
  }

  return { local, global };
}

/**
 * Write Harness MCP config to Copilot's local (.vscode/mcp.json) or global scope
 * GitHub Copilot uses "servers" key instead of "mcpServers"
 */
function writeCopilotMcpConfig(filePath: string, harness: MCPServerConfig): void {
  // Ensure directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let config: { servers?: Record<string, MCPServerConfig> } = {};
  if (fs.existsSync(filePath)) {
    try {
      config = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(filePath, `${filePath}.${ts}.bak`);
      logger.warn('MCP', `Backed up invalid mcp.json at ${filePath}`);
      config = {};
    }
  }

  if (!config.servers) config.servers = {};
  const existing = config.servers.harness;
  config.servers.harness = {
    ...harness,
    command: existing?.command || harness.command,
    args: existing?.args || harness.args,
    env: { ...(existing?.env || {}), ...harness.env },
  };

  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
  logger.info('MCP', existing ? `Updated Harness MCP at ${filePath}` : `Created Harness MCP at ${filePath}`);
  logger.info('MCP', 'IMPORTANT: Restart VS Code to activate MCP server for GitHub Copilot');
}

/**
 * Configure Harness MCP server for GitHub Copilot (local or global scope)
 */
export async function configureCopilotMCP(options: ConfigureOptions): Promise<{ scope: MCPScope; path: string }> {
  const harnessConfig: MCPServerConfig = buildCopilotServerConfig(options);
  const paths = getCopilotMcpPaths();

  if (options.scope === 'project') {
    if (!paths.local) {
      throw new Error('No workspace folder is open. Open a folder before choosing project scope.');
    }
    writeCopilotMcpConfig(paths.local, harnessConfig);
    return { scope: 'project', path: paths.local };
  }

  writeCopilotMcpConfig(paths.global, harnessConfig);
  return { scope: 'global', path: paths.global };
}

/**
 * Remove Harness MCP server from GitHub Copilot config
 */
export async function removeCopilotMCPConfig(scope: MCPScope): Promise<void> {
  const paths = getCopilotMcpPaths();
  const configPath = scope === 'project' ? paths.local : paths.global;

  if (!configPath || !fs.existsSync(configPath)) {
    return;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config: { servers?: Record<string, MCPServerConfig> } = JSON.parse(content);

    if (config.servers?.harness) {
      delete config.servers.harness;

      // Write updated config
      const configJson = JSON.stringify(config, null, 2);
      fs.writeFileSync(configPath, configJson, 'utf-8');

      logger.info('MCP', `Removed Harness MCP server from GitHub Copilot ${scope} config`);
    }
  } catch (error) {
    logger.error('MCP', 'Failed to remove Copilot MCP config:', error);
    throw error;
  }
}
