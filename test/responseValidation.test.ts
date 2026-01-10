import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: () => undefined }),
  },
  window: { visibleTextEditors: [] },
  languages: { getDiagnostics: () => [] },
  Uri: { file: (p: string) => ({ fsPath: p }) },
}));

import { ContextService } from '../src/context/contextService';
import { AgentService } from '../src/agent/agentService';

describe('response validation', () => {
  it('rejects invalid agent response edits', async () => {
    const svc = new AgentService(
      { getContext: async () => ({ workspaceId: 'ws', tasks: [], conversations: [], fetchedAt: 0 }) } as any,
      () => 'ws',
      {
        request: async () => ({ plan: [], edits: [{ filePath: null, newText: 1 }] }),
      } as any,
      { audit: () => undefined, error: () => undefined } as any
    );
    await expect(svc.propose('hi', 'dry-run')).rejects.toThrow(/Invalid agent response/);
  });

  it('parses context with invalid shapes', async () => {
    let calls = 0;
    const svc = new ContextService(
      { get: () => undefined, update: () => Promise.resolve() } as any,
      {
        request: async () => {
          calls += 1;
          return { tasks: [{ id: '1' }, { id: 2 }], conversations: [{ id: 'c1', summary: 's' }] };
        },
      } as any,
      { audit: () => undefined, error: () => undefined } as any,
      () => 'ws',
      {
        ttlMs: 10,
        apiBaseProvider: () => 'http://example.com',
        userIdProvider: () => 'u1',
        authFingerprintProvider: () => 'fp',
      }
    );
    const result = await svc.getContext(true);
    expect(result.tasks.length).toBe(1);
    expect(result.conversations.length).toBe(1);
    expect(calls).toBe(1);
  });
});
