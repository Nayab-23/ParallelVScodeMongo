import * as path from 'path';
import * as vscode from 'vscode';

import { ParallelContextPayload } from '../context/contextService';
import { AgentCommandResult } from './commandHistory';
import { buildPrompt, PromptBuildResult, PromptDiagnostic } from './promptBuilder';

const MAX_OPEN_FILES = 8;
const MAX_FILE_CONTENT_CHARS = 12_000;
const MAX_WORKSPACE_FILES = 1200;
const MAX_SEARCH_RESULTS = 24;
const MAX_SEARCH_TERMS = 3;
const MAX_PREVIEW_CHARS = 200;
const MAX_GUIDE_FILES = 3;
const MAX_ADDITIONAL_FILES = 6;
const MAX_TOTAL_FILE_CHARS = 80_000;
const SEARCH_TERM_MIN = 4;

const FILE_EXCLUDES = '**/{.git,node_modules,dist,build,out,.next,.venv,.cache,coverage,__pycache__,.vscode}/**';
const BLOCKED_PATH_SEGMENTS = new Set(['__pycache__', '.git', 'node_modules', '.venv', '.vscode']);
const BLOCKED_EXTENSIONS = new Set(['.pyc', '.pyo', '.pyd', '.class', '.o', '.so', '.dll', '.dylib', '.exe']);

export interface RepoFileEntry {
  absolute?: string;
  relative?: string;
  content?: string;
  language?: string;
  size?: number;
  truncated?: boolean;
}

export interface RepoSearchResult {
  file: string;
  line: number;
  preview: string;
}

export interface RepoGuide {
  path: string;
  content: string;
}

export interface RepoSymbol {
  name: string;
  kind?: string;
  detail?: string;
  file?: string;
  range?: { start: { line: number; character: number }; end?: { line: number; character: number } };
}

export interface RepoReference {
  file: string;
  line: number;
  character: number;
  preview?: string;
}

export interface RepoGitCommit {
  hash: string;
  message: string;
  author?: string;
  date?: string;
}

export interface RepoGitContext {
  branch?: string;
  staged_files: string[];
  unstaged_files: string[];
  recent_commits: RepoGitCommit[];
}

export interface RepoSemanticContext {
  file_path: string;
  content: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface RepoContext {
  root?: string;
  openFiles: string[];
  files: RepoFileEntry[];
  diagnostics: PromptDiagnostic[];
  gitDiffStat?: string;
  searchResults: RepoSearchResult[];
  guides: RepoGuide[];
  symbols: RepoSymbol[];
  references: RepoReference[];
  hoverInfo?: string;
  git?: RepoGitContext;
  semanticContext: RepoSemanticContext[];
}

export interface CollectedPrompt extends PromptBuildResult {
  repoContext: {
    root?: string;
    openFiles: string[];
    files: RepoFileEntry[];
    diagnostics: PromptDiagnostic[];
    gitDiffStat?: string;
    searchResults: RepoSearchResult[];
    guides: RepoGuide[];
    symbols: RepoSymbol[];
    references: RepoReference[];
    hoverInfo?: string;
    git?: RepoGitContext;
    semanticContext: RepoSemanticContext[];
    commandResults: AgentCommandResult[];
  };
}

interface CollectPromptOptions {
  commandResults?: AgentCommandResult[];
  additionalFiles?: string[];
  searchQueries?: string[];
  includeGuides?: boolean;
  includeLsp?: boolean;
  includeGit?: boolean;
  semanticContext?: RepoSemanticContext[];
  fullRepoContext?: boolean;
  fullRepoMaxFiles?: number;
}

export async function collectPrompt(
  userMessage: string,
  context: ParallelContextPayload,
  mode: 'dry-run' | 'apply',
  options: CollectPromptOptions = {}
): Promise<CollectedPrompt> {
  const repoContext = await collectRepoContext(userMessage, options);
  const repoName = vscode.workspace.workspaceFolders?.[0]?.name;
  const prompt = buildPrompt({
    workspaceName: repoName,
    repoName,
    files: repoContext.openFiles,
    diagnostics: repoContext.diagnostics,
    gitDiffStat: repoContext.gitDiffStat,
    guides: repoContext.guides,
    symbols: repoContext.symbols,
    references: repoContext.references,
    hoverInfo: repoContext.hoverInfo,
    git: repoContext.git,
    semanticContext: repoContext.semanticContext,
    parallelContext: context,
    userMessage,
    mode,
  });
  return {
    ...prompt,
    repoContext: {
      ...repoContext,
      semanticContext: options.semanticContext ?? repoContext.semanticContext,
      commandResults: options.commandResults ?? [],
    },
  };
}

export async function collectRepoContext(
  userMessage: string,
  options: CollectPromptOptions = {}
): Promise<RepoContext> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  const rootPath = workspace?.uri.fsPath;
  const openEditors = vscode.window.visibleTextEditors
    .map((e) => e.document)
    .filter((doc) => doc.uri.scheme === 'file')
    .filter((doc) => !isBlockedPath(toRelativePath(doc.uri)))
    .slice(0, MAX_OPEN_FILES);
  const openFiles = openEditors
    .map((doc) => toRelativePath(doc.uri))
    .filter((p) => !!p);
  const openFileEntries = openEditors.map((doc) => buildFileEntry(doc));
  const workspaceFiles = await listWorkspaceFiles(workspace);
  const mergedFiles = mergeFileEntries(openFileEntries, workspaceFiles);
  const diagnostics = vscode.languages
    .getDiagnostics()
    .slice(0, 10)
    .map(([uri, diags]) =>
      diags.map((d) => ({
        file: toRelativePath(uri),
        severity: vscode.DiagnosticSeverity[d.severity],
        message: truncate(d.message, 200),
      }))
    )
    .flat();
  const gitDiffStat = await tryGitDiffStat(workspace);
  const searchResults = collectSearchResults(openFileEntries, userMessage, options.searchQueries);
  const guides = options.includeGuides === false ? [] : await loadGuideFiles(workspace);
  const lsp = options.includeLsp === false ? undefined : await collectLspContext();
  const git = options.includeGit === false ? undefined : await collectGitContext(workspace);
  const additionalFiles = options.additionalFiles ?? [];
  const autoFiles =
    additionalFiles.length > 0
      ? additionalFiles
      : selectRelevantFiles(userMessage, workspaceFiles, openFiles);
  const additionalEntries = await readAdditionalFiles(workspace, autoFiles, openFileEntries);
  const fullRepoContext = !!options.fullRepoContext;
  const fullRepoMaxFiles = normalizeFullRepoMaxFiles(options.fullRepoMaxFiles);
  const fullRepoEntries = fullRepoContext
    ? await readAdditionalFiles(
        workspace,
        workspaceFiles
          .map((entry) => entry.relative ?? entry.absolute ?? '')
          .filter((entry) => entry.length > 0),
        mergeFileEntries(openFileEntries, additionalEntries),
        fullRepoMaxFiles
      )
    : [];
  const combinedFiles = mergeFileEntries(mergeFileEntries(mergedFiles, additionalEntries), fullRepoEntries);
  return {
    root: rootPath,
    openFiles,
    files: combinedFiles,
    diagnostics,
    gitDiffStat,
    searchResults,
    guides,
    symbols: lsp?.symbols ?? [],
    references: lsp?.references ?? [],
    hoverInfo: lsp?.hoverInfo,
    git,
    semanticContext: options.semanticContext ?? [],
  };
}

async function tryGitDiffStat(workspace: vscode.WorkspaceFolder | undefined): Promise<string | undefined> {
  if (!workspace) {
    return undefined;
  }
  try {
    const stat = await vscode.commands.executeCommand<string>(
      'git.api.getStatusSummary',
      workspace.uri
    );
    if (typeof stat === 'string' && stat.trim().length) {
      return stat.trim();
    }
  } catch {
    // ignore; git extension may not be available
  }
  return undefined;
}

function toRelativePath(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return uri.fsPath;
  }
  return path.relative(folder.uri.fsPath, uri.fsPath);
}

function truncate(text: string, limit: number): string {
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3)}...`;
}

function buildFileEntry(doc: vscode.TextDocument): RepoFileEntry {
  const text = doc.getText();
  const { text: content, truncated } = truncateText(text, MAX_FILE_CONTENT_CHARS);
  return {
    absolute: doc.uri.fsPath,
    relative: toRelativePath(doc.uri),
    content,
    language: doc.languageId,
    size: text.length,
    truncated,
  };
}

function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, limit), truncated: true };
}

async function listWorkspaceFiles(
  workspace: vscode.WorkspaceFolder | undefined
): Promise<RepoFileEntry[]> {
  if (!workspace || typeof vscode.workspace.findFiles !== 'function') {
    return [];
  }
  try {
    const uris = await vscode.workspace.findFiles('**/*', FILE_EXCLUDES, MAX_WORKSPACE_FILES);
    return uris
      .map((uri) => ({
        absolute: uri.fsPath,
        relative: toRelativePath(uri),
      }))
      .filter((entry) => !!entry.relative && !isBlockedPath(entry.relative ?? ''));
  } catch {
    return [];
  }
}

function mergeFileEntries(primary: RepoFileEntry[], secondary: RepoFileEntry[]): RepoFileEntry[] {
  const results = new Map<string, RepoFileEntry>();
  const add = (entry: RepoFileEntry) => {
    const key = entry.relative ?? entry.absolute ?? '';
    if (!key) {
      return;
    }
    const existing = results.get(key);
    if (!existing) {
      results.set(key, entry);
      return;
    }
    if (!existing.content && entry.content) {
      results.set(key, entry);
    }
  };
  primary.forEach(add);
  secondary.forEach(add);
  return Array.from(results.values());
}

function selectRelevantFiles(
  userMessage: string,
  workspaceFiles: RepoFileEntry[],
  openFiles: string[]
): string[] {
  const terms = extractSearchTerms(userMessage);
  if (!terms.length) {
    return [];
  }
  const openSet = new Set(openFiles);
  const scored = workspaceFiles
    .map((entry) => entry.relative ?? entry.absolute ?? '')
    .filter((path) => path && !openSet.has(path))
    .map((path) => {
      const lower = path.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (lower.includes(term)) {
          score += 2;
        }
      }
      return { path, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_ADDITIONAL_FILES).map((item) => item.path);
}

async function readAdditionalFiles(
  workspace: vscode.WorkspaceFolder | undefined,
  paths: string[],
  existing: RepoFileEntry[],
  limit: number = MAX_ADDITIONAL_FILES
): Promise<RepoFileEntry[]> {
  if (!workspace || !paths.length) {
    return [];
  }
  const root = workspace.uri.fsPath;
  const existingSet = new Set(
    existing.map((entry) => entry.relative ?? entry.absolute ?? '')
  );
  const results: RepoFileEntry[] = [];
  let totalChars = 0;
  for (const candidate of paths.slice(0, limit)) {
    const resolved = resolveWorkspacePath(root, candidate);
    if (!resolved || existingSet.has(resolved.relative) || isBlockedPath(resolved.relative)) {
      continue;
    }
    try {
      const data = await vscode.workspace.fs.readFile(resolved.uri);
      if (isBinary(data)) {
        continue;
      }
      const text = Buffer.from(data).toString('utf8');
      totalChars += text.length;
      if (totalChars > MAX_TOTAL_FILE_CHARS) {
        break;
      }
      const { text: content, truncated } = truncateText(text, MAX_FILE_CONTENT_CHARS);
      results.push({
        absolute: resolved.absolute,
        relative: resolved.relative,
        content,
        language: detectLanguage(resolved.uri),
        size: text.length,
        truncated,
      });
    } catch {
      continue;
    }
  }
  return results;
}

function normalizeFullRepoMaxFiles(value: number | undefined): number {
  if (!value || value <= 0) {
    return 500;
  }
  return Math.min(value, MAX_WORKSPACE_FILES);
}

async function loadGuideFiles(
  workspace: vscode.WorkspaceFolder | undefined
): Promise<RepoGuide[]> {
  if (!workspace) {
    return [];
  }
  const patterns = ['**/AGENTS.md', '**/.editorconfig', '**/CONTRIBUTING.md'];
  const guides: RepoGuide[] = [];
  for (const pattern of patterns) {
    if (guides.length >= MAX_GUIDE_FILES) {
      break;
    }
    const uris = await vscode.workspace.findFiles(pattern, FILE_EXCLUDES, MAX_GUIDE_FILES);
    for (const uri of uris) {
      if (guides.length >= MAX_GUIDE_FILES) {
        break;
      }
      try {
        const data = await vscode.workspace.fs.readFile(uri);
        if (isBinary(data)) {
          continue;
        }
        const content = Buffer.from(data).toString('utf8');
        guides.push({
          path: toRelativePath(uri),
          content: truncate(content, MAX_FILE_CONTENT_CHARS),
        });
      } catch {
        continue;
      }
    }
  }
  return guides;
}

async function collectLspContext(): Promise<{
  symbols: RepoSymbol[];
  references: RepoReference[];
  hoverInfo?: string;
} | null> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return null;
  }
  const uri = editor.document.uri;
  const position = editor.selection.active;
  const symbols: RepoSymbol[] = [];
  try {
    const symbolResults = (await vscode.commands.executeCommand(
      'vscode.executeDocumentSymbolProvider',
      uri
    )) as vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined;
    if (Array.isArray(symbolResults)) {
      const flattened = flattenSymbols(symbolResults);
      symbols.push(
        ...flattened.slice(0, 50).map((s) => {
          const range = 'location' in s ? s.location.range : s.range;
          return {
            name: s.name,
            kind: typeof s.kind === 'number' ? vscode.SymbolKind[s.kind] : String(s.kind),
            detail: 'detail' in s ? s.detail : undefined,
            file: toRelativePath(('location' in s ? s.location.uri : uri) ?? uri),
            range: range
              ? {
                  start: { line: range.start.line, character: range.start.character },
                  end: { line: range.end.line, character: range.end.character },
                }
              : undefined,
          };
        })
      );
    }
  } catch {
    // ignore
  }

  const references: RepoReference[] = [];
  try {
    const refResults = (await vscode.commands.executeCommand(
      'vscode.executeReferenceProvider',
      uri,
      position
    )) as vscode.Location[] | undefined;
    if (Array.isArray(refResults)) {
      for (const ref of refResults.slice(0, 20)) {
        let refDoc: vscode.TextDocument | null = null;
        try {
          refDoc = await vscode.workspace.openTextDocument(ref.uri);
        } catch {
          refDoc = null;
        }
        const line = ref.range.start.line;
        references.push({
          file: toRelativePath(ref.uri),
          line: line + 1,
          character: ref.range.start.character + 1,
          preview: refDoc ? refDoc.lineAt(line).text.trim() : undefined,
        });
      }
    }
  } catch {
    // ignore
  }

  let hoverInfo: string | undefined;
  try {
    const hoverResults = (await vscode.commands.executeCommand(
      'vscode.executeHoverProvider',
      uri,
      position
    )) as vscode.Hover[] | undefined;
    if (Array.isArray(hoverResults) && hoverResults.length) {
      const parts = hoverResults.flatMap((hover) =>
        hover.contents.map((c) => (typeof c === 'string' ? c : c.value))
      );
      hoverInfo = truncate(parts.join('\n'), 1200);
    }
  } catch {
    // ignore
  }

  return { symbols, references, hoverInfo };
}

async function collectGitContext(
  workspace: vscode.WorkspaceFolder | undefined
): Promise<RepoGitContext | undefined> {
  if (!workspace) {
    return undefined;
  }
  try {
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    if (!gitExtension) {
      return undefined;
    }
    const gitApi = gitExtension.exports?.getAPI?.(1);
    if (!gitApi) {
      return undefined;
    }
    const repo = gitApi.getRepository(workspace.uri);
    if (!repo) {
      return undefined;
    }
    const branch = repo.state.HEAD?.name;
    const staged = repo.state.indexChanges.map((c: any) => c.uri?.fsPath).filter(Boolean);
    const unstaged = repo.state.workingTreeChanges.map((c: any) => c.uri?.fsPath).filter(Boolean);
    let commits: RepoGitCommit[] = [];
    if (typeof repo.log === 'function') {
      try {
        const log = await repo.log({ maxEntries: 5 });
        commits = (log ?? []).map((entry: any) => ({
          hash: entry.hash ?? entry.commit ?? '',
          message: entry.message ?? '',
          author: entry.authorName ?? entry.authorEmail ?? undefined,
          date: entry.authorDate ?? entry.commitDate ?? undefined,
        }));
      } catch {
        commits = [];
      }
    }
    return {
      branch,
      staged_files: staged.map((p: string) => path.relative(workspace.uri.fsPath, p)),
      unstaged_files: unstaged.map((p: string) => path.relative(workspace.uri.fsPath, p)),
      recent_commits: commits,
    };
  } catch {
    return undefined;
  }
}

function resolveWorkspacePath(
  root: string,
  candidate: string
): { uri: vscode.Uri; absolute: string; relative: string } | null {
  const normalized = path.normalize(candidate);
  const absolute = path.isAbsolute(normalized) ? normalized : path.join(root, normalized);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..')) {
    return null;
  }
  return { uri: vscode.Uri.file(absolute), absolute, relative };
}

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

function isBinary(data: Uint8Array): boolean {
  const sample = data.slice(0, 2048);
  return sample.some((byte) => byte === 0);
}

function detectLanguage(uri: vscode.Uri): string | undefined {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  return doc?.languageId;
}

function flattenSymbols(
  symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[]
): Array<vscode.DocumentSymbol | vscode.SymbolInformation> {
  const results: Array<vscode.DocumentSymbol | vscode.SymbolInformation> = [];
  for (const symbol of symbols) {
    results.push(symbol);
    if ('children' in symbol && Array.isArray(symbol.children) && symbol.children.length) {
      results.push(...flattenSymbols(symbol.children));
    }
  }
  return results;
}

function collectSearchResults(
  openFileEntries: RepoFileEntry[],
  userMessage: string,
  searchQueries?: string[]
): RepoSearchResult[] {
  const terms = extractSearchTerms(userMessage, searchQueries);
  if (!terms.length) {
    return [];
  }
  const results: RepoSearchResult[] = [];
  for (const entry of openFileEntries) {
    if (!entry.content) {
      continue;
    }
    const filePath = entry.relative ?? entry.absolute ?? '';
    if (!filePath) {
      continue;
    }
    const content = entry.content;
    const lower = content.toLowerCase();
    for (const term of terms) {
      if (results.length >= MAX_SEARCH_RESULTS) {
        break;
      }
      const index = lower.indexOf(term);
      if (index === -1) {
        continue;
      }
      const match = buildPreview(content, index);
      results.push({
        file: filePath,
        line: match.line,
        preview: match.preview,
      });
    }
    if (results.length >= MAX_SEARCH_RESULTS) {
      break;
    }
  }
  return results;
}

function buildPreview(
  content: string,
  index: number
): { line: number; preview: string } {
  const lineStart = content.lastIndexOf('\n', index - 1) + 1;
  const lineEnd = content.indexOf('\n', index);
  const end = lineEnd === -1 ? content.length : lineEnd;
  const lineText = content.slice(lineStart, end).trim();
  const line = content.slice(0, lineStart).split('\n').length;
  return {
    line,
    preview: truncate(lineText, MAX_PREVIEW_CHARS),
  };
}

function extractSearchTerms(message: string, additional?: string[]): string[] {
  const combined = [message, ...(additional ?? [])].join(' ');
  const tokens = combined.toLowerCase().match(/[a-z][a-z0-9_./-]{2,}/g) ?? [];
  const stopwords = new Set([
    'the',
    'and',
    'for',
    'with',
    'this',
    'that',
    'from',
    'into',
    'then',
    'when',
    'what',
    'which',
    'about',
    'have',
    'should',
    'could',
    'would',
    'make',
    'please',
    'update',
    'change',
    'fix',
    'error',
    'issue',
    'bug',
  ]);
  const unique: string[] = [];
  for (const token of tokens) {
    if (token.length < SEARCH_TERM_MIN || stopwords.has(token)) {
      continue;
    }
    if (!unique.includes(token)) {
      unique.push(token);
    }
    if (unique.length >= MAX_SEARCH_TERMS) {
      break;
    }
  }
  return unique;
}
