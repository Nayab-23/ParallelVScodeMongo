import { describe, expect, it } from 'vitest';

import {
  applyEditsToFs,
  FileSystemAdapter,
  ProposedFileEdit,
} from '../src/edits/pipeline';

class MemoryFs implements FileSystemAdapter {
  constructor(private files: Record<string, string> = {}) {}
  async exists(filePath: string): Promise<boolean> {
    return this.files[filePath] !== undefined;
  }
  async readFile(filePath: string): Promise<string> {
    return this.files[filePath] ?? '';
  }
  async writeFile(filePath: string, content: string): Promise<void> {
    this.files[filePath] = content;
  }
  snapshot(): Record<string, string> {
    return { ...this.files };
  }
}

describe('applyEditsToFs', () => {
  it('skips writes in dry run', async () => {
    const fs = new MemoryFs({ 'a.txt': 'old' });
    const edits: ProposedFileEdit[] = [{ filePath: 'a.txt', newText: 'new' }];
    const result = await applyEditsToFs(edits, fs, { dryRun: true });
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toEqual(['a.txt']);
    expect(fs.snapshot()['a.txt']).toBe('old');
  });

  it('applies edits when not dry run', async () => {
    const fs = new MemoryFs({ 'a.txt': 'old' });
    const edits: ProposedFileEdit[] = [{ filePath: 'a.txt', newText: 'new' }];
    const result = await applyEditsToFs(edits, fs, { dryRun: false });
    expect(result.applied).toEqual(['a.txt']);
    expect(fs.snapshot()['a.txt']).toBe('new');
  });

  it('skips when allowWrites is false', async () => {
    const fs = new MemoryFs({ 'a.txt': 'old' });
    const edits: ProposedFileEdit[] = [{ filePath: 'a.txt', newText: 'new' }];
    const result = await applyEditsToFs(edits, fs, { allowWrites: false });
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toEqual(['a.txt']);
    expect(fs.snapshot()['a.txt']).toBe('old');
  });

  it('enforces allowedRoots', async () => {
    const fs = new MemoryFs({ '/workspace/a.txt': 'old', '/tmp/evil.txt': 'x' });
    const edits: ProposedFileEdit[] = [
      { filePath: '/workspace/a.txt', newText: 'new' },
      { filePath: '/tmp/evil.txt', newText: 'bad' },
    ];
    const result = await applyEditsToFs(edits, fs, {
      allowWrites: true,
      allowedRoots: ['/workspace'],
    });
    expect(result.applied).toEqual(['/workspace/a.txt']);
    expect(result.skipped).toEqual(['/tmp/evil.txt']);
    expect(fs.snapshot()['/tmp/evil.txt']).toBe('x');
  });
});
