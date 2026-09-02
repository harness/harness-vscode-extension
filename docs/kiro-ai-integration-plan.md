# Kiro AI Integration - Implementation Plan

> **Status:** Research & Planning Phase  
> **Created:** 2026-09-01  
> **Target:** Add Kiro IDE AI integration to Harness VS Code Extension

---

## Executive Summary

This document outlines the implementation plan to add **Kiro IDE** support to the Harness VS Code extension's AI integration features, including:
1. Kiro AI Chat integration (prompt auto-paste)
2. MCP (Model Context Protocol) configuration automation for Harness MCP server
3. Detection and lifecycle management

---

## Current State Analysis

### Supported AI Tools (v0.1.9)

The extension currently supports 4 AI tools:

| Tool | Detection Method | MCP Config Location | Launch Method | Notes |
|------|-----------------|---------------------|---------------|-------|
| **Claude Code CLI** | `which claude` | `~/.claude.json` | Subprocess spawn | Full automation |
| **Claude Code Extension** | VS Code extension API | `~/.claude.json` or `.mcp.json` | Command + auto-paste | Semi-automated |
| **Cursor** | `vscode.env.appName` | `~/.cursor/mcp.json` (macOS/Linux)<br>`%APPDATA%\Cursor\User\mcp.json` (Windows) | Command + auto-paste | Plugin (OAuth) or local MCP |
| **GitHub Copilot** | VS Code extension API | `.vscode/mcp.json` (local)<br>Platform-specific global path | Command + auto-paste | Uses `"servers"` key |

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                       Extension Host                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │  detector.ts │  │mcpConfigurer │  │ launcher.ts  │         │
│  │              │  │              │  │              │         │
│  │ - Detect AI  │  │ - Write MCP  │  │ - Launch AI  │         │
│  │   tools      │  │   configs    │  │   with prompt│         │
│  │ - Check MCP  │  │ - Backup     │  │ - Auto-paste │         │
│  │   readiness  │  │ - Merge      │  │ - CLI spawn  │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
│         │                  │                  │                 │
│         └──────────────────┴──────────────────┘                │
│                            │                                    │
│                    ┌───────▼────────┐                          │
│                    │ webviewBridge  │                          │
│                    │                │                          │
│                    │ - AI_RESPONSE  │                          │
│                    │ - AI_LAUNCHED  │                          │
│                    │ - AI_ERROR     │                          │
│                    │ - STATE_UPDATE │                          │
│                    └───────┬────────┘                          │
└────────────────────────────┼───────────────────────────────────┘
                             │
                    ┌────────▼─────────┐
                    │  Webview (UI)    │
                    │                  │
                    │ - AI bar         │
                    │ - Tool badges    │
                    │ - MCP setup flow │
                    └──────────────────┘
```

---

## Kiro IDE - Research Questions

> **⚠️ CRITICAL:** The following information needs to be confirmed before implementation:

### 1. **Environment Detection**
- **Question:** How can we detect if the extension is running in Kiro?
  - Expected: `vscode.env.appName` contains "Kiro" (similar to Cursor)
  - Alternative: Check for Kiro-specific extension or environment variable?
  
### 2. **AI Chat Interface**
- **Question:** Does Kiro have a built-in AI chat interface?
  - Expected: Yes (similar to Cursor Composer)
  - **Question:** What is the VS Code command to open it?
    - Possible commands: `kiro.openChat`, `kiro.ai.chat`, `workbench.action.chat.open`?

### 3. **MCP Support**
- **Question:** Does Kiro support MCP (Model Context Protocol)?
  - Expected: Yes (standard protocol)
  - **Question:** Where does Kiro store its MCP configuration?
    - Possible locations:
      - `~/.kiro/mcp.json` (macOS/Linux)
      - `%APPDATA%\Kiro\User\mcp.json` (Windows)
      - `.vscode/mcp.json` (project-level, if Kiro shares VS Code settings)
  - **Question:** What is the config format?
    - Expected: `{ "mcpServers": { "harness": { ... } } }` (Claude Code format)
    - Alternative: `{ "servers": { "harness": { ... } } }` (Copilot format)

### 4. **Authentication**
- **Question:** Does Kiro have OAuth plugin support (like Cursor)?
  - If yes: Need detection logic for plugin installation + auth status
  - If no: Use local MCP config only

### 5. **Auto-Paste Mechanism**
- **Question:** Can we auto-paste prompts into Kiro AI Chat?
  - Expected: Yes, via `editor.action.clipboardPasteAction` command
  - Alternative: Kiro-specific paste command?

---

## Implementation Plan

### Phase 1: Research & Discovery (1 day)

**Goal:** Answer all research questions above

**Tasks:**
1. Install Kiro IDE in test environment
2. Inspect `vscode.env.appName` value in Kiro
3. List all available VS Code commands in Kiro:
   ```typescript
   const allCommands = await vscode.commands.getCommands(true);
   const kiroCommands = allCommands.filter(cmd => 
     cmd.toLowerCase().includes('kiro') || 
     cmd.toLowerCase().includes('ai') ||
     cmd.toLowerCase().includes('chat')
   );
   ```
4. Search Kiro filesystem for MCP config files
5. Test MCP server installation manually
6. Document findings in this plan

**Acceptance Criteria:**
- [ ] Confirmed detection method
- [ ] Confirmed AI chat command
- [ ] Confirmed MCP config location(s)
- [ ] Confirmed MCP config format
- [ ] Confirmed auto-paste mechanism

---

### Phase 2: Core Detection (0.5 days)

**Goal:** Add Kiro detection to `src/ai/detector.ts`

**Files to Modify:**
- `src/ai/detector.ts`
- `src/ai/types.ts`

**Implementation Steps:**

#### 1. Update Types (`src/ai/types.ts`)
```typescript
export interface DetectedTool {
  id: 'claudecode-cli' | 'claudecode-ext' | 'cursor' | 'copilot' | 'kiro';  // ADD 'kiro'
  name: string;
  sub: string | null;
  mcpReady: boolean;
  path?: string;
  // Kiro-specific fields (if needed)
  kiroMcpMode?: 'plugin' | 'local' | 'none';  // IF Kiro has plugin support
  kiroOAuthReady?: boolean;                    // IF Kiro has OAuth
}
```

#### 2. Add Kiro Detection Functions (`src/ai/detector.ts`)

```typescript
/**
 * Get Kiro MCP config path (cross-platform)
 * TODO: Verify actual paths with Kiro installation
 */
function getKiroMcpPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Kiro', 'User', 'mcp.json');  // ASSUMPTION
  } else {
    return path.join(os.homedir(), '.kiro', 'mcp.json');    // ASSUMPTION
  }
}

/**
 * Check if Harness MCP entry exists in Kiro mcp.json
 */
function hasKiroMcpEntry(kiroMcpPath: string): boolean {
  if (!fs.existsSync(kiroMcpPath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(kiroMcpPath, 'utf-8');
    const config = JSON.parse(content);
    // TODO: Verify if Kiro uses 'mcpServers' or 'servers' key
    const harnessServer = config?.mcpServers?.harness ?? config?.servers?.harness;
    if (!harnessServer) {
      return false;
    }
    const hasCommand = typeof harnessServer.command === 'string' && harnessServer.command.length > 0;
    const hasEnv = harnessServer.env && typeof harnessServer.env === 'object';
    return hasCommand && hasEnv;
  } catch {
    return false;
  }
}

/**
 * Detect Kiro IDE
 * Only detects when running inside Kiro editor
 */
async function detectKiro(): Promise<DetectedTool | null> {
  try {
    // Step 1 - Are we running in Kiro editor?
    const isKiroEditor = vscode.env.appName.toLowerCase().includes('kiro');  // TODO: Verify

    if (!isKiroEditor) {
      return null;
    }

    // Step 2 - Check MCP configuration
    const kiroMcpPath = getKiroMcpPath();
    const mcpReady = hasKiroMcpEntry(kiroMcpPath);

    // Step 3 - Plugin detection (IF Kiro supports plugins)
    // TODO: Add plugin detection logic if applicable

    return {
      id: 'kiro',
      name: 'Kiro',
      sub: null,
      mcpReady,
      path: path.dirname(kiroMcpPath),
    };
  } catch (error) {
    logger.error('Kiro Detection', 'Failed to detect Kiro:', error);
    return null;
  }
}
```

#### 3. Register Kiro in Main Detection Function

```typescript
export async function detectAITools(preferredToolId?: string): Promise<DetectionResult> {
  const tools: DetectedTool[] = [];

  // ... existing detections ...

  // Detect Kiro
  const kiro = await detectKiro();
  if (kiro) {
    tools.push(kiro);
  }

  // ... rest of function ...
}
```

**Acceptance Criteria:**
- [ ] Kiro is detected when running in Kiro IDE
- [ ] MCP readiness check works
- [ ] No errors when Kiro is not installed
- [ ] Logger outputs clear debug info

---

### Phase 3: MCP Configuration (0.5 days)

**Goal:** Add Kiro MCP config writer to `src/ai/mcpConfigurer.ts`

**Files to Modify:**
- `src/ai/mcpConfigurer.ts`

**Implementation Steps:**

#### 1. Add Kiro Config Builder

```typescript
/**
 * Build Harness MCP server config for Kiro
 * TODO: Verify if Kiro uses 'mcpServers' or 'servers' key
 */
function buildKiroServerConfig(options: ConfigureOptions): MCPServerConfig {
  const useEnvAuth = options.credentialSource === 'env';

  return {
    type: 'stdio',
    command: 'npx',
    args: ['harness-mcp-v2'],
    env: {
      // If using PAT auth, include credentials explicitly
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
```

#### 2. Add Kiro Config Writer

```typescript
/**
 * Get Kiro MCP config paths (cross-platform)
 */
function getKiroMcpPaths(): { local: string | null; global: string } {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const local = workspaceFolder ? path.join(workspaceFolder.uri.fsPath, '.vscode', 'mcp.json') : null;

  let global: string;
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    global = path.join(appData, 'Kiro', 'User', 'mcp.json');  // TODO: Verify
  } else {
    global = path.join(os.homedir(), '.kiro', 'mcp.json');    // TODO: Verify
  }

  return { local, global };
}

/**
 * Write Harness MCP config to Kiro's local or global scope
 */
function writeKiroMcpConfig(filePath: string, harness: MCPServerConfig): void {
  // Ensure directory exists
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // TODO: Verify if Kiro uses 'mcpServers' or 'servers' key
  let config: { mcpServers?: Record<string, MCPServerConfig>; servers?: Record<string, MCPServerConfig> } = {};
  
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

  // Try mcpServers first (Claude format), fall back to servers (Copilot format)
  const serverKey = config.mcpServers !== undefined ? 'mcpServers' : 'servers';
  if (!config[serverKey]) config[serverKey] = {};
  
  const existing = config[serverKey]!.harness;
  config[serverKey]!.harness = {
    ...harness,
    command: existing?.command || harness.command,
    args: existing?.args || harness.args,
    env: { ...(existing?.env || {}), ...harness.env },
  };

  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8');
  logger.info('MCP', existing ? `Updated Harness MCP at ${filePath}` : `Created Harness MCP at ${filePath}`);
  logger.info('MCP', 'IMPORTANT: Restart Kiro to activate MCP server');
}

/**
 * Configure Harness MCP server for Kiro (local or global scope)
 */
export async function configureKiroMCP(options: ConfigureOptions): Promise<{ scope: MCPScope; path: string; gitignoreAdded?: string[] }> {
  const harnessConfig: MCPServerConfig = buildKiroServerConfig(options);
  const paths = getKiroMcpPaths();
  const writesPatToProject = options.scope === 'project' && options.credentialSource !== 'env';

  if (options.scope === 'project') {
    if (!paths.local) {
      throw new Error('No workspace folder is open. Open a folder before choosing project scope.');
    }
    writeKiroMcpConfig(paths.local, harnessConfig);
    const gitignoreAdded = writesPatToProject ? await ensureMcpSecretsGitignored() : [];
    return { scope: 'project', path: paths.local, gitignoreAdded };
  }

  writeKiroMcpConfig(paths.global, harnessConfig);
  return { scope: 'global', path: paths.global };
}

/**
 * Remove Harness MCP server from Kiro config
 */
export async function removeKiroMCPConfig(scope: MCPScope): Promise<void> {
  const paths = getKiroMcpPaths();
  const configPath = scope === 'project' ? paths.local : paths.global;

  if (!configPath || !fs.existsSync(configPath)) {
    return;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const config: { mcpServers?: Record<string, MCPServerConfig>; servers?: Record<string, MCPServerConfig> } = JSON.parse(content);

    // Try both keys
    if (config.mcpServers?.harness) {
      delete config.mcpServers.harness;
    }
    if (config.servers?.harness) {
      delete config.servers.harness;
    }

    const configJson = JSON.stringify(config, null, 2);
    fs.writeFileSync(configPath, configJson, 'utf-8');

    logger.info('MCP', `Removed Harness MCP server from Kiro ${scope} config`);
  } catch (error) {
    logger.error('MCP', 'Failed to remove Kiro MCP config:', error);
    throw error;
  }
}
```

**Acceptance Criteria:**
- [ ] MCP config is written to correct location
- [ ] Existing config is preserved and merged
- [ ] Invalid JSON is backed up before overwrite
- [ ] Works for both local and global scope
- [ ] Works with both env vars and PAT auth

---

### Phase 4: Launcher Integration (0.5 days)

**Goal:** Add Kiro launcher to `src/ai/launcher.ts`

**Files to Modify:**
- `src/ai/launcher.ts`

**Implementation Steps:**

#### 1. Update LaunchOptions Type

```typescript
interface LaunchOptions {
  prompt: string;
  toolId: 'claudecode-cli' | 'claudecode-ext' | 'cursor' | 'copilot' | 'kiro';  // ADD 'kiro'
  config?: HarnessConfig;
  cwd?: string;
  mcpConfigPath?: string;
}
```

#### 2. Add Kiro Launch Function

```typescript
/**
 * Launch Kiro AI Chat with prompt
 * Opens Kiro AI Chat and auto-pastes the prompt
 */
async function launchKiro(prompt: string): Promise<LaunchResult> {
  try {
    logger.debug('AI Launcher', 'Starting Kiro integration');
    logger.debug('AI Launcher', 'Prompt length:', prompt.length);

    // List all available commands to find the right one
    const allCommands = await vscode.commands.getCommands(true);
    const kiroCommands = allCommands.filter(cmd =>
      cmd.toLowerCase().includes('kiro') ||
      cmd.toLowerCase().includes('ai') ||
      cmd.toLowerCase().includes('chat')
    );
    logger.debug('AI Launcher', 'Available Kiro commands:', kiroCommands);

    // Copy prompt to clipboard
    await vscode.env.clipboard.writeText(prompt);
    logger.debug('AI Launcher', '✓ Prompt copied to clipboard');

    // Try opening Kiro AI Chat
    // TODO: Replace with actual Kiro commands after discovery phase
    const commandsToTry = [
      'kiro.openChat',              // Hypothetical command
      'kiro.ai.chat',               // Hypothetical command
      'workbench.action.chat.open', // Generic fallback
    ];

    let opened = false;
    for (const cmd of commandsToTry) {
      if (kiroCommands.includes(cmd) || allCommands.includes(cmd)) {
        try {
          logger.debug('AI Launcher', `⏳ Trying command: ${cmd}`);
          await vscode.commands.executeCommand(cmd);
          logger.debug('AI Launcher', `✓ Opened with: ${cmd}`);
          opened = true;
          break;
        } catch (err) {
          logger.debug('AI Launcher', `⚠ ${cmd} failed`);
        }
      }
    }

    if (!opened) {
      logger.debug('AI Launcher', '✗ Could not open Kiro AI Chat with any command');
      vscode.window.showWarningMessage('Could not open Kiro AI Chat. Please open it manually and try again.');
      return {
        type: 'error',
        error: 'Failed to open Kiro AI Chat',
      };
    }

    // Give UI time to render and focus
    await new Promise(resolve => setTimeout(resolve, 800));

    // Auto-paste without user interaction
    logger.debug('AI Launcher', 'Auto-pasting prompt...');
    try {
      await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
      logger.debug('AI Launcher', '✓ Auto-paste successful');

      // Show brief success notification
      vscode.window.showInformationMessage(
        '✅ Prompt sent to Kiro AI Chat',
        { modal: false }
      );
    } catch (err) {
      logger.debug('AI Launcher', '⚠ Auto-paste failed, showing fallback notification');
      // Fallback: show notification if auto-paste fails
      vscode.window.showInformationMessage(
        'Prompt copied to clipboard - paste it in Kiro AI Chat (Cmd+V)',
        'OK'
      );
    }

    logger.debug('AI Launcher', '✓ Kiro launch complete');
    return {
      type: 'launched',
      content: 'Prompt auto-pasted to Kiro AI Chat.',
    };
  } catch (error) {
    logger.error('AI Launcher', '✗ Kiro launch failed:', error);
    return {
      type: 'error',
      error: error instanceof Error ? error.message : 'Failed to launch Kiro',
    };
  }
}
```

#### 3. Update Main Launch Function

```typescript
export async function launchAI(options: LaunchOptions): Promise<LaunchResult> {
  if (options.toolId === 'claudecode-cli') {
    const timeoutMs = options.config ? options.config.claudeCliTimeoutSeconds * 1000 : 90000;
    return launchCLI(options.prompt, timeoutMs, options.cwd, options.mcpConfigPath);
  } else if (options.toolId === 'claudecode-ext') {
    return launchExtension(options.prompt);
  } else if (options.toolId === 'cursor') {
    return launchCursor(options.prompt);
  } else if (options.toolId === 'copilot') {
    return launchCopilot(options.prompt);
  } else if (options.toolId === 'kiro') {  // ADD THIS
    return launchKiro(options.prompt);
  } else {
    return {
      type: 'error',
      error: `Unknown tool: ${options.toolId}`,
    };
  }
}
```

**Acceptance Criteria:**
- [ ] Kiro AI Chat opens when launched
- [ ] Prompt is auto-pasted (or clipboard notification shown)
- [ ] Error handling works gracefully
- [ ] User sees clear success/error messages

---

### Phase 5: UI Integration (0.5 days)

**Goal:** Add Kiro badge and UI elements to webview

**Files to Modify:**
- `src/ui/webview/main.ts`
- `src/ui/webview/styles.css` (if needed)

**Implementation Steps:**

#### 1. Add Kiro Tool Name Mapping (`main.ts`)

```typescript
const toolNames: Record<string, { name: string; sub: string | null }> = {
  'claudecode-cli': { name: 'Claude Code', sub: 'CLI' },
  'claudecode-ext': { name: 'Claude Code', sub: 'Extension' },
  'cursor': { name: 'Cursor', sub: null },
  'copilot': { name: 'GitHub Copilot', sub: null },
  'kiro': { name: 'Kiro', sub: null },  // ADD THIS
};
```

#### 2. Add Kiro Glyph Function

```typescript
function kiroGlyph(): string {
  // TODO: Replace with actual Kiro logo/icon
  // This is a placeholder - get the actual icon from Kiro branding
  return `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="12" r="10" opacity="0.2"/>
      <text x="12" y="16" font-size="12" text-anchor="middle" font-weight="bold">K</text>
    </svg>
  `;
}
```

#### 3. Update Tool Glyph Dispatcher

```typescript
function toolGlyph(toolId: string): string {
  if (toolId === 'claudecode-cli') return claudeCliGlyph();
  if (toolId === 'claudecode-ext') return claudeExtGlyph();
  if (toolId === 'cursor') return cursorGlyph();
  if (toolId === 'copilot') return copilotGlyph();
  if (toolId === 'kiro') return kiroGlyph();  // ADD THIS
  return '<span>?</span>';
}
```

#### 4. Update MCP Instructions (if needed)

```typescript
// In renderAIMCPSetup() or similar functions, add Kiro-specific instructions
if (activeTool === 'kiro') {
  // Add Kiro-specific MCP setup instructions
  // TODO: Customize based on actual Kiro workflow
}
```

**Acceptance Criteria:**
- [ ] Kiro badge renders correctly in AI bar
- [ ] Kiro icon/logo is visible
- [ ] MCP setup instructions work for Kiro
- [ ] Status indicators work (configured/unconfigured)

---

### Phase 6: Extension Entry Point (0.5 days)

**Goal:** Wire Kiro support into main extension activation

**Files to Modify:**
- `src/extension.ts`

**Implementation Steps:**

#### 1. Update AI Tool Registration

The extension should already handle new tools automatically via the detection system. Verify that:
- Kiro appears in AI tool picker dropdown
- MCP configuration commands work for Kiro
- Launch commands work for Kiro

#### 2. Add Integration Tests (if applicable)

Create test cases for:
- Kiro detection when running in Kiro
- MCP config read/write for Kiro
- Launcher commands

**Acceptance Criteria:**
- [ ] Kiro appears in tool selection UI
- [ ] All commands work end-to-end
- [ ] Extension activates without errors in Kiro

---

### Phase 7: Testing & Documentation (1 day)

**Goal:** Comprehensive testing and documentation

**Testing Checklist:**

#### Detection Tests
- [ ] Kiro is detected when running in Kiro IDE
- [ ] Kiro is NOT detected when running in VS Code/Cursor
- [ ] MCP readiness check works correctly
- [ ] Detection fails gracefully when Kiro is not installed

#### Configuration Tests
- [ ] MCP config is written to correct location (global)
- [ ] MCP config is written to correct location (project)
- [ ] Existing config is preserved and merged
- [ ] Invalid JSON is backed up before overwrite
- [ ] Works with PAT auth
- [ ] Works with env var auth
- [ ] Config can be removed cleanly

#### Launcher Tests
- [ ] Kiro AI Chat opens on launch
- [ ] Prompt is copied to clipboard
- [ ] Auto-paste works (or fallback notification)
- [ ] Error messages are clear
- [ ] Timeout handling works

#### UI Tests
- [ ] Kiro badge renders correctly
- [ ] Kiro icon is visible
- [ ] MCP setup flow works
- [ ] Status indicators are accurate
- [ ] Tool switching works (Kiro ↔ other tools)

#### Integration Tests
- [ ] End-to-end: Detect → Configure → Launch
- [ ] Works in Kiro with no workspace open
- [ ] Works in Kiro with workspace open
- [ ] Switching between scopes works
- [ ] Re-authentication works

**Documentation Tasks:**

1. **Update CLAUDE.md**
   - Add Kiro to "AI Integration" section
   - Document Kiro-specific MCP config locations
   - Add Kiro detection notes

2. **Update README (if exists)**
   - Add Kiro to supported tools list
   - Add Kiro setup instructions

3. **Create Kiro-specific docs**
   - Setup guide for Kiro users
   - Troubleshooting guide
   - Screenshot/GIF of Kiro integration

4. **Code Comments**
   - Add detailed comments to all Kiro functions
   - Document assumptions and TODOs
   - Link to Kiro documentation (if available)

**Acceptance Criteria:**
- [ ] All tests pass
- [ ] Documentation is complete
- [ ] No console errors
- [ ] Performance is acceptable

---

## Risk Assessment

### High Risk
1. **Unknown Kiro MCP config format** - Could block Phase 3
   - Mitigation: Research phase must confirm format before coding
   - Fallback: Support both 'mcpServers' and 'servers' keys

2. **Kiro AI Chat command unknown** - Could block Phase 4
   - Mitigation: Discovery via `vscode.commands.getCommands()`
   - Fallback: Manual clipboard copy with user notification

### Medium Risk
3. **Kiro detection fails** - Could make feature unusable
   - Mitigation: Test on actual Kiro installation
   - Fallback: Manual tool selection in UI

4. **Auto-paste doesn't work** - Degrades UX
   - Mitigation: Implement fallback clipboard notification
   - Fallback: Show clear "paste now" instructions

### Low Risk
5. **Icon/branding issues** - Cosmetic only
   - Mitigation: Use placeholder, request official assets
   - Fallback: Text-only badge

---

## Success Metrics

### Functional Success
- [ ] Kiro is detected automatically in Kiro IDE
- [ ] MCP config can be written successfully
- [ ] Kiro AI Chat can be launched with prompts
- [ ] No regression in existing AI tools (Claude, Cursor, Copilot)

### Quality Success
- [ ] Zero console errors related to Kiro integration
- [ ] All edge cases handled gracefully
- [ ] Error messages are clear and actionable
- [ ] Code follows existing patterns and conventions

### User Experience Success
- [ ] Setup takes < 2 minutes (same as other tools)
- [ ] Clear feedback at each step
- [ ] Works out-of-box in Kiro (with MCP config)
- [ ] Switching tools is seamless

---

## Timeline Estimate

| Phase | Duration | Dependencies |
|-------|----------|--------------|
| Phase 1: Research | 1 day | Kiro installation |
| Phase 2: Detection | 0.5 days | Phase 1 complete |
| Phase 3: MCP Config | 0.5 days | Phase 1 complete |
| Phase 4: Launcher | 0.5 days | Phase 1 complete |
| Phase 5: UI | 0.5 days | Phase 2-4 complete |
| Phase 6: Integration | 0.5 days | Phase 2-5 complete |
| Phase 7: Testing | 1 day | Phase 6 complete |
| **Total** | **5 days** | |

---

## Next Steps

1. **User Confirmation:**
   - Review this plan
   - Provide Kiro IDE information (installation link, docs)
   - Confirm/correct assumptions about Kiro

2. **Environment Setup:**
   - Install Kiro IDE in development environment
   - Install Harness VS Code extension in Kiro
   - Document initial findings

3. **Phase 1 Execution:**
   - Answer all research questions
   - Update this plan with findings
   - Get approval to proceed with implementation

4. **Implementation:**
   - Execute Phases 2-7 in order
   - Create PR with all changes
   - Test in real Kiro environment

---

## Open Questions for User

> **Please answer these questions to proceed:**

1. **Where can I download/install Kiro IDE?**
   - Official website URL?
   - Installation instructions?

2. **Is there official Kiro documentation for:**
   - AI Chat feature?
   - MCP support?
   - VS Code extension compatibility?

3. **Do you have access to a Kiro installation where I can test?**
   - If yes: Can you run the command discovery script above?
   - If no: Can you provide Kiro team contact for technical questions?

4. **What is the priority/timeline for this feature?**
   - Urgent (ship in next release)?
   - Normal (ship in 2-3 releases)?
   - Low (nice-to-have)?

5. **Are there any Kiro-specific requirements I should know about?**
   - Branding guidelines?
   - Authentication requirements?
   - Performance constraints?

---

## Appendix A: Research Script

Run this in Kiro to gather detection information:

```typescript
// Run in Kiro's VS Code Extension Host Console
// Or create a temporary command in extension.ts

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

async function researchKiro() {
  console.log('=== KIRO DETECTION RESEARCH ===\n');
  
  // 1. Environment Detection
  console.log('1. ENVIRONMENT:');
  console.log('   vscode.env.appName:', vscode.env.appName);
  console.log('   vscode.env.appRoot:', vscode.env.appRoot);
  console.log('   vscode.env.appHost:', vscode.env.appHost);
  console.log('   process.platform:', process.platform);
  
  // 2. Command Discovery
  console.log('\n2. AVAILABLE COMMANDS:');
  const allCommands = await vscode.commands.getCommands(true);
  const relevantCommands = allCommands.filter(cmd =>
    cmd.toLowerCase().includes('kiro') ||
    cmd.toLowerCase().includes('ai') ||
    cmd.toLowerCase().includes('chat') ||
    cmd.toLowerCase().includes('mcp')
  );
  console.log('   Relevant commands:', relevantCommands.join('\n   '));
  
  // 3. Config File Discovery
  console.log('\n3. CONFIG FILE LOCATIONS:');
  const configPaths = [
    path.join(os.homedir(), '.kiro', 'mcp.json'),
    path.join(os.homedir(), '.kiro', 'config.json'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Kiro', 'User', 'mcp.json'),
    path.join(os.homedir(), 'Library', 'Application Support', 'Kiro', 'User', 'mcp.json'),
    path.join(vscode.env.appRoot, 'mcp.json'),
  ];
  for (const p of configPaths) {
    const exists = fs.existsSync(p);
    console.log(`   ${exists ? '✓' : '✗'} ${p}`);
    if (exists) {
      try {
        const content = fs.readFileSync(p, 'utf-8');
        console.log('     Sample:', content.substring(0, 200));
      } catch {}
    }
  }
  
  // 4. Extension Discovery
  console.log('\n4. INSTALLED EXTENSIONS:');
  const extensions = vscode.extensions.all
    .filter(ext => 
      ext.id.toLowerCase().includes('kiro') ||
      ext.id.toLowerCase().includes('ai') ||
      ext.id.toLowerCase().includes('mcp')
    )
    .map(ext => `${ext.id} (${ext.isActive ? 'active' : 'inactive'})`);
  console.log('   Relevant extensions:', extensions.join('\n   '));
  
  console.log('\n=== END RESEARCH ===');
}

// Register command: harness.research.kiro
vscode.commands.registerCommand('harness.research.kiro', researchKiro);
```

---

## Appendix B: File Change Summary

| File | Changes | LOC |
|------|---------|-----|
| `src/ai/types.ts` | Add 'kiro' to DetectedTool.id union | +5 |
| `src/ai/detector.ts` | Add detectKiro(), getKiroMcpPath(), hasKiroMcpEntry() | +150 |
| `src/ai/mcpConfigurer.ts` | Add configureKiroMCP(), removeKiroMCPConfig(), buildKiroServerConfig() | +180 |
| `src/ai/launcher.ts` | Add launchKiro() function | +100 |
| `src/ui/webview/main.ts` | Add Kiro badge, glyph, tool name | +50 |
| `src/ui/webview/styles.css` | Add Kiro-specific styles (if needed) | +20 |
| `CLAUDE.md` | Update AI integration docs | +30 |
| **Total** | | **~535 LOC** |

---

_This plan will be updated as we progress through each phase._
