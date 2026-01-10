import { describe, expect, it } from 'vitest';

import {
  ContextService,
  MementoLike,
  ParallelContextPayload,
} from '../src/context/contextService';

class MemoryMemento implements MementoLike {
  private data = new Map<string, any>();
  get<T>(key: string): T | undefined {
    return this.data.get(key);
  }
  update(key: string, value: any): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
}

const loggerStub = {
  audit: () => undefined,
  debug: () => undefined,
  error: () => undefined,
};

describe('ContextService caching', () => {
  it('caches within ttl and refreshes after expiry', async () => {
    const memento = new MemoryMemento();
    let calls = 0;
    const fetcher = async (workspaceId: string): Promise<ParallelContextPayload> => {
      calls += 1;
      return {
        workspaceId,
        tasks: [{ id: `t-${calls}` }],
        conversations: [],
        fetchedAt: Date.now(),
      };
    };
    const svc = new ContextService(
      memento,
      {} as any,
      loggerStub as any,
      () => 'ws-1',
      {
        ttlMs: 200,
        fetcher,
        apiBaseProvider: () => 'http://example.com',
        userIdProvider: () => 'u1',
        authFingerprintProvider: () => 'fp',
      }
    );
    const first = await svc.getContext();
    const second = await svc.getContext();
    expect(first.tasks[0].id).toBe('t-1');
    expect(second.tasks[0].id).toBe('t-1');
    expect(calls).toBe(1);
    await new Promise((r) => setTimeout(r, 220));
    const third = await svc.getContext();
    expect(third.tasks[0].id).toBe('t-2');
    expect(calls).toBe(2);
  });

  it('returns empty context when workspace is missing', async () => {
    const memento = new MemoryMemento();
    const svc = new ContextService(
      memento,
      {} as any,
      loggerStub as any,
      () => null,
      {
        fetcher: async () => ({ workspaceId: 'x', tasks: [], conversations: [], fetchedAt: 0 }),
        apiBaseProvider: () => 'http://example.com',
        userIdProvider: () => 'u1',
        authFingerprintProvider: () => 'fp',
      }
    );
    const result = await svc.getContext();
    expect(result.workspaceId).toBeNull();
    expect(result.tasks).toHaveLength(0);
  });

  it('invalidates cache explicitly', async () => {
    const memento = new MemoryMemento();
    let calls = 0;
    const fetcher = async (workspaceId: string): Promise<ParallelContextPayload> => {
      calls += 1;
      return { workspaceId, tasks: [{ id: `t-${calls}` }], conversations: [], fetchedAt: Date.now() };
    };
    const svc = new ContextService(
      memento,
      {} as any,
      loggerStub as any,
      () => 'ws-2',
      {
        ttlMs: 60_000,
        fetcher,
        apiBaseProvider: () => 'http://example.com',
        userIdProvider: () => 'u1',
        authFingerprintProvider: () => 'fp',
      }
    );
    const first = await svc.getContext();
    expect(first.tasks[0].id).toBe('t-1');
    svc.invalidate('ws-2');
    const second = await svc.getContext();
    expect(second.tasks[0].id).toBe('t-2');
  });
});
