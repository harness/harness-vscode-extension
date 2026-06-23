# Harness for VS Code

[![VS Code Marketplace](https://vsmarketplacebadges.dev/version-short/harness-inc.harness-vscode.svg?label=VS%20Code%20Marketplace&color=00ADE4)](https://marketplace.visualstudio.com/items?itemName=harness-inc.harness-vscode)
[![Installs](https://vsmarketplacebadges.dev/installs-short/harness-inc.harness-vscode.svg?color=00ADE4)](https://marketplace.visualstudio.com/items?itemName=harness-inc.harness-vscode)

**Monitor CI/CD pipelines, view logs, and manage approvals — all without leaving your IDE.**

Bring Harness directly into VS Code. See real-time pipeline status, debug failures with syntax-highlighted logs, approve deployments, and get AI-powered insights — zero context switching required.

---

## ✨ Features

### 🚀 **Real-time Pipeline Monitoring**
Watch your pipelines run with live status updates. Automatic git context detection shows executions for your current branch and commit.

### 📝 **Syntax-Highlighted Logs**
Click any step to open its logs in a dedicated editor tab with full syntax highlighting. Failed steps are instantly highlighted for quick debugging.

### ✅ **One-Click Approvals**
Handle Harness native, Jira, and ServiceNow approval gates directly in your editor. Permission checks happen automatically.

### 🔍 **Smart Search & Filtering**
Browse all pipelines, filter by status, pin favorites, and explore execution history with pagination. Works with or without a git repository.

### 🔁 **Re-run & Abort**
Re-run a finished execution with its original inputs in one click, or abort a running pipeline (Abort All / Mark as Failed) — the action button adapts to the execution's status and the view follows the new run.

### 🧭 **Build, Deploy & Security Tabs**
Drill into an execution with dedicated detail tabs:
- **Build** — repository, branch (and PR), commits, and published image/SBOM artifacts.
- **Deploy** — per-stage services (with manifests) and environments, plus skip reasons.
- **Security** — STO scanner results with per-severity tiles and new-vulnerability deltas, parsed straight from the execution.

### 🤖 **AI-Powered Debugging**
Ask Claude Code, GitHub Copilot, or Cursor AI about pipeline failures with automatic context injection. No copy-pasting needed.

---

## 🚀 Getting Started

### Installation

**From VS Code Marketplace:**
1. Open Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`)
2. Search for **"Harness"**
3. Click **Install**

**From Command Line:**
```bash
code --install-extension harness-inc.harness-vscode
```

### Quick Setup (2 minutes)

1. **Open Harness panel**: Click the Harness icon in the Activity Bar (left sidebar)
2. **Configure credentials**: Run command **"Harness: Configure API Key"**
   - Enter your Harness instance URL (or keep default: `https://app.harness.io`)
   - Paste your [Personal Access Token](https://developer.harness.io/docs/platform/automation/api/add-and-manage-api-keys)
   - Account ID is **automatically extracted** from your PAT ✨
3. **Select project**: Choose your organization and project from the dropdowns
4. **Done!** Your pipelines appear automatically

### Alternative: Environment Variable Authentication

Perfect for CI/CD environments or shared setups:
```bash
export HARNESS_API_KEY="your-pat"
export HARNESS_BASE_URL="https://app.harness.io"
export HARNESS_ACCOUNT_ID="your-account-id"
code .
```

The extension auto-detects environment variables and skips credential prompts.

**Requirements:** VS Code 1.85.0+, active Harness account

---

## 📖 How to Use

### Two View Modes

Switch between views using the tabs at the top of the Harness panel:

#### **📋 Pipelines View**
Browse all pipelines in your project:
- 🔍 Search by name
- 📌 Pin favorites to the top
- 🎯 Click any pipeline to see its latest execution
- ✅ Works without a git repository

#### **📊 Executions View**
Browse full execution history:
- 🔀 Filter by status (All / Failed / Passed)
- 🎯 Filter by specific pipeline
- 📄 Paginated (10-15 per page)
- 🔍 Click any execution for full details and on-demand logs

### Working with Executions

**View Pipeline Status**
The extension automatically detects your current git branch and commit, showing the matching pipeline execution. Live updates every 10 seconds during active runs.

**Debug with Logs**
Click any step to open its logs in a new editor tab with syntax highlighting. Failed steps are highlighted in red for quick identification.

**Handle Approvals**
When a pipeline reaches an approval step, **✓ Approve** and **✕ Reject** buttons appear inline. The extension automatically checks if you have permission to approve.

Supported approval types:
- Harness native approvals (user/group permissions)
- Jira approvals (with ticket link)
- ServiceNow approvals (with ticket link)

**View Policy Results**
OPA policy evaluation results appear when configured. Warnings and errors are highlighted with detailed messages.

### Multi-Project Workflows

Working on multiple Harness projects? Use **"Harness: Switch Project (This Workspace)"** to override org/project for specific workspace folders. Your global settings remain unchanged.

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
- **Recommended**: Install [Harness Cursor Plugin](https://cursor.com/marketplace/harness) — OAuth authentication, zero config
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
1. **Recommended**: Install [Harness Plugin](https://cursor.com/marketplace/harness) in Cursor
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
