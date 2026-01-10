import * as vscode from 'vscode';

import * as fs from 'fs/promises';
import { ContextService, ParallelContextPayload } from '../context/contextService';
import { renderDiff } from '../edits/diff';
import { ProposedFileEdit } from '../edits/pipeline';
import { HttpError, ParallelClient } from '../api/client';
import { Logger } from '../util/logger';
import { AgentCommand, AgentCommandResult } from './commandHistory';
import { CollectedPrompt, collectPrompt, RepoSemanticContext } from './promptCollector';
import { PromptBuildResult } from './promptBuilder';
import { ensureWorkspacePath } from '../util/pathSafe';

export interface AgentProposal {
  plan: string[];
  edits: ProposedFileEdit[];
  commands: AgentCommand[];
  prompt: string;
  context: ParallelContextPayload;
  promptSummary: PromptBuildResult['summary'];
  dryRun: boolean;
}

interface ProposeResponse {
  plan: string[];
  edits: {
    filePath: string;
    newText?: string;
    diff?: string;
    mode?: 'replace' | 'diff' | 'search_replace' | 'insert';
    description?: string;
    range?: { start: { line: number; character: number }; end?: { line: number; character: number } };
    originalLines?: number[];
    searchReplace?: { search: string; replace: string; matchCase?: boolean; useRegex?: boolean };
  }[];
  commands?: AgentCommand[];
  dryRun?: boolean;
}

interface PlanResponse {
  plan: string[];
  files_to_read: string[];
  files_to_modify: string[];
  search_queries: string[];
  reasoning?: string;
}

export class AgentService {
  constructor(
    private contextService: ContextService,
    private workspaceProvider: () => string | null,
    private client: ParallelClient,
    private logger: Logger,
    private commandResultsProvider: () => AgentCommandResult[] = () => []
  ) {}

  async propose(
    userMessage: string,
    mode: 'dry-run' | 'apply'
  ): Promise<AgentProposal> {
    const workspaceId = this.workspaceProvider();
    if (!workspaceId) {
      throw new Error('Select a workspace before asking the agent.');
    }
    const context = await this.contextService.getContext();
    const planResult = await this.planIfEnabled(userMessage, context, workspaceId);
    const planFiles = mergePlanFiles(planResult);
    const semanticContext = await this.fetchSemanticContext(userMessage, workspaceId);
    const config = vscode.workspace.getConfiguration();
    const fullRepoContext = !!config.get<boolean>('parallel.agent.fullRepoContext');
    const fullRepoMaxFiles = config.get<number>('parallel.agent.fullRepoMaxFiles');
    const prompt = await collectPrompt(userMessage, context, mode, {
      commandResults: this.commandResultsProvider(),
      additionalFiles: planFiles,
      searchQueries: planResult?.search_queries ?? [],
      semanticContext,
      fullRepoContext,
      fullRepoMaxFiles,
    });
    const response = parseProposeResponse(
      await this.callProposeEndpoint(userMessage, prompt, mode, workspaceId)
    );
    const edits = await this.materializeEdits(response.edits);
    this.logger.audit(
      `Agent proposal prepared (${response.dryRun ? 'dry-run' : 'apply'}, files: ${edits.length})`
    );
    const plan =
      response.plan && response.plan.length
        ? response.plan
        : planResult?.plan?.length
          ? planResult.plan
          : this.buildPlan(userMessage, context);
    return {
      plan,
      edits,
      commands: response.commands ?? [],
      prompt: prompt.prompt,
      context,
      promptSummary: prompt.summary,
      dryRun: response.dryRun ?? mode === 'dry-run',
    };
  }

  async proposeStreaming(
    userMessage: string,
    mode: 'dry-run' | 'apply',
    onEvent?: (event: { type: string; text?: string; message?: string }) => void
  ): Promise<AgentProposal> {
    const workspaceId = this.workspaceProvider();
    if (!workspaceId) {
      throw new Error('Select a workspace before asking the agent.');
    }
    const context = await this.contextService.getContext();
    const planResult = await this.planIfEnabled(userMessage, context, workspaceId);
    const planFiles = mergePlanFiles(planResult);
    const semanticContext = await this.fetchSemanticContext(userMessage, workspaceId);
    const config = vscode.workspace.getConfiguration();
    const fullRepoContext = !!config.get<boolean>('parallel.agent.fullRepoContext');
    const fullRepoMaxFiles = config.get<number>('parallel.agent.fullRepoMaxFiles');
    const prompt = await collectPrompt(userMessage, context, mode, {
      commandResults: this.commandResultsProvider(),
      additionalFiles: planFiles,
      searchQueries: planResult?.search_queries ?? [],
      semanticContext,
      fullRepoContext,
      fullRepoMaxFiles,
    });
    const payload = {
      request: userMessage,
      mode,
      repo: {
        name: prompt.summary.repoName ?? prompt.summary.workspaceName ?? 'workspace',
        root: prompt.repoContext.root,
        open_files: prompt.repoContext.openFiles,
        allowNewFiles: true,
        files: prompt.repoContext.files,
        diagnostics: prompt.repoContext.diagnostics,
        gitDiffStat: prompt.repoContext.gitDiffStat,
        searchResults: prompt.repoContext.searchResults,
        commandResults: prompt.repoContext.commandResults,
        guides: prompt.repoContext.guides,
        symbols: prompt.repoContext.symbols,
        references: prompt.repoContext.references,
        hoverInfo: prompt.repoContext.hoverInfo,
        git: prompt.repoContext.git,
        semanticContext: prompt.repoContext.semanticContext,
      },
      parallelContext: {
        tasks: prompt.summary.tasks,
        conversations: prompt.summary.conversations,
      },
      prompt: prompt.prompt,
    };

    const response = await this.client.requestStream(
      `/api/v1/workspaces/${workspaceId}/vscode/agent/propose-stream`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
        redactBody: true,
      }
    );
    if (!response.body) {
      return this.propose(userMessage, mode);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finalPayload: any = null;
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      buffer += decoder.decode(result.value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const dataLine = part
          .split('\n')
          .find((line) => line.startsWith('data:'));
        if (!dataLine) {
          continue;
        }
        const json = dataLine.replace(/^data:\s*/, '');
        try {
          const payload = JSON.parse(json);
          if (payload.type === 'delta') {
            onEvent?.({ type: 'delta', text: payload.text });
          }
          if (payload.type === 'status') {
            onEvent?.({ type: 'status', message: payload.message });
          }
          if (payload.type === 'error') {
            onEvent?.({ type: 'error', message: payload.message });
          }
          if (payload.type === 'final') {
            finalPayload = payload.response;
          }
        } catch {
          continue;
        }
      }
    }
    if (!finalPayload) {
      return this.propose(userMessage, mode);
    }
    const parsed = parseProposeResponse(finalPayload);
    const edits = await this.materializeEdits(parsed.edits);
    return {
      plan: parsed.plan?.length
        ? parsed.plan
        : planResult?.plan?.length
          ? planResult.plan
          : this.buildPlan(userMessage, context),
      edits,
      commands: parsed.commands ?? [],
      prompt: prompt.prompt,
      context,
      promptSummary: prompt.summary,
      dryRun: parsed.dryRun ?? mode === 'dry-run',
    };
  }

  private async planIfEnabled(
    userMessage: string,
    context: ParallelContextPayload,
    workspaceId: string
  ): Promise<PlanResponse | null> {
    const config = vscode.workspace.getConfiguration();
    const enabled = !!config.get<boolean>('parallel.agent.planBeforePropose');
    if (!enabled) {
      return null;
    }
    try {
      const repo = await collectPrompt(userMessage, context, 'dry-run', {
        commandResults: this.commandResultsProvider(),
      });
      const response = await this.client.request<PlanResponse>(
        `/api/v1/workspaces/${workspaceId}/vscode/agent/plan`,
        {
          method: 'POST',
          body: JSON.stringify({
            request: userMessage,
            repo: {
              name: repo.summary.repoName ?? repo.summary.workspaceName ?? 'workspace',
              root: repo.repoContext.root,
              open_files: repo.repoContext.openFiles,
              allowNewFiles: true,
              files: repo.repoContext.files,
              diagnostics: repo.repoContext.diagnostics,
              gitDiffStat: repo.repoContext.gitDiffStat,
              searchResults: repo.repoContext.searchResults,
              guides: repo.repoContext.guides,
              symbols: repo.repoContext.symbols,
              references: repo.repoContext.references,
              hoverInfo: repo.repoContext.hoverInfo,
              git: repo.repoContext.git,
            },
            parallelContext: {
              tasks: repo.summary.tasks,
              conversations: repo.summary.conversations,
            },
          }),
          redactBody: true,
        }
      );
      return response;
    } catch (err) {
      this.logger.error('Agent plan failed', err);
      return null;
    }
  }

  private async fetchSemanticContext(
    userMessage: string,
    workspaceId: string
  ): Promise<RepoSemanticContext[]> {
    const config = vscode.workspace.getConfiguration();
    const enabled = !!config.get<boolean>('parallel.indexing.useSemanticContext');
    const indexingEnabled = !!config.get<boolean>('parallel.indexing.enabled');
    if (!enabled || !indexingEnabled || !userMessage.trim()) {
      return [];
    }
    try {
      const response = await this.client.request<{ results: any[] }>(
        `/api/v1/workspaces/${workspaceId}/vscode/index/search`,
        {
          method: 'POST',
          body: JSON.stringify({ query: userMessage, limit: 6 }),
          redactBody: true,
        }
      );
      return (response?.results ?? []).map((r) => ({
        file_path: r.file_path ?? r.file ?? '',
        content: r.content ?? '',
        score: r.score,
        metadata: coerceMetadata(r.metadata),
      }));
    } catch {
      return [];
    }
  }

  private buildPlan(userMessage: string, context: ParallelContextPayload): string[] {
    const steps = ['Review repository context', 'Blend Parallel tasks + chats', `Address: ${userMessage}`];
    if (context.tasks.length) {
      steps.push(`Align with task ${context.tasks[0].title ?? context.tasks[0].id}`);
    }
    return steps;
  }

  private async callProposeEndpoint(
    userMessage: string,
    prompt: CollectedPrompt,
    mode: 'dry-run' | 'apply',
    workspaceId: string
  ): Promise<ProposeResponse> {
    const repoName =
      prompt.summary.repoName ?? prompt.summary.workspaceName ?? 'workspace';
    try {
      return await this.client.request<ProposeResponse>(
        `/api/v1/workspaces/${workspaceId}/vscode/agent/propose`,
        {
          method: 'POST',
          body: JSON.stringify({
            request: userMessage,
            mode,
            repo: {
              name: repoName,
              root: prompt.repoContext.root,
              open_files: prompt.repoContext.openFiles,
              allowNewFiles: true,
              files: prompt.repoContext.files,
              diagnostics: prompt.repoContext.diagnostics,
              gitDiffStat: prompt.repoContext.gitDiffStat,
              searchResults: prompt.repoContext.searchResults,
              commandResults: prompt.repoContext.commandResults,
              guides: prompt.repoContext.guides,
              symbols: prompt.repoContext.symbols,
              references: prompt.repoContext.references,
              hoverInfo: prompt.repoContext.hoverInfo,
              git: prompt.repoContext.git,
              semanticContext: prompt.repoContext.semanticContext,
            },
            parallelContext: {
              tasks: prompt.summary.tasks,
              conversations: prompt.summary.conversations,
            },
            prompt: prompt.prompt,
          }),
          redactBody: true,
        }
      );
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        throw new Error('Parallel authentication required for agent. Please sign in again.');
      }
      this.logger.error('Agent propose failed', err);
      throw err;
    }
  }

  private async materializeEdits(edits: ProposeResponse['edits']): Promise<ProposedFileEdit[]> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || !workspaceFolders.length) {
      return [];
    }
    const root = workspaceFolders[0];
    const results: ProposedFileEdit[] = [];
    for (const edit of edits ?? []) {
      if (!edit.filePath || typeof edit.filePath !== 'string') {
        this.logger.error('Rejected edit with missing path or content');
        continue;
      }
      if (edit.newText !== undefined && typeof edit.newText !== 'string') {
        this.logger.error('Rejected edit with invalid content');
        continue;
      }
      if (!edit.newText && !edit.diff && !edit.searchReplace) {
        this.logger.error('Rejected edit with no content or diff');
        continue;
      }
      try {
        const resolved = await ensureWorkspacePath(root.uri.fsPath, edit.filePath);
        const diff =
          edit.diff ?? (edit.newText ? await buildDiffSafely(resolved.absolutePath, edit.newText) : undefined);
        results.push({
          filePath: resolved.absolutePath,
          relativePath: resolved.relativePath,
          newText: edit.newText,
          diff,
          mode: edit.mode,
          description: edit.description,
          range: edit.range,
          originalLines: edit.originalLines,
          searchReplace: edit.searchReplace,
        });
      } catch (err) {
        this.logger.error(`Rejected edit with unsafe path: ${edit.filePath}`, err);
      }
    }
    return results;
  }
}

const MAX_DIFF_FILE_BYTES = 1_000_000;
const MAX_NEW_TEXT_BYTES = 1_000_000;

async function buildDiffSafely(filePath: string, newText: string): Promise<string> {
  if (newText.length > MAX_NEW_TEXT_BYTES) {
    return `[diff omitted: generated content too large (~${Math.round(newText.length / 1024)} KB)]`;
  }
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_DIFF_FILE_BYTES) {
      return `[diff omitted: existing file too large (~${Math.round(stat.size / 1024)} KB)]`;
    }
  } catch {
    // file may not exist; continue with empty
  }
  const existingText = await readFileTextIfExists(filePath);
  return renderDiff(filePath, existingText ?? '', newText);
}

async function readFileTextIfExists(filePath: string): Promise<string | null> {
  try {
    const data = await fs.readFile(filePath);
    return data.toString('utf8');
  } catch {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      return doc.getText();
    } catch {
      return null;
    }
  }
}

function coerceMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parseProposeResponse(raw: any): ProposeResponse {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid agent response: expected object');
  }
  const plan =
    Array.isArray(raw.plan) && raw.plan.every((p: unknown) => typeof p === 'string') ? raw.plan : [];
  if (!Array.isArray(raw.edits)) {
    throw new Error('Invalid agent response: edits missing');
  }
  const edits = raw.edits
    .filter((e: any) => e && typeof e.filePath === 'string')
    .map((e: any) => ({
      filePath: e.filePath,
      newText: typeof e.newText === 'string' ? e.newText : undefined,
      diff: typeof e.diff === 'string' ? e.diff : undefined,
      mode: typeof e.mode === 'string' ? e.mode : undefined,
      description: typeof e.description === 'string' ? e.description : undefined,
      range: typeof e.range === 'object' ? e.range : undefined,
      originalLines: Array.isArray(e.originalLines) ? e.originalLines : undefined,
      searchReplace: typeof e.searchReplace === 'object' ? e.searchReplace : undefined,
    }));
  if (!edits.length && raw.edits.length) {
    throw new Error('Invalid agent response: no valid edits');
  }
  const commands = Array.isArray(raw.commands)
    ? raw.commands
        .filter((c: any) => c && typeof c.command === 'string')
        .map((c: any) => ({
          command: c.command,
          cwd: typeof c.cwd === 'string' ? c.cwd : undefined,
          purpose: typeof c.purpose === 'string' ? c.purpose : undefined,
          when: typeof c.when === 'string' ? c.when : undefined,
        }))
    : [];
  const dryRun = typeof raw.dryRun === 'boolean' ? raw.dryRun : undefined;
  return { plan, edits, commands, dryRun };
}

function mergePlanFiles(planResult: PlanResponse | null): string[] {
  if (!planResult) {
    return [];
  }
  const combined = [...(planResult.files_to_read ?? []), ...(planResult.files_to_modify ?? [])];
  const normalized = combined
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return Array.from(new Set(normalized));
}
