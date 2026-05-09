# Harness VS Code Extension

**Monitor your CI/CD pipelines, view logs, and manage approvals — all without leaving your IDE.**

See pipeline status, investigate failures, and approve deployments right in your sidebar.

---

## ✨ Features

- 📊 **Real-time pipeline status** — See all your pipelines and executions
- 📝 **Syntax-highlighted logs** — View step logs in editor tabs with full syntax highlighting
- ✅ **Approve deployments** — Handle approval gates without leaving your editor
- 🔍 **Search & filter** — Find pipelines and executions quickly
- 🤖 **AI integration** — Ask Claude Code or Cursor AI about your pipeline failures (with automatic context)

---

## 🚀 Quick Start

### For Users (Install from Release)

1. Download the latest `.vsix` file from [Releases](https://github.com/harness/harness-vscode-extension/releases)

2. **Option A: Install via VS Code UI**
   - Open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`)
   - Click the `...` menu at the top → **Install from VSIX...**
   - Select the downloaded `.vsix` file
   - Reload VS Code when prompted

3. **Option B: Install via CLI**
   ```bash
   code --install-extension harness-vscode-0.x.x.vsix
   ```

4. Run **Harness: Configure API Key** to get started

### For Developers (Build from Source)

```bash
# Clone and install
git clone https://github.com/harness/harness-vscode-extension
cd harness-vscode-extension
npm install

# Build
npm run compile

# Run in VS Code
# Press F5 to launch Extension Development Host

# Package for distribution (optional)
npm install -g @vscode/vsce  # Install packaging tool if you don't have it
npm run package
# Creates harness-vscode-0.x.x.vsix
```

**Requirements:** VS Code 1.85+, Node.js 18+

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

Ask questions about your pipelines using **Claude Code** or **Cursor AI** with automatic context injection.

### Supported AI Tools

**Claude Code** (CLI or Extension)
- Install from [claude.ai/code](https://claude.ai/code)
- **CLI mode**: Fully automated — responses appear directly in Harness sidebar
- **Extension mode**: Semi-automated — auto-opens Claude Code panel with prompt ready
- Uses local MCP server configuration (`~/.claude.json`)

**Cursor AI**
- Auto-detected when running in Cursor editor
- **Recommended**: Install [Harness Cursor Plugin](https://cursor.com/plugins) — OAuth authentication, zero config
- **Fallback**: Local MCP configuration (harness-mcp-v2) for advanced users
- Seamless prompt delivery with auto-paste

### Setup

**For Claude Code:**
1. Install Claude Code (CLI or VS Code Extension)
2. Click **Configure MCP** in the AI footer
3. Your Harness credentials are automatically configured in `~/.claude.json`
4. Restart Claude Code to activate the MCP server

**For Cursor:**
1. **Recommended**: Install [Harness Plugin](https://cursor.com/plugins) in Cursor
   - OAuth authentication — no manual configuration needed
   - Plugin manages MCP connection automatically
2. **Alternative**: Configure local MCP manually (for advanced users)

### Usage

- Type your question in the AI footer (appears when AI integration is enabled)
- Select your preferred tool using the dropdown (Claude Code CLI / Extension / Cursor)
- Tool preference persists across VS Code sessions
- Pipeline context automatically included in every query

**What context gets sent:**
- Pipeline name, status, execution ID
- Harness execution URL

**Example questions:**
- "Why did this pipeline fail?"
- "What changed between this run and the last successful one?"
- "How can I fix the failing test in the build stage?"

---

## ⚙️ Configuration

### Global Settings (apply everywhere)

Run **Harness: Configure API Key** to set:
- `harness.baseUrl` — Your Harness instance URL (default: `https://app.harness.io`)
- `harness.accountIdentifier` — Your account ID
- `harness.orgIdentifier` — Default organization
- `harness.projectIdentifier` — Default project

Your Personal Access Token is stored securely in VS Code's secret storage.

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

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.
