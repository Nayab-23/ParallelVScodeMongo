export interface FileSystemAdapter {
  exists(filePath: string): Promise<boolean>;
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
}

export interface ProposedFileEdit {
  filePath: string; // absolute path target
  relativePath?: string; // canonical relative path from backend, used for safety checks
  newText?: string;
  diff?: string;
  mode?: 'replace' | 'diff' | 'search_replace' | 'insert' | 'delete';
  description?: string;
  range?: { start: { line: number; character: number }; end?: { line: number; character: number } };
  originalLines?: number[];
  searchReplace?: { search: string; replace: string; matchCase?: boolean; useRegex?: boolean };
}

export interface ApplyResult {
  applied: string[];
  skipped: string[];
  reason?: 'cancelled' | 'blocked' | 'rolled_back' | 'failed' | 'dry_run';
}

export async function applyEditsToFs(
  edits: ProposedFileEdit[],
  fsAdapter: FileSystemAdapter,
  options?: { dryRun?: boolean; allowWrites?: boolean; allowedRoots?: string[] }
): Promise<ApplyResult> {
  const applied: string[] = [];
  const skipped: string[] = [];
  const allowWrites = options?.allowWrites !== false;
  for (const edit of edits) {
    if (options?.dryRun || !allowWrites) {
      skipped.push(edit.filePath);
      continue;
    }
    if (options?.allowedRoots && !isPathInsideRoots(edit.filePath, options.allowedRoots)) {
      skipped.push(edit.filePath);
      continue;
    }
    if (!edit.newText) {
      skipped.push(edit.filePath);
      continue;
    }
    await fsAdapter.writeFile(edit.filePath, edit.newText);
    applied.push(edit.filePath);
  }
  return { applied, skipped };
}

export function isPathInsideRoots(targetPath: string, roots: string[]): boolean {
  const normalizedTarget = normalize(targetPath);
  return roots.some((root) => {
    const normalizedRoot = normalize(root);
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
  });
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}
