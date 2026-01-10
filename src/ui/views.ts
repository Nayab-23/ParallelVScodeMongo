import * as vscode from 'vscode';

import { EntityRecord, Store } from '../store/store';

type NodeKind = 'info' | 'action' | 'entity' | 'section' | 'prompt';

class ParallelTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly kind: NodeKind,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
  ) {
    super(label, collapsibleState);
    this.contextValue = `${kind}:${label}`;
  }
}

export class ContextTreeDataProvider implements vscode.TreeDataProvider<ParallelTreeItem> {
  private emitter = new vscode.EventEmitter<ParallelTreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private store: Store,
    private getWorkspaceInfo: () => { id: string | null; name?: string },
    private getStatus: () => string
  ) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: ParallelTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ParallelTreeItem): Promise<ParallelTreeItem[]> {
    if (!element) {
      const ws = this.getWorkspaceInfo();
      const items: ParallelTreeItem[] = [];
      items.push(new ParallelTreeItem(`Workspace: ${ws.name ?? ws.id ?? 'Not selected'}`, 'info'));
      items.push(new ParallelTreeItem(`Status: ${this.getStatus()}`, 'info'));
      const lastSync = ws.id ? this.store.getLastSync(ws.id) : null;
      const lastSyncText = lastSync ? new Date(lastSync).toLocaleString() : 'n/a';
      items.push(new ParallelTreeItem(`Last Sync: ${lastSyncText}`, 'info'));

      const forceSync = new ParallelTreeItem('Force Sync', 'action');
      forceSync.command = { command: 'parallel.forceSync', title: 'Force Sync' };
      const fullResync = new ParallelTreeItem('Force Full Resync', 'action');
      fullResync.command = { command: 'parallel.forceFullResync', title: 'Force Full Resync' };
      const openWeb = new ParallelTreeItem('Open Web App', 'action');
      openWeb.command = { command: 'parallel.openWebApp', title: 'Open Web App' };
      items.push(forceSync, fullResync, openWeb);

      const messages = new ParallelTreeItem(
        'Recent Messages',
        'section',
        vscode.TreeItemCollapsibleState.Expanded
      );
      messages.contextValue = 'section:messages';
      const tasks = new ParallelTreeItem(
        'Open Tasks',
        'section',
        vscode.TreeItemCollapsibleState.Expanded
      );
      tasks.contextValue = 'section:tasks';
      items.push(messages, tasks);
      return items;
    }

    if (element.contextValue === 'section:messages') {
      const recents = await this.getRecentEntities(['message', 'messages'], 20);
      return recents.map((entity) => this.toEntityItem(entity));
    }
    if (element.contextValue === 'section:tasks') {
      const recents = await this.getRecentEntities(['task', 'tasks'], 20);
      return recents.map((entity) => this.toEntityItem(entity));
    }
    return [];
  }

  private toEntityItem(entity: EntityRecord): ParallelTreeItem {
    const label = `${entity.entity_type}: ${entity.id}`;
    const item = new ParallelTreeItem(label, 'entity');
    item.description = entity.deleted ? 'Deleted' : new Date(entity.updated_at).toLocaleString();
    item.command = { command: 'parallel.openDetails', title: 'Open Details', arguments: [entity] };
    return item;
  }

  private async getRecentEntities(types: string[], n: number): Promise<EntityRecord[]> {
    const results: EntityRecord[] = [];
    for (const t of types) {
      const list = await this.store.getRecent(t, n).catch(() => []);
      results.push(...list);
    }
    return results
      .filter((item) => !item.deleted)
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, n);
  }
}

export class SearchTreeDataProvider implements vscode.TreeDataProvider<ParallelTreeItem> {
  private emitter = new vscode.EventEmitter<ParallelTreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private query = '';
  private results: EntityRecord[] = [];

  constructor(private store: Store) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  setQuery(query: string): void {
    this.query = query;
    void this.runSearch();
  }

  getTreeItem(element: ParallelTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: ParallelTreeItem): Promise<ParallelTreeItem[]> {
    if (element) {
      return [];
    }
    if (!this.query) {
      const prompt = new ParallelTreeItem('Enter search text…', 'prompt');
      prompt.command = { command: 'parallel.search.prompt', title: 'Search Parallel' };
      return [prompt];
    }
    return this.results.map((entity) => {
      const label = `${entity.entity_type}: ${entity.id}`;
      const item = new ParallelTreeItem(label, 'entity');
      item.description = new Date(entity.updated_at).toLocaleString();
      item.command = {
        command: 'parallel.openDetails',
        title: 'Open Details',
        arguments: [entity],
      };
      return item;
    });
  }

  private async runSearch(): Promise<void> {
    if (!this.query) {
      this.results = [];
      this.refresh();
      return;
    }
    try {
      this.results = await this.store.searchAll(this.query);
    } catch (err) {
      this.results = [];
      vscode.window.showErrorMessage(
        `Search failed. Ensure a workspace is selected. ${err instanceof Error ? err.message : ''}`
      );
    }
    this.refresh();
  }
}
