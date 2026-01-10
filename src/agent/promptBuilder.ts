import { ConversationSummary, ParallelContextPayload, TaskSummary } from '../context/contextService';

const MAX_SECTION_LENGTH = 2000;
const MAX_PROMPT_LENGTH = 8000;
const MAX_ITEM_LENGTH = 180;

export interface PromptParts {
  workspaceName?: string;
  repoName?: string;
  files: string[];
  diagnostics: PromptDiagnostic[];
  gitDiffStat?: string;
  guides?: { path: string; content: string }[];
  symbols?: { name: string; kind?: string; detail?: string; file?: string }[];
  references?: { file: string; line: number; character: number; preview?: string }[];
  hoverInfo?: string;
  git?: { branch?: string; staged_files?: string[]; unstaged_files?: string[]; recent_commits?: any[] };
  semanticContext?: { file_path: string; content: string; score?: number }[];
  parallelContext: ParallelContextPayload;
  userMessage: string;
  mode: 'dry-run' | 'apply';
}

export interface PromptDiagnostic {
  file: string;
  severity: string;
  message: string;
}

export interface PromptBuildResult {
  prompt: string;
  summary: {
    workspaceName?: string;
    repoName?: string;
    files: string[];
    diagnostics: PromptDiagnostic[];
    gitDiffStat?: string;
    guides?: { path: string; content: string }[];
    symbols?: { name: string; kind?: string; detail?: string; file?: string }[];
    references?: { file: string; line: number; character: number; preview?: string }[];
    hoverInfo?: string;
    git?: { branch?: string; staged_files?: string[]; unstaged_files?: string[]; recent_commits?: any[] };
    semanticContext?: { file_path: string; content: string; score?: number }[];
    tasks: TaskSummary[];
    conversations: ConversationSummary[];
    mode: 'dry-run' | 'apply';
  };
}

function truncate(text: string | undefined, limit: number): string {
  if (!text) {
    return '';
  }
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 3)}...`;
}

function truncateList(items: string[], limit: number): string[] {
  return items.map((i) => truncate(i, limit));
}

function capSection(section: string): string {
  if (section.length <= MAX_SECTION_LENGTH) {
    return section;
  }
  return `${section.slice(0, MAX_SECTION_LENGTH)}\n...[truncated]`;
}

export function buildPrompt(parts: PromptParts): PromptBuildResult {
  const sections: string[] = [];
  const repoLines: string[] = [];
  if (parts.workspaceName) {
    repoLines.push(`Workspace: ${parts.workspaceName}`);
  }
  if (parts.repoName) {
    repoLines.push(`Repository: ${parts.repoName}`);
  }
  if (parts.files.length) {
    const filesLine = truncateList(parts.files, MAX_ITEM_LENGTH).join(', ');
    repoLines.push(`Focused files (${parts.files.length}): ${filesLine}`);
  }
  if (parts.gitDiffStat) {
    repoLines.push(`Git diff: ${truncate(parts.gitDiffStat, 256)}`);
  }
  if (parts.git?.branch) {
    repoLines.push(`Git branch: ${truncate(parts.git.branch, 120)}`);
  }
  if (parts.diagnostics.length) {
    const diagText = parts.diagnostics
      .slice(0, 10)
      .map((d) => `- [${d.severity}] ${truncate(d.file, 200)}: ${truncate(d.message, 200)}`)
      .join('\n');
    repoLines.push(`Diagnostics:\n${diagText}`);
  }
  if (repoLines.length) {
    sections.push(capSection(`# Repo\n${repoLines.join('\n')}`));
  }

  if (parts.guides?.length) {
    const guideLines = parts.guides
      .slice(0, 3)
      .map((g) => `- ${truncate(g.path, 120)}`)
      .join('\n');
    sections.push(capSection(`# Project Guides\n${guideLines}`));
  }
  if (parts.hoverInfo) {
    sections.push(capSection(`# Cursor Info\n${truncate(parts.hoverInfo, 600)}`));
  }
  if (parts.symbols?.length) {
    sections.push(
      capSection(
        `# Symbols\n${parts.symbols
          .slice(0, 12)
          .map((s) => truncate(`${s.name}${s.kind ? ` (${s.kind})` : ''}`, MAX_ITEM_LENGTH))
          .join('; ')}`
      )
    );
  }
  if (parts.references?.length) {
    sections.push(
      capSection(
        `# References\n${parts.references
          .slice(0, 8)
          .map((r) => truncate(`${r.file}:${r.line}`, MAX_ITEM_LENGTH))
          .join('; ')}`
      )
    );
  }
  if (parts.semanticContext?.length) {
    sections.push(
      capSection(
        `# Semantic Context\n${parts.semanticContext
          .slice(0, 6)
          .map((s) => truncate(`${s.file_path} (score ${s.score ?? ''})`, MAX_ITEM_LENGTH))
          .join('; ')}`
      )
    );
  }

  const ctxLines: string[] = [];
  if (parts.parallelContext.tasks.length) {
    ctxLines.push(
      `Tasks (${parts.parallelContext.tasks.length}): ${parts.parallelContext.tasks
        .map((t) => truncate(`${t.title ?? t.id}${t.status ? ` [${t.status}]` : ''}`, MAX_ITEM_LENGTH))
        .join('; ')}`
    );
  }
  if (parts.parallelContext.conversations.length) {
    const convoLine = parts.parallelContext.conversations
      .map((c) =>
        truncate(
          `${c.title ?? c.id}${c.summary ? ` — ${c.summary}` : ''}`,
          MAX_ITEM_LENGTH
        )
      )
      .join('; ');
    ctxLines.push(`Assistant chats (${parts.parallelContext.conversations.length}): ${convoLine}`);
  }
  if (ctxLines.length) {
    sections.push(capSection(`# Parallel Context\n${ctxLines.join('\n')}`));
  }

  sections.push(`# Mode\n${parts.mode === 'dry-run' ? 'Suggest (no writes)' : 'Apply-ready'}`);
  sections.push(`# User Request\n${truncate(parts.userMessage, 1000)}`);
  sections.push(
    `# Output expectations\nReturn a brief plan followed by file edits. Always include newText for each edit (full file contents for replace). Diffs are optional. Do not write without explicit apply.`
  );

  const prompt = sections.join('\n\n');
  return {
    prompt: prompt.length > MAX_PROMPT_LENGTH ? `${prompt.slice(0, MAX_PROMPT_LENGTH)}\n\n[truncated]` : prompt,
    summary: {
      workspaceName: parts.workspaceName,
      repoName: parts.repoName,
      files: parts.files,
      diagnostics: parts.diagnostics,
      gitDiffStat: parts.gitDiffStat,
      guides: parts.guides,
      symbols: parts.symbols,
      references: parts.references,
      hoverInfo: parts.hoverInfo,
      git: parts.git,
      semanticContext: parts.semanticContext,
      tasks: parts.parallelContext.tasks,
      conversations: parts.parallelContext.conversations,
      mode: parts.mode,
    },
  };
}
