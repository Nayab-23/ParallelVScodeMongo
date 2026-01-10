import * as vscode from 'vscode';

export type LogLevel = 'info' | 'debug';

export class Logger {
  private level: LogLevel;

  constructor(
    private channel: vscode.OutputChannel,
    level: LogLevel = 'info'
  ) {
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  info(message: string): void {
    this.channel.appendLine(`[info] ${message}`);
  }

  debug(message: string): void {
    if (this.level === 'debug') {
      this.channel.appendLine(`[debug] ${message}`);
    }
  }

  error(message: string, error?: unknown): void {
    const suffix = error instanceof Error ? ` ${error.message}` : error ? ` ${String(error)}` : '';
    this.channel.appendLine(`[error] ${message}${suffix}`);
  }

  audit(message: string): void {
    this.channel.appendLine(`[audit] ${message}`);
  }
}
