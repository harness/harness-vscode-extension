// AI tool launcher - opens Claude Code in the terminal, or an editor AI panel

import * as vscode from 'vscode';
import { logger } from '../utils/logger';
import { launchClaudeInTerminal } from './claudeTerminalLauncher';

export interface LaunchResult {
  type: 'response' | 'launched' | 'error';
  content?: string;
  toolCalls?: Array<{ name: string; args?: unknown }>;
  durationMs?: number;
  error?: string;
}

interface LaunchOptions {
  prompt: string;
  toolId: 'claudecode-cli' | 'claudecode-ext' | 'cursor' | 'copilot' | 'kiro';
  cwd?: string; // working directory for the Claude terminal
}

/**
 * Launch AI tool with the given prompt
 */
export async function launchAI(options: LaunchOptions): Promise<LaunchResult> {
  if (options.toolId === 'claudecode-cli') {
    return launchClaudeInTerminal(options.prompt, options.cwd);
  } else if (options.toolId === 'claudecode-ext') {
    return launchExtension(options.prompt);
  } else if (options.toolId === 'cursor') {
    return launchCursor(options.prompt);
  } else if (options.toolId === 'copilot') {
    return launchCopilot(options.prompt);
  } else if (options.toolId === 'kiro') {
    return launchKiro(options.prompt);
  } else {
    return {
      type: 'error',
      error: `Unknown tool: ${options.toolId}`,
    };
  }
}

/**
 * Launch Claude Code Extension.
 * Prefers injecting the prompt into Claude's input (not submitted). Clipboard
 * paste is only a last-resort fallback for older Claude Code builds.
 */
async function launchExtension(prompt: string): Promise<LaunchResult> {
  try {
    logger.debug('AI Launcher', 'Starting Extension integration');
    logger.debug('AI Launcher', 'Prompt length:', prompt.length);

    // Try to execute Claude Code extension command
    const extension = vscode.extensions.getExtension('anthropic.claude-code');
    if (!extension) {
      logger.debug('AI Launcher', '✗ Extension not found');
      return {
        type: 'error',
        error: 'Claude Code extension not found',
      };
    }

    logger.debug('AI Launcher', '✓ Extension found');
    logger.debug('AI Launcher', '  Extension ID:', extension.id);
    logger.debug('AI Launcher', '  Is Active:', extension.isActive);

    // Activate extension if not already active
    if (!extension.isActive) {
      logger.debug('AI Launcher', '⏳ Activating extension...');
      await extension.activate();
      logger.debug('AI Launcher', '✓ Extension activated');
    }

    // List all available Claude Code commands first
    const allCommands = await vscode.commands.getCommands(true);
    const claudeCommands = allCommands.filter(cmd =>
      cmd.toLowerCase().includes('claude') || cmd.toLowerCase().includes('anthropic')
    );
    logger.debug('AI Launcher', 'Available Claude/Anthropic commands:', claudeCommands);

    // Current Claude Code builds take the prompt as the second argument and put
    // it in the chat input. Without the programmatic flag, a prompt pins the
    // panel; honor-preferred-location keeps sidebar vs Panel (New Tab).
    // editor.action.clipboardPasteAction only reaches a text editor.
    if (claudeCommands.includes('claude-vscode.editor.open')) {
      try {
        logger.debug('AI Launcher', '⏳ Opening Claude Code with prompt (honor preferred location)');
        await vscode.commands.executeCommand(
          'claude-vscode.editor.open',
          undefined, // sessionId
          prompt,
          undefined, // viewColumn
          undefined, // sessionGroup
          undefined, // fullEditor
          { programmatic: 'honor-preferred-location' },
        );
        logger.debug('AI Launcher', '✓ Prompt added via editor.open (preferred location)');
        vscode.window.showInformationMessage('Prompt added to Claude Code', { modal: false });
        return {
          type: 'launched',
          content: 'Prompt added to Claude Code.',
        };
      } catch (err) {
        logger.debug('AI Launcher', '⚠ editor.open preferred-location failed:', err);
      }

      try {
        logger.debug('AI Launcher', '⏳ Opening Claude Code with prompt (panel fallback)');
        await vscode.commands.executeCommand('claude-vscode.editor.open', undefined, prompt);
        logger.debug('AI Launcher', '✓ Prompt added via editor.open');
        vscode.window.showInformationMessage('Prompt added to Claude Code', { modal: false });
        return {
          type: 'launched',
          content: 'Prompt added to Claude Code.',
        };
      } catch (err) {
        logger.debug('AI Launcher', '⚠ editor.open with prompt failed:', err);
      }
    }

    // Legacy fallback: open Claude, then paste from clipboard only if needed
    logger.debug('AI Launcher', '⏳ Opening Claude Code chat (clipboard fallback)...');

    const openCommands = [
      'claude-vscode.focus',
      'claudeVSCodeSidebar.focus',
      'claude-vscode.sidebar.open',
      'claudeVSCodeSidebar.open',
      'claude-vscode.window.open',
    ];

    let opened = false;
    for (const cmd of openCommands) {
      if (claudeCommands.includes(cmd)) {
        logger.debug('AI Launcher', `⏳ Trying: ${cmd}`);
        try {
          await vscode.commands.executeCommand(cmd);
          logger.debug('AI Launcher', `✓ Opened with: ${cmd}`);
          await new Promise(resolve => setTimeout(resolve, 600));
          opened = true;
          break;
        } catch (cmdErr) {
          logger.debug('AI Launcher', `⚠ ${cmd} failed:`, cmdErr);
        }
      } else {
        logger.debug('AI Launcher', `⊘ ${cmd} not available`);
      }
    }

    if (!opened) {
      logger.debug('AI Launcher', '✗ Could not open Claude Code with any command');
      vscode.window.showWarningMessage('Could not open Claude Code. Please open it manually and try again.');
      return {
        type: 'error',
        error: 'Failed to open Claude Code',
      };
    }

    if (claudeCommands.includes('claude-vscode.newConversation')) {
      logger.debug('AI Launcher', '⏳ Starting new conversation...');
      try {
        await vscode.commands.executeCommand('claude-vscode.newConversation');
        logger.debug('AI Launcher', '✓ New conversation started');
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (err) {
        logger.debug('AI Launcher', '⚠ New conversation failed:', err);
      }
    }

    logger.debug('AI Launcher', '⏳ Clipboard fallback: copying prompt...');
    await vscode.env.clipboard.writeText(prompt);
    await new Promise(resolve => setTimeout(resolve, 800));

    try {
      await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
      logger.debug('AI Launcher', '✓ Clipboard paste succeeded');
      vscode.window.showInformationMessage('Prompt added to Claude Code', { modal: false });
    } catch (err) {
      logger.debug('AI Launcher', '⚠ Clipboard paste failed:', err);
      vscode.window.showInformationMessage(
        'Prompt copied to clipboard — paste it in Claude Code (Cmd+V / Ctrl+V)',
        'OK'
      );
    }

    logger.debug('AI Launcher', '✓ Extension launch complete');
    return {
      type: 'launched',
      content: 'Prompt added to Claude Code.',
    };
  } catch (error) {
    logger.error('AI Launcher', '✗ Extension launch failed:', error);
    return {
      type: 'error',
      error: error instanceof Error ? error.message : 'Failed to launch extension',
    };
  }
}

/**
 * Launch Cursor with prompt
 * Opens Cursor Chat/Agent with the prompt prefilled but not submitted.
 */
async function launchCursor(prompt: string): Promise<LaunchResult> {
  try {
    logger.debug('AI Launcher', 'Starting Cursor integration');
    logger.debug('AI Launcher', 'Prompt length:', prompt.length);

    // List all available commands to find the right one
    const allCommands = await vscode.commands.getCommands(true);
    const aiCommands = allCommands.filter(cmd =>
      cmd.toLowerCase().includes('chat') ||
      cmd.toLowerCase().includes('ai') ||
      cmd.toLowerCase().includes('agent') ||
      cmd.toLowerCase().includes('composer')
    );
    logger.debug('AI Launcher', 'Available AI commands:', aiCommands);

    // Cursor 2.3+ accepts a string prompt and pre-fills the chat input without
    // submitting it. Prefer this over clipboard paste into the chat webview.
    if (allCommands.includes('workbench.action.chat.open')) {
      try {
        await vscode.commands.executeCommand('workbench.action.chat.open', prompt);
        logger.debug('AI Launcher', '✓ Prompt added through Cursor chat command');
        vscode.window.showInformationMessage('Prompt added to Cursor', { modal: false });
        return {
          type: 'launched',
          content: 'Prompt added to Cursor.',
        };
      } catch (err) {
        logger.debug('AI Launcher', '⚠ Direct Cursor prompt handoff failed:', err);
      }
    }

    // Older Cursor builds: open chat and paste from the clipboard.
    await vscode.env.clipboard.writeText(prompt);
    logger.debug('AI Launcher', '✓ Prompt copied to clipboard');

    const commandsToTry = [
      'aichat.newchataction',  // Cursor AI Chat
      'workbench.panel.chat.view.copilot.focus',  // Copilot chat (Cursor might use this)
    ];

    let opened = false;
    for (const cmd of commandsToTry) {
      if (aiCommands.includes(cmd)) {
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

    // Give UI time to render and focus
    await new Promise(resolve => setTimeout(resolve, 800));

    // Auto-paste without user interaction
    logger.debug('AI Launcher', 'Auto-pasting prompt...');
    try {
      await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
      logger.debug('AI Launcher', '✓ Auto-paste successful');

      vscode.window.showInformationMessage(
        'Prompt added to Cursor',
        { modal: false }
      );
    } catch (err) {
      logger.debug('AI Launcher', '⚠ Auto-paste failed, showing fallback notification');
      // Fallback: show notification if auto-paste fails
      vscode.window.showInformationMessage(
        'Prompt copied to clipboard - paste it in Cursor Composer (Cmd+V)',
        'OK'
      );
    }

    logger.debug('AI Launcher', '✓ Cursor launch complete');
    return {
      type: 'launched',
      content: 'Prompt added to Cursor.',
    };
  } catch (error) {
    logger.error('AI Launcher', '✗ Cursor launch failed:', error);
    return {
      type: 'error',
      error: error instanceof Error ? error.message : 'Failed to launch Cursor',
    };
  }
}

/**
 * Launch GitHub Copilot with prompt
 * Opens GitHub Copilot Chat with the prompt prefilled but not submitted.
 */
async function launchCopilot(prompt: string): Promise<LaunchResult> {
  try {
    logger.debug('AI Launcher', 'Starting GitHub Copilot integration');
    logger.debug('AI Launcher', 'Prompt length:', prompt.length);

    // List all available commands to find the right one
    const allCommands = await vscode.commands.getCommands(true);
    const copilotCommands = allCommands.filter(cmd =>
      cmd.toLowerCase().includes('copilot') ||
      cmd.toLowerCase().includes('github')
    );
    logger.debug('AI Launcher', 'Available Copilot commands:', copilotCommands);

    // VS Code Chat accepts a partial query object. isPartialQuery keeps the
    // prompt in the input instead of immediately submitting it.
    if (allCommands.includes('workbench.action.chat.open')) {
      try {
        await vscode.commands.executeCommand('workbench.action.chat.open', {
          query: prompt,
          isPartialQuery: true,
          mode: 'agent',
        });
        logger.debug('AI Launcher', '✓ Prompt added through VS Code Chat command');
        vscode.window.showInformationMessage('Prompt added to GitHub Copilot', { modal: false });
        return {
          type: 'launched',
          content: 'Prompt added to GitHub Copilot.',
        };
      } catch (err) {
        logger.debug('AI Launcher', '⚠ Direct Copilot prompt handoff failed:', err);
      }
    }

    // Older VS Code/Copilot builds: open chat and paste from the clipboard.
    await vscode.env.clipboard.writeText(prompt);
    logger.debug('AI Launcher', '✓ Prompt copied to clipboard');

    const commandsToTry = [
      'github.copilot.chat.focus',  // Focus Copilot chat
      'workbench.panel.chat.view.copilot.focus',  // Focus Copilot panel view
    ];

    let opened = false;
    for (const cmd of commandsToTry) {
      if (copilotCommands.includes(cmd) || allCommands.includes(cmd)) {
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
      logger.debug('AI Launcher', '✗ Could not open GitHub Copilot with any command');
      vscode.window.showWarningMessage('Could not open GitHub Copilot. Please open it manually and try again.');
      return {
        type: 'error',
        error: 'Failed to open GitHub Copilot',
      };
    }

    // Give UI time to render and focus
    await new Promise(resolve => setTimeout(resolve, 800));

    // Auto-paste without user interaction
    logger.debug('AI Launcher', 'Auto-pasting prompt...');
    try {
      await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
      logger.debug('AI Launcher', '✓ Auto-paste successful');

      vscode.window.showInformationMessage(
        'Prompt added to GitHub Copilot',
        { modal: false }
      );
    } catch (err) {
      logger.debug('AI Launcher', '⚠ Auto-paste failed, showing fallback notification');
      // Fallback: show notification if auto-paste fails
      vscode.window.showInformationMessage(
        'Prompt copied to clipboard - paste it in GitHub Copilot (Cmd+V)',
        'OK'
      );
    }

    logger.debug('AI Launcher', '✓ GitHub Copilot launch complete');
    return {
      type: 'launched',
      content: 'Prompt added to GitHub Copilot.',
    };
  } catch (error) {
    logger.error('AI Launcher', '✗ GitHub Copilot launch failed:', error);
    return {
      type: 'error',
      error: error instanceof Error ? error.message : 'Failed to launch GitHub Copilot',
    };
  }
}

/**
 * Launch Kiro AI Chat with prompt
 * Opens Kiro AI Chat and auto-pastes the prompt
 */
async function launchKiro(prompt: string): Promise<LaunchResult> {
  try {
    logger.debug('AI Launcher', 'Starting Kiro integration');
    logger.debug('AI Launcher', 'Prompt length:', prompt.length);

    const allCommands = await vscode.commands.getCommands(true);

    // Kiro's chat is its own panel, not VS Code's built-in chat. kiroAgent.focusChatInput
    // (the Cmd+L command) starts a new session, waits for it to render, and fills the input,
    // so it works on every Send without relying on clipboard paste or focus timing.
    if (allCommands.includes('kiroAgent.focusChatInput')) {
      await vscode.commands.executeCommand('kiroAgent.focusChatInput', {
        prompt,
        newSession: true,
        clear: true,
      });
      logger.debug('AI Launcher', '✓ Opened a new Kiro chat session with the prompt');
      return {
        type: 'launched',
        content: 'Prompt placed in a new Kiro AI Chat session.',
      };
    }

    // Older Kiro builds: open the chat and paste from the clipboard.
    await vscode.env.clipboard.writeText(prompt);
    logger.debug('AI Launcher', '✓ Prompt copied to clipboard');

    const commandsToTry = [
      'workbench.action.chat.open',
      'workbench.action.chat.new',
      'kiro.openChat',
    ];

    let opened = false;
    for (const cmd of commandsToTry) {
      if (allCommands.includes(cmd)) {
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
        'Prompt pasted into Kiro AI Chat',
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
