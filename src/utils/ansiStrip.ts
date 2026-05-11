/**
 * Strip ANSI color codes and control sequences from log lines
 * Handles common escape sequences: colors, cursor movement, text formatting
 */

/**
 * Remove all ANSI escape sequences and control characters from a string
 */
export function stripAnsi(text: string): string {
  let clean = text;

  // Remove standard ANSI escape sequences (ESC[...m, ESC[...H, etc.)
  clean = clean.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

  // Remove OSC sequences (ESC]...BEL or ESC]...ST)
  clean = clean.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');

  // Remove character set sequences (ESC(B, ESC)0, etc.)
  clean = clean.replace(/\x1b[()][AB012]/g, '');

  // Remove malformed UTF-8 ANSI sequences (�[32m, �[0m)
  clean = clean.replace(/�\[[0-9;]*[a-zA-Z]/g, '');

  // Remove other control characters except newline (\n), tab (\t), and carriage return (\r)
  // This handles raw control codes that appear as garbage
  clean = clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  return clean;
}

/**
 * Strip ANSI codes from an array of log lines
 */
export function stripAnsiFromLines(lines: string[]): string[] {
  return lines.map(line => stripAnsi(line));
}
