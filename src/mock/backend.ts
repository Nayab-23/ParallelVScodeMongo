import { BootstrapResponse } from '../api/bootstrap';
import { SyncEntity, SyncResponse } from '../api/sync';
import { nowIso } from '../util/time';

type StatusListener = (status: 'connecting' | 'live' | 'disconnected') => void;

export class MockBackend {
  private workspaces = [
    { id: 'mock-workspace', name: 'Mock Workspace' },
    { id: 'mock-workspace-2', name: 'Mock Workspace 2' },
  ];

  private data = new Map<string, SyncEntity[]>();

  constructor() {
    this.workspaces.forEach((ws, idx) => {
      this.data.set(ws.id, this.buildSeedData(ws.id, idx));
    });
  }

  bootstrap(): BootstrapResponse {
    return {
      user: { id: 'mock-user', name: 'Mock User' },
      workspaces: this.workspaces,
    };
  }

  async syncPage(workspaceId: string, cursor: string | null): Promise<SyncResponse> {
    const all = this.data.get(workspaceId) ?? [];
    const start =
      cursor === null ? 0 : all.findIndex((item) => this.cursorFor(item) === cursor) + 1;
    const page = all.slice(start, start + 50);
    const last = page[page.length - 1];
    const nextCursor =
      page.length && start + page.length < all.length ? this.cursorFor(last) : null;
    return {
      items: page,
      next_cursor: nextCursor,
      cursor: nextCursor,
      done: !nextCursor,
    };
  }

  startEvents(
    workspaceId: string,
    onEvent: (event: SyncEntity, cursor: string | null) => Promise<void>,
    onStatusChange?: StatusListener,
    intervalMs = 1500
  ): () => void {
    let count = 0;
    let connected = false;
    let running = false;

    const connectTimer = setTimeout(() => {
      connected = true;
      onStatusChange?.('live');
    }, 200);

    onStatusChange?.('connecting');

    const timer = setInterval(async () => {
      if (running) {
        return;
      }
      running = true;
      const event = this.nextLiveEvent(workspaceId, count);
      count += 1;
      const cursor = this.cursorFor(event);
      try {
        await onEvent(event, cursor);
      } finally {
        running = false;
      }
    }, intervalMs);

    return () => {
      clearInterval(timer);
      clearTimeout(connectTimer);
      if (connected) {
        onStatusChange?.('disconnected');
      }
    };
  }

  private cursorFor(record: SyncEntity): string {
    return `${record.updated_at}-${record.id}`;
  }

  private buildSeedData(workspaceId: string, offset: number): SyncEntity[] {
    const base = Date.now() - offset * 1000;
    return [
      {
        entity_type: 'message',
        id: `${workspaceId}-message-1`,
        updated_at: new Date(base - 5000).toISOString(),
        payload: { text: 'Welcome to Parallel mock mode' },
      },
      {
        entity_type: 'task',
        id: `${workspaceId}-task-1`,
        updated_at: new Date(base - 4000).toISOString(),
        payload: { title: 'Mock task open', status: 'open' },
      },
      {
        entity_type: 'task',
        id: `${workspaceId}-task-2`,
        updated_at: new Date(base - 3000).toISOString(),
        payload: { title: 'Mock task closed', status: 'closed' },
        deleted: true,
      },
      {
        entity_type: 'document',
        id: `${workspaceId}-doc-1`,
        updated_at: new Date(base - 2000).toISOString(),
        payload: { title: 'Mock doc', body: 'Hello world' },
      },
    ];
  }

  private nextLiveEvent(workspaceId: string, idx: number): SyncEntity {
    const stamp = nowIso();
    const mod = idx % 4;
    if (mod === 0) {
      return {
        entity_type: 'message',
        id: `${workspaceId}-live-message-${idx}`,
        updated_at: stamp,
        payload: { text: `Live message ${idx}` },
      };
    }
    if (mod === 1) {
      return {
        entity_type: 'task',
        id: `${workspaceId}-task-1`,
        updated_at: stamp,
        payload: { title: 'Mock task open', status: 'in_progress', iteration: idx },
      };
    }
    if (mod === 2) {
      return {
        entity_type: 'task',
        id: `${workspaceId}-task-2`,
        updated_at: stamp,
        deleted: true,
      };
    }
    return {
      entity_type: 'document',
      id: `${workspaceId}-doc-1`,
      updated_at: stamp,
      payload: { title: 'Mock doc', body: `Updated ${idx}` },
    };
  }
}
