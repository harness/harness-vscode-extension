# Harness VS Code Extension

**Monitor your CI/CD pipelines, view logs, and manage approvals — all without leaving your IDE.**

See pipeline status, investigate failures, and approve deployments right in your sidebar.

---

## ✨ Features

- 📊 **Real-time pipeline status** — See all your pipelines and executions
- 📝 **Syntax-highlighted logs** — View step logs in editor tabs with full syntax highlighting
- ✅ **Approve deployments** — Handle approval gates without leaving your editor
- 🔍 **Search & filter** — Find pipelines and executions quickly
- 🤖 **AI integration** — Ask Claude Code, GitHub Copilot, or Cursor AI about your pipeline failures (with automatic context)

---

## 🚀 Quick Start

### Installation

1. Open VS Code
2. Press `Ctrl+Shift+X` (Windows/Linux) or `Cmd+Shift+X` (Mac) to open Extensions
3. Search for **"Harness"**
4. Click **Install**

Or install via command line:
```bash
code --install-extension harness.harness-vscode
```

### Setup

1. Click the Harness icon in the Activity Bar (left sidebar)
2. Run **Harness: Configure API Key** from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
3. Enter your Harness instance URL (default: `https://app.harness.io`)
4. Paste your [Personal Access Token](https://developer.harness.io/docs/platform/automation/api/add-and-manage-api-keys)
5. Account ID is **automatically extracted** from your PAT
6. Select your organization and project

**Alternative: Environment Variable Auth** (passwordless, CI/CD-friendly)
```bash
export HARNESS_API_KEY="your-pat"
export HARNESS_BASE_URL="https://app.harness.io"
export HARNESS_ACCOUNT_ID="your-account-id"
code .
```

**Requirements:** VS Code 1.85.0 or higher, active Harness account

---

## 📖 Usage

### View Modes

Switch between two views using the tabs at the top:

**Pipelines** — Browse all your pipelines
- Search, filter, and pin your favorite pipelines
- Click any pipeline to see its latest execution
- Works without a git repository

**Executions** — Browse execution history
- Filter by status (All / Failed / Passed)
- Filter by pipeline to see specific execution history
- Paginated view with 10-15 executions per page
- Click any execution for full details and logs

### Key Features

**Logs** — Click any step to open its logs in a separate editor tab with syntax highlighting. Failed steps are highlighted for quick identification.

**Approvals** — When a pipeline needs approval, **✓ Approve** and **✕ Reject** buttons appear. The extension checks your permissions automatically.

**Policy Evaluations** — See OPA policy results with warnings and errors highlighted.

**Workspace Override** — Working on multiple projects? Use **Harness: Switch Project (This Workspace)** to set different org/project per workspace folder.

---

## 🤖 AI Integration

Ask questions about your pipelines using **Claude Code**, **GitHub Copilot**, or **Cursor AI** with automatic context injection.

### Supported AI Tools

**Claude Code** (CLI or Extension)
- Install from [claude.ai/code](https://claude.ai/code)
- **CLI mode**: Fully automated — responses appear directly in Harness sidebar
- **Extension mode**: Semi-automated — auto-opens Claude Code panel with prompt ready
- Uses local MCP server configuration (`~/.claude.json`)

**GitHub Copilot**
- Auto-detected in VS Code when GitHub Copilot extension is installed
- Opens Copilot Chat with auto-paste integration
- MCP configuration uses VS Code-specific paths (`.vscode/mcp.json` for project scope)
- Inherits environment variables from VS Code process when using env var auth

**Cursor AI**
- Auto-detected when running in Cursor editor
- **Recommended**: Install [Harness Cursor Plugin](https://cursor.com/plugins) — OAuth authentication, zero config
- **Fallback**: Local MCP configuration (harness-mcp-v2) for advanced users
- Seamless prompt delivery with auto-paste

### Setup

**For Claude Code:**
1. Install Claude Code (CLI or VS Code Extension)
2. Click **Configure MCP** in the AI footer
3. Choose scope (Project or Global):
   - **Project**: `.mcp.json` in workspace root — shared with team if committed
   - **Global**: `~/.claude.json` in home folder — personal, applies to all projects
4. Your Harness credentials are automatically configured
5. Restart Claude Code to activate the MCP server

**For GitHub Copilot:**
1. Install [GitHub Copilot extension](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) in VS Code
2. Click **Configure MCP** in the AI footer
3. Choose scope (Project or Global):
   - **Project**: `.vscode/mcp.json` in workspace root — shared with team
   - **Global**: Platform-specific path in home folder — personal
4. Restart VS Code to activate the MCP server

**For Cursor:**
1. **Recommended**: Install [Harness Plugin](https://cursor.com/plugins) in Cursor
   - OAuth authentication — no manual configuration needed
   - Plugin manages MCP connection automatically
2. **Alternative**: Configure local MCP manually (for advanced users)

### Usage

- Type your question in the AI footer (appears at the bottom of the Harness panel)
- Select your preferred tool using the dropdown (Claude Code CLI / Extension / GitHub Copilot / Cursor)
- Tool preference persists across VS Code sessions
- Pipeline context automatically included in every query

**What context gets sent:**
- Pipeline name, status, execution ID
- Harness execution URL

**Example questions:**
- "Why did this pipeline fail?"
- "What changed between this run and the last successful one?"
- "How can I fix the failing test in the build stage?"

### Authentication Methods

**Personal Access Token (PAT)** — Traditional method
1. Run **Harness: Configure API Key**
2. Enter Base URL and PAT
3. Account ID is **automatically extracted** from your PAT (no manual entry needed!)
4. If extraction fails, you'll be prompted to enter it manually
5. Select org/project during onboarding

**Environment Variables** — Passwordless, CI/CD-friendly
1. Set `HARNESS_API_KEY`, `HARNESS_BASE_URL`, `HARNESS_ACCOUNT_ID` before launching VS Code
2. Extension auto-detects and uses environment variables
3. MCP config uses environment variable references (for Claude Code) or inherits from process (for GitHub Copilot)
4. Select org/project during onboarding

---

## ⚙️ Configuration

### Global Settings (apply everywhere)

Run **Harness: Configure API Key** to set:
- `harness.baseUrl` — Your Harness instance URL (default: `https://app.harness.io`)
- `harness.accountIdentifier` — Your account ID (auto-extracted from PAT, or set via environment variable)
- `harness.orgIdentifier` — Default organization
- `harness.projectIdentifier` — Default project

Your Personal Access Token is stored securely in VS Code's secret storage.

**💡 Tip:** The extension automatically extracts your account ID from your PAT during setup, so you typically only need to provide Base URL and PAT.

### Optional Settings

- `harness.pollingIntervalSeconds` — How often to check for updates (default: 10s, min: 5s, max: 120s)
- `harness.defaultView` — Which view opens by default (`pipelines` or `executions`)
- `harness.diffAwareSTO` — Limit STO annotations to files changed in current diff (default: true)
- `harness.logLevel` — Console verbosity: `off`, `error`, `warn`, `info` (default), `debug`

### Per-Workspace Override

Use **Harness: Switch Project (This Workspace)** to override org/project for specific workspace folders.

---

---

## 📋 Commands

| Command | Description |
|---------|-------------|
| **Harness: Configure API Key** | Set up your credentials and project (global) |
| **Harness: Reset Auth Configuration** | Clear all credentials and org/project settings |
| **Harness: Select Org & Project** | Change global org/project settings |
| **Harness: Switch Project (This Workspace)** | Override for current workspace only |
| **Harness: Refresh Pipeline Status** | Force refresh immediately |
| **Harness: Open Execution in Browser** | Open current execution in Harness UI |
| **Harness: Export Last Execution to JSON** | Export execution data for debugging |
| **Harness: Show Debug Output** | View API request logs |
| **Harness: Debug FME Flags** | View current feature flag states |


---

## 📝 Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes and version history.

---

## 🤝 Contributing

Interested in contributing? See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, build instructions, and guidelines.

---

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.
