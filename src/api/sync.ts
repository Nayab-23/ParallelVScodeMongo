import { Store } from '../store/store';
import { Logger } from '../util/logger';

import { ParallelClient } from './client';

export type SyncPageFetcher = (workspaceId: string, cursor: string | null) => Promise<SyncResponse>;

export interface SyncEntity {
  entity_type: string;
  id: string;
  updated_at: string;
  created_at?: string | null;
  payload?: unknown;
  deleted?: boolean;
  [key: string]: unknown;
}

export interface SyncResponse {
  items: SyncEntity[];
  next_cursor?: string | null;
  cursor?: string | null;
  done?: boolean;
}

interface RawSyncResponse {
  messages?: Array<Record<string, unknown>>;
  message_tombstones?: Array<Record<string, unknown>>;
  tasks?: Array<Record<string, unknown>>;
  task_tombstones?: Array<Record<string, unknown>>;
  items?: SyncEntity[];
  next_cursor?: string | null;
  cursor?: string | null;
  done?: boolean;
  [key: string]: unknown;
}

export async function fetchSyncPage(
  client: ParallelClient,
  workspaceId: string,
  cursor?: string | null,
  limit = 200,
  timeoutMs?: number
): Promise<SyncResponse> {
  const encodedWorkspaceId = encodeURIComponent(workspaceId);
  const cursorParam = cursor ?? undefined;
  const raw = await client.request<RawSyncResponse>(
    `/api/v1/workspaces/${encodedWorkspaceId}/sync`,
    {
      method: 'GET',
      query: {
        since: cursorParam,
        cursor: cursorParam,
        limit,
      },
      timeoutMs,
    }
  );
  return normalizeSyncResponse(raw);
}

export class SyncService {
  private fetcher: SyncPageFetcher;

  constructor(
    private client: ParallelClient,
    private store: Store,
    private logger: Logger,
    fetcher?: SyncPageFetcher
  ) {
    this.fetcher =
      fetcher ??
      ((workspaceId: string, cursor: string | null) =>
        fetchSyncPage(this.client, workspaceId, cursor));
  }

  async fullSync(workspaceId: string): Promise<void> {
    this.logger.info(`Starting full sync for workspace ${workspaceId}`);
    await this.store.clearWorkspace(workspaceId);
    await this.syncFromCursor(workspaceId, null);
  }

  async incrementalSync(workspaceId: string): Promise<void> {
    const cursor = this.store.getCursor(workspaceId);
    await this.syncFromCursor(workspaceId, cursor ?? null);
  }

  private async syncFromCursor(workspaceId: string, cursor: string | null): Promise<void> {
    let currentCursor: string | null = cursor;
    let page = 0;
    let keepSyncing = true;
    while (keepSyncing) {
      const response = await this.fetcher(workspaceId, currentCursor);
      page += 1;
      this.logger.info(
        `Sync page ${page} workspace=${workspaceId} cursor=${currentCursor ?? 'none'}`
      );
      const nextCursor = response.next_cursor ?? response.cursor ?? null;
      await this.store.applyPage(workspaceId, response.items, nextCursor);
      const done = (response.done ?? !nextCursor) || nextCursor === currentCursor;
      if (done) {
        keepSyncing = false;
      } else {
        currentCursor = nextCursor;
      }
    }
    this.logger.info(`Sync completed for workspace ${workspaceId}`);
  }
}

function normalizeSyncResponse(raw: RawSyncResponse): SyncResponse {
  if (raw.items && Array.isArray(raw.items)) {
    return raw as SyncResponse;
  }
  const items: SyncEntity[] = [];
  (raw.messages ?? []).forEach((msg) => {
    const id = String(msg.id ?? msg.resource_id ?? '');
    if (!id) {
      return;
    }
    const createdAt = (msg.created_at as string | undefined) ?? null;
    const updatedAt =
      (msg.updated_at as string | undefined) ??
      (msg.timestamp as string | undefined) ??
      createdAt ??
      new Date().toISOString();
    items.push({
      entity_type: 'message',
      id,
      updated_at: updatedAt,
      created_at: createdAt,
      deleted: false,
      payload: msg,
    });
  });
  (raw.message_tombstones ?? []).forEach((tomb) => {
    const id = String(tomb.id ?? tomb.resource_id ?? '');
    if (!id) {
      return;
    }
    const ts =
      (tomb.deleted_at as string | undefined) ??
      (tomb.updated_at as string | undefined) ??
      new Date().toISOString();
    items.push({
      entity_type: 'message',
      id,
      updated_at: ts,
      created_at: ts,
      deleted: true,
      payload: tomb,
    });
  });
  (raw.tasks ?? []).forEach((task) => {
    const id = String(task.id ?? task.resource_id ?? '');
    if (!id) {
      return;
    }
    const updatedAt =
      (task.updated_at as string | undefined) ??
      (task.created_at as string | undefined) ??
      new Date().toISOString();
    items.push({
      entity_type: 'task',
      id,
      updated_at: updatedAt,
      created_at: (task.created_at as string | undefined) ?? null,
      deleted: false,
      payload: task,
    });
  });
  (raw.task_tombstones ?? []).forEach((tomb) => {
    const id = String(tomb.id ?? tomb.resource_id ?? '');
    if (!id) {
      return;
    }
    const ts =
      (tomb.deleted_at as string | undefined) ??
      (tomb.updated_at as string | undefined) ??
      new Date().toISOString();
    items.push({
      entity_type: 'task',
      id,
      updated_at: ts,
      created_at: ts,
      deleted: true,
      payload: tomb,
    });
  });
  return {
    items,
    next_cursor: raw.next_cursor ?? raw.cursor ?? null,
    cursor: raw.cursor ?? raw.next_cursor ?? null,
    done: raw.done,
  };
}
