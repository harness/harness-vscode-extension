// MCP configuration for Harness server in Claude Desktop
// Safely writes/updates ~/.claude/claude_desktop_config.json

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getMCPConfigPath } from './detector';
import { logger } from '../utils/logger';

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
}

/**
 * Configure Harness MCP server in Claude Desktop config
 * Backs up invalid JSON before writing
 * Merges with existing servers (never overwrites other tools)
 */
export async function configureMCP(options: ConfigureOptions): Promise<void> {
  const configPath = getMCPConfigPath();
  // Config is at ~/.claude.json (file in home directory, no subdirectory needed)

  let config: ClaudeDesktopConfig = {};

  // Read existing config if it exists
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      config = JSON.parse(content);
    } catch (error) {
      // Invalid JSON - back it up
      const backupPath = `${configPath}.bak`;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPathWithTime = `${configPath}.${timestamp}.bak`;

      // Move to timestamped backup
      fs.copyFileSync(configPath, backupPathWithTime);

      logger.warn('MCP', `Backed up invalid config to ${backupPathWithTime}`);

      // Start fresh
      config = {};
    }
  }

  // Build Harness MCP server config
  // Note: harness-mcp-v2 expects HARNESS_API_KEY (not HARNESS_PLATFORM_API_KEY)
  const harnessConfig: MCPServerConfig = {
    type: 'stdio',
    command: 'npx',
    args: ['harness-mcp-v2'],
    env: {
      HARNESS_API_KEY: options.apiKey,
      HARNESS_BASE_URL: options.baseUrl || 'https://app.harness.io',
      ...(options.accountId && { HARNESS_ACCOUNT_ID: options.accountId }),
      ...(options.orgId && { HARNESS_ORG_ID: options.orgId }),
      ...(options.projectId && { HARNESS_PROJECT_ID: options.projectId }),
    },
  };

  // Configure GLOBAL mcpServers (used when not in a project directory)
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

  // Configure PROJECT-SPECIFIC mcpServers (used when inside a project directory)
  // Get current working directory to determine project key
  const cwd = process.cwd();
  if (!config.projects) {
    config.projects = {};
  }

  // Add to ALL existing projects (so it works regardless of which project you're in)
  const projectKeys = Object.keys(config.projects);
  if (projectKeys.length > 0) {
    for (const projectPath of projectKeys) {
      if (!config.projects[projectPath].mcpServers) {
        config.projects[projectPath].mcpServers = {};
      }
      const existingProjectHarness = config.projects[projectPath].mcpServers!.harness;
      const existingProjectEnv = existingProjectHarness?.env || {};
      config.projects[projectPath].mcpServers!.harness = {
        ...harnessConfig,
        command: existingProjectHarness?.command || harnessConfig.command,
        args: existingProjectHarness?.args || harnessConfig.args,
        env: { ...existingProjectEnv, ...harnessConfig.env },
      };
    }
    logger.debug('MCP', `Configured Harness MCP for ${projectKeys.length} project(s)`);
  }

  // Also add to current working directory if it's not already in projects
  if (cwd && !config.projects[cwd]) {
    config.projects[cwd] = {
      mcpServers: {
        harness: harnessConfig,
      },
    };
    logger.debug('MCP', `Added Harness MCP to current project: ${cwd}`);
  }

  // Write config with pretty formatting (preserves other top-level fields)
  const configJson = JSON.stringify(config, null, 2);
  fs.writeFileSync(configPath, configJson, 'utf-8');

  if (existingGlobalHarness) {
    logger.info('MCP', `Updated Harness MCP server configuration at ${configPath}`);
  } else {
    logger.info('MCP', `Created Harness MCP server configuration at ${configPath}`);
  }
  logger.info('MCP', 'IMPORTANT: Restart Claude Code to activate MCP server');

  // Log the config for debugging
  logger.debug('MCP', 'Global configuration:', JSON.stringify(config.mcpServers?.harness, null, 2));
}

/**
 * Check if Harness MCP is already configured
 */
export function isMCPConfigured(): boolean {
  const configPath = getMCPConfigPath();

  if (!fs.existsSync(configPath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config: ClaudeDesktopConfig = JSON.parse(content);

    const harnessServer = config?.mcpServers?.harness;
    if (!harnessServer) {
      return false;
    }

    // Verify it has required fields
    const hasCommand = typeof harnessServer.command === 'string';
    const hasApiKey = harnessServer.env?.HARNESS_API_KEY || harnessServer.env?.HARNESS_PLATFORM_API_KEY; // Support both for backwards compat

    return hasCommand && !!hasApiKey;
  } catch {
    return false;
  }
}

/**
 * Remove Harness MCP server from config (cleanup/uninstall)
 */
export async function removeMCPConfig(): Promise<void> {
  const configPath = getMCPConfigPath();

  if (!fs.existsSync(configPath)) {
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

      logger.info('MCP', 'Removed Harness MCP server from config');
    }
  } catch (error) {
    logger.error('MCP', 'Failed to remove config:', error);
    throw error;
  }
}
