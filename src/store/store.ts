import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';

import { SyncEntity } from '../api/sync';
import { isNewer, nowIso } from '../util/time';

export interface EntityRecord extends SyncEntity {}

interface WorkspaceData {
  entities: Map<string, Map<string, EntityRecord>>;
  cursor: string | null;
  lastSync: string | null;
  lastEventId: string | null;
}

interface WorkspaceFileData {
  cursor: string | null;
  lastSync: string | null;
  lastEventId: string | null;
  entities: Record<string, Record<string, EntityRecord>>;
}

interface StoreOptions {
  maxEntitiesPerType?: number;
}

export class Store {
  private activeWorkspaceId: string | null = null;
  private workspaces = new Map<string, WorkspaceData>();
  private changeEmitter = new EventEmitter();
  private locks = new Map<string, Promise<void>>();
  private maxEntitiesPerType: number;

  constructor(private storagePath: string, options: StoreOptions = {}) {
    this.maxEntitiesPerType = options.maxEntitiesPerType ?? Infinity;
  }

  onDidChange(listener: () => void): () => void {
    this.changeEmitter.on('change', listener);
    return () => this.changeEmitter.off('change', listener);
  }

  setActiveWorkspace(workspaceId: string | null): void {
    this.activeWorkspaceId = workspaceId;
  }

  getActiveWorkspace(): string | null {
    return this.activeWorkspaceId;
  }

  setMaxEntitiesPerType(limit: number): void {
    this.maxEntitiesPerType = limit;
  }

  async applyPage(
    workspaceId: string,
    records: EntityRecord[],
    cursor: string | null
  ): Promise<void> {
    await this.withLock(workspaceId, async () => {
      const ws = await this.ensureWorkspace(workspaceId);
      records.forEach((record) => this.applyRecordToWorkspace(ws, record));
      ws.cursor = cursor;
      ws.lastSync = nowIso();
      await this.persistWorkspace(workspaceId, ws);
      this.emitChange();
    });
  }

  async applyEvent(
    workspaceId: string,
    record: EntityRecord,
    cursor?: string | null
  ): Promise<void> {
    await this.withLock(workspaceId, async () => {
      const ws = await this.ensureWorkspace(workspaceId);
      this.applyRecordToWorkspace(ws, record);
      if (cursor !== undefined) {
        ws.lastEventId = cursor;
      }
      ws.lastSync = nowIso();
      await this.persistWorkspace(workspaceId, ws);
      this.emitChange();
    });
  }

  async clearWorkspace(workspaceId: string): Promise<void> {
    await this.withLock(workspaceId, async () => {
      this.workspaces.delete(workspaceId);
      const filePath = this.workspaceFilePath(workspaceId);
      await fs.rm(filePath, { force: true });
      this.emitChange();
    });
  }

  getCursor(workspaceId: string): string | null {
    const ws = this.workspaces.get(workspaceId);
    return ws ? ws.cursor : null;
  }

  getLastSync(workspaceId: string): string | null {
    const ws = this.workspaces.get(workspaceId);
    return ws ? ws.lastSync : null;
  }

  getLastEventId(workspaceId: string): string | null {
    const ws = this.workspaces.get(workspaceId);
    return ws ? ws.lastEventId : null;
  }

  async load(workspaceId: string): Promise<void> {
    await this.withLock(workspaceId, async () => {
      await this.ensureWorkspace(workspaceId, true);
    });
  }

  async getRecent(entityType: string, n: number, workspaceId?: string): Promise<EntityRecord[]> {
    const ws = await this.ensureWorkspaceOrActive(workspaceId);
    const typeMap = ws.entities.get(entityType);
    if (!typeMap) {
      return [];
    }
    return Array.from(typeMap.values())
      .filter((item) => !item.deleted)
      .sort(
        (a, b) =>
          new Date(this.timestampFor(b)).getTime() - new Date(this.timestampFor(a)).getTime()
      )
      .slice(0, n);
  }

  async searchAll(text: string, workspaceId?: string): Promise<EntityRecord[]> {
    const ws = await this.ensureWorkspaceOrActive(workspaceId);
    const needle = text.toLowerCase();
    const results: EntityRecord[] = [];
    ws.entities.forEach((map) => {
      map.forEach((entity) => {
        if (entity.deleted) {
          return;
        }
        const payloadText = JSON.stringify(entity.payload ?? {}).toLowerCase();
        if (
          entity.entity_type.toLowerCase().includes(needle) ||
          entity.id.toLowerCase().includes(needle) ||
          payloadText.includes(needle)
        ) {
          results.push(entity);
        }
      });
    });
    return results.sort(
      (a, b) => new Date(this.timestampFor(b)).getTime() - new Date(this.timestampFor(a)).getTime()
    );
  }

  async getById(
    entityType: string,
    id: string,
    workspaceId?: string
  ): Promise<EntityRecord | undefined> {
    const ws = await this.ensureWorkspaceOrActive(workspaceId);
    const typeMap = ws.entities.get(entityType);
    const entity = typeMap?.get(id);
    if (entity?.deleted) {
      return undefined;
    }
    return entity;
  }

  private applyRecordToWorkspace(ws: WorkspaceData, record: EntityRecord): void {
    const typeMap = ws.entities.get(record.entity_type) ?? new Map<string, EntityRecord>();
    const existing = typeMap.get(record.id);
    let shouldUpdate = false;
    if (!existing) {
      shouldUpdate = true;
    } else if (this.timestampFor(record) === this.timestampFor(existing)) {
      shouldUpdate = record.id >= existing.id;
    } else {
      shouldUpdate = isNewer(this.timestampFor(record), this.timestampFor(existing));
    }
    if (shouldUpdate) {
      typeMap.set(record.id, { ...record });
      ws.entities.set(record.entity_type, typeMap);
      this.pruneTypeMap(typeMap);
    }
  }

  private timestampFor(record: EntityRecord): string {
    return record.updated_at ?? record.created_at ?? nowIso();
  }

  private pruneTypeMap(typeMap: Map<string, EntityRecord>): void {
    if (!Number.isFinite(this.maxEntitiesPerType) || this.maxEntitiesPerType <= 0) {
      return;
    }
    if (typeMap.size <= this.maxEntitiesPerType) {
      return;
    }
    const sorted = Array.from(typeMap.values()).sort(
      (a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
    );
    while (sorted.length > this.maxEntitiesPerType) {
      const oldest = sorted.shift();
      if (oldest) {
        typeMap.delete(oldest.id);
      }
    }
  }

  private async ensureWorkspaceOrActive(workspaceId?: string): Promise<WorkspaceData> {
    const id = workspaceId ?? this.activeWorkspaceId;
    if (!id) {
      throw new Error('No active workspace set');
    }
    return this.ensureWorkspace(id);
  }

  private async ensureWorkspace(workspaceId: string, forceReload = false): Promise<WorkspaceData> {
    const existing = this.workspaces.get(workspaceId);
    if (existing && !forceReload) {
      return existing;
    }
    const loaded = await this.loadWorkspaceFromDisk(workspaceId);
    this.workspaces.set(workspaceId, loaded);
    return loaded;
  }

  private async loadWorkspaceFromDisk(workspaceId: string): Promise<WorkspaceData> {
    const filePath = this.workspaceFilePath(workspaceId);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const json = JSON.parse(raw) as WorkspaceFileData;
      return {
        cursor: json.cursor ?? null,
        lastSync: json.lastSync ?? null,
        lastEventId: json.lastEventId ?? json.cursor ?? null,
        entities: this.deserializeEntities(json.entities),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { cursor: null, lastSync: null, lastEventId: null, entities: new Map() };
      }
      throw err;
    }
  }

  private deserializeEntities(
    entities: Record<string, Record<string, EntityRecord>>
  ): Map<string, Map<string, EntityRecord>> {
    const outer = new Map<string, Map<string, EntityRecord>>();
    Object.entries(entities).forEach(([entityType, values]) => {
      const inner = new Map<string, EntityRecord>();
      Object.entries(values).forEach(([id, record]) => {
        inner.set(id, record);
      });
      outer.set(entityType, inner);
    });
    return outer;
  }

  private async persistWorkspace(workspaceId: string, ws: WorkspaceData): Promise<void> {
    await fs.mkdir(this.storagePath, { recursive: true });
    const filePath = this.workspaceFilePath(workspaceId);
    const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const json: WorkspaceFileData = {
      cursor: ws.cursor,
      lastSync: ws.lastSync,
      lastEventId: ws.lastEventId ?? null,
      entities: {},
    };
    ws.entities.forEach((map, entityType) => {
      json.entities[entityType] = Object.fromEntries(map);
    });
    await fs.writeFile(tempPath, JSON.stringify(json, null, 2), 'utf-8');
    await fs.rename(tempPath, filePath);
  }

  private workspaceFilePath(workspaceId: string): string {
    const safeId = encodeURIComponent(workspaceId);
    return path.join(this.storagePath, `workspace-${safeId}.json`);
  }

  private emitChange(): void {
    this.changeEmitter.emit('change');
  }

  private async withLock(workspaceId: string, fn: () => Promise<void>): Promise<void> {
    const current = this.locks.get(workspaceId) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(workspaceId, current.then(() => next));
    try {
      await current;
      await fn();
    } finally {
      release();
      if (this.locks.get(workspaceId) === next) {
        this.locks.delete(workspaceId);
      }
    }
  }
}
