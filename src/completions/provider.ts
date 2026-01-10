import * as vscode from 'vscode';

import { ParallelClient } from '../api/client';
import { Store } from '../store/store';
import { Logger } from '../util/logger';

interface CompletionResponse {
  completion?: string;
  completions?: string[];
  text?: string;
}

type CompletionConfig = {
  enabled: boolean;
  endpoint: string;
  maxSuggestions: number;
  minPrefixChars: number;
  maxPrefixChars: number;
  maxSuffixChars: number;
  debounceMs: number;
  stream: boolean;
  progressiveThrottleMs: number;
};

type CacheEntry = { expiresAt: number; items: string[] };
type CompletionSession = {
  key: string;
  uri: string;
  positionKey: string;
  version: number;
  text: string;
  items: string[];
  startedAt: number;
  done: boolean;
  error?: string;
  abort?: AbortController;
};

export class ParallelCompletionProvider implements vscode.InlineCompletionItemProvider {
  private warnedMissingEndpoint = false;
  private lastRequestAt = 0;
  private cache = new Map<string, CacheEntry>();
  private sessions = new Map<string, CompletionSession>();
  private refreshTimers = new Map<string, NodeJS.Timeout>();
  private lastSuggestions:
    | { uri: string; positionKey: string; items: string[]; updatedAt: number }
    | null = null;

  constructor(
    private store: Store,
    private client: ParallelClient,
    private logger: Logger,
    private getConfig: () => CompletionConfig,
    private workspaceProvider: () => string | null
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context?: vscode.InlineCompletionContext,
    token?: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | null> {
    const config = this.getConfig();
    if (!config.enabled) {
      return null;
    }
    const workspaceId = this.workspaceProvider();
    if (!config.endpoint && !workspaceId) {
      if (!this.warnedMissingEndpoint) {
        this.warnedMissingEndpoint = true;
        void vscode.window.showWarningMessage(
          'Parallel inline completion is enabled but no endpoint is configured.'
        );
        this.logger.info('Inline completion skipped: endpoint not configured');
      }
      return null;
    }
    try {
      this.pruneSessions(document);
      const fullText = document.getText();
      const offset = document.offsetAt(position);
      const prefix = fullText.slice(Math.max(0, offset - config.maxPrefixChars), offset);
      if (prefix.trim().length < config.minPrefixChars) {
        return null;
      }
      const suffix = fullText.slice(offset, Math.min(fullText.length, offset + config.maxSuffixChars));
      const context = await this.buildContext();
      const relativePath = this.toRelativePath(document.uri);
      const body = {
        filePath: relativePath ?? document.uri.toString(),
        languageId: document.languageId,
        cursor: { line: position.line, character: position.character },
        prefix,
        suffix,
        maxCompletions: Math.max(1, Math.min(config.maxSuggestions, 5)),
        context,
      };
      const cacheKey = this.cacheKey(body);
      const sessionKey = this.sessionKey(document, position, cacheKey);
      const positionKey = this.positionKey(position);
      const cached = this.readCache(cacheKey);
      if (cached) {
        this.rememberSuggestions(document, positionKey, cached);
        return this.asInlineItems(cached, position);
      }
      const existing = this.sessions.get(sessionKey);
      if (existing && existing.version === document.version) {
        const items = existing.items.length ? existing.items : existing.text ? [existing.text] : [];
        if (items.length) {
          this.rememberSuggestions(document, existing.positionKey, items);
          return this.asInlineItems(items, position);
        }
        if (!existing.done) {
          return null;
        }
      }
      if (Date.now() - this.lastRequestAt < config.debounceMs) {
        return null;
      }
      this.lastRequestAt = Date.now();
      const endpoint = config.endpoint || this.buildDefaultEndpoint(workspaceId, config.stream);
      if (!endpoint) {
        return null;
      }
      if (config.stream) {
        void this.startStreaming(sessionKey, document, position, endpoint, body, config, token);
        return null;
      }
      const response = await this.client.request<CompletionResponse>(endpoint, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const items = this.normalizeCompletions(response);
      if (!items.length) {
        return null;
      }
      this.writeCache(cacheKey, items);
      this.rememberSuggestions(document, positionKey, items);
      return this.asInlineItems(items, position);
    } catch (err) {
      this.logger.error('Completion request failed', err as unknown);
      return null;
    }
  }

  getLastSuggestions(editor: vscode.TextEditor | undefined): string[] {
    if (!editor || !this.lastSuggestions) {
      return [];
    }
    const uri = editor.document.uri.toString();
    if (this.lastSuggestions.uri !== uri) {
      return [];
    }
    const currentKey = this.positionKey(editor.selection.active);
    if (this.lastSuggestions.positionKey !== currentKey) {
      return [];
    }
    return this.lastSuggestions.items;
  }

  private normalizeCompletions(response: CompletionResponse): string[] {
    const items = response.completions ?? [];
    if (response.completion) {
      items.unshift(response.completion);
    } else if (response.text) {
      items.unshift(response.text);
    }
    return items
      .map((text) => (text ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, ''))
      .filter((text) => text.length > 0)
      .filter((text, idx, arr) => arr.indexOf(text) === idx)
      .slice(0, 5);
  }

  private asInlineItems(items: string[], position: vscode.Position): vscode.InlineCompletionItem[] {
    return items.map((text) => new vscode.InlineCompletionItem(text, new vscode.Range(position, position)));
  }

  private cacheKey(body: Record<string, unknown>): string {
    const raw = JSON.stringify(body).slice(0, 2000);
    const filePath = typeof (body as { filePath?: string }).filePath === 'string'
      ? (body as { filePath?: string }).filePath
      : 'unknown';
    return `${filePath}:${raw.length}:${raw}`;
  }

  private readCache(key: string): string[] | null {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return entry.items;
  }

  private writeCache(key: string, items: string[]): void {
    if (!items.length) {
      return;
    }
    this.cache.set(key, { expiresAt: Date.now() + 20_000, items });
  }

  private rememberSuggestions(
    document: vscode.TextDocument,
    positionKey: string,
    items: string[]
  ): void {
    this.lastSuggestions = {
      uri: document.uri.toString(),
      positionKey,
      items,
      updatedAt: Date.now(),
    };
  }

  private sessionKey(
    document: vscode.TextDocument,
    position: vscode.Position,
    cacheKey: string
  ): string {
    return `${document.uri.toString()}::${position.line}:${position.character}::${cacheKey}`;
  }

  private positionKey(position: vscode.Position): string {
    return `${position.line}:${position.character}`;
  }

  private pruneSessions(document: vscode.TextDocument): void {
    const uri = document.uri.toString();
    const now = Date.now();
    for (const [key, session] of this.sessions.entries()) {
      if (session.uri !== uri) {
        continue;
      }
      if (session.version !== document.version || now - session.startedAt > 30_000) {
        session.abort?.abort();
        this.sessions.delete(key);
      }
    }
  }

  private async startStreaming(
    sessionKey: string,
    document: vscode.TextDocument,
    position: vscode.Position,
    endpoint: string,
    body: Record<string, unknown>,
    config: CompletionConfig,
    token?: vscode.CancellationToken
  ): Promise<void> {
    if (this.sessions.has(sessionKey)) {
      return;
    }
    const abort = new AbortController();
    const session: CompletionSession = {
      key: sessionKey,
      uri: document.uri.toString(),
      positionKey: this.positionKey(position),
      version: document.version,
      text: '',
      items: [],
      startedAt: Date.now(),
      done: false,
      abort,
    };
    this.sessions.set(sessionKey, session);
    if (token) {
      token.onCancellationRequested(() => abort.abort());
    }
    let response: Response;
    try {
      response = await this.client.requestStream(endpoint, {
        method: 'POST',
        body: JSON.stringify(body),
        signal: abort.signal,
      });
    } catch (err) {
      this.sessions.delete(sessionKey);
      this.logger.error('Streaming completion request failed', err as unknown);
      return;
    }
    if (!response.body) {
      this.sessions.delete(sessionKey);
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        buffer += decoder.decode(result.value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const dataLine = part
            .split('\n')
            .find((line) => line.startsWith('data:'));
          if (!dataLine) {
            continue;
          }
          const json = dataLine.replace(/^data:\s*/, '');
          let payload:
            | { type?: string; text?: string; completion?: string; completions?: string[]; message?: string }
            | null =
            null;
          try {
            payload = JSON.parse(json);
          } catch {
            payload = null;
          }
          if (!payload) {
            continue;
          }
          if (payload.type === 'delta' && payload.text) {
            session.text += payload.text;
            this.scheduleRefresh(session, config.progressiveThrottleMs);
          }
          if (payload.type === 'final') {
            const items = payload.completions ?? (payload.completion ? [payload.completion] : []);
            if (items.length) {
              session.items = items;
              this.writeCache(this.cacheKey(body), items);
              this.rememberSuggestions(document, session.positionKey, items);
            }
            session.done = true;
            this.scheduleRefresh(session, 0);
          }
          if (payload.type === 'error') {
            session.error = payload.message ?? 'Streaming completion failed';
            session.done = true;
          }
        }
      }
    } catch (err) {
      session.error = err instanceof Error ? err.message : String(err);
      session.done = true;
    } finally {
      setTimeout(() => this.sessions.delete(sessionKey), 10_000);
    }
  }

  private scheduleRefresh(session: CompletionSession, delayMs: number): void {
    const key = session.uri;
    if (this.refreshTimers.has(key)) {
      return;
    }
    const delay = Math.max(0, delayMs);
    const handle = setTimeout(async () => {
      this.refreshTimers.delete(key);
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      if (editor.document.uri.toString() !== session.uri) {
        return;
      }
      if (editor.document.version !== session.version) {
        return;
      }
      await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    }, delay);
    this.refreshTimers.set(key, handle);
  }

  private buildDefaultEndpoint(workspaceId: string | null, stream: boolean): string | null {
    if (!workspaceId) {
      return null;
    }
    return `/api/v1/workspaces/${workspaceId}/vscode/agent/${stream ? 'complete-stream' : 'complete'}`;
  }

  private toRelativePath(uri: vscode.Uri): string | null {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return null;
    }
    return vscode.workspace.asRelativePath(uri);
  }

  private async buildContext(): Promise<{ messages: unknown[]; tasks: unknown[] }> {
    const messages: unknown[] = [];
    const tasks: unknown[] = [];
    for (const type of ['message', 'messages']) {
      const list = await this.store.getRecent(type, 5).catch(() => []);
      messages.push(...list.map((m) => m.payload));
    }
    for (const type of ['task', 'tasks']) {
      const list = await this.store.getRecent(type, 5).catch(() => []);
      tasks.push(...list.map((t) => t.payload));
    }
    return { messages, tasks };
  }
}
