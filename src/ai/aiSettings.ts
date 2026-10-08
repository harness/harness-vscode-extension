import * as vscode from 'vscode';

const EXTERNAL_TOOL_SETTING = 'ai.preferredExternalTool';
const LEGACY_EXTERNAL_TOOL_SETTING = 'ai.preferredTool';
const LEGACY_TOOL_KEY = 'harness.aiToolPreference';
const LEGACY_DESTINATION_KEY = 'harness.aiDestination';

export const AI_TOOL_IDS = ['auto', 'claudecode-cli', 'claudecode-ext', 'cursor', 'copilot', 'kiro'] as const;
export type AiDestination = 'harness' | 'external';

function isToolId(value: string): boolean {
  return (AI_TOOL_IDS as readonly string[]).includes(value);
}

function isExplicit(key: string): boolean {
  const inspected = vscode.workspace.getConfiguration('harness').inspect(key);
  return inspected?.globalValue !== undefined
    || inspected?.workspaceValue !== undefined
    || inspected?.workspaceFolderValue !== undefined;
}

/** `undefined` means automatic selection of the first detected external tool. */
export function readPreferredExternalToolId(): string | undefined {
  const cfg = vscode.workspace.getConfiguration('harness');
  const value = isExplicit(EXTERNAL_TOOL_SETTING)
    ? cfg.get<string>(EXTERNAL_TOOL_SETTING, 'auto')
    : cfg.get<string>(LEGACY_EXTERNAL_TOOL_SETTING, 'auto');
  if (!value || value === 'auto' || !isToolId(value)) return undefined;
  return value;
}

export function readAiDestination(): AiDestination {
  return vscode.workspace.getConfiguration('harness').get<string>('ai.defaultDestination', 'harness') === 'external'
    ? 'external'
    : 'harness';
}

export async function setPreferredExternalTool(toolId: string): Promise<void> {
  const value = isToolId(toolId) ? toolId : 'auto';
  await vscode.workspace.getConfiguration('harness').update(EXTERNAL_TOOL_SETTING, value, vscode.ConfigurationTarget.Global);
}

export async function setAiDestination(destination: AiDestination): Promise<void> {
  await vscode.workspace.getConfiguration('harness').update(
    'ai.defaultDestination',
    destination,
    vscode.ConfigurationTarget.Global,
  );
}

/**
 * Copy the previous globalState choices into settings the first time those settings are unset.
 */
export async function migrateAiSettings(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('harness');
  if (!isExplicit(EXTERNAL_TOOL_SETTING)) {
    const renamed = isExplicit(LEGACY_EXTERNAL_TOOL_SETTING)
      ? cfg.get<string>(LEGACY_EXTERNAL_TOOL_SETTING)
      : undefined;
    const legacy = renamed && renamed !== 'auto'
      ? renamed
      : context.globalState.get<string>(LEGACY_TOOL_KEY);
    if (legacy && isToolId(legacy) && legacy !== 'auto') {
      await cfg.update(EXTERNAL_TOOL_SETTING, legacy, vscode.ConfigurationTarget.Global);
    }
  }
  if (!isExplicit('ai.defaultDestination')) {
    const legacy = context.globalState.get<string>(LEGACY_DESTINATION_KEY);
    if (legacy === 'external') {
      await cfg.update('ai.defaultDestination', 'external', vscode.ConfigurationTarget.Global);
    }
  }
}
