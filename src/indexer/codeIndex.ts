import * as vscode from 'vscode';

import { ParallelClient } from '../api/client';
import { Logger } from '../util/logger';

const FILE_EXCLUDES = '**/{.git,node_modules,dist,build,out,.next,.venv,.cache,coverage}/**';
const MAX_INDEX_FILES = 400;
const MAX_INDEX_FILE_BYTES = 200_000;
const BATCH_SIZE = 20;

export async function indexWorkspaceFiles(
  client: ParallelClient,
  workspaceId: string,
  logger: Logger
): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) {
    return;
  }
  const uris = await vscode.workspace.findFiles('**/*', FILE_EXCLUDES, MAX_INDEX_FILES);
  const payloads = [];
  for (const uri of uris) {
    const entry = await readIndexEntry(uri);
    if (entry) {
      payloads.push(entry);
    }
  }
  if (!payloads.length) {
    return;
  }
  let indexed = 0;
  for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
    const batch = payloads.slice(i, i + BATCH_SIZE);
    try {
      const response = await client.request<{ indexed: number }>(
        `/api/v1/workspaces/${workspaceId}/vscode/index`,
        {
          method: 'POST',
          body: JSON.stringify({ files: batch }),
          redactBody: true,
        }
      );
      indexed += response?.indexed ?? 0;
    } catch (err) {
      logger.error('Code index batch failed', err as Error);
    }
  }
  logger.info(`Indexed ${indexed} code chunks`);
}

export async function indexDocument(
  client: ParallelClient,
  workspaceId: string,
  document: vscode.TextDocument,
  logger: Logger
): Promise<void> {
  if (document.uri.scheme !== 'file') {
    return;
  }
  const entry = await readIndexEntry(document.uri, document);
  if (!entry) {
    return;
  }
  try {
    await client.request(`/api/v1/workspaces/${workspaceId}/vscode/index`, {
      method: 'POST',
      body: JSON.stringify({ files: [entry] }),
      redactBody: true,
    });
  } catch (err) {
    logger.error('Code index update failed', err as Error);
  }
}

async function readIndexEntry(
  uri: vscode.Uri,
  docOverride?: vscode.TextDocument
): Promise<{ path: string; content: string; language?: string } | null> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return null;
  }
  try {
    let content = '';
    if (docOverride) {
      content = docOverride.getText();
    } else {
      const data = await vscode.workspace.fs.readFile(uri);
      if (isBinary(data) || data.byteLength > MAX_INDEX_FILE_BYTES) {
        return null;
      }
      content = Buffer.from(data).toString('utf8');
    }
    if (!content.trim()) {
      return null;
    }
    const relative = vscode.workspace.asRelativePath(uri);
    return {
      path: relative,
      content,
      language: docOverride?.languageId ?? guessLanguage(uri),
    };
  } catch {
    return null;
  }
}

function isBinary(data: Uint8Array): boolean {
  const sample = data.slice(0, 1024);
  return sample.some((byte) => byte === 0);
}

function guessLanguage(uri: vscode.Uri): string | undefined {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
  return doc?.languageId;
}
