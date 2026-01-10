import { describe, expect, it, vi } from 'vitest';

import { SyncEntity } from '../src/api/sync';
import { RealtimeClient } from '../src/realtime/sse';
import { Logger } from '../src/util/logger';

class StubLogger implements Partial<Logger> {
  level: any;
  channel: any;
  setLevel(): void {}
  info(): void {}
  debug(): void {}
  error(): void {}
}

describe('RealtimeClient event queue', () => {
  it('processes events sequentially', async () => {
    const order: string[] = [];
    const client = new RealtimeClient(
      { apiBaseUrl: 'http://localhost', workspaceId: 'ws', token: 't' },
      new StubLogger() as unknown as Logger,
      async (event: SyncEntity) =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            order.push(event.id);
            resolve();
          }, 20)
        )
    );

    const first: SyncEntity = { entity_type: 'message', id: '1', updated_at: '2024-01-01' };
    const second: SyncEntity = { entity_type: 'message', id: '2', updated_at: '2024-01-02' };

    // @ts-expect-error accessing private for test
    client.processParsedEvent(first, null);
    // @ts-expect-error accessing private for test
    client.processParsedEvent(second, null);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(order).toEqual(['1', '2']);
  });

  it('start is idempotent while connecting', () => {
    let createCount = 0;
    const factory = (_url: string, _init: any) => {
      createCount += 1;
      const es: any = {
        readyState: 0,
        onopen: (_ev?: any) => {},
        onerror: (_ev?: any) => {},
        onmessage: (_ev?: any) => {},
        close: () => {},
      };
      return es as EventSource;
    };
    const client = new RealtimeClient(
      { apiBaseUrl: 'http://localhost', workspaceId: 'ws', token: 't' },
      new StubLogger() as unknown as Logger,
      async () => Promise.resolve(),
      factory as any
    );
    client.start();
    client.start();
    expect(createCount).toBe(1);
  });

  it('schedules only one reconnect timer', async () => {
    vi.useFakeTimers();
    let createCount = 0;
    let onError: ((err: any) => void) | undefined;
    const factory = (_url: string, _init: any) => {
      createCount += 1;
      const es: any = {
        readyState: 1,
        onopen: (_ev?: any) => {},
        onmessage: (_ev?: any) => {},
        close: () => {},
        set onerror(fn: (err: any) => void) {
          onError = fn;
        },
      };
      return es as EventSource;
    };
    const client = new RealtimeClient(
      { apiBaseUrl: 'http://localhost', workspaceId: 'ws', token: 't' },
      new StubLogger() as unknown as Logger,
      async () => Promise.resolve(),
      factory as any
    );
    client.start();
    onError?.(new Error('boom'));
    onError?.(new Error('boom2'));
    vi.runAllTimers();
    expect(createCount).toBe(2);
    vi.useRealTimers();
  });

  it('builds URL with persisted cursor and encoded workspace', () => {
    const client = new RealtimeClient(
      { apiBaseUrl: 'http://localhost', workspaceId: 'ws/../x', token: 't', lastEventId: 'evt-1' },
      new StubLogger() as unknown as Logger,
      async () => Promise.resolve()
    );
    // @ts-expect-error accessing private
    const url: string = client.buildUrl();
    expect(url).toContain('workspace_id=ws%2F..%2Fx');
    expect(url).toContain('since_event_id=evt-1');
  });
});
