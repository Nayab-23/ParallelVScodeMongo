import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { Store } from '../src/store/store';
import * as fs from 'fs/promises';

function tmpDir(): string {
  return fsPath(path.join(os.tmpdir(), `parallel-store-${Date.now()}`));
}

function fsPath(p: string): string {
  return path.resolve(p);
}

describe('Store', () => {
  it('applies pages and honors cursors', async () => {
    const store = new Store(tmpDir());
    const workspaceId = 'ws1';
    await store.applyPage(
      workspaceId,
      [
        { entity_type: 'task', id: '1', updated_at: '2024-01-01T00:00:00Z', payload: { t: 1 } },
        { entity_type: 'task', id: '2', updated_at: '2024-01-02T00:00:00Z', payload: { t: 2 } },
      ],
      'cursor-a'
    );
    expect(store.getCursor(workspaceId)).toBe('cursor-a');
    const recent = await store.getRecent('task', 10, workspaceId);
    expect(recent.map((r) => r.id)).toEqual(['2', '1']);
  });

  it('prefers newer updates and hides tombstones', async () => {
    const store = new Store(tmpDir());
    const workspaceId = 'ws2';
    await store.applyPage(
      workspaceId,
      [{ entity_type: 'task', id: '1', updated_at: '2024-01-01T00:00:00Z', payload: { t: 1 } }],
      'c1'
    );
    await store.applyPage(
      workspaceId,
      [
        {
          entity_type: 'task',
          id: '1',
          updated_at: '2023-12-01T00:00:00Z',
          payload: { t: 0 },
        },
        {
          entity_type: 'task',
          id: '1',
          updated_at: '2024-02-01T00:00:00Z',
          deleted: true,
        },
      ],
      'c2'
    );
    const recent = await store.getRecent('task', 10, workspaceId);
    expect(recent.length).toBe(0);
  });

  it('persists to disk', async () => {
    const dir = tmpDir();
    const workspaceId = 'ws3';
    const store = new Store(dir);
    await store.applyPage(
      workspaceId,
      [{ entity_type: 'message', id: 'a', updated_at: '2024-01-01T00:00:00Z', payload: {} }],
      'cursor-1'
    );
    const reload = new Store(dir);
    await reload.load(workspaceId);
    const recent = await reload.getRecent('message', 5, workspaceId);
    expect(recent[0].id).toBe('a');
    expect(reload.getCursor(workspaceId)).toBe('cursor-1');
  });

  it('uses encoded workspace ids for file paths', async () => {
    const dir = tmpDir();
    const workspaceId = 'ws/../evil';
    const store = new Store(dir);
    await store.applyPage(
      workspaceId,
      [{ entity_type: 'message', id: 'a', updated_at: '2024-01-01T00:00:00Z', payload: {} }],
      'cursor-1'
    );
    const files = await fs.readdir(dir);
    const hasEncoded = files.some((f) => f.includes('ws%2F..%2Fevil'));
    expect(hasEncoded).toBe(true);
  });

  it('uses created_at fallback when updated_at is missing', async () => {
    const store = new Store(tmpDir());
    const workspaceId = 'ws-fallback';
    await store.applyPage(
      workspaceId,
      [
        {
          entity_type: 'message',
          id: 'm1',
          updated_at: null as any,
          created_at: '2024-01-01T00:00:00Z',
          payload: {},
        },
        {
          entity_type: 'message',
          id: 'm2',
          updated_at: null as any,
          created_at: '2024-01-02T00:00:00Z',
          payload: {},
        },
      ],
      'cursor-x'
    );
    const recent = await store.getRecent('message', 5, workspaceId);
    expect(recent.map((r) => r.id)).toEqual(['m2', 'm1']);
  });

  it('serializes concurrent writes safely', async () => {
    const dir = tmpDir();
    const workspaceId = 'ws-concurrent';
    const store = new Store(dir);
    await Promise.all([
      store.applyPage(
        workspaceId,
        [{ entity_type: 'task', id: 'a', updated_at: '2024-01-01T00:00:00Z', payload: {} }],
        'cursor-page'
      ),
      store.applyEvent(
        workspaceId,
        { entity_type: 'task', id: 'b', updated_at: '2024-01-02T00:00:00Z', payload: {} },
        'evt-1'
      ),
    ]);
    const filePath = path.join(dir, `workspace-${encodeURIComponent(workspaceId)}.json`);
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.cursor).toBe('cursor-page');
    expect(parsed.lastEventId).toBe('evt-1');
    expect(Object.keys(parsed.entities.task || {})).toEqual(expect.arrayContaining(['a', 'b']));
    const tmpFiles = (await fs.readdir(dir)).filter((f) => f.includes('.tmp-'));
    expect(tmpFiles.length).toBe(0);
  });

  it('prunes old entities based on maxEntitiesPerType', async () => {
    const dir = tmpDir();
    const store = new Store(dir, { maxEntitiesPerType: 2 });
    const workspaceId = 'ws-prune';
    await store.applyPage(
      workspaceId,
      [
        { entity_type: 'task', id: '1', updated_at: '2024-01-01T00:00:00Z', payload: {} },
        { entity_type: 'task', id: '2', updated_at: '2024-01-02T00:00:00Z', payload: {} },
      ],
      'c1'
    );
    await store.applyEvent(
      workspaceId,
      { entity_type: 'task', id: '3', updated_at: '2024-01-03T00:00:00Z', payload: {} },
      'evt'
    );
    const recent = await store.getRecent('task', 5, workspaceId);
    expect(recent.length).toBe(2);
    expect(recent.map((r) => r.id)).toEqual(['3', '2']);
  });
});
