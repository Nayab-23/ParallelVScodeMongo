import * as vscode from 'vscode';

import { ParallelClient } from '../api/client';
import { Logger } from '../util/logger';

type TerminalBuffer = {
  chunks: string[];
  size: number;
  flushTimer?: NodeJS.Timeout;
  cwd?: string;
};

const FLUSH_DELAY_MS = 1200;
const MAX_BUFFER_CHARS = 8000;
const MAX_SEND_CHARS = 4000;

export class TerminalMonitor {
  private buffers = new Map<string, TerminalBuffer>();

  constructor(
    private clientProvider: () => ParallelClient | null,
    private workspaceIdProvider: () => string | null,
    private signedInProvider: () => boolean,
    private logger: Logger
  ) {}

  activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.window.onDidOpenTerminal((terminal) => {
        const key = terminal.name;
        const buffer = this.ensureBuffer(key);
        const cwd = this.extractCwd(terminal);
        if (cwd) {
          buffer.cwd = cwd;
        }
      }),
      vscode.window.onDidCloseTerminal((terminal) => {
        const key = terminal.name;
        const exitCode = terminal.exitStatus?.code ?? -1;
        void this.flush(key, exitCode);
        this.buffers.delete(key);
      }),
      vscode.window.onDidWriteTerminalData((event) => {
        if (!vscode.workspace.getConfiguration().get<boolean>('parallel.terminal.capture')) {
          return;
        }
        const key = event.terminal.name;
        const buffer = this.ensureBuffer(key);
        buffer.chunks.push(event.data);
        buffer.size += event.data.length;
        if (buffer.size >= MAX_BUFFER_CHARS) {
          void this.flush(key);
          return;
        }
        this.scheduleFlush(key);
      }),
      {
        dispose: () => {
          for (const buffer of this.buffers.values()) {
            if (buffer.flushTimer) {
              clearTimeout(buffer.flushTimer);
            }
          }
          this.buffers.clear();
        },
      }
    );
  }

  private ensureBuffer(key: string): TerminalBuffer {
    let buffer = this.buffers.get(key);
    if (!buffer) {
      buffer = { chunks: [], size: 0 };
      this.buffers.set(key, buffer);
    }
    return buffer;
  }

  private scheduleFlush(key: string): void {
    const buffer = this.buffers.get(key);
    if (!buffer) {
      return;
    }
    if (buffer.flushTimer) {
      return;
    }
    buffer.flushTimer = setTimeout(() => {
      buffer.flushTimer = undefined;
      void this.flush(key);
    }, FLUSH_DELAY_MS);
  }

  private async flush(key: string, exitCode: number = -1): Promise<void> {
    const buffer = this.buffers.get(key);
    if (!buffer || !buffer.chunks.length) {
      return;
    }
    if (buffer.flushTimer) {
      clearTimeout(buffer.flushTimer);
      buffer.flushTimer = undefined;
    }
    const payload = buffer.chunks.join('');
    buffer.chunks = [];
    buffer.size = 0;
    const output = this.trimOutput(payload);
    await this.sendOutput(key, output, exitCode, buffer.cwd);
  }

  private trimOutput(payload: string): string {
    if (payload.length <= MAX_SEND_CHARS) {
      return payload;
    }
    return payload.slice(-MAX_SEND_CHARS);
  }

  private async sendOutput(
    terminalName: string,
    output: string,
    exitCode: number,
    cwd?: string
  ): Promise<void> {
    if (!output.trim()) {
      return;
    }
    if (!this.signedInProvider()) {
      return;
    }
    const client = this.clientProvider();
    const workspaceId = this.workspaceIdProvider();
    if (!client || !workspaceId) {
      return;
    }
    try {
      await client.request(`/api/v1/workspaces/${workspaceId}/vscode/terminal/output`, {
        method: 'POST',
        body: JSON.stringify({
          command: `[terminal:${terminalName}]`,
          output,
          exit_code: exitCode,
          cwd,
        }),
        redactBody: true,
      });
    } catch (err) {
      this.logger.debug(`Terminal output upload failed: ${String(err)}`);
    }
  }

  private extractCwd(terminal: vscode.Terminal): string | undefined {
    const options = terminal.creationOptions as
      | vscode.TerminalOptions
      | vscode.ExtensionTerminalOptions
      | { cwd?: string | vscode.Uri }
      | undefined;
    if (!options || typeof options === 'string') {
      return undefined;
    }
    const cwd = (options as { cwd?: string | vscode.Uri }).cwd;
    if (typeof cwd === 'string') {
      return cwd;
    }
    if (cwd && 'fsPath' in cwd) {
      return cwd.fsPath;
    }
    return undefined;
  }
}
