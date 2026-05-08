// AI tool detection for Claude Code CLI and Extension
// Checks PATH for CLI, VS Code extensions API for Extension, and MCP configuration readiness

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

export interface DetectedTool {
  id: 'claudecode-cli' | 'claudecode-ext' | 'cursor';
  name: string;
  sub: string | null;
  mcpReady: boolean;
  path?: string; // CLI executable path or extension install path
  cursorMcpMode?: 'plugin' | 'local' | 'none'; // how Harness MCP is connected (Cursor only)
  cursorOAuthReady?: boolean; // plugin OAuth authenticated (Cursor only)
}

export interface DetectionResult {
  tools: DetectedTool[];
  activeTool: string | null; // ID of the highest-priority tool
  mcpConfigPath: string | null;
}

/**
 * Detect Claude Code CLI by checking PATH
 */
async function detectClaudeCLI(): Promise<DetectedTool | null> {
  try {
    // Check if claude command exists
    const command = process.platform === 'win32' ? 'where claude' : 'which claude';
    const output = execSync(command, { encoding: 'utf-8', stdio: 'pipe' }).trim();

    if (!output) {
      return null;
    }

    const cliPath = output.split('\n')[0]; // Take first match

    // Verify it's Claude Code CLI by checking version
    try {
      const versionOutput = execSync('claude --version', { encoding: 'utf-8', stdio: 'pipe', timeout: 3000 });

      // Check if it's actually Claude Code (not some other claude command)
      if (!versionOutput.toLowerCase().includes('claude')) {
        return null;
      }
    } catch {
      // If --version fails, assume it's not Claude Code
      return null;
    }

    // Check MCP configuration readiness
    const mcpReady = await checkMCPReady();

    return {
      id: 'claudecode-cli',
      name: 'Claude Code',
      sub: 'CLI',
      mcpReady,
      path: cliPath,
    };
  } catch (error) {
    // Command not found or execution failed
    return null;
  }
}

/**
 * Detect Claude Code Extension via VS Code extensions API
 */
async function detectClaudeExtension(): Promise<DetectedTool | null> {
  try {
    const extension = vscode.extensions.getExtension('anthropic.claude-code');

    if (!extension) {
      return null;
    }

    // Check MCP configuration readiness (same config file as CLI)
    const mcpReady = await checkMCPReady();

    return {
      id: 'claudecode-ext',
      name: 'Claude Code',
      sub: 'Extension',
      mcpReady,
      path: extension.extensionPath,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Check if Harness MCP server is configured in Claude Desktop config
 */
async function checkMCPReady(): Promise<boolean> {
  const configPath = getClaudeConfigPath();

  if (!configPath || !fs.existsSync(configPath)) {
    return false;
  }

  try {
    const configContent = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(configContent);

    // Check if mcpServers.harness exists and has required fields
    const harnessServer = config?.mcpServers?.harness;
    if (!harnessServer) {
      return false;
    }

    // Verify it has command and env (at minimum)
    const hasCommand = typeof harnessServer.command === 'string' && harnessServer.command.length > 0;
    const hasEnv = harnessServer.env && typeof harnessServer.env === 'object';

    return hasCommand && hasEnv;
  } catch (error) {
    // Invalid JSON or read error
    return false;
  }
}

/**
 * Get Claude Code config path
 * Returns ~/.claude.json on all platforms
 */
function getClaudeConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

/**
 * Check if Harness MCP entry exists in Cursor mcp.json
 */
function hasCursorMcpEntry(cursorMcpPath: string): boolean {
  if (!fs.existsSync(cursorMcpPath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(cursorMcpPath, 'utf-8');
    const config = JSON.parse(content);
    const harnessServer = config?.mcpServers?.harness;
    if (!harnessServer) {
      return false;
    }
    // Verify it has command and env (at minimum)
    const hasCommand = typeof harnessServer.command === 'string' && harnessServer.command.length > 0;
    const hasEnv = harnessServer.env && typeof harnessServer.env === 'object';
    return hasCommand && hasEnv;
  } catch {
    return false;
  }
}

/**
 * Recursively search for Harness plugin in Cursor plugins directory
 */
function findHarnessPlugin(dir: string, maxDepth = 3, currentDepth = 0): string | null {
  if (currentDepth >= maxDepth || !fs.existsSync(dir)) {
    return null;
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Check if this directory is the Harness plugin
      if (entry.name.toLowerCase().includes('harness')) {
        const fullPath = path.join(dir, entry.name);
        // Verify it's a plugin by checking for .cursor-plugin marker
        const pluginMarker = path.join(fullPath, '.cursor-plugin');
        if (fs.existsSync(pluginMarker)) {
          return fullPath;
        }
        // Also check subdirectories (versioned plugin directories)
        const subEntries = fs.readdirSync(fullPath, { withFileTypes: true });
        for (const subEntry of subEntries) {
          if (subEntry.isDirectory()) {
            const subPluginMarker = path.join(fullPath, subEntry.name, '.cursor-plugin');
            if (fs.existsSync(subPluginMarker)) {
              return path.join(fullPath, subEntry.name);
            }
          }
        }
      }

      // Recurse into subdirectories
      const found = findHarnessPlugin(path.join(dir, entry.name), maxDepth, currentDepth + 1);
      if (found) return found;
    }

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Check if Cursor plugin has OAuth configured
 *
 * Detection Strategy: When Cursor plugins are authenticated, they expose their full
 * tool catalog to project directories. Unauthenticated plugins only show STATUS.md
 * and mcp_auth.json.
 *
 * Authenticated state indicators:
 * - prompts/ directory exists with .json files
 * - tools/ directory contains harness_*.json files (not just mcp_auth.json)
 * - resources/ directory exists
 */
function isCursorPluginOAuthReady(cursorDir: string): boolean {
  const projectsDir = path.join(cursorDir, 'projects');

  if (!fs.existsSync(projectsDir)) {
    return false;
  }

  try {
    // Look for ANY project directory that has the full Harness MCP toolset exposed
    // This indicates successful OAuth authentication
    const findAuthenticatedPlugin = (dir: string, depth = 0): boolean => {
      if (depth > 4) return false; // Limit recursion

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isDirectory()) continue;

          const fullPath = path.join(dir, entry.name);

          // Check if this looks like an authenticated Harness plugin directory
          if (entry.name.includes('harness')) {
            // Authenticated plugins have prompts/ and multiple harness_*.json tools
            const promptsDir = path.join(fullPath, 'prompts');
            const toolsDir = path.join(fullPath, 'tools');

            if (fs.existsSync(promptsDir) && fs.existsSync(toolsDir)) {
              // Check for actual Harness tools (not just mcp_auth)
              const toolFiles = fs.readdirSync(toolsDir);
              const hasHarnessTools = toolFiles.some(f => f.startsWith('harness_') && f.endsWith('.json'));

              if (hasHarnessTools) {
                console.log('[Cursor OAuth Detection] ✅ Authenticated plugin found at:', fullPath);
                return true;
              }
            }
          }

          // Recurse into subdirectories
          if (findAuthenticatedPlugin(fullPath, depth + 1)) {
            return true;
          }
        }
      } catch {
        // Ignore directory read errors
      }

      return false;
    };

    return findAuthenticatedPlugin(projectsDir);
  } catch {
    return false;
  }
}

/**
 * Detect Cursor AI editor
 * Only detects when running inside Cursor editor (not VS Code)
 */
async function detectCursor(): Promise<DetectedTool | null> {
  try {
    // Step 0 - Are we running in Cursor editor?
    // Check if the host application is Cursor
    const isCursorEditor = vscode.env.appName.toLowerCase().includes('cursor');

    if (!isCursorEditor) {
      // Running in VS Code, not Cursor - skip detection
      return null;
    }

    // Step 1 - Is Cursor installed?
    const cursorDir = path.join(os.homedir(), '.cursor');
    const cursorInstalled = fs.existsSync(cursorDir);

    if (!cursorInstalled) {
      return null;
    }

    // Step 2 - Which MCP mode?
    // Priority 1: Harness Cursor Plugin (preferred — OAuth, remote MCP, zero config)
    const pluginDir = path.join(cursorDir, 'plugins');
    const pluginPath = findHarnessPlugin(pluginDir);
    const hasPlugin = pluginPath !== null;

    // Priority 2: Local harness-mcp-v2 in mcp.json (fallback)
    const cursorMcpPath = path.join(cursorDir, 'mcp.json');
    const hasLocalMcp = hasCursorMcpEntry(cursorMcpPath);

    // Determine mode
    const cursorMcpMode: 'plugin' | 'local' | 'none' =
      hasPlugin ? 'plugin' :
      hasLocalMcp ? 'local' :
      'none';

    // Step 3 - OAuth status (plugin mode only)
    // For Cursor plugins, OAuth is managed by the plugin system
    // We check if auth files exist in the projects directory
    const cursorOAuthReady = hasPlugin && isCursorPluginOAuthReady(cursorDir);

    // Step 4 - Determine mcpReady status
    const mcpReady = (cursorMcpMode === 'plugin' && cursorOAuthReady) || cursorMcpMode === 'local';

    return {
      id: 'cursor',
      name: 'Cursor',
      sub: null,
      mcpReady,
      path: cursorDir,
      cursorMcpMode,
      cursorOAuthReady,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Detect all available AI tools (Claude Code CLI + Extension + Cursor)
 * Returns preferred tool as activeTool, or first available if no preference
 */
export async function detectAITools(preferredToolId?: string): Promise<DetectionResult> {
  const tools: DetectedTool[] = [];

  // Detect CLI
  const cli = await detectClaudeCLI();
  if (cli) {
    tools.push(cli);
  }

  // Detect Extension
  const ext = await detectClaudeExtension();
  if (ext) {
    tools.push(ext);
  }

  // Detect Cursor
  const cursor = await detectCursor();
  if (cursor) {
    tools.push(cursor);
  }

  // Use preferred tool if specified and available, otherwise default to first
  let activeTool: string | null = null;
  if (preferredToolId && tools.some(t => t.id === preferredToolId)) {
    activeTool = preferredToolId;
  } else {
    activeTool = tools.length > 0 ? tools[0].id : null;
  }

  return {
    tools,
    activeTool,
    mcpConfigPath: tools.length > 0 ? getClaudeConfigPath() : null,
  };
}

/**
 * Get the MCP config path for Claude Code
 * Used by MCP configurer to write settings
 */
export function getMCPConfigPath(): string {
  return getClaudeConfigPath();
}
