import EventSource from 'eventsource';

import { SyncEntity } from '../api/sync';
import { computeBackoff } from '../util/backoff';
import { Logger } from '../util/logger';

export type RealtimeStatus = 'disconnected' | 'connecting' | 'live';

export interface RealtimeOptions {
  apiBaseUrl: string;
  workspaceId: string;
  token: string;
  cursor?: string | null;
  lastEventId?: string | null;
  demoUser?: string | undefined;
}

export class RealtimeClient {
  private es: EventSource | null = null;
  private stopped = false;
  private attempt = 0;
  private lastEventId: string | null = null;
  private status: RealtimeStatus = 'disconnected';
  private statusListeners: Array<(status: RealtimeStatus) => void> = [];
  private eventQueue: Promise<void> = Promise.resolve();
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private options: RealtimeOptions,
    private logger: Logger,
    private onEvent: (event: SyncEntity, cursor?: string | null) => Promise<void>,
    private eventSourceFactory: (url: string, init: EventSourceInit) => EventSource = (url, init) =>
      new EventSource(url, init)
  ) {
    this.lastEventId = options.lastEventId ?? options.cursor ?? null;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    this.setStatus('disconnected');
  }

  updateOptions(options: Partial<RealtimeOptions>): void {
    this.options = { ...this.options, ...options };
    if (options.lastEventId !== undefined) {
      this.lastEventId = options.lastEventId;
    }
  }

  onStatusChange(listener: (status: RealtimeStatus) => void): void {
    this.statusListeners.push(listener);
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }
    if (this.es && (this.es as any).readyState === 0) {
      return;
    }
    if (this.es && (this.es as any).readyState === 1) {
      return;
    }
    this.setStatus('connecting');
    const url = this.buildUrl();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.token}`,
    };
    // Include demo user header if provided so server can filter events
    if (this.options.demoUser) {
      headers['X-Demo-User'] = this.options.demoUser;
    }
    if (this.lastEventId) {
      headers['Last-Event-ID'] = this.lastEventId;
    }
    this.logger.info(`[SSE] Opening connection: ${url}${this.lastEventId ? ` [lastEventId:${this.lastEventId}]` : ''}`);
    this.es = this.eventSourceFactory(url, { headers } as any);
    this.es.onopen = () => {
      this.logger.info(`[SSE] Connected to workspace:${this.options.workspaceId}`);
      this.attempt = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.setStatus('live');
    };
    this.es.onerror = (err) => {
      this.logger.error(`[SSE] Connection error${this.lastEventId ? ` [lastEventId:${this.lastEventId}]` : ''}`, err as unknown);
      this.scheduleReconnect();
    };
    this.es.onmessage = (event) => {
      const eventId = (event as { id?: string; lastEventId?: string }).id ?? event.lastEventId;
      this.lastEventId = eventId ?? this.lastEventId;
      const data = event.data?.toString() ?? '';
      const trimmed = data.trim();
      if (!trimmed || trimmed === ':heartbeat' || trimmed === 'heartbeat') {
        return;
      }
      this.logger.info(`[SSE] Event received [id:${eventId || 'none'}]`);
      this.handleEventString(trimmed);
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    this.setStatus('disconnected');
    const delay = computeBackoff(this.attempt);
    this.attempt += 1;
    this.logger.info(`Reconnecting SSE in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private buildUrl(): string {
    const base = this.options.apiBaseUrl.replace(/\/+$/, '');
    const url = new URL('/api/v1/events', base);
    url.searchParams.set('workspace_id', this.options.workspaceId);
    if (this.lastEventId) {
      url.searchParams.set('since_event_id', this.lastEventId);
    }
    return url.toString();
  }

  private setStatus(status: RealtimeStatus): void {
    this.status = status;
    this.statusListeners.forEach((listener) => listener(status));
  }

  private handleEventString(data: string): void {
    try {
      const parsed = JSON.parse(data) as SyncEntity;
      this.processParsedEvent(parsed, this.lastEventId);
    } catch (err) {
      this.logger.error('Failed to parse SSE event', err as unknown);
    }
  }

  private processParsedEvent(event: SyncEntity, cursor: string | null): void {
    this.eventQueue = this.eventQueue
      .then(() => this.onEvent(event, cursor))
      .catch((err) => this.logger.error('Failed to handle SSE event', err as unknown));
  }
}
