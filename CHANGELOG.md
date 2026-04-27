# Changelog

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
