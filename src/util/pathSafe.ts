import * as fs from 'fs/promises';
import * as path from 'path';

export interface ResolvedWorkspacePath {
  absolutePath: string;
  relativePath: string; // posix-style, canonical
}

export async function ensureWorkspacePath(
  workspaceRoot: string,
  proposedPath: string
): Promise<ResolvedWorkspacePath> {
  const decoded = decodeOnce(proposedPath);
  if (decoded === null) {
    throw new Error('Invalid path encoding');
  }
  // Reject residual encodings that may hide traversal (double-encoded)
  if (/%[0-9a-fA-F]{2}/.test(decoded)) {
    throw new Error('Encoded path segments are not allowed');
  }
  const normalizedRaw = decoded.replace(/\\/g, '/');
  if (isAbsoluteAny(decoded) || isAbsoluteAny(normalizedRaw)) {
    throw new Error('Absolute paths are not allowed');
  }
  const normalized = normalizedRaw.replace(/^\/+/, '');
  if (!normalized) {
    throw new Error('Absolute paths are not allowed');
  }
  const segments = normalized.split('/');
  if (segments.some((s) => s === '..' || s === '')) {
    throw new Error('Path traversal detected');
  }
  const candidate = path.resolve(workspaceRoot, normalized);
  const rootReal = await fs.realpath(workspaceRoot);
  const targetReal = await realpathOrParent(candidate);
  if (!isPathContained(rootReal, targetReal)) {
    throw new Error('Path escapes workspace');
  }
  const rel = path.relative(rootReal, targetReal).replace(/\\/g, '/');
  return { absolutePath: targetReal, relativePath: rel };
}

function decodeOnce(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isAbsoluteAny(p: string): boolean {
  return path.isAbsolute(p) || path.win32.isAbsolute(p) || /^\\\\/.test(p) || /^\/\//.test(p);
}

async function realpathOrParent(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    let current = path.dirname(target);
    let existingReal: string | null = null;
    while (true) {
      try {
        existingReal = await fs.realpath(current);
        break;
      } catch {
        const parent = path.dirname(current);
        if (parent === current) {
          throw new Error('No existing ancestor for path');
        }
        current = parent;
      }
    }
    return path.join(existingReal, path.relative(current, target));
  }
}

function isPathContained(root: string, candidate: string): boolean {
  const normalizedRoot = normalizePath(root);
  const normalizedCandidate = normalizePath(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}
