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
 * Launch Claude Code Extension
 * Opens the extension and copies prompt to clipboard
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

    // Open Claude Code chat interface
    logger.debug('AI Launcher', '⏳ Opening Claude Code chat...');

    // Try these commands in order of preference
    const openCommands = [
      'claude-vscode.focus',           // Focus the main Claude view
      'claudeVSCodeSidebar.focus',     // Focus the sidebar view
      'claude-vscode.sidebar.open',    // Open sidebar
      'claudeVSCodeSidebar.open',      // Open the view
      'claude-vscode.window.open',     // Open as window/editor
    ];

    let opened = false;
    for (const cmd of openCommands) {
      if (claudeCommands.includes(cmd)) {
        logger.debug('AI Launcher', `⏳ Trying: ${cmd}`);
        try {
          await vscode.commands.executeCommand(cmd);
          logger.debug('AI Launcher', `✓ Opened with: ${cmd}`);
          // Give it time to fully render
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

    // Try starting a new conversation (opens with empty input ready)
    if (claudeCommands.includes('claude-vscode.newConversation')) {
      logger.debug('AI Launcher', '⏳ Starting new conversation...');
      try {
        await vscode.commands.executeCommand('claude-vscode.newConversation');
        logger.debug('AI Launcher', '✓ New conversation started');
        // Give the input time to focus and render
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (err) {
        logger.debug('AI Launcher', '⚠ New conversation failed:', err);
      }
    } else {
      logger.debug('AI Launcher', '⚠ newConversation command not available');
    }

    // Copy prompt to clipboard
    logger.debug('AI Launcher', '⏳ Copying prompt to clipboard...');
    await vscode.env.clipboard.writeText(prompt);
    logger.debug('AI Launcher', '✓ Prompt copied');

    // Give UI time to render and focus
    await new Promise(resolve => setTimeout(resolve, 800));

    // Auto-paste without user interaction
    logger.debug('AI Launcher', 'Auto-pasting prompt...');
    try {
      await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
      logger.debug('AI Launcher', '✓ Auto-paste successful');

      // Show brief success notification
      vscode.window.showInformationMessage(
        '✅ Prompt sent to Claude Code',
        { modal: false }
      );
    } catch (err) {
      logger.debug('AI Launcher', '⚠ Auto-paste failed, showing fallback notification');
      // Fallback: show notification if auto-paste fails
      vscode.window.showInformationMessage(
        'Prompt copied to clipboard - paste it in Claude Code (Cmd+V)',
        'OK'
      );
    }

    logger.debug('AI Launcher', '✓ Extension launch complete');
    return {
      type: 'launched',
      content: 'Prompt auto-pasted to Claude Code.',
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
 * Opens Cursor Composer/Agents and auto-pastes when user clicks button
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

    // Copy prompt to clipboard
    await vscode.env.clipboard.writeText(prompt);
    logger.debug('AI Launcher', '✓ Prompt copied to clipboard');

    // Try opening Cursor Composer/Agent tab
    const commandsToTry = [
      'aichat.newchataction',  // Cursor AI Chat
      'workbench.action.chat.open',  // Generic chat open
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

      // Show brief success notification
      vscode.window.showInformationMessage(
        '✅ Prompt sent to Cursor Composer',
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
      content: 'Prompt auto-pasted to Cursor Composer.',
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
 * Opens GitHub Copilot Chat and auto-pastes the prompt
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

    // Copy prompt to clipboard
    await vscode.env.clipboard.writeText(prompt);
    logger.debug('AI Launcher', '✓ Prompt copied to clipboard');

    // Try opening GitHub Copilot Chat
    const commandsToTry = [
      'workbench.action.chat.open',  // Open chat panel
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

      // Show brief success notification
      vscode.window.showInformationMessage(
        '✅ Prompt sent to GitHub Copilot',
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
      content: 'Prompt auto-pasted to GitHub Copilot.',
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

    // List all available commands to find the right one
    const allCommands = await vscode.commands.getCommands(true);
    const kiroCommands = allCommands.filter(cmd =>
      cmd.toLowerCase().includes('kiro') ||
      cmd.toLowerCase().includes('ai') ||
      cmd.toLowerCase().includes('chat')
    );
    logger.debug('AI Launcher', 'Available Kiro commands:', kiroCommands);

    // Copy prompt to clipboard
    await vscode.env.clipboard.writeText(prompt);
    logger.debug('AI Launcher', '✓ Prompt copied to clipboard');

    // Try opening Kiro AI Chat
    // Kiro uses standard workbench.action.chat commands
    const commandsToTry = [
      'workbench.action.chat.open',  // Standard VS Code chat open
      'workbench.action.chat.new',   // Start new chat
      'kiro.openChat',               // Kiro-specific (if exists)
    ];

    let opened = false;
    for (const cmd of commandsToTry) {
      if (kiroCommands.includes(cmd) || allCommands.includes(cmd)) {
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
        '✅ Prompt sent to Kiro AI Chat',
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
