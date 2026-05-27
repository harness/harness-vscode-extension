# Changelog

## [0.1.7] - 2026-05-27

### Fixed
- **Authentication isolation**: Prevents credential conflicts when both environment variables and PAT are configured
  - Added `getAuthSource()` validation that verifies env vars are present before using 'env' mode
  - Strict isolation in `getConfig()`: 'env' mode uses ONLY environment variables, 'pat' mode uses ONLY secret store + settings
  - No more fallback mixing between auth sources
  - Fixes 401 "Token is not valid" error when environment variables from Account A interfere with PAT for Account B
  - Added defensive token trimming in `SecretStore.getApiKey()` to handle whitespace issues

### Changed
- **Marketplace readiness**: Prepared extension for VS Code Marketplace publication
  - Added keywords for discoverability (harness, ci/cd, pipelines, devops, continuous integration, continuous deployment, logs, testing, approvals, monitoring)
  - Added categories: Other, Visualization, Testing
  - Added gallery banner with Harness brand color (#00ADE4, dark theme)
  - Added Q&A link pointing to GitHub issues
  - Added `vscode:prepublish` script for automatic build before publishing
  - Cleaned up README.md for marketplace audience (removed VSIX instructions)
  - Created CONTRIBUTING.md with developer setup, build, and release instructions

## [0.1.6] - 2026-05-21

### Added
- **Automatic account ID extraction from PAT**: No more manual account ID entry during setup
  - Extracts account ID from PAT token format (`pat.<accountId>.<userId>.<random>`)
  - Verifies credentials with API call before proceeding
  - Falls back to manual entry if extraction fails or token format doesn't match
  - Reduces onboarding from 3 steps to 2 steps for most users
- **GitHub Copilot integration**: Full support for GitHub Copilot Chat alongside Claude Code and Cursor
  - Auto-detects GitHub Copilot extension (only in VS Code, not Cursor)
  - GitHub Copilot icon in AI bar when detected
  - MCP configuration with correct paths:
    - Local (project): `.vscode/mcp.json`
    - Global: `~/Library/Application Support/Code/User/mcp.json` (macOS), `%APPDATA%\Code\User\mcp.json` (Windows), `~/.config/Code/User/mcp.json` (Linux)
  - Uses `"servers"` key instead of `"mcpServers"` (Copilot-specific format)
  - Environment variable inheritance: When using env var auth, only includes org/project IDs in config (API key inherited from VS Code process)
  - PAT mode includes all credentials explicitly in MCP config
  - Auto-paste integration: Opens Copilot Chat and pastes prompt automatically
- **AI bar enabled by default**: AI integration now defaults to ON if FME flag evaluation fails
  - Provides better fail-safe experience
  - Only disabled when FME explicitly returns 'off'
  - Ensures AI features are always available unless intentionally turned off

### Fixed
- **Workspace settings error**: Fixed "Unable to write to Workspace Settings" error when no workspace is open
  - Added workspace existence checks before updating workspace settings
  - Applied to `runWorkspaceSetup()`, `runEnvVarOnboarding()`, and `resetConfiguration` command
  - Prevents errors during onboarding without an open workspace
- **Cursor detection**: Fixed undefined variable reference in Cursor detector
  - Changed `cursorDir` to `cursorBaseDir` in return statement
  - Cursor now appears correctly in AI bar
- **Environment variable authentication with MCP**: MCP configuration now respects auth source
  - When using env vars (`authSource === 'env'`), MCP config writes `${HARNESS_API_KEY}` placeholders
  - When using PAT, MCP config includes actual credentials
  - API key resolution checks env vars first, falls back to secret store

### Changed
- **Cross-platform MCP paths**: Updated MCP configuration paths for all platforms
  - Claude Code: `~/.claude.json` (all platforms)
  - Cursor (macOS/Linux): `~/.cursor/mcp.json`
  - Cursor (Windows): `%APPDATA%\Cursor\User\mcp.json`
  - GitHub Copilot: Platform-specific paths as listed above
- **MCP path display in UI**: Dynamically shows correct paths based on selected AI tool
  - Claude Code: Shows `.mcp.json` (project) or `~/.claude.json` (global)
  - GitHub Copilot: Shows `.vscode/mcp.json` (project) or OS-specific paths (global)
  - Tip text updated for Copilot project scope: "Lives in .vscode/ folder"

## [0.1.5] - 2026-05-13

### Fixed
- **Export command**: Fixed export not working when viewing history detail executions
  - Reordered message handler to process HISTORY_DETAIL before EXECUTION_UPDATE
  - Prevents EXECUTION_UPDATE from overwriting history detail source
  - Execution data now updates while keeping history source intact
- **Looping strategy visualization**: Fixed looped stages not displaying all iterations
  - Changed getStages() to track by execution ID instead of nodeUuid
  - Now shows all iterations (e.g., GitOps Dev_movie, GitOps Dev_booking) separately
  - Each iteration displays its own steps and status
- **Switch project button**: Fixed button appearing to do nothing when clicked
  - Now clears workspace-specific org/project settings before saving global selection
  - Workspace settings take precedence over global, so they must be cleared first

## [0.1.4] - 2026-05-12

### Added
- **Configurable Claude CLI timeout**: New `harness.claudeCliTimeoutSeconds` setting
  - Default: 90s (range: 30-600s)
  - Allows users to increase timeout for complex AI queries requiring many API calls
  - Applied only to Claude CLI subprocess execution (cursor/extension tools unaffected)
- **VS Code Output panel logging**: Centralized logging system with user control
  - All logs now appear in dedicated "Harness" channel (View → Output → Harness)
  - Removed 220+ console.* calls to Developer Tools
  - Timestamp and component prefixes for better readability
  - FME Split.io SDK debug logs now respect `harness.logLevel` setting

### Fixed
- **Streaming ZIP parser for step logs**: Properly handles data descriptors in streaming ZIP files
  - Fixes garbled/unreadable logs for Gitleaks, Wiz SAST, and similar security scanning steps
  - Scans for data descriptor signature (0x08074b50) when compSize=0 in local file header
  - Calculates actual compressed size by locating descriptor or next entry
  - Skips past data descriptor (12 or 16 bytes) after processing each entry
  - Preserves compatibility with standard ZIP files (EOCD-based)
- **UI state management during log fetch**: Loading states now update correctly
  - Added render() calls after STEP_LOGS_LOADING, STEP_LOGS_EMPTY, and STEP_LOGS_OPENED_IN_TAB messages
  - Loading spinner displays immediately when clicking a step
  - Proper "No logs available" state instead of stale content
  - Shows "✓ Logs opened in editor tab" confirmation
- **ANSI escape codes in logs**: Removes color codes and control characters for clean display
  - Created utils/ansiStrip.ts utility to strip ANSI sequences
  - Removes standard ANSI codes (\x1b[...m), OSC sequences, character sets, malformed UTF-8
  - Applied in logEditorTab.ts before rendering in editor tabs

### Changed
- Cleaned up verbose debug logging throughout logService.ts for production readiness
- Logger now initialized with OutputChannel in extension.ts activation
- "Harness: Show Debug Output" and "Harness: Debug FME Flags" commands reference Output panel

## [0.1.3] - 2026-05-09

### Fixed
- **Critical poller stability issues**: Resolved multiple issues causing pipeline updates to stop
  - Added 10-30s timeouts to all network requests to prevent indefinite hangs
  - Implemented re-entrancy guard to prevent concurrent tick() executions
  - Fixed terminal execution behavior: now schedules heartbeat (120s) instead of stopping completely
  - Fixed scheduling logic to keep polling active when detail executions are running
  - Prevented 25-second UI freezes when fetching step logs (now non-blocking)
  - Fixed FME SDK callbacks creating race conditions (now run in background)
  - Fixed log editor tabs stealing sidebar focus and pausing updates (preserveFocus: true)
  - Fixed poller stopping when no matching live execution found (early return scheduling bug)

### Changed
- **Optimized GIT_CONTEXT messaging**: Reduced from every-second spam to only-on-change
  - Extracted to `sendGitContext()` method, only called when git/config/FME changes
  - Removes unnecessary webview re-renders and console noise
- **Removed automatic log streaming**: Logs now fetched only on-demand when user clicks a step
  - Reduces API calls and network traffic
  - Logs still available instantly via on-demand fetch with editor tab display
- **Reduced FME debug logging**: Disabled Split.io debug logs, switched to OPTIMIZED impression mode
  - Cleaner console output focused on application messages

### Documentation
- Added installation instructions for end users in README
  - Installation from GitHub Releases via UI or CLI
  - Clearer distinction between user installation and developer build

## [0.1.2] - 2026-05-08

### Added
- **First-run onboarding empty state**: Beautiful setup UI for new users
  - Shows 3-step preview (Base URL, Personal Access Token, Account ID) before configuration
  - "Start setup" button launches existing onboarding flow
  - No popup interruption on first install - user discovers setup naturally in sidebar
  - Auto-refreshes to normal view after completion (no reload needed)
  - Consistent "Personal Access Token" terminology throughout onboarding
- **Smart polling optimization**: Significant reduction in API calls and resource usage
  - Pauses polling when Harness sidebar is hidden
  - Pauses polling when VS Code window loses focus
  - Only polls when sidebar visible AND window focused
  - Auto-refresh with fresh data when becoming visible/focused
- **Auto-paste in Claude Code Extension**: Seamless prompt delivery
  - Automatically pastes prompts after opening Claude Code panel
  - Removed manual "Paste Now" button for consistent UX with Cursor
  - 800ms delay for UI focus before auto-paste

### Fixed
- Cursor AI detection now only works when running inside Cursor editor (not VS Code)
  - Prevents opening GitHub Copilot when using Harness AI bar in VS Code
  - Uses `vscode.env.appName` to detect editor context
- Silent handling of fetch requests when extension not configured
  - No more error notifications during first-run experience
  - Empty state UI handles unconfigured state gracefully

### Changed
- **Icon updates**: Official Harness brand assets
  - Icon-only logo (no text) for VS Marketplace compatibility
  - Updated to PNG format (196×196px) for marketplace requirements
  - SVG preserved for future use
  - Better consistency with Harness platform UI

## [0.1.1] - 2026-05-04

### Added
- **Cursor AI integration**: Full support for Cursor editor with official Harness Cursor Plugin
  - Auto-detection of Cursor installation and Harness Plugin
  - OAuth authentication detection for plugin-based MCP
  - Auto-paste functionality for seamless prompt delivery
  - Fallback to local MCP configuration (harness-mcp-v2)
  - Official Cursor cube logo in AI tool picker
- **Configurable logging system**: Production-grade log level control
  - New VS Code setting `harness.logLevel` with 5 levels (off/error/warn/info/debug)
  - Centralized logger utility (`src/utils/logger.ts`)
  - Applied to extension host and pipeline dispatcher modules
  - Default: `info` level (recommended for production)

### Fixed
- AI bar "Thinking..." animation now displays correctly during Claude CLI requests
- AI response scroll position preserved during re-renders (no more jumping to top)
- AI bar state now correctly reflects selected tool (Cursor vs Claude Code)

### Removed
- AIDA root cause analysis API calls (endpoint returns 404, commented out for future re-enable)
- STO vulnerability findings API calls (deferred to future implementation)
- Design handoff assets from repository (`handoff/` directory)

### Changed
- `.gitignore` updated to exclude test files and design assets
- Added `.vscode/launch.json` and `.vscode/tasks.json` for developer setup

## [0.1.0] - 2026-04-26

### Added
- Sidebar panel with live pipeline execution status for current git branch and commit
- Two view modes: "This commit" (live) and "All executions" (history with pagination and filters)
- Detail view with on-demand log fetching and live polling for running executions
- CI log fetching via blob/download (ZIP) with stream fallback
- Stage and step traversal from Harness execution graph
- Expanded log viewer: opens logs in editor tabs with syntax highlighting (TextMate grammar)
- Module support: CI, CD, STO, TI, SSCA, OPA, CCM, AIDA
- STO, TI, and SSCA diagnostics surfaced in VS Code Problems panel
- Harness native approval flow with user/group permission checks
- External approval support (Jira, ServiceNow) with ticket links
- Dual theme system: simple (VS Code tokens) and enhanced (OKLCH cards UI), gated by FME
- Light/dark theme auto-detection for enhanced theme
- App menu drawer with product navigation and account switching
- Feature Management Engine (FME) integration via Split.io SDK for controlled rollouts
- Two-phase onboarding: global API key + per-workspace org/project selection
- AI integration: Claude Code CLI and Extension detection, MCP auto-configuration
- Default view pinning with persistent preference
- Export execution to JSON for debugging
- Debug output channel for API inspection
- Walkthrough for first-time setup
