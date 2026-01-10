import * as vscode from 'vscode';

import { AgentCommand } from '../agent/commandHistory';
import { AgentProposal, AgentService } from '../agent/agentService';
import { ProposedFileEdit, ApplyResult } from '../edits/pipeline';

type ApplyHandler = (
  edits: ProposedFileEdit[],
  options: { dryRun: boolean; proposalDryRun: boolean }
) => Promise<ApplyResult>;

type CommandRunResult = {
  command: string;
  cwd?: string;
  status: 'ok' | 'failed' | 'skipped';
  exitCode?: number;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  message?: string;
};

type CommandRunHandler = (commands: AgentCommand[]) => Promise<CommandRunResult[]>;

export class AgentPanel {
  private panel: vscode.WebviewPanel | null = null;
  private lastProposal: AgentProposal | null = null;

  constructor(
    private extensionUri: vscode.Uri,
    private agentService: AgentService,
    private applyHandler: ApplyHandler,
    private commandRunner: CommandRunHandler,
    private permissionProvider: () => boolean
  ) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.postPermission();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'parallelAgent',
      'Parallel Agent',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.webview.html = this.buildHtml(this.panel.webview);
    this.panel.onDidDispose(() => (this.panel = null));
    this.panel.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    });
  }

  updatePermissionState(): void {
    this.postPermission();
  }

  async submitPrompt(text: string, mode: 'dry-run' | 'apply' = 'dry-run'): Promise<void> {
    this.show();
    await this.handlePrompt(text, mode);
  }

  private async handleMessage(message: any): Promise<void> {
    switch (message?.type) {
      case 'requestPermission':
        this.postPermission();
        break;
      case 'userPrompt':
        await this.handlePrompt(message.text, message.mode === 'apply' ? 'apply' : 'dry-run');
        break;
      case 'applyEdits':
        await this.handleApply(message.selected as string[]);
        break;
      case 'togglePermission':
        await vscode.commands.executeCommand('parallel.toggleFullPermission');
        this.postPermission();
        break;
      case 'runCommands':
        await this.handleRunCommands(message.selected as number[]);
        break;
      default:
        break;
    }
  }

  private async handlePrompt(text: string, mode: 'dry-run' | 'apply'): Promise<void> {
    if (!text || !text.trim()) {
      return;
    }
    if (mode === 'apply' && !this.permissionProvider()) {
      await vscode.commands.executeCommand('parallel.toggleFullPermission');
      this.postPermission();
      if (!this.permissionProvider()) {
        this.panel?.webview.postMessage({
          type: 'error',
          message: 'Full Permission is off. Enable it before requesting apply-ready edits.',
        });
        return;
      }
    }
    this.panel?.webview.postMessage({ type: 'status', status: 'working' });
    try {
      const config = vscode.workspace.getConfiguration();
      const streamEnabled = !!config.get<boolean>('parallel.agent.streamProposals');
      const autoIterate = mode === 'dry-run' && !!config.get<boolean>('parallel.agent.autoIterate');
      const maxIterations = Math.max(1, config.get<number>('parallel.agent.maxIterations') ?? 2);
      const proposeOnce = async (): Promise<AgentProposal> =>
        streamEnabled
          ? this.agentService.proposeStreaming(text.trim(), mode, (event) => {
              if (event.type === 'delta') {
                this.panel?.webview.postMessage({ type: 'status', status: 'streaming' });
                if (event.text) {
                  this.panel?.webview.postMessage({ type: 'streamDelta', text: event.text });
                }
              }
              if (event.type === 'error' && event.message) {
                this.panel?.webview.postMessage({ type: 'status', status: 'error' });
              }
            })
          : this.agentService.propose(text.trim(), mode);

      let proposal = await proposeOnce();
      if (autoIterate) {
        let iteration = 0;
        while (iteration < maxIterations && proposal.commands?.length) {
          this.panel?.webview.postMessage({ type: 'status', status: 'running-commands' });
          const results = await this.commandRunner(proposal.commands);
          this.panel?.webview.postMessage({ type: 'commandResults', results });
          const ranAny = results.some((r) => r.status !== 'skipped');
          if (!ranAny) {
            break;
          }
          iteration += 1;
          this.panel?.webview.postMessage({ type: 'status', status: 'working' });
          proposal = await proposeOnce();
        }
      }
      this.lastProposal = proposal;
      this.panel?.webview.postMessage({
        type: 'proposal',
        plan: proposal.plan,
        edits: proposal.edits.map((e) => ({ filePath: e.filePath, diff: e.diff })),
        commands: proposal.commands,
        context: {
          tasks: proposal.context.tasks.length,
          conversations: proposal.context.conversations.length,
        },
        promptSummary: proposal.promptSummary,
        dryRun: proposal.dryRun,
      });
    } catch (err) {
      this.panel?.webview.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.panel?.webview.postMessage({ type: 'status', status: 'idle' });
    }
  }

  private async handleApply(selected: string[]): Promise<void> {
    if (!this.lastProposal) {
      this.panel?.webview.postMessage({ type: 'error', message: 'No proposal to apply yet.' });
      return;
    }
    if (this.lastProposal.dryRun) {
      this.panel?.webview.postMessage({
        type: 'error',
        message: 'Dry run mode is enabled. Switch to apply mode and rerun.',
      });
      return;
    }
    if (!this.permissionProvider()) {
      await vscode.commands.executeCommand('parallel.toggleFullPermission');
      this.postPermission();
      if (!this.permissionProvider()) {
        this.panel?.webview.postMessage({
          type: 'error',
          message: 'Full Permission is off. Enable it before applying edits.',
        });
        return;
      }
    }
    const edits = this.lastProposal.edits.filter((e) => selected.includes(e.filePath));
    if (!edits.length) {
      this.panel?.webview.postMessage({ type: 'error', message: 'No files selected.' });
      return;
    }
    const result = await this.applyHandler(edits, {
      dryRun: false,
      proposalDryRun: this.lastProposal?.dryRun ?? true,
    });
    this.panel?.webview.postMessage({
      type: 'applyResult',
      applied: result.applied,
      skipped: result.skipped,
    });
  }

  private async handleRunCommands(selected: number[]): Promise<void> {
    if (!this.lastProposal) {
      this.panel?.webview.postMessage({ type: 'error', message: 'No proposal yet.' });
      return;
    }
    const commands = this.lastProposal.commands ?? [];
    if (!commands.length) {
      this.panel?.webview.postMessage({ type: 'error', message: 'No commands to run.' });
      return;
    }
    const chosen =
      selected && selected.length
        ? selected.map((index) => commands[index]).filter(Boolean)
        : commands;
    if (!chosen.length) {
      this.panel?.webview.postMessage({ type: 'error', message: 'No commands selected.' });
      return;
    }
    this.panel?.webview.postMessage({ type: 'status', status: 'running-commands' });
    try {
      const results = await this.commandRunner(chosen);
      this.panel?.webview.postMessage({ type: 'commandResults', results });
    } catch (err) {
      this.panel?.webview.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.panel?.webview.postMessage({ type: 'status', status: 'idle' });
    }
  }

  private postPermission(): void {
    this.panel?.webview.postMessage({
      type: 'permission',
      fullPermission: this.permissionProvider(),
    });
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = `${Date.now()}`;
    const cspSource = webview.cspSource;
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
        <style>
          body { font-family: sans-serif; padding: 12px; display: grid; gap: 12px; grid-template-columns: 2fr 1fr; }
          h2 { margin: 0 0 8px; }
          .panel { border: 1px solid #ddd; border-radius: 6px; padding: 12px; background: #fafafa; }
          .row { display: flex; gap: 8px; align-items: center; }
          textarea { width: 100%; min-height: 80px; }
          button { padding: 6px 10px; }
          .diff { font-family: monospace; white-space: pre-wrap; background: #111; color: #f5f5f5; padding: 8px; border-radius: 4px; }
          .stream { font-family: monospace; white-space: pre-wrap; background: #0b0b0b; color: #d6ffd6; padding: 8px; border-radius: 4px; border: 1px solid #1c3b1c; }
          .file-item { margin-bottom: 8px; }
          .context-pill { display: inline-block; background: #eef0ff; padding: 4px 8px; border-radius: 999px; margin-right: 6px; }
          .status { color: #666; }
        </style>
      </head>
      <body>
        <section class="panel">
          <h2>Parallel Agent</h2>
          <div class="status" id="status">Ready (dry-run by default)</div>
          <div id="stream-preview" class="stream" style="display:none;"></div>
          <div class="row">
            <textarea id="prompt" placeholder="Describe what you want the agent to do"></textarea>
          </div>
          <div class="row">
            <label><input type="radio" name="mode" value="dry-run" checked> Read-only suggestions</label>
            <label><input type="radio" name="mode" value="apply"> Apply-capable (requires Full Permission + Apply)</label>
            <button id="send">Ask</button>
          </div>
          <div id="plan"></div>
          <div id="files"></div>
          <div id="commands"></div>
          <button id="apply">Apply selected</button>
          <button id="run">Run selected commands</button>
          <div id="command-results"></div>
        </section>
        <section class="panel">
          <h2>Context</h2>
          <div id="context-summary">No context yet</div>
          <div id="permission">Full Permission: off</div>
          <button id="toggle-permission">Enable Full Permission</button>
        </section>
        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          const promptEl = document.getElementById('prompt');
          const planEl = document.getElementById('plan');
          const filesEl = document.getElementById('files');
          const statusEl = document.getElementById('status');
          const applyBtn = document.getElementById('apply');
          const commandsEl = document.getElementById('commands');
          const runBtn = document.getElementById('run');
          const commandResultsEl = document.getElementById('command-results');
          const permissionEl = document.getElementById('permission');
          const permissionBtn = document.getElementById('toggle-permission');
          const contextSummaryEl = document.getElementById('context-summary');
          const streamEl = document.getElementById('stream-preview');
          runBtn.disabled = true;

          document.getElementById('send').addEventListener('click', () => {
            const mode = document.querySelector('input[name="mode"]:checked').value;
            vscode.postMessage({ type: 'userPrompt', text: promptEl.value, mode });
          });

          applyBtn.addEventListener('click', () => {
            const selected = Array.from(document.querySelectorAll('input[name="file-select"]:checked')).map((i) => i.value);
            vscode.postMessage({ type: 'applyEdits', selected });
          });

          permissionBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'togglePermission' });
          });

          runBtn.addEventListener('click', () => {
            const selected = Array.from(document.querySelectorAll('input[name="command-select"]:checked')).map((i) => Number(i.value));
            vscode.postMessage({ type: 'runCommands', selected });
          });

          vscode.postMessage({ type: 'requestPermission' });

          window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.type === 'status') {
              if (msg.status === 'working') {
                statusEl.textContent = 'Thinking…';
                streamEl.textContent = '';
                streamEl.style.display = 'none';
              } else if (msg.status === 'streaming') {
                statusEl.textContent = 'Streaming…';
                streamEl.style.display = 'block';
              } else if (msg.status === 'error') {
                statusEl.textContent = 'Error while streaming.';
              } else if (msg.status === 'running-commands') {
                statusEl.textContent = 'Running commands…';
                streamEl.textContent = '';
                streamEl.style.display = 'none';
              } else {
                statusEl.textContent = 'Ready';
                streamEl.textContent = '';
                streamEl.style.display = 'none';
              }
            }
            if (msg.type === 'proposal') {
              streamEl.textContent = '';
              streamEl.style.display = 'none';
              renderPlan(msg.plan || []);
              renderFiles(msg.edits || []);
              renderCommands(msg.commands || []);
              renderContextSummary(msg);
              applyBtn.disabled = msg.dryRun;
              if (msg.dryRun) {
                statusEl.textContent = 'Read-only mode (dry run).';
              }
            }
            if (msg.type === 'streamDelta') {
              streamEl.textContent += msg.text || '';
              streamEl.style.display = 'block';
            }
            if (msg.type === 'error') {
              statusEl.textContent = msg.message;
            }
            if (msg.type === 'applyResult') {
              statusEl.textContent = 'Applied: ' + msg.applied.join(', ') + (msg.skipped.length ? '; skipped: ' + msg.skipped.join(', ') : '');
            }
            if (msg.type === 'commandResults') {
              renderCommandResults(msg.results || []);
            }
            if (msg.type === 'permission') {
              permissionEl.textContent = 'Full Permission: ' + (msg.fullPermission ? 'on' : 'off');
              permissionBtn.textContent = msg.fullPermission ? 'Disable Full Permission' : 'Enable Full Permission';
            }
          });

          function renderPlan(plan) {
            planEl.innerHTML = '';
            const heading = document.createElement('strong');
            heading.textContent = 'Plan';
            planEl.appendChild(heading);
            const list = document.createElement('ul');
            plan.forEach((p) => {
              const li = document.createElement('li');
              li.textContent = p;
              list.appendChild(li);
            });
            planEl.appendChild(list);
          }

          function renderFiles(edits) {
            filesEl.innerHTML = '';
            if (!edits.length) {
              filesEl.textContent = 'No edits proposed';
              return;
            }
            edits.forEach((edit) => {
              const wrapper = document.createElement('div');
              wrapper.className = 'file-item';
              const label = document.createElement('label');
              const checkbox = document.createElement('input');
              checkbox.type = 'checkbox';
              checkbox.name = 'file-select';
              checkbox.value = edit.filePath;
              checkbox.checked = true;
              label.appendChild(checkbox);
              const textNode = document.createTextNode(' ' + edit.filePath);
              label.appendChild(textNode);
              wrapper.appendChild(label);
              const diff = document.createElement('div');
              diff.className = 'diff';
              diff.textContent = edit.diff || '';
              wrapper.appendChild(diff);
              filesEl.appendChild(wrapper);
            });
          }

          function renderCommands(commands) {
            commandsEl.innerHTML = '';
            commandResultsEl.textContent = '';
            if (!commands.length) {
              commandsEl.textContent = 'No commands proposed';
              runBtn.disabled = true;
              return;
            }
            runBtn.disabled = false;
            const heading = document.createElement('strong');
            heading.textContent = 'Commands';
            commandsEl.appendChild(heading);
            commands.forEach((cmd, index) => {
              const wrapper = document.createElement('div');
              wrapper.className = 'file-item';
              const label = document.createElement('label');
              const checkbox = document.createElement('input');
              checkbox.type = 'checkbox';
              checkbox.name = 'command-select';
              checkbox.value = String(index);
              checkbox.checked = true;
              label.appendChild(checkbox);
              const detail = cmd.cwd ? cmd.command + ' (' + cmd.cwd + ')' : cmd.command;
              label.appendChild(document.createTextNode(' ' + detail));
              wrapper.appendChild(label);
              if (cmd.purpose) {
                const purpose = document.createElement('div');
                purpose.textContent = 'Purpose: ' + cmd.purpose;
                wrapper.appendChild(purpose);
              }
              commandsEl.appendChild(wrapper);
            });
          }

          function renderCommandResults(results) {
            commandResultsEl.innerHTML = '';
            if (!results.length) {
              return;
            }
            const heading = document.createElement('strong');
            heading.textContent = 'Command Results';
            commandResultsEl.appendChild(heading);
            results.forEach((result) => {
              const wrapper = document.createElement('div');
              wrapper.className = 'file-item';
              const title = document.createElement('div');
              const status = result.status ? result.status.toUpperCase() : 'DONE';
              title.textContent = status + ': ' + result.command;
              wrapper.appendChild(title);
              if (result.message) {
                const msg = document.createElement('div');
                msg.textContent = result.message;
                wrapper.appendChild(msg);
              }
              if (result.stdout) {
                const out = document.createElement('pre');
                out.className = 'diff';
                out.textContent = result.stdout;
                wrapper.appendChild(out);
              }
              if (result.stderr) {
                const err = document.createElement('pre');
                err.className = 'diff';
                err.textContent = result.stderr;
                wrapper.appendChild(err);
              }
              commandResultsEl.appendChild(wrapper);
            });
          }

          function renderContextSummary(msg) {
            const tasks = msg.promptSummary?.tasks || [];
            const conversations = msg.promptSummary?.conversations || [];
            const lines = [
              'Tasks (' + msg.context.tasks + '):',
              tasks.length ? tasks.map((t) => '- ' + (t.title || t.id || '')).join('\\n') : '(none)',
              '',
              'Assistant chats (' + msg.context.conversations + '):',
              conversations.length ? conversations.map((c) => '- ' + (c.title || c.id || '')).join('\\n') : '(none)',
            ];
            contextSummaryEl.textContent = lines.join('\\n');
          }
        </script>
      </body>
      </html>
    `;
  }
}
