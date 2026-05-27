# Contributing to Harness VS Code Extension

Thank you for your interest in contributing! This guide will help you get started with development.

---

## 🛠 Development Setup

### Prerequisites

- **Node.js** 18 or higher
- **VS Code** 1.85.0 or higher
- **Git**

### Clone and Build

```bash
# Clone the repository
git clone https://github.com/harness/harness-vscode-extension
cd harness-vscode-extension

# Install dependencies
npm install

# Build the extension
npm run compile
```

### Run in Development Mode

1. Open the project in VS Code
2. Press `F5` to launch the **Extension Development Host**
3. A new VS Code window will open with the extension loaded
4. Test your changes in this window

### Watch Mode (Auto-rebuild)

```bash
npm run watch
```

This automatically rebuilds when you save changes. You'll still need to reload the Extension Development Host window (`Ctrl+R` / `Cmd+R`).

---

## 📦 Building & Packaging

### Build for Distribution

```bash
npm run compile
```

This uses `esbuild` to bundle the extension into `dist/` directory.

### Create VSIX Package

```bash
# Install vsce if you don't have it
npm install -g @vscode/vsce

# Package the extension
npm run package
```

This creates `harness-vscode-0.x.x.vsix` in the project root.

### Install VSIX Locally

**In VS Code:**
```bash
code --install-extension harness-vscode-0.x.x.vsix
```

**In Cursor:**
```bash
cursor --install-extension harness-vscode-0.x.x.vsix
```

Or use the VS Code UI:
1. Open Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`)
2. Click `...` menu → **Install from VSIX...**
3. Select the `.vsix` file

---

## 🏗 Project Structure

```
harness-vscode-extension/
├── src/
│   ├── extension.ts           # Extension entry point
│   ├── api/                   # Harness API client
│   ├── auth/                  # Authentication & onboarding
│   ├── config/                # Configuration management
│   ├── git/                   # Git context detection
│   ├── pipeline/              # Pipeline polling & dispatch
│   ├── ui/                    # Webview (sidebar & bridge)
│   │   ├── webview/           # Webview frontend (main.ts)
│   │   ├── sidebarProvider.ts
│   │   └── webviewBridge.ts
│   ├── features/              # Diagnostics, annotations
│   └── utils/                 # Logger, error handling
├── dist/                      # Build output (git-ignored)
├── icons/                     # Extension icons
├── syntaxes/                  # Log syntax highlighting
└── esbuild.js                 # Build script
```

---

## 🧪 Testing

### Manual Testing

1. Launch Extension Development Host (`F5`)
2. Configure credentials in the dev window
3. Open a project with a Harness pipeline
4. Verify:
   - Pipeline status appears in sidebar
   - Logs open in editor tabs
   - Approvals work (if applicable)
   - AI integration (if configured)

### Debug Logging

Set `harness.logLevel` to `"debug"` in settings, then check:
- **Output panel**: View → Output → Select "Harness" from dropdown
- **Developer Console**: Help → Toggle Developer Tools

---

## 📝 Code Guidelines

### Commits

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: Add support for approval rejections
fix: Prevent 401 error when using env vars
docs: Update README with new auth flow
chore: Bump dependencies
```

### TypeScript

- Use `async/await` over callbacks
- Prefer `const` over `let`
- Add JSDoc comments for public APIs
- Run type checking: `npx tsc --noEmit`

### Error Handling

- Use `logger.error()` for errors (respects `logLevel` setting)
- Use `handleApiError()` helper for API failures
- Never swallow errors silently

---

## 🚀 Release Process

### Pre-release Checklist

1. Update version in `package.json`
2. Update `CHANGELOG.md` with release notes
3. Test VSIX package locally
4. Commit changes: `chore: Bump version to 0.x.x`

### Publishing to Marketplace

```bash
# Login (first time only)
vsce login harness

# Publish
vsce publish
```

**Note:** Only maintainers with publisher access can publish.

### GitHub Release

1. Create a new tag: `git tag v0.x.x`
2. Push tag: `git push origin v0.x.x`
3. Create GitHub release with `.vsix` file attached

---

## 🐛 Debugging Tips

### Extension Not Loading

- Check Output panel → "Harness" for startup errors
- Verify `activationEvents` in `package.json`
- Try Developer: Reload Window

### API Errors

- Use **Harness: Show Debug Output** command
- Check `harness.logLevel` is set to `"debug"`
- Verify PAT has correct permissions

### Webview Not Rendering

- Check browser console in webview (Developer Tools)
- Verify `webviewBridge.ts` is sending messages
- Check CSP errors in webview HTML

---

## 📚 Resources

- [VS Code Extension API](https://code.visualstudio.com/api)
- [Harness API Docs](https://apidocs.harness.io/)
- [GitHub Issues](https://github.com/harness/harness-vscode-extension/issues)

---

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.
