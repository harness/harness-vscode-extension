import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { logger } from '../utils/logger';

/** MCP config paths that may contain PAT credentials when using project scope. */
export const MCP_SECRET_GITIGNORE_ENTRIES = ['.mcp.json', '.vscode/mcp.json', '.kiro/settings/mcp.json'] as const;

const GITIGNORE_MARKER = '# Harness VS Code extension — MCP configs may contain API keys';

/**
 * Idempotently append MCP secret paths to the workspace .gitignore.
 * Returns the entries that were newly added.
 */
export async function ensureMcpSecretsGitignored(): Promise<string[]> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return [];
  }

  const gitignorePath = path.join(folder.uri.fsPath, '.gitignore');
  let content = '';
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf-8');
  }

  const existingLines = new Set(
    content.split('\n').map((line) => line.trim()).filter(Boolean),
  );

  const toAdd = MCP_SECRET_GITIGNORE_ENTRIES.filter(
    (entry) => !existingLines.has(entry) && !content.includes(entry),
  );

  if (toAdd.length === 0) {
    return [];
  }

  const needsLeadingNewline = content.length > 0 && !content.endsWith('\n');
  const block = `${needsLeadingNewline ? '\n' : ''}\n${GITIGNORE_MARKER}\n${toAdd.join('\n')}\n`;
  fs.writeFileSync(gitignorePath, content + block, 'utf-8');

  logger.info('MCP', `Added to .gitignore: ${toAdd.join(', ')}`);
  return [...toAdd];
}
