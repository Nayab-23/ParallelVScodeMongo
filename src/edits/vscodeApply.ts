import * as path from 'path';
import * as vscode from 'vscode';
import { applyPatch } from 'diff';

import { ApplyResult, ProposedFileEdit } from './pipeline';
import { Logger } from '../util/logger';
import { ensureWorkspacePath } from '../util/pathSafe';

export async function applyWithWorkspace(
  edits: ProposedFileEdit[],
  logger: Logger,
  options?: { allowWrites?: boolean; workspaceFolders?: readonly vscode.WorkspaceFolder[] }
): Promise<ApplyResult> {
  const applied: string[] = [];
  const skipped: string[] = [];
  const allowWrites = options?.allowWrites === true;
  const workspaceFolders = options?.workspaceFolders ?? vscode.workspace.workspaceFolders ?? [];
  for (const edit of edits) {
    if (!allowWrites) {
      skipped.push(edit.filePath);
      logger.audit(`Skipped apply (writes disabled): ${edit.filePath}`);
      continue;
    }
    if (!workspaceFolders.length) {
      skipped.push(edit.filePath);
      logger.error(`Skipped apply (no workspace root for ${edit.filePath})`);
      continue;
    }
    const workspaceRoot = workspaceFolders[0].uri.fsPath;
    let resolvedPath: string | null = null;
    let relativePath: string | null = null;
    try {
      const resolved = await ensureWorkspacePath(
        workspaceRoot,
        edit.relativePath ?? path.relative(workspaceRoot, edit.filePath)
      );
      resolvedPath = resolved.absolutePath;
      relativePath = resolved.relativePath;
    } catch (err) {
      skipped.push(edit.filePath);
      logger.error(`Skipped apply (invalid path): ${edit.filePath}`, err);
      continue;
    }
    if (relativePath && isBlockedPath(relativePath)) {
      skipped.push(resolvedPath);
      logger.audit(`Skipped apply (blocked file type): ${relativePath}`);
      continue;
    }
    try {
      await applySingleEdit({ ...edit, filePath: resolvedPath }, logger);
      if (edit.mode !== 'delete') {
        await formatIfPossible(resolvedPath);
      }
      applied.push(resolvedPath);
      logger.audit(`Applied edit to ${resolvedPath}`);
    } catch (err) {
      skipped.push(resolvedPath);
      logger.error(`Failed to apply edit to ${resolvedPath}`, err);
    }
  }
  return { applied, skipped };
}

async function applySingleEdit(edit: ProposedFileEdit, logger: Logger): Promise<void> {
  const uri = vscode.Uri.file(edit.filePath);
  const workspaceEdit = new vscode.WorkspaceEdit();
  const mode = edit.mode ?? 'replace';
  if (mode === 'delete') {
    workspaceEdit.delete(uri, { ignoreIfNotExists: true });
    await vscode.workspace.applyEdit(workspaceEdit);
    await vscode.workspace.saveAll();
    return;
  }
  let doc: vscode.TextDocument | null = null;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    doc = null;
  }
  const existingText = doc ? doc.getText() : '';
  if (doc && edit.range && !rangeWithinDocument(doc, edit.range)) {
    throw new Error('Edit range is outside the current document.');
  }
  if (mode === 'search_replace') {
    if (!doc || !edit.searchReplace) {
      throw new Error('Search/replace requires an existing file and searchReplace payload.');
    }
    if (!hasSearchMatch(doc.getText(), edit.searchReplace)) {
      throw new Error('Search/replace verification failed; pattern not found.');
    }
    const updated = applySearchReplace(doc.getText(), edit.searchReplace);
    const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    workspaceEdit.replace(uri, fullRange, updated);
  } else if (mode === 'insert') {
    const position = edit.range?.start
      ? new vscode.Position(edit.range.start.line, edit.range.start.character)
      : new vscode.Position(0, 0);
    if (!doc) {
      workspaceEdit.createFile(uri, { overwrite: true });
    }
    workspaceEdit.insert(uri, position, edit.newText ?? '');
  } else {
    let nextText = edit.newText;
    if (!nextText && edit.diff) {
      const patched = applyPatch(existingText, edit.diff);
      if (patched === false) {
        throw new Error('Diff apply failed; unable to compute updated content.');
      }
      nextText = patched;
    }
    if (!nextText) {
      throw new Error('Edit content missing for replace/diff operation.');
    }
    if (doc && edit.diff && edit.newText && !diffLikelyApplies(existingText, edit.diff)) {
      logger.info(`Diff verification failed; applying newText for ${edit.filePath}.`);
    }
    if (doc) {
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      workspaceEdit.replace(uri, fullRange, nextText);
    } else {
      workspaceEdit.createFile(uri, { overwrite: true });
      workspaceEdit.insert(uri, new vscode.Position(0, 0), nextText);
    }
  }
  await vscode.workspace.applyEdit(workspaceEdit);
  await vscode.workspace.saveAll();
}

async function formatIfPossible(filePath: string): Promise<void> {
  const uri = vscode.Uri.file(filePath);
  const edits = (await vscode.commands.executeCommand(
    'vscode.executeFormatDocumentProvider',
    uri
  )) as vscode.TextEdit[] | undefined;
  if (!edits || !edits.length) {
    return;
  }
  const workspaceEdit = new vscode.WorkspaceEdit();
  for (const e of edits) {
    workspaceEdit.replace(uri, e.range, e.newText);
  }
  await vscode.workspace.applyEdit(workspaceEdit);
  await vscode.workspace.saveAll();
}

function applySearchReplace(
  content: string,
  searchReplace: { search: string; replace: string; matchCase?: boolean; useRegex?: boolean }
): string {
  const { search, replace, matchCase, useRegex } = searchReplace;
  if (!search) {
    return content;
  }
  if (useRegex) {
    const flags = matchCase ? 'g' : 'gi';
    const regex = new RegExp(search, flags);
    return content.replace(regex, replace ?? '');
  }
  if (matchCase) {
    return content.split(search).join(replace ?? '');
  }
  const lowerContent = content.toLowerCase();
  const lowerSearch = search.toLowerCase();
  let index = 0;
  let result = '';
  while (index < content.length) {
    const match = lowerContent.indexOf(lowerSearch, index);
    if (match === -1) {
      result += content.slice(index);
      break;
    }
    result += content.slice(index, match) + (replace ?? '');
    index = match + search.length;
  }
  return result;
}

function rangeWithinDocument(
  doc: vscode.TextDocument,
  range: { start: { line: number; character: number }; end?: { line: number; character: number } }
): boolean {
  const lineCount = doc.lineCount;
  if (range.start.line < 0 || range.start.line >= lineCount) {
    return false;
  }
  if (range.end) {
    if (range.end.line < range.start.line || range.end.line >= lineCount) {
      return false;
    }
  }
  return true;
}

function hasSearchMatch(
  content: string,
  searchReplace: { search: string; replace: string; matchCase?: boolean; useRegex?: boolean }
): boolean {
  const { search, matchCase, useRegex } = searchReplace;
  if (!search) {
    return false;
  }
  if (useRegex) {
    const flags = matchCase ? 'g' : 'gi';
    try {
      const regex = new RegExp(search, flags);
      return regex.test(content);
    } catch {
      return false;
    }
  }
  if (matchCase) {
    return content.includes(search);
  }
  return content.toLowerCase().includes(search.toLowerCase());
}

function diffLikelyApplies(content: string, diff: string): boolean {
  const removedLines = diff
    .split('\n')
    .filter((line) => line.startsWith('-') && !line.startsWith('---'))
    .map((line) => line.slice(1))
    .filter((line) => line.trim().length > 0);
  if (!removedLines.length) {
    return true;
  }
  return removedLines.every((line) => content.includes(line));
}

const BLOCKED_PATH_SEGMENTS = new Set(['__pycache__', '.git', 'node_modules', '.venv', '.vscode']);
const BLOCKED_EXTENSIONS = new Set(['.pyc', '.pyo', '.pyd', '.class', '.o', '.so', '.dll', '.dylib', '.exe']);

function isBlockedPath(candidate: string): boolean {
  if (!candidate) {
    return true;
  }
  const normalized = candidate.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => BLOCKED_PATH_SEGMENTS.has(segment))) {
    return true;
  }
  const ext = path.extname(normalized).toLowerCase();
  return BLOCKED_EXTENSIONS.has(ext);
}
