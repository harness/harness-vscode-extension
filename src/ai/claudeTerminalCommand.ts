/**
 * Pure command builder for launching interactive Claude in a VS Code terminal.
 * The prompt is baked into the shell's startup args so it never enters shell history.
 */

export const TRUNCATION_MARKER = ' …';

const POSIX_ARGV_BUDGET = 200_000;
const POWERSHELL_ENCODED_BUDGET = 30_000;
const CMD_LINE_BUDGET = 7_000;

export type ClaudeShellLaunch =
  | { ok: true; shellPath: string; shellArgs: string[] | string }
  | { ok: false; error: string };

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Double-quote for cmd. Returns null when the value can break out of the quotes. */
export function cmdDoubleQuote(value: string): string | null {
  if (/[\u0000-\u001f%!&|<>^"]/.test(value)) return null;
  return `"${value}"`;
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
    const prompt = shrinkToFit(input.prompt, (candidate) => {
      const script = `& ${psSingleQuote(claudePath)} ${psSingleQuote(candidate)}`;
      return encodePowerShellCommand(script).length <= POWERSHELL_ENCODED_BUDGET;
    });
    if (!prompt) return { ok: false, error: UNSUPPORTED_SHELL };
    const encoded = encodePowerShellCommand(`& ${psSingleQuote(claudePath)} ${psSingleQuote(prompt)}`);
    return { ok: true, shellPath, shellArgs: ['-NoExit', '-EncodedCommand', encoded] };
  }

  if (windows && name === 'cmd') {
    // Newlines and cmd metacharacters cannot be quoted safely. Truncating would drop them
    // and launch a different prompt, so refuse instead.
    if (!cmdDoubleQuote(claudePath) || !cmdDoubleQuote(input.prompt)) {
      return { ok: false, error: UNSUPPORTED_SHELL };
    }
    const prompt = shrinkToFit(input.prompt, (candidate) => {
      const exe = cmdDoubleQuote(claudePath);
      const arg = cmdDoubleQuote(candidate);
      if (!exe || !arg) return false;
      return `/K ${exe} ${arg}`.length <= CMD_LINE_BUDGET;
    });
    if (!prompt) return { ok: false, error: UNSUPPORTED_SHELL };
    const exe = cmdDoubleQuote(claudePath);
    const arg = cmdDoubleQuote(prompt);
    if (!exe || !arg) return { ok: false, error: UNSUPPORTED_SHELL };
    return { ok: true, shellPath, shellArgs: `/K ${exe} ${arg}` };
  }

  if (windows && name !== 'bash' && name !== 'zsh' && name !== 'sh') {
    return { ok: false, error: UNSUPPORTED_SHELL };
  }
  if (name === 'fish' || name === 'nu' || name === 'nushell') {
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
