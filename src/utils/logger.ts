// Logger utility with configurable log levels
// Respects harness.logLevel setting from VS Code configuration

import * as vscode from 'vscode';

export enum LogLevel {
  OFF = 0,
  ERROR = 1,
  WARN = 2,
  INFO = 3,
  DEBUG = 4,
}

const LOG_LEVEL_MAP: Record<string, LogLevel> = {
  off: LogLevel.OFF,
  error: LogLevel.ERROR,
  warn: LogLevel.WARN,
  info: LogLevel.INFO,
  debug: LogLevel.DEBUG,
};

class Logger {
  private outputChannel: vscode.OutputChannel | null = null;

  /**
   * Initialize logger with VS Code OutputChannel
   * Call this during extension activation
   */
  initialize(outputChannel: vscode.OutputChannel): void {
    this.outputChannel = outputChannel;
  }

  private getCurrentLevel(): LogLevel {
    const config = vscode.workspace.getConfiguration('harness');
    const levelStr = config.get<string>('logLevel', 'info');
    return LOG_LEVEL_MAP[levelStr] ?? LogLevel.INFO;
  }

  private formatMessage(prefix: string, ...args: any[]): string {
    const timestamp = new Date().toISOString().substring(11, 23); // HH:MM:SS.mmm
    const message = args.map(arg => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return `${arg.message}\n${arg.stack}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    }).join(' ');
    return `[${timestamp}] [${prefix}] ${message}`;
  }

  private log(level: string, prefix: string, ...args: any[]): void {
    const message = this.formatMessage(prefix, ...args);

    // Write to OutputChannel if available
    if (this.outputChannel) {
      this.outputChannel.appendLine(message);
    } else {
      // Fallback to console if not initialized (during early startup)
      console.log(message);
    }
  }

  /**
   * Log an error message (always shown unless logLevel is 'off')
   */
  error(prefix: string, ...args: any[]): void {
    if (this.getCurrentLevel() >= LogLevel.ERROR) {
      this.log('ERROR', prefix, ...args);
    }
  }

  /**
   * Log a warning message (shown when logLevel is 'warn', 'info', or 'debug')
   */
  warn(prefix: string, ...args: any[]): void {
    if (this.getCurrentLevel() >= LogLevel.WARN) {
      this.log('WARN', prefix, ...args);
    }
  }

  /**
   * Log an info message (shown when logLevel is 'info' or 'debug')
   */
  info(prefix: string, ...args: any[]): void {
    if (this.getCurrentLevel() >= LogLevel.INFO) {
      this.log('INFO', prefix, ...args);
    }
  }

  /**
   * Log a debug message (only shown when logLevel is 'debug')
   */
  debug(prefix: string, ...args: any[]): void {
    if (this.getCurrentLevel() >= LogLevel.DEBUG) {
      this.log('DEBUG', prefix, ...args);
    }
  }

  /**
   * Log a message at any level (bypass filtering - use sparingly)
   */
  always(prefix: string, ...args: any[]): void {
    this.log('ALWAYS', prefix, ...args);
  }
}

// Singleton logger instance
export const logger = new Logger();
