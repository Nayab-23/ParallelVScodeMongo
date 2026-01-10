import { ParallelClient, HttpError } from '../api/client';
import { Logger } from '../util/logger';

export interface TaskSummary {
  id: string;
  title?: string;
  status?: string;
}

export interface ConversationSummary {
  id: string;
  title?: string;
  summary?: string;
  lastMessages?: { role: string; content: string }[];
}

export interface ParallelContextPayload {
  workspaceId: string | null;
  tasks: TaskSummary[];
  conversations: ConversationSummary[];
  fetchedAt: number;
  userId?: string;
  apiBaseUrl?: string;
}

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: any): Thenable<void>;
}

const CACHE_KEY = 'parallel.context.cache';
const DEFAULT_TASKS_LIMIT = 20;
const DEFAULT_CONVERSATIONS_LIMIT = 5;
const DEFAULT_INCLUDE_MESSAGES = false;

interface ContextBundleResponse {
  tasks?: TaskSummary[];
  conversations?: ConversationSummary[];
}

export class ContextService {
  private readonly ttlMs: number;
  private readonly fetchOverride?: (workspaceId: string) => Promise<ParallelContextPayload>;
  private readonly apiBaseProvider: () => string | undefined;
  private readonly userProvider?: () => string | undefined;
  private readonly authFingerprintProvider?: () => string | undefined;
  private readonly anonSalt: string;

  constructor(
    private storage: MementoLike,
    private client: ParallelClient,
    private logger: Logger,
    private workspaceProvider: () => string | null,
    options?: {
      ttlMs?: number;
      fetcher?: (workspaceId: string) => Promise<ParallelContextPayload>;
      apiBaseProvider?: () => string | undefined;
      userIdProvider?: () => string | undefined;
      authFingerprintProvider?: () => string | undefined;
    }
  ) {
    this.ttlMs = options?.ttlMs ?? 5 * 60 * 1000;
    this.fetchOverride = options?.fetcher;
    this.apiBaseProvider = options?.apiBaseProvider ?? (() => this.client.getApiBaseUrl());
    this.userProvider = options?.userIdProvider;
    this.authFingerprintProvider = options?.authFingerprintProvider;
    this.anonSalt = Math.random().toString(16).slice(2);
  }

  async getContext(forceRefresh = false): Promise<ParallelContextPayload> {
    const workspaceId = this.workspaceProvider();
    if (!workspaceId) {
      return { workspaceId: null, tasks: [], conversations: [], fetchedAt: Date.now() };
    }
    if (!forceRefresh) {
      const cached = this.storage.get<ParallelContextPayload>(this.cacheKey(workspaceId));
      if (cached && cached.workspaceId === workspaceId && !this.isExpired(cached.fetchedAt)) {
        return cached;
      }
    }
    const payload = await this.fetchContext(workspaceId);
    await this.storage.update(this.cacheKey(workspaceId), payload);
    this.logger.audit(
      `Context refreshed for ${workspaceId} (tasks=${payload.tasks.length}, chats=${payload.conversations.length})`
    );
    return payload;
  }

  async refresh(): Promise<ParallelContextPayload> {
    return this.getContext(true);
  }

  invalidate(workspaceId?: string): void {
    const target = workspaceId ?? this.workspaceProvider();
    if (!target) {
      return;
    }
    void this.storage.update(this.cacheKey(target), undefined as any);
  }

  private isExpired(timestamp: number): boolean {
    return Date.now() - timestamp > this.ttlMs;
  }

  private async fetchContext(workspaceId: string): Promise<ParallelContextPayload> {
    if (this.fetchOverride) {
      return this.fetchOverride(workspaceId);
    }
    try {
      const response = await this.client.request<unknown>(
        `/api/v1/workspaces/${workspaceId}/vscode/context`,
        {
          query: {
            tasks_limit: DEFAULT_TASKS_LIMIT,
            conversations_limit: DEFAULT_CONVERSATIONS_LIMIT,
            include_messages: DEFAULT_INCLUDE_MESSAGES ? 'true' : 'false',
          },
          redactBody: true,
        }
      );
      const parsed = parseContextResponse(response);
      const tasks = (parsed.tasks ?? []).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
      }));
      const conversations = (parsed.conversations ?? []).map((c) => ({
        id: c.id,
        title: c.title,
        summary: c.summary,
        lastMessages: (c.lastMessages ?? []).slice(-3).map((m) => ({
          role: m.role,
          content: trimContent(m.content),
        })),
      }));
      return {
        workspaceId,
        tasks,
        conversations,
        fetchedAt: Date.now(),
        userId: this.userProvider?.(),
        apiBaseUrl: this.apiBaseProvider(),
      };
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        throw new Error('Parallel authentication required (401/403). Please sign in again.');
      }
      this.logger.error('Failed to fetch context bundle', err);
      throw err;
    }
  }

  private cacheKey(workspaceId: string): string {
    const server = normalizeBaseUrl(this.apiBaseProvider()?.trim() ?? '');
    const userId = this.userProvider?.() ?? `anon-${this.anonSalt}`;
    const authFp = this.authFingerprintProvider?.() ?? `anon-${this.anonSalt}`;
    const flags = `tasks=${DEFAULT_TASKS_LIMIT}-convos=${DEFAULT_CONVERSATIONS_LIMIT}-msgs=${DEFAULT_INCLUDE_MESSAGES}`;
    return `${CACHE_KEY}:${workspaceId}:${server}:${userId}:${authFp}:${flags}`;
  }
}

function parseContextResponse(raw: unknown): ContextBundleResponse {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid context response');
  }
  const obj = raw as Record<string, unknown>;
  const tasks = Array.isArray(obj.tasks)
    ? obj.tasks.filter(isTaskSummary).map((t) => ({ id: t.id, title: t.title, status: t.status }))
    : [];
  const conversations = Array.isArray(obj.conversations)
    ? obj.conversations.filter(isConversationSummary).map((c) => ({
        id: c.id,
        title: c.title,
        summary: c.summary,
        lastMessages: Array.isArray(c.lastMessages)
          ? c.lastMessages.filter(isMessageSummary).map((m) => ({ role: m.role, content: m.content }))
          : [],
      }))
    : [];
  return { tasks, conversations };
}

function isTaskSummary(value: any): value is TaskSummary {
  return value && typeof value.id === 'string';
}

function isConversationSummary(value: any): value is ConversationSummary {
  return value && typeof value.id === 'string';
}

function isMessageSummary(value: any): value is { role: string; content: string } {
  return value && typeof value.role === 'string' && typeof value.content === 'string';
}

function normalizeBaseUrl(server: string): string {
  try {
    return new URL(server).origin;
  } catch {
    return server.replace(/\/+$/, '');
  }
}

function trimContent(content: string | undefined): string {
  if (!content) {
    return '';
  }
  if (content.length <= 280) {
    return content;
  }
  return `${content.slice(0, 277)}...`;
}
