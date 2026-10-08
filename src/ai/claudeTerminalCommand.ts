/**
 * Pure command builder for launching interactive Claude in a VS Code terminal.
 * The prompt is baked into the shell's startup args so it never enters shell history.
 */

export const TRUNCATION_MARKER = ' …';

const POSIX_ARGV_BUDGET = 200_000;
const POWERSHELL_ENCODED_BUDGET = 30_000;

export type ClaudeShellLaunch =
  | { ok: true; shellPath: string; shellArgs: string[] | string }
  | { ok: false; error: string };

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function encodePowerShellCommand(script: string): string {
  const bytes = Buffer.alloc(script.length * 2);
  for (let i = 0; i < script.length; i++) {
    bytes.writeUInt16LE(script.charCodeAt(i), i * 2);
  }
  return bytes.toString('base64');
}

function shellName(shellPath: string): string {
  const base = shellPath.split(/[/\\]/).pop() ?? '';
  return base.toLowerCase().replace(/\.exe$/, '');
}

function hasUnsafeControls(value: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
}

function shrinkToFit(prompt: string, fits: (candidate: string) => boolean): string | null {
  if (fits(prompt)) return prompt;
  const points = Array.from(prompt);
  let lo = 0;
  let hi = points.length;
  let best: string | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = (points.slice(0, mid).join('').trimEnd() || '') + TRUNCATION_MARKER;
    if (fits(candidate)) {
      best = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

const UNSUPPORTED_SHELL =
  'This shell cannot safely launch Claude with the current prompt. Switch the default terminal to PowerShell, bash, or zsh.';

/** Windows PowerShell 5.1 is present on every Windows install, so cmd can hand off to it. */
const WINDOWS_POWERSHELL = 'powershell.exe';

function powershellLaunch(shellPath: string, claudePath: string, prompt: string): ClaudeShellLaunch {
  const fitted = shrinkToFit(prompt, (candidate) => {
    const script = `& ${psSingleQuote(claudePath)} ${psSingleQuote(candidate)}`;
    return encodePowerShellCommand(script).length <= POWERSHELL_ENCODED_BUDGET;
  });
  if (!fitted) return { ok: false, error: UNSUPPORTED_SHELL };
  const encoded = encodePowerShellCommand(`& ${psSingleQuote(claudePath)} ${psSingleQuote(fitted)}`);
  return { ok: true, shellPath, shellArgs: ['-NoExit', '-EncodedCommand', encoded] };
}

/**
 * Build shell args that start interactive Claude, then return to a normal shell when it exits.
 */
export function buildClaudeShellLaunch(input: {
  shellPath: string;
  claudePath: string;
  prompt: string;
  platform: NodeJS.Platform;
}): ClaudeShellLaunch {
  const shellPath = input.shellPath.trim();
  const claudePath = input.claudePath.trim();
  if (!shellPath || !claudePath) {
    return { ok: false, error: 'Claude Code CLI was not found on PATH.' };
  }
  if (hasUnsafeControls(input.prompt) || hasUnsafeControls(claudePath) || hasUnsafeControls(shellPath)) {
    return { ok: false, error: 'The prompt contains characters that cannot be passed to the terminal safely.' };
  }

  const name = shellName(shellPath);
  const windows = input.platform === 'win32';

  if (windows && (name === 'powershell' || name === 'pwsh')) {
    return powershellLaunch(shellPath, claudePath, input.prompt);
  }

  // cmd cannot quote a multi-line prompt. Hand off to Windows PowerShell instead.
  if (windows && name === 'cmd') {
    return powershellLaunch(WINDOWS_POWERSHELL, claudePath, input.prompt);
  }

  if (windows && name !== 'bash' && name !== 'zsh') {
    return { ok: false, error: UNSUPPORTED_SHELL };
  }
  // dash (often /bin/sh) rejects -l, so it cannot run the login-shell handoff.
  if (name === 'sh' || name === 'fish' || name === 'nu' || name === 'nushell') {
    return { ok: false, error: UNSUPPORTED_SHELL };
  }

  const prompt = shrinkToFit(input.prompt, (candidate) => {
    const script = `${shellSingleQuote(claudePath)} ${shellSingleQuote(candidate)}; exec ${shellSingleQuote(shellPath)} -l -i`;
    return Buffer.byteLength(script) <= POSIX_ARGV_BUDGET;
  });
  if (!prompt) return { ok: false, error: UNSUPPORTED_SHELL };
  const script = `${shellSingleQuote(claudePath)} ${shellSingleQuote(prompt)}; exec ${shellSingleQuote(shellPath)} -l -i`;
  return { ok: true, shellPath, shellArgs: ['-l', '-i', '-c', script] };
}
