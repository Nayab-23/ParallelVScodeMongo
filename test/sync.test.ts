import { describe, expect, it } from 'vitest';

import { SyncResponse, SyncService, fetchSyncPage } from '../src/api/sync';
import { Store } from '../src/store/store';
import { Logger } from '../src/util/logger';

class StubLogger implements Partial<Logger> {
  level: any;
  channel: any;
  setLevel(): void {}
  info(): void {}
  debug(): void {}
  error(): void {}
}

describe('SyncService', () => {
  it('persists cursor when only cursor is returned', async () => {
    const store = new Store('/tmp');
    const logger = new StubLogger() as unknown as Logger;
    const responses: SyncResponse[] = [
      { items: [], cursor: 'cursor-1', done: false },
      { items: [], cursor: 'cursor-2', done: true },
    ];
    let idx = 0;
    const fetcher = async (): Promise<SyncResponse> => responses[idx++] ?? { items: [], done: true };
    const service = new SyncService({} as any, store, logger, fetcher);

    const workspaceId = 'ws';
    await store.clearWorkspace(workspaceId);
    await service.incrementalSync(workspaceId);

    expect(store.getCursor(workspaceId)).toBe('cursor-2');
  });

  it('encodes workspace id in sync path', async () => {
    let calledPath = '';
    const fakeClient = {
      request: async (path: string) => {
        calledPath = path;
        return { items: [], done: true };
      },
    } as any;
    await fetchSyncPage(fakeClient, 'ws/../evil', null);
    expect(calledPath).toContain('ws%2F..%2Fevil');
  });

  it('normalizes message sync payloads using created_at fallback', async () => {
    let payload: SyncResponse | null = null;
    const fakeClient = {
      request: async () => {
        return {
          messages: [
            {
              id: 'm1',
              created_at: '2025-01-01T00:00:00Z',
            },
          ],
        };
      },
    } as any;
    payload = await fetchSyncPage(fakeClient, 'ws1', null);
    expect(payload.items[0].entity_type).toBe('message');
    expect(payload.items[0].updated_at).toBe('2025-01-01T00:00:00Z');
    expect(payload.items[0].created_at).toBe('2025-01-01T00:00:00Z');
  });
});
