import * as os from 'os';
import * as vscode from 'vscode';
import { resolveClaudeExecutable } from './detector';
import { buildClaudeShellLaunch } from './claudeTerminalCommand';
import { logger } from '../utils/logger';

export async function launchClaudeInTerminal(
  prompt: string,
  cwd?: string,
): Promise<{ type: 'launched' | 'error'; error?: string }> {
  const claudePath = await resolveClaudeExecutable(true);
  if (!claudePath) {
    return {
      type: 'error',
      error: 'Claude Code CLI was not found on PATH. Install it from https://claude.ai/code and open a new VS Code window.',
    };
  }

  const shellPath = vscode.env.shell
    || (process.platform === 'win32' ? 'powershell.exe' : process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  const built = buildClaudeShellLaunch({
    shellPath,
    claudePath,
    prompt,
    platform: process.platform,
  });
  if (!built.ok) {
    return { type: 'error', error: built.error };
  }

  const terminal = vscode.window.createTerminal({
    name: 'Harness · Claude',
    cwd: cwd || os.homedir(),
    shellPath: built.shellPath,
    shellArgs: built.shellArgs,
  });
  terminal.show(true);
  logger.info('AI Launcher', 'Opened Claude Code in the integrated terminal');
  return { type: 'launched' };
}
