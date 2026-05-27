# Media Assets

This directory contains screenshots and GIFs for the VS Code Marketplace.

## Required Screenshots

### Hero/Overview
- **hero-screenshot.png** - Full extension overview showing sidebar with pipeline execution
- Recommended size: 1280x720px or larger

### Feature Highlights
- **pipeline-view.png** - Pipelines tab showing search, filters, and pipeline list
- **logs-view.png** - Step logs open in editor tab with syntax highlighting
- **approval-view.png** - Approval card with approve/reject buttons
- **ai-bar.png** - AI footer with question input and tool selector

### Animated Walkthrough
- **setup-walkthrough.gif** - Quick setup flow (configure credentials, select project)
- Recommended: Under 5MB, optimized for web

## Image Guidelines

- Use actual extension UI (no mockups)
- Show realistic data (sample pipeline names, logs)
- Use light theme for consistency
- Ensure text is readable when scaled down
- Remove any sensitive data (account IDs, tokens, personal info)

## Optimization

Before committing, optimize images:
```bash
# PNG optimization
pngquant --quality=65-80 *.png

# GIF optimization
gifsicle -O3 --colors 256 *.gif
```
