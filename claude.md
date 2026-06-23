# Harness VS Code Extension — Context & Requirements

> Last updated: 2026-06-23

---

## Overview

A VS Code sidebar extension that surfaces Harness pipeline execution (CI, CD, STO, TI, AIDA, OPA, SSCA, CCM) directly in the editor, scoped to the developer's current git branch + commit SHA. Zero context-switching.

**GitHub repo:** `github.com/harness/harness-vscode-extension`  
**Entry point:** `src/extension.ts`  
**Build:** `npm run compile` → esbuild produces `dist/extension.js` + `dist/webview.js` + `dist/webview.css`

---

## Architecture

### Key Files

| File | Role |
|------|------|
| `src/extension.ts` | Activation, command registration, poller wiring |
| `src/config/configManager.ts` | Reads/writes PAT + identifiers; global vs workspace config; env var fallback |
| `src/auth/onboarding.ts` | 2-phase onboarding: global (PAT+AccountID) → workspace (Org/Project); env var flow |
| `src/auth/envCredentials.ts` | Reads HARNESS_* environment variables for passwordless auth |
| `src/api/harnessClient.ts` | Typed fetch wrapper, injects auth headers |
| `src/api/logService.ts` | Log fetch (blob/download + stream fallback), ZIP parsing |
| `src/api/approvalService.ts` | Submits approve/reject via API |
| `src/api/rerunService.ts` | Re-runs a pipeline via the retry API (inputSet YAML + first-stage `retryStages` + `runAllStages`) |
| `src/api/abortService.ts` | Aborts a running execution via interrupt API (`AbortAll` / `UserMarkedFailure`) |
| `src/api/stoScan.ts` | Parses STO scanner vulnerability counts from the execution graph (no API call) |
| `src/api/userService.ts` | Fetches current user + checks group membership |
| `src/pipeline/pipelinePoller.ts` | Polls for pipeline execution updates; pauses when sidebar hidden/window unfocused |
| `src/pipeline/executionDispatcher.ts` | Fan-out to CI/CD/STO/TI/SSCA/OPA/CCM/AIDA/Approval modules |
| `src/ui/sidebarProvider.ts` | `WebviewViewProvider` — injects HTML, tracks visibility |
| `src/ui/webviewBridge.ts` | Typed message bus between extension host and webview |
| `src/ui/webview/main.ts` | All webview rendering (browser context, no vscode APIs) |
| `src/ui/webview/styles.css` | Dual-theme styles (simple + enhanced OKLCH) |
| `src/fme/fmeClient.ts` | Harness Feature Management Engine (FME) client using Split.io SDK |
| `src/logs/logEditorTab.ts` | Opens step logs in editor tabs with syntax highlighting |
| `src/ai/detector.ts` | Detects Claude Code CLI/Extension/Cursor and checks MCP configuration |
| `src/ai/mcpConfigurer.ts` | Writes Harness MCP server config to `~/.claude.json` |
| `src/ai/launcher.ts` | Launches Claude Code CLI/Extension or Cursor with prompts |

---

## Data Flow

```
git branch + SHA
  → POST /pipeline/api/pipelines/execution/summary (branch filter)
      → SHA match client-side (supports short/full SHA)
          → GET /pipeline/api/pipelines/execution/v2/{planExecutionId}?renderFullBottomGraph=true
              → executionDispatcher inspects moduleInfo keys:
                  moduleInfo.ci      → log fetch (blob/download or stream)
                  moduleInfo.cd      → deployment status
                  moduleInfo.ti      → test results + flaky → diagnostics
                  moduleInfo.ssca    → SBOM component flags
                  moduleInfo.ccm     → build cost
                  governanceMetadata → OPA policy evaluation
                  status=APPROVALWAITING → approval card with Approve/Reject buttons
```

---

## Log Fetching

Two-approach strategy in `src/api/logService.ts`:

1. **Blob/download** (preferred): `POST /gateway/log-service/blob/download` → signed URL → ZIP download → parse NDJSON
   - Requires FF `SPG_LOG_SERVICE_ENABLE_DOWNLOAD_LOGS`
   
2. **Stream** (fallback): `GET /log-service/stream` with log-service token
   - Token fetched via `GET /log-service/token` with PAT

**Log viewer modes** (FME flag `vscode-log-experience`):
- `inline` — Logs in sidebar tree
- `expanded` (default) — Logs open in editor tab with syntax highlighting (`harness-log://` URI scheme)

---

## Webview Message Types

**Host → Webview:**
- `EXECUTION_UPDATE` — Pipeline execution data
- `HISTORY_LIST` — Paginated execution history
- `HISTORY_DETAIL` — Full execution detail for history view
- `LOG_CHUNK` — Step logs (lines array)
- `GIT_CONTEXT` — Git branch/SHA, org/project, FME variations
- `APPROVAL_UPDATE` — Harness native approval
- `EXTERNAL_APPROVAL_UPDATE` — Jira/ServiceNow approval
- `STEP_LOGS_OPENED_IN_TAB` — Log opened in editor (not inline)
- `RERUN_SUCCESS` / `RERUN_CANCELLED` / `RERUN_ERROR` — Re-run outcome (success carries `newPlanExecutionId`)
- `ABORT_SUCCESS` / `ABORT_CANCELLED` / `ABORT_ERROR` — Abort outcome
- `STO_SCAN` — Security tab scan summary (parsed from execution graph)

**Webview → Host:**
- `approval` — Approve/reject action
- `fetchStepLogs` — Request logs for a specific step
- `fetchExecutionDetail` — Load detail view for history execution
- `fetchHistory` — Request execution history page
- `setDefaultView` — Pin view preference
- `rerunPipeline` — Re-run a terminal execution (carries `planExecutionId`, `pipelineIdentifier`, `firstStageId`)
- `abortPipeline` — Abort a running execution (carries `planExecutionId`)

---

## View Modes

### Pipelines Tab
- Browse all pipelines in project
- Search, filter (All/Failed/Running/Waiting), sort, pin favorites
- Click any pipeline → view latest execution
- Works without git repository

### Executions Tab  
- Paginated execution history (10-15 per page)
- Filter by status (All/Failed/Passed)
- Filter by pipeline
- Click execution → detail view with on-demand log fetching
- Works without git repository

### Detail View
- Full execution detail with stages/steps
- Live polling for running executions
- On-demand log fetching (click step to open logs in editor tab)
- Approval cards inline for Harness/Jira/ServiceNow approvals
- Re-run / Abort action button (status-adaptive)

#### Detail Tabs (enhanced theme)
The detail card has module-driven tabs, switched via `state.activeDetailTab`
(resets to `pipeline` on navigation). All parse data already in webview state —
no extra API calls.
- **Pipeline** — default stage/step tree.
- **Build** (`mi.ci`) — `parseBuild()`: repo, branch (+ PR), commits, image/SBOM artifacts (`pipelineCIInfo`, with `stepArtifacts` fallback).
- **Deploy** (`mi.cd`) — `parseDeploy()`: per CD stage (`layoutNodeMap` `module === 'cd'`) — services + manifests, environments, skip reasons.
- **Security** (`mi.sto` / parsed scan) — `parseStoScan()` (host-side): per-severity tiles + new-vuln deltas; badge shows new critical+high.

---

## Polling Optimization

Smart polling reduces API calls and battery usage:
- Pauses when sidebar hidden (`webviewView.visible === false`)
- Pauses when VS Code window loses focus (`vscode.window.state.focused === false`)
- Only polls when **both** sidebar visible AND window focused
- Auto-refreshes with fresh data when becoming visible/focused

Implementation: `pipelinePoller.ts` tracks visibility and focus via callbacks.

---

## Onboarding

**Authentication Methods:**

1. **PAT (Personal Access Token)** — Traditional method
   - Two-phase setup:
     - **Global** (once): `Harness: Configure API Key` → Base URL, PAT (stored in SecretStorage), Account ID
     - **Project** (per workspace or global): `Harness: Select Org & Project` → Org/Project dropdowns
   - Settings: `harness.authSource = 'pat'`

2. **Environment Variables** — Passwordless, CI/CD-friendly
   - Set `HARNESS_API_KEY`, `HARNESS_BASE_URL`, `HARNESS_ACCOUNT_ID` before launching VS Code
   - One-phase setup: Org/Project selection only (credentials read from env)
   - Settings: `harness.authSource = 'env'`
   - **Resolution order:** Environment variables → SecretStorage/Settings

**First-run empty state:**
- Auto-detects env vars on startup
- Panel A: Choose "Connect with environment variables" or "Connect with Personal Access Token"
- Panel D (env vars): Shows detected credentials, click "Connect" → Org/Project picker
- Panel E (PAT): Traditional 3-step flow (Base URL → PAT → Account ID → Org/Project)
- Auto-refreshes after completion (no reload needed)

**Lifecycle Management:**
- `Harness: Reset Auth Configuration` — Clears all credentials + org/project settings
- `Harness: Select Org & Project` — Change org/project globally
- `Harness: Switch Project (This Workspace)` — Override org/project for current workspace only

**Config resolution order:** Environment variables → Workspace settings → Global settings

**Workspace Safety:**
- All workspace settings operations check if workspace is open first
- Prevents "Unable to write to Workspace Settings" error when no workspace is open

---

## Theme Variations

FME flag `vscode-bar-experience`:
- **`simple`** — VS Code CSS variables, minimal styling
- **`enhanced`** (default) — OKLCH color system, cards-based UI, light/dark auto-detection

**Enhanced theme features:**
- OKLCH color tokens for perceptual uniformity
- Single-focus rule: only first stage with interesting steps expanded
- Cards-based layout with elevated backgrounds
- Compact status icons (✓ × ⚠ ⏱)

---

## Approval Flow

### Harness Native
- Detects `HarnessApproval` step in `executionGraph`
- Checks user permissions via `GET /ng/api/user-groups/{id}/member/{uuid}`
- Renders approval card inline with Approve/Reject buttons
- POST to `/gateway/pipeline/api/v1/orgs/{org}/projects/{project}/approvals/execution/{id}`

### External (Jira/ServiceNow)
- Detects `JiraApproval` or `ServiceNowApproval` step
- Extracts ticket info from `stepParameters.spec`
- Renders card with ticket link and approval/rejection criteria
- User updates ticket externally (no direct API call from extension)

---

## Re-run & Abort

A single action button on each execution card swaps based on status:
**terminal → Re-run**, **running → Abort**.

### Re-run (`src/api/rerunService.ts`)
1. Fetch original inputSet YAML — `GET /pipeline/api/pipelines/execution/{planExecutionId}/inputsetV2` (preserves runtime inputs)
2. Resolve the first stage's YAML identifier — `GET /pipeline/api/pipeline/execute/{planExecutionId}/retryStages` (uses `groups[0].info[0].identifier`, not the UUID)
3. Retry — `POST /pipeline/api/pipeline/execute/retry/{pipelineIdentifier}?planExecutionId=…&retryStages=<firstStage>&runAllStages=true` with the inputSet YAML as the body
4. New execution ID is read from `data.planExecution.uuid`; extension registers it via `poller.setDetailExecution()` and the webview navigates to the detail view

### Abort (`src/api/abortService.ts`)
- `PUT /pipeline/api/pipeline/execute/interrupt/{planExecutionId}?interruptType=<type>`
- Confirmation dialog doubles as the interrupt-type picker: **Abort All** (`AbortAll`) / **Mark as Failed** (`UserMarkedFailure`)
- On success, `poller.refresh()` picks up the terminal status, which swaps the button back to Re-run

### Polling notes (see Polling Optimization)
- A re-run execution may 404 until queryable; the poller keeps active 1s polling within a waiting window instead of dropping to the heartbeat
- `tick()` queues a `pendingRefresh` if one is requested mid-tick (so a post-rerun/abort `refresh()` is never lost)
- A newly-created poller (after org/project switch) is seeded with current sidebar visibility, since visibility events only fire on change

---

## AI Integration

Supports **Claude Code** (CLI/Extension), **Cursor AI**, and **GitHub Copilot** with automatic context injection via MCP.

### Claude Code
- **CLI mode**: Fully automated (spawns subprocess, response in sidebar)
- **Extension mode**: Semi-automated (auto-opens panel, auto-pastes prompt)
- MCP config written to `~/.claude.json`

### Cursor AI
- Auto-detected when running in Cursor editor (`vscode.env.appName.includes('cursor')`)
- **Recommended**: Install [Harness Cursor Plugin](https://cursor.com/plugins) — OAuth, zero config
- **Fallback**: Local MCP configuration (harness-mcp-v2)

### GitHub Copilot
- Auto-detected via VS Code extensions API (only in VS Code, not Cursor)
- Opens Copilot Chat and auto-pastes prompt
- Uses `"servers"` key in MCP config (Copilot-specific format)
- Environment variable inheritance: When using env var auth, only org/project IDs in config (credentials inherited from VS Code process)

**MCP Configuration:**
- **Claude Code**: `~/.claude.json` (global) or `<workspace>/.mcp.json` (project)
- **Cursor**: 
  - macOS/Linux: `~/.cursor/mcp.json`
  - Windows: `%APPDATA%\Cursor\User\mcp.json`
- **GitHub Copilot**:
  - Project: `.vscode/mcp.json`
  - Global (macOS): `~/Library/Application Support/Code/User/mcp.json`
  - Global (Windows): `%APPDATA%\Code\User\mcp.json`
  - Global (Linux): `~/.config/Code/User/mcp.json`
- Preserves existing config, only updates Harness MCP fields
- User must restart AI tool to activate
- **Auth handling**: When `authSource === 'env'`, writes environment variable references (`${HARNESS_API_KEY}`); when `authSource === 'pat'`, writes actual credentials

**Prompt Context:**
- Pipeline name, status, execution ID
- Git branch and commit SHA
- Stage/step status with durations and error messages
- Harness execution URL

**Tool preference persists** across sessions via VS Code globalState.

---

## Feature Management (FME)

- Uses Split.io SDK for Harness FME integration
- Default embedded SDK key (works for all users)
- User targeting based on Harness user email
- Graceful degradation: FME failure → baseline behavior

**Current flags:**
- `vscode-log-experience` — Log viewer mode (inline/expanded/drawer)
- `vscode-bar-experience` — Theme (simple/enhanced)
- `vscode-mcp-integration` — AI chat integration toggle
  - **Default**: ON (enabled by default for fail-safe behavior)
  - **'on'** or **'control'**: Enabled
  - **'off'**: Disabled (only way to turn off AI bar)

---

## Configuration

**Global Settings:**
- `harness.baseUrl` — Instance URL (default: `https://app.harness.io`)
- `harness.accountIdentifier` — Account ID
- `harness.authSource` — Authentication method (`pat` or `env`)
- `harness.orgIdentifier` — Organization
- `harness.projectIdentifier` — Project
- `harness.pollingIntervalSeconds` — Polling frequency (default: 10s)
- `harness.defaultView` — Default view (`pipelines` or `executions`)
- `harness.logLevel` — Console verbosity (`off`/`error`/`warn`/`info`/`debug`)

**Workspace Settings (optional overrides):**
- `harness.orgIdentifier`
- `harness.projectIdentifier`

**Environment Variables (optional, passwordless auth):**
- `HARNESS_API_KEY` — Personal Access Token
- `HARNESS_BASE_URL` — Instance URL (e.g., `https://app.harness.io`)
- `HARNESS_ACCOUNT_ID` — Account identifier
- Must be set before launching VS Code (inherited from parent process)

---

## Logging

Configurable logger (`src/utils/logger.ts`) respects `harness.logLevel` setting.

**Usage:**
```typescript
import { logger } from './utils/logger';

logger.debug('Component', 'Detailed trace', { data });
logger.info('Component', 'Operation started', context);
logger.warn('Component', 'Potential issue', details);
logger.error('Component', 'Operation failed:', error);
```

**Commands:**
- `Harness: Show Debug Output` — View full API payloads
- `Harness: Debug FME Flags` — View current feature flag states
- `Harness: Export Last Execution to JSON` — Export execution data for debugging

---

## Known Issues

1. **AIDA RCA** — Endpoint not available (commented out in dispatcher)
2. **STO integration** — Deferred to future release (commented out in dispatcher)

---

## Build & Run

```bash
npm install
npm run compile      # esbuild → dist/

# Run in VS Code: F5 → Extension Development Host
# Package: npm run package → harness-vscode-0.x.x.vsix
```

**FME SDK Key:** Extension ships with default key. Override with `HARNESS_FME_SDK_KEY` env var or `harness.fmeSdkKey` setting for testing custom flags.
