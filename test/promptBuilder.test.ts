import { describe, expect, it } from 'vitest';

import { buildPrompt } from '../src/agent/promptBuilder';

describe('prompt builder', () => {
  it('builds prompt with repo and context sections', () => {
    const result = buildPrompt({
      workspaceName: 'WS',
      repoName: 'Repo',
      files: ['file1.ts', 'file2.ts'],
      diagnostics: [{ file: 'file1.ts', severity: 'Error', message: 'oops' }],
      gitDiffStat: '1 file changed',
      parallelContext: {
        workspaceId: 'ws',
        tasks: [{ id: 't1', title: 'Task 1' }],
        conversations: [{ id: 'c1', title: 'Chat 1', summary: 'summary' }],
        fetchedAt: Date.now(),
      },
      userMessage: 'Fix the bug',
      mode: 'dry-run',
    });
    expect(result.prompt).toContain('# Repo');
    expect(result.prompt).toContain('Task 1');
    expect(result.prompt).toContain('Assistant chats');
    expect(result.prompt).toContain('Fix the bug');
    expect(result.summary.files).toHaveLength(2);
    expect(result.summary.gitDiffStat).toBe('1 file changed');
    expect(result.summary.tasks[0].title).toBe('Task 1');
  });
});
