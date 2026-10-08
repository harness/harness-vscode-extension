# Harness VS Code Extension - Architecture Diagram

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         VS CODE EXTENSION                               │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                      EXTENSION CORE                              │  │
│  │                    (extension.ts)                                │  │
│  │  • Activation & initialization                                  │  │
│  │  • Command routing & message handling                           │  │
│  │  • State management (poller, client, config)                    │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    AUTHENTICATION LAYER                         │   │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │   │
│  │  │  SecretStore     │  │  ConfigManager   │  │ Onboarding   │  │   │
│  │  │  (VS Code        │  │  (Credentials &  │  │ (Setup flow) │  │   │
│  │  │   secrets)       │  │   org/project)   │  │              │  │   │
│  │  └──────────────────┘  └──────────────────┘  └──────────────┘  │   │
│  │                                                                  │   │
│  │  ┌──────────────────────────────────────────────────────────┐  │   │
│  │  │         Environment Variable Detection                   │  │   │
│  │  │  (HARNESS_API_KEY, HARNESS_BASE_URL, HARNESS_ACCOUNT_ID) │  │   │
│  │  └──────────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                  FEATURE MANAGEMENT (FME)                       │   │
│  │  ┌──────────────────────────────────────────────────────────┐   │   │
│  │  │  FME Client (Feature Flags & Experimentation)            │   │   │
│  │  │  • Log viewer variation                                  │   │   │
│  │  │  • Webview theme variation                               │   │   │
│  │  │  • AI chat enabled flag                                  │   │   │
│  │  └──────────────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    POLLING & DATA LAYER                         │   │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │   │
│  │  │ PipelinePoller   │  │  HarnessClient   │  │ Dispatcher   │  │   │
│  │  │ (Polling logic)  │  │  (HTTP requests) │  │ (Execution   │  │   │
│  │  │                  │  │                  │  │  modules)    │  │   │
│  │  └──────────────────┘  └──────────────────┘  └──────────────┘  │   │
│  │                                                                  │   │
│  │  ┌──────────────────────────────────────────────────────────┐  │   │
│  │  │              API SERVICES LAYER                          │  │   │
│  │  │  ┌────────────────────────────────────────────────────┐  │  │   │
│  │  │  │ Pipeline Service    │ Log Service                  │  │  │   │
│  │  │  │ User Service        │ Approval Service             │  │  │   │
│  │  │  │ Account Service     │ Rerun Service                │  │  │   │
│  │  │  │ STO Service         │ Abort Service                │  │  │   │
│  │  │  │ SSCA Service        │ OPA Service                  │  │  │   │
│  │  │  │ FF Service          │ AIDA Service                 │  │  │   │
│  │  │  │ CCM Service         │ TI Service                   │  │  │   │
│  │  │  └────────────────────────────────────────────────────┘  │  │   │
│  │  └──────────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    UI LAYER                                     │   │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │   │
│  │  │ SidebarProvider  │  │ WebviewBridge    │  │ StatusBar    │  │   │
│  │  │ (Webview host)   │  │ (Message routing)│  │ (Status UI)  │  │   │
│  │  └──────────────────┘  └──────────────────┘  └──────────────┘  │   │
│  │                                                                  │   │
│  │  ┌──────────────────────────────────────────────────────────┐  │   │
│  │  │              WEBVIEW (React-based)                       │  │   │
│  │  │  • main.ts (Pipeline/Execution views)                    │  │   │
│  │  │  • ai-bar.ts (AI chat interface)                         │  │   │
│  │  │  • styles.css & ai-bar.css (Styling)                     │  │   │
│  │  └──────────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                  FEATURES & ANNOTATIONS                         │   │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │   │
│  │  │ STO Annotations  │  │ TI Annotations   │  │ SSCA Annot.  │  │   │
│  │  │ (Security scans) │  │ (Code coverage)  │  │ (Supply      │  │   │
│  │  │                  │  │                  │  │  chain)      │  │   │
│  │  └──────────────────┘  └──────────────────┘  └──────────────┘  │   │
│  │                                                                  │   │
│  │  ┌──────────────────────────────────────────────────────────┐  │   │
│  │  │ FF Decorations (Feature Flag inline indicators)          │  │   │
│  │  │ Diagnostics Manager (Error/warning collection)           │  │   │
│  │  └──────────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    AI INTEGRATION LAYER                         │   │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │   │
│  │  │ AI Detector      │  │ MCP Configurer   │  │ Launcher     │  │   │
│  │  │ (Tool detection) │  │ (Config setup)   │  │ (Tool exec)  │  │   │
│  │  └──────────────────┘  └──────────────────┘  └──────────────┘  │   │
│  │                                                                  │   │
│  │  ┌──────────────────────────────────────────────────────────┐  │   │
│  │  │ Prompt Builder (Context injection for AI tools)          │  │   │
│  │  │ Supports: Claude Code, GitHub Copilot, Cursor AI        │  │   │
│  │  └──────────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    LOGGING & UTILITIES                          │   │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐  │   │
│  │  │ Logger           │  │ Git Context      │  │ Log Provider │  │   │
│  │  │ (Output channel) │  │ (Branch/commit)  │  │ (Editor tabs)│  │   │
│  │  └──────────────────┘  └──────────────────┘  └──────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
                                  ↓
                    ┌─────────────────────────────┐
                    │   HARNESS BACKEND API       │
                    │  (REST endpoints)           │
                    │  • Pipelines                │
                    │  • Executions               │
                    │  • Logs                     │
                    │  • Approvals                │
                    │  • Security scans           │
                    │  • Feature flags            │
                    └─────────────────────────────┘
```

---

## Data Flow Diagrams

### 1. **Initialization & Authentication Flow**

```
VS Code Activation
       ↓
Initialize Core Components
  • SecretStore
  • ConfigManager
  • Logger
  • FME Client
       ↓
Check for Stored Credentials
       ├─ Found → Load config
       └─ Not found → Show onboarding
       ↓
Read Environment Variables
  (HARNESS_API_KEY, HARNESS_BASE_URL, HARNESS_ACCOUNT_ID)
       ↓
Create HarnessClient
       ↓
Start PipelinePoller
       ↓
Register Sidebar & Commands
```

### 2. **Pipeline Polling & Display Flow**

```
PipelinePoller (every 10 seconds)
       ↓
Get Git Context (current branch/commit)
       ↓
HarnessClient.getPipelines()
       ↓
Execution Dispatcher
  • Parse execution details
  • Extract logs
  • Analyze STO/TI/SSCA results
       ↓
WebviewBridge.send()
       ↓
Webview (React)
  • Render pipeline status
  • Display execution details
  • Show annotations
```

### 3. **User Action Flow (Approval/Rerun/Abort)**

```
User clicks button in Webview
       ↓
WebviewBridge.onMessage()
       ↓
Route to appropriate service
  • Approval → submitApproval()
  • Rerun → rerunPipeline()
  • Abort → abortExecution()
       ↓
HarnessClient (HTTP request)
       ↓
Harness Backend API
       ↓
Success/Error response
       ↓
Show notification to user
       ↓
Trigger poller refresh
```

### 4. **AI Integration Flow**

```
User types question in AI footer
       ↓
Select AI tool (Claude Code / Copilot / Cursor)
       ↓
Detect AI tool availability
       ↓
Build prompt with context
  • Pipeline name
  • Execution status
  • Execution ID
  • Harness URL
       ↓
Launch AI tool
  • Claude Code: Use MCP server
  • Copilot: Open chat with auto-paste
  • Cursor: Use plugin or MCP
       ↓
AI tool responds with analysis
```

### 5. **Log Viewing Flow**

```
User clicks "View Logs" on step
       ↓
LogContentProvider.provideTextDocumentContent()
       ↓
HarnessClient.getStepLogs()
       ↓
Parse & format logs
       ↓
Apply syntax highlighting
  (harness-log language grammar)
       ↓
Display in editor tab
```

---

## Key Components Detail

### **Extension Core (extension.ts)**
- **Role**: Main entry point, orchestrates all subsystems
- **Responsibilities**:
  - Activate/deactivate extension
  - Initialize all managers and providers
  - Route webview messages to services
  - Manage poller lifecycle
  - Handle commands (configure, refresh, export, etc.)

### **Authentication Layer**
- **SecretStore**: Encrypts & stores PAT in VS Code secret storage
- **ConfigManager**: Manages org/project/URL configuration
- **Onboarding**: Interactive setup flow for first-time users
- **EnvCredentials**: Detects environment variable auth

### **Polling & Data Layer**
- **PipelinePoller**: Periodically fetches execution status (respects window focus & sidebar visibility)
- **HarnessClient**: HTTP client for all Harness API calls
- **ExecutionDispatcher**: Parses execution data and extracts module-specific info

### **API Services**
Each service handles a specific domain:
- **LogService**: Fetches & caches logs with pagination
- **ApprovalService**: Submits approval decisions
- **RerunService**: Triggers pipeline re-runs
- **AbortService**: Aborts/marks executions as failed
- **StoService/SscaService**: Security scanning data
- **TiService**: Test Intelligence data
- **UserService**: User permissions & account info

### **UI Layer**
- **SidebarProvider**: Hosts the webview in the activity bar
- **WebviewBridge**: Bidirectional message routing (VS Code ↔ Webview)
- **StatusBar**: Shows connection status
- **Webview**: React-based UI with two main views:
  - Pipelines: Browse all pipelines
  - Executions: Browse execution history with filters

### **Features & Annotations**
- **STO Annotations**: Security vulnerability markers in editor
- **TI Annotations**: Code coverage & test intelligence
- **SSCA Annotations**: Supply chain security info
- **FF Decorations**: Feature flag inline indicators
- **DiagnosticsManager**: Collects errors/warnings

### **AI Integration**
- **Detector**: Auto-detects Claude Code, Copilot, Cursor, and Kiro; Claude PATH lookup is asynchronous and session-cached
- **MCPConfigurer**: Sets up MCP server configuration
- **ClaudeTerminalLauncher**: Opens a fresh integrated terminal with an interactive Claude session and shell-safe structured prompt
- **Launcher**: Routes editor AI tools to their existing panels and Claude CLI to the terminal handoff
- **PromptBuilder**: Injects pipeline context into prompts and enforces the terminal argv budget

---

## Configuration & State Management

### **VS Code Settings** (`harness.*`)
```
harness.baseUrl                    → Harness instance URL
harness.accountIdentifier          → Account ID
harness.orgIdentifier              → Default org
harness.projectIdentifier          → Default project
harness.authSource                 → 'pat' or 'env'
harness.pollingIntervalSeconds     → Refresh rate (5-120s)
harness.defaultView                → 'thisCommit' or 'allExecutions'
harness.diffAwareSTO               → Limit STO to changed files
harness.fmeSdkKey                  → Feature flag SDK key
harness.logLevel                   → Logging verbosity
harness.ai.preferredExternalTool   → External AI tool (auto or a detected tool id)
harness.ai.defaultDestination      → harness or external
```

### **Secret Storage** (VS Code secrets)
```
harness.pat                        → Personal Access Token (encrypted)
```

---

## Extension Lifecycle

```
1. ACTIVATION
   ├─ Initialize core managers
   ├─ Register providers & commands
   ├─ Load stored credentials
   ├─ Initialize FME client
   └─ Start polling (if configured)

2. POLLING (every 10 seconds)
   ├─ Check window focus & sidebar visibility
   ├─ Fetch git context
   ├─ Query Harness API
   ├─ Parse execution data
   └─ Send updates to webview

3. USER INTERACTION
   ├─ Webview sends message
   ├─ Extension routes to service
   ├─ Service calls Harness API
   ├─ Show result notification
   └─ Refresh poller

4. DEACTIVATION
   ├─ Stop polling
   ├─ Dispose subscriptions
   └─ Clean up resources
```

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| **Language** | TypeScript |
| **IDE Integration** | VS Code Extension API |
| **UI Framework** | React (in webview) |
| **HTTP Client** | Node.js built-in (fetch), with an optional proxy/CA dispatcher (`src/utils/proxy.ts`) |
| **State Management** | VS Code context/globalState |
| **Feature Flags** | Split.io (FME SDK) |
| **Build Tool** | esbuild |
| **Packaging** | vsce |
| **AI Integration** | MCP (Model Context Protocol) |

---

## File Structure

```
src/
├── extension.ts              # Main entry point
├── api/                      # Harness API services
│   ├── harnessClient.ts      # HTTP client
│   ├── logService.ts         # Log fetching
│   ├── approvalService.ts    # Approvals
│   ├── rerunService.ts       # Re-run logic
│   ├── abortService.ts       # Abort logic
│   ├── userService.ts        # User info
│   ├── stoService.ts         # Security scans
│   ├── tiService.ts          # Test Intelligence
│   └── [other services]
├── auth/                     # Authentication
│   ├── secretStore.ts        # Secret storage
│   ├── configManager.ts      # Config management
│   ├── onboarding.ts         # Setup flow
│   └── envCredentials.ts     # Env var detection
├── ui/                       # UI components
│   ├── sidebarProvider.ts    # Webview host
│   ├── webviewBridge.ts      # Message routing
│   ├── statusBar.ts          # Status indicator
│   └── webview/              # React webview
│       ├── main.ts           # Pipeline/Execution views
│       ├── ai-bar.ts         # AI chat interface
│       └── styles.css        # Styling
├── pipeline/                 # Polling logic
│   ├── pipelinePoller.ts     # Polling engine
│   └── executionDispatcher.ts # Data parsing
├── features/                 # Code annotations
│   ├── stoAnnotations.ts     # Security markers
│   ├── tiAnnotations.ts      # Coverage markers
│   ├── sscaAnnotations.ts    # Supply chain markers
│   ├── ffDecorations.ts      # Feature flag indicators
│   └── diagnosticsManager.ts # Error collection
├── ai/                       # AI integration
│   ├── detector.ts           # Tool detection
│   ├── mcpConfigurer.ts      # MCP setup
│   ├── launcher.ts           # Tool execution
│   ├── promptBuilder.ts      # Context injection
│   └── aidaChatPanel.ts      # Harness AI Chat panel (SSE, elicitations, session title, split input, context chip, MCP pill, ⌘⇧H)
├── fme/                      # Feature Management
│   └── fmeClient.ts          # Feature flags
├── logs/                     # Log viewing
│   ├── logContentProvider.ts # Editor content
│   └── logEditorTab.ts       # Tab management
├── config/                   # Configuration
│   └── configManager.ts      # Settings management
├── git/                      # Git integration
│   └── [git utilities]
├── utils/                    # Utilities
│   └── logger.ts             # Logging
└── syntaxes/                 # Language grammars
    └── log.tmLanguage.json   # Log syntax highlighting
```

---

## Message Flow Between Components

### **Webview → Extension**
```json
{
  "type": "command",
  "command": "harness.openUrl",
  "url": "https://..."
}
```

### **Extension → Webview**
```json
{
  "type": "GIT_CONTEXT",
  "ctx": { "branch": "main", "commit": "abc123" },
  "org": "default",
  "project": "my-project",
  "logViewerVariation": "enhanced",
  "webviewTheme": "dark",
  "aiChatEnabled": true
}
```

### **Approval Flow**
```json
Webview → Extension:
{
  "type": "approval",
  "planExecutionId": "xyz",
  "action": "APPROVE",
  "comments": "Looks good"
}

Extension → Harness API:
POST /approval/submit
```

---

## Harness AI Chat (`ai/aidaChatPanel.ts`)

A webview **panel** (not the sidebar), surfaced as **"Harness AI Chat"**, that
talks to the Harness Intelligence chat API and streams responses over
Server-Sent Events (SSE). Layout mirrors the web chat: centered greeting, quick
chips near the input, minimal header.

**Command:** `Harness: Open AI Chat` — keybinding **⌘⇧H** / **Ctrl+⇧H** opens
or focuses the panel and focuses the textarea.

**Base URL:** all endpoints are prefixed with `cfg.baseUrl` from extension
config (SaaS or self-hosted).

### Input layout

Split input (Claude-style): textarea on top, neutral grey divider
(`--ac-input-divider`), footer row with MCP pill + send button.

### Session title & history

- Header shows the generated **session title** during an active chat (blank on
  new chat until the backend assigns a title).
- Title from SSE (`stream_metadata.title`, `session_title` / `title`) or
  `FETCH_SESSION_TITLE` after stream end.
- **History** (overflow → History): searchable card list (title + relative
  time); reopening a session restores title + messages via `hydrateFromHistory`.

### Streaming
```
POST /gateway/harness-intelligence/api/v2/chat?is_v2=false&orgIdentifier=…&projectIdentifier=…
  body: { prompt, context:{currentUrl}, metadata, conversation:[], conversation_id?, system_event?, stream:true }
  → text/event-stream
```
The extension host reads the stream, splits `event:` / `data:` lines, and
forwards each as a `STREAM_EVENT` message to the webview, which dispatches on
the event name in `handleSseEvent`.

### Elicitations
Interactive cards the assistant emits mid-stream to collect input. Each renders
via `renderElicitation` and, on submit, posts a `system_event`
(`{event_type, capability_id, result}`) back through the same chat endpoint.

| SSE event | UI | `result` payload |
|-----------|----|------------------|
| `elicitation_yaml` / `elicitation_confirm` | YAML/confirm card with action buttons | `action_id` (+ `yaml`, entity info) |
| `elicitation_free_text` | textarea | `free_text` |
| `elicitation_select` | option pills (pick one) | `selection` (chosen label) |
| `elicitation_multi_select` | checkboxes (pick many) | `selections` (array) + `selection` (comma-joined) |
| `elicitation_form` | per-field inputs — `select`→dropdown, `multi_select`→checkboxes, `text`→textarea | `form_values` keyed by **field label**; `multi_select` values are arrays |

Notes:
- Cards **lock on submit** (buttons + inputs disabled) so a later edit can't
  re-enable Submit.
- **History replay** (`hydrateFromHistory`): a reopened session stores the
  user's answer under `resolved.result`. `parseElicitationData` flattens
  `resolved.result` up into `resolved`, so the read-only render highlights the
  previously-chosen options (checked boxes / marked pills / saved dropdown).

### Pipeline-context chip
The chat shows which pipeline/execution it's scoped to and auto-follows
navigation. `extension.ts` tracks `currentViewedExecution` and, on identity
change, calls `updateActiveChatContext()` → `SET_CONTEXT` to the open panel
(guarded so poll ticks don't spam). `renderContextChip` draws
`Context: <pipeline> ×`, pulses on auto-update, and the × clears context
(stops sending `currentUrl`); navigating re-attaches it.

### MCP connectors
External MCP connectors (Jira, GitHub, …) are a **per-user-per-project**
backend setting — the chat body is identical whether or not they apply; the
backend injects the tools from the stored selection keyed on the authenticated
user + project. On open, `fetchSelectedConnectorIds()` reads
`/api/v1/user-settings/selected_connector_ids` and an input-**footer** pill
(`ac-mcp-pill`) shows `MCP · N connectors` / `MCP · none` with the connector
names in a tooltip. Works over PAT; the deciding factor is which project the
extension targets.

---

## Summary

This extension follows a **layered architecture** with clear separation of concerns:

1. **Authentication Layer** - Manages credentials securely
2. **API Layer** - Communicates with Harness backend
3. **Polling Layer** - Keeps UI in sync with pipeline status
4. **UI Layer** - Renders webview and handles user interactions
5. **Features Layer** - Provides code annotations and inline indicators
6. **AI Layer** - Integrates with external AI tools

The extension is **event-driven** and **reactive**, using VS Code's extension API for lifecycle management and the webview bridge for bidirectional communication. It respects user focus and sidebar visibility to optimize polling frequency.
