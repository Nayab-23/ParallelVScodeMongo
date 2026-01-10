import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { ensureWorkspacePath } from '../src/util/pathSafe';

function tmpDir(): string {
  return path.join(os.tmpdir(), `parallel-path-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

describe('ensureWorkspacePath', () => {
  it('rejects encoded traversal', async () => {
    const root = tmpDir();
    await fs.mkdir(root, { recursive: true });
    await expect(ensureWorkspacePath(root, '%2e%2e/evil')).rejects.toThrow();
  });

  it('rejects double-encoded traversal (%252e%252e)', async () => {
    const root = tmpDir();
    await fs.mkdir(root, { recursive: true });
    await expect(ensureWorkspacePath(root, '%252e%252e/evil.txt')).rejects.toThrow();
  });

  it('rejects windows drive and UNC paths', async () => {
    const root = tmpDir();
    await fs.mkdir(root, { recursive: true });
    await expect(ensureWorkspacePath(root, 'C:\\\\temp\\\\x')).rejects.toThrow();
    await expect(ensureWorkspacePath(root, '\\\\server\\share\\x')).rejects.toThrow();
  });

  it('rejects backslash traversal', async () => {
    const root = tmpDir();
    await fs.mkdir(root, { recursive: true });
    await expect(ensureWorkspacePath(root, 'a\\..\\b')).rejects.toThrow();
  });

  it('rejects symlink escape', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const root = tmpDir();
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}`);
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    const linkPath = path.join(root, 'link');
    await fs.symlink(outside, linkPath, 'dir');
    await expect(ensureWorkspacePath(root, 'link/file.txt')).rejects.toThrow();
  });

  it('rejects sibling prefix trick', async () => {
    const base = tmpDir();
    const root = path.join(base, 'ws');
    const evil = path.join(base, 'ws_evil');
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(evil, { recursive: true });
    await expect(ensureWorkspacePath(root, '../ws_evil/file.txt')).rejects.toThrow();
  });

  it('allows valid relative path', async () => {
    const root = tmpDir();
    await fs.mkdir(root, { recursive: true });
    const filePath = path.join(root, 'src', 'file.ts');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'ok');
    const result = await ensureWorkspacePath(root, 'src/file.ts');
    expect(result.absolutePath).toContain('src/file.ts');
    expect(result.relativePath).toBe('src/file.ts');
  });
});
