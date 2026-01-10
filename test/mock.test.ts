import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

import { SyncEntity } from '../src/api/sync';
import { MockBackend } from '../src/mock/backend';
import { Store } from '../src/store/store';

function tmpDir(): string {
  return path.join(
    os.tmpdir(),
    `parallel-mock-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

describe('Mock backend integration', () => {
  let backend: MockBackend;
  let store: Store;
  const workspaceId = 'mock-workspace';

  beforeEach(() => {
    backend = new MockBackend();
    store = new Store(tmpDir());
  });

  it('populates store via mock sync pages', async () => {
    let cursor: string | null = null;
    for (let i = 0; i < 5; i += 1) {
      const page = await backend.syncPage(workspaceId, cursor);
      await store.applyPage(workspaceId, page.items as SyncEntity[], page.next_cursor ?? null);
      cursor = page.next_cursor ?? null;
      if (!cursor) {
        break;
      }
    }
    const messages = await store.getRecent('message', 10, workspaceId);
    expect(messages.length).toBeGreaterThan(0);
  });

  it('applies live mock events into the store', async () => {
    const stop = backend.startEvents(
      workspaceId,
      async (event, cursor) => store.applyEvent(workspaceId, event, cursor ?? undefined),
      undefined,
      50
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    stop();
    const tasks = await store.getRecent('task', 5, workspaceId);
    expect(tasks.length).toBeGreaterThan(0);
  });
});
