import * as vscode from 'vscode';

import { normalizeToken } from '../util/token';

export const PAT_SECRET_KEY = 'parallel.pat';
const REFRESH_SECRET_KEY = 'parallel.refreshToken';

export async function readPat(context: vscode.ExtensionContext): Promise<string | undefined> {
  const token = await context.secrets.get(PAT_SECRET_KEY);
  return normalizeToken(token);
}

export async function savePat(context: vscode.ExtensionContext, pat: string): Promise<void> {
  const normalized = normalizeToken(pat);
  if (!normalized) {
    return;
  }
  await context.secrets.store(PAT_SECRET_KEY, normalized);
}

export async function readRefreshToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  return context.secrets.get(REFRESH_SECRET_KEY);
}

export async function saveRefreshToken(
  context: vscode.ExtensionContext,
  refreshToken: string | undefined
): Promise<void> {
  if (!refreshToken) {
    await context.secrets.delete(REFRESH_SECRET_KEY);
    return;
  }
  await context.secrets.store(REFRESH_SECRET_KEY, refreshToken);
}

export async function clearAuthTokens(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(PAT_SECRET_KEY);
  await context.secrets.delete(REFRESH_SECRET_KEY);
}
