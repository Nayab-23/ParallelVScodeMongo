import { spawn } from 'child_process';
import { formatPatch, parsePatch } from 'diff';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

import { AgentCommand, AgentCommandResult, CommandHistory } from './agent/commandHistory';
import { AgentProposal, AgentService } from './agent/agentService';
import { fetchBootstrap, BootstrapResponse } from './api/bootstrap';
import { HttpError, ParallelClient } from './api/client';
import { clearAuthTokens, readPat, readRefreshToken, savePat, saveRefreshToken } from './auth/session';
import { fetchSyncPage, SyncEntity, SyncService } from './api/sync';
import { ParallelCompletionProvider } from './completions/provider';
import { ContextService } from './context/contextService';
import type { ApplyResult, ProposedFileEdit } from './edits/pipeline';
import { applyWithWorkspace } from './edits/vscodeApply';
import { MockBackend } from './mock/backend';
import { RealtimeClient, RealtimeStatus } from './realtime/sse';
import { indexDocument, indexWorkspaceFiles } from './indexer/codeIndex';
import { ensureMigrations } from './store/migrations';
import { EntityRecord, Store } from './store/store';
import { TerminalMonitor } from './terminal/monitor';
import { AgentPanel } from './ui/agentPanel';
import { ChatSidebarProvider } from './ui/chatSidebar';
import { SearchTreeDataProvider } from './ui/views';
import { DetailsPanel } from './ui/webview';
import { Logger, LogLevel } from './util/logger';
import { nowIso } from './util/time';
import { normalizeToken } from './util/token';
import { ensureWorkspacePath } from './util/pathSafe';

const API_BASE_URL_KEY = 'parallel.apiBaseUrl';
const LEGACY_SERVER_URL_KEY = 'parallel.serverUrl';
const WEB_BASE_URL_KEY = 'parallel.webBaseUrl';
const LEGACY_WEB_APP_URL_KEY = 'parallel.webAppUrl';
const REQUEST_TIMEOUT_KEY = 'parallel.requestTimeoutMs';
const SYNC_REQUEST_TIMEOUT_KEY = 'parallel.sync.requestTimeoutMs';
const SYNC_PAGE_SIZE_KEY = 'parallel.sync.pageSize';
const STREAM_RESPONSES_KEY = 'parallel.streamResponses';
const WORKSPACE_ID_KEY = 'parallel.workspaceId';
const BOOTSTRAP_KEY = 'parallel.bootstrap';
const FULL_PERMISSION_KEY = 'parallel.fullPermission';
const LEGACY_TOKEN_KEY = 'parallel.token';
const OAUTH_PENDING_KEY = 'parallel.oauth.pending';
const DEVICE_ID_KEY = 'parallel.deviceId';
const OAUTH_CLIENT_ID = 'vscode-extension';
const OAUTH_SCOPES = [
  'openid',
  'profile',
  'email',
  'read',
  'write',
  'tasks:read',
  'tasks:write',
  'chats:read',
  'chats:write',
  'workspaces:read',
  'edits:propose',
  'files:read',
  'files:search',
  'edits:apply',
  'commands:run',
  'terminal:write',
  'edits:undo',
  'completions:read',
  'index:read',
  'index:write',
  'explain:read',
  'tests:write',
  'git:read',
];
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_API_BASE_URL = 'http://localhost:8000';
const DEFAULT_WEB_BASE_URL = 'http://localhost:5173';
const HEARTBEAT_INTERVAL_MS = 20_000;
const INBOX_POLL_INTERVAL_MS = 5_000;
const INBOX_PROCESSED_KEY = 'parallel.inbox.processedTasks';
const MAX_INBOX_PROCESSED = 200;
const INBOX_POLL_LIMIT = 20;

type ViewRefresher = {
  refresh: () => void;
  refreshSessions?: () => Promise<void>;
  handleSignedOut?: () => void;
};

type SignInMode = 'browser' | 'manual';

type SignInOptions = {
  mode?: SignInMode;
  apiBaseUrl?: string;
  token?: string;
};

type OAuthPending = {
  state: string;
  verifier: string;
  redirectUri: string;
  apiBaseUrl: string;
  createdAt: number;
};

let statusBarItem: vscode.StatusBarItem | null = null;
let realtimeClient: RealtimeClient | null = null;
let syncTimer: NodeJS.Timeout | null = null;
let mockStreamStop: (() => void) | null = null;
let syncInFlight = false;
let connectionStatus: RealtimeStatus = 'disconnected';
let bootstrapCache: BootstrapResponse | null = null;
let mockBackend: MockBackend | null = null;
let contextService: ContextService | null = null;
let agentService: AgentService | null = null;
let agentPanel: AgentPanel | null = null;
let commandHistory: CommandHistory | null = null;
let chatSidebarProvider: ChatSidebarProvider | null = null;
let fullPermission = false;
let isSignedIn = false;
let permissionNeedsReconfirm = false;
let authFingerprint: string | null = null;
let oauthPending: OAuthPending | null = null;
let activeClient: ParallelClient | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let inboxPollTimer: NodeJS.Timeout | null = null;
let inboxPollInFlight = false;
let deviceIdCache: string | null = null;
let repoMetadataCache: { workspaceRoot: string; repoRoot: string; repoId: string } | null = null;
type EditHistoryEntry = {
  id: string;
  workspaceId: string;
  createdAt: number;
  files: string[];
  original: Record<string, string>;
  updated: Record<string, string>;
  description?: string;
};
const MAX_UNDO_HISTORY = 10;
let undoHistory: EditHistoryEntry[] = [];
let inboxProcessedTasks: string[] = [];
let inboxProcessedSet = new Set<string>();
const inboxInProgress = new Set<string>();
const oauthCallbacks = new Map<
  string,
  { resolve: () => void; reject: (err: Error) => void; timeout: NodeJS.Timeout }
>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  await ensureStorageFolder(context);
  ensureMigrations();

  const outputChannel = vscode.window.createOutputChannel('Parallel');
  const logger = new Logger(outputChannel, getLoggingLevel());

  const apiBaseUrl = readApiBaseUrl(context);
  let pat = await readPat(context);
  const migratedToken = await migrateLegacyToken(context, pat);
  if (!pat && migratedToken) {
    pat = migratedToken;
  }
  isSignedIn = !!pat;
  fullPermission = context.globalState.get<boolean>(FULL_PERMISSION_KEY) ?? false;
  authFingerprint = pat ? hashToken(pat) : null;
  permissionNeedsReconfirm = fullPermission;
  deviceIdCache = context.globalState.get<string>(DEVICE_ID_KEY) ?? null;
  inboxProcessedTasks = context.globalState.get<string[]>(INBOX_PROCESSED_KEY) ?? [];
  inboxProcessedSet = new Set(inboxProcessedTasks);
  const store = new Store(context.globalStorageUri.fsPath, {
    maxEntitiesPerType: getCacheLimit(),
  });
  const client = new ParallelClient(apiBaseUrl, pat ?? undefined, logger, {
    requestTimeoutMs: readRequestTimeoutMs(),
  });
  activeClient = client;
  client.setRefreshHandler(() => refreshAccessToken(context, client, logger));
  mockBackend = ensureMockBackend();
  let syncService = buildSyncService(client, store, logger);
  const detailsPanel = new DetailsPanel(context.extensionUri);
  contextService = new ContextService(
    context.globalState,
    client,
    logger,
    () => getWorkspaceId(context),
    {
      apiBaseProvider: () => client.getApiBaseUrl(),
      userIdProvider: () => bootstrapCache?.user.id,
      authFingerprintProvider: () => authFingerprint ?? undefined,
    }
  );
  commandHistory = new CommandHistory(10);
  agentService = new AgentService(
    contextService,
    () => getWorkspaceId(context),
    client,
    logger,
    () => commandHistory?.list() ?? []
  );
  agentPanel = new AgentPanel(
    context.extensionUri,
    agentService,
    (edits, options) => applyAgentEdits(edits, options, logger),
    (commands) => runAgentCommands(commands, logger, commandHistory),
    () => fullPermission
  );

  const searchProvider = new SearchTreeDataProvider(store);
  let sidebarProvider: ChatSidebarProvider;
  const authActions = {
    startBrowserSignIn: (desiredUrl?: string) =>
      signIn(context, client, store, logger, syncService, sidebarProvider, {
        mode: 'browser',
        apiBaseUrl: desiredUrl,
      }),
  };
  const agentActions = {
    submitAgentPrompt: async (text: string, mode: 'dry-run' | 'apply') => {
      if (!agentPanel) {
        agentPanel = new AgentPanel(
          context.extensionUri,
          agentService!,
          (edits, options) => applyAgentEdits(edits, options, logger),
          (commands) => runAgentCommands(commands, logger, commandHistory),
          () => fullPermission
        );
      }
      await agentPanel.submitPrompt(text, mode);
    },
  };
  sidebarProvider = new ChatSidebarProvider(
    context,
    client,
    store,
    logger,
    () => getWorkspaceInfo(context),
    () => bootstrapCache?.user ?? null,
    () => connectionStatus,
    () => isSignedIn,
    authActions,
    agentActions
  );
  chatSidebarProvider = sidebarProvider;

  vscode.window.registerWebviewViewProvider('parallelChatView', sidebarProvider, {
    webviewOptions: { retainContextWhenHidden: true },
  });
  vscode.window.registerTreeDataProvider('parallelSearchView', searchProvider);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'parallel.selectWorkspace';
  statusBarItem.tooltip = 'Parallel status';
  statusBarItem.show();
  if (fullPermission) {
    vscode.window.showWarningMessage(
      'Parallel Full Permission was enabled previously. You will be asked to reconfirm before applying edits.'
    );
  }

  const authHandler: vscode.UriHandler = {
    handleUri: (uri: vscode.Uri) =>
      handleAuthCallback(context, client, store, logger, syncService, sidebarProvider, uri),
  };

  const completionProvider = new ParallelCompletionProvider(
    store,
    client,
    logger,
    () => {
      const config = vscode.workspace.getConfiguration();
      return {
        enabled: !!config.get<boolean>('parallel.completion.enabled'),
        endpoint: config.get<string>('parallel.completion.endpoint') ?? '',
        maxSuggestions: config.get<number>('parallel.completion.maxSuggestions') ?? 3,
        minPrefixChars: config.get<number>('parallel.completion.minPrefixChars') ?? 8,
        maxPrefixChars: config.get<number>('parallel.completion.maxPrefixChars') ?? 4000,
        maxSuffixChars: config.get<number>('parallel.completion.maxSuffixChars') ?? 2000,
        debounceMs: config.get<number>('parallel.completion.debounceMs') ?? 120,
        stream: !!config.get<boolean>('parallel.completion.stream'),
        progressiveThrottleMs: config.get<number>('parallel.completion.progressiveThrottleMs') ?? 60,
      };
    },
    () => store.getActiveWorkspace()
  );
  const terminalMonitor = new TerminalMonitor(
    () => activeClient,
    () => getWorkspaceId(context),
    () => isSignedIn,
    logger
  );

  context.subscriptions.push(
    vscode.window.registerUriHandler(authHandler),
    sidebarProvider,
    outputChannel,
    statusBarItem,
    vscode.commands.registerCommand('parallel.signIn', (options?: SignInOptions) =>
      signIn(
        context,
        client,
        store,
        logger,
        syncService,
        chatSidebarProvider ?? undefined,
        options
      ).catch((err) => handleError(err, 'Sign in failed'))
    ),
    vscode.commands.registerCommand('parallel.signOut', () =>
      signOut(context, client, store, logger, chatSidebarProvider ?? undefined).catch((err) =>
        handleError(err, 'Sign out failed')
      )
    ),
    vscode.commands.registerCommand('parallel.openProfileMenu', () =>
      openProfileMenu(
        context,
        client,
        store,
        logger,
        syncService,
        chatSidebarProvider ?? undefined
      ).catch((err) => handleError(err, 'Open profile menu failed'))
    ),
    vscode.commands.registerCommand('parallel.selectWorkspace', () =>
      selectWorkspace(
        context,
        client,
        store,
        logger,
        syncService,
        chatSidebarProvider ?? undefined,
        { forcePrompt: true }
      ).catch((err) => handleError(err, 'Workspace selection failed'))
    ),
    vscode.commands.registerCommand('parallel.forceSync', () =>
      runSync(context, syncService, store, logger, false, chatSidebarProvider ?? undefined).catch((err) =>
        handleError(err, 'Sync failed')
      )
    ),
    vscode.commands.registerCommand('parallel.forceFullResync', () =>
      forceFullResync(context, syncService, store, logger, chatSidebarProvider ?? undefined).catch((err) =>
        handleError(err, 'Full resync failed')
      )
    ),
    vscode.commands.registerCommand('parallel.openWebApp', () =>
      openWebApp(context).catch((err) => handleError(err, 'Open web app failed'))
    ),
    vscode.commands.registerCommand('parallel.insertContextSummary', () =>
      insertContextSummary(store).catch((err) => handleError(err, 'Insert summary failed'))
    ),
    vscode.commands.registerCommand('parallel.search.prompt', async () => {
      const query = await vscode.window.showInputBox({ prompt: 'Search Parallel cache' });
      if (query !== undefined) {
        searchProvider.setQuery(query.trim());
      }
    }),
    vscode.commands.registerCommand('parallel.openDetails', (record: EntityRecord) =>
      detailsPanel.show(record)
    ),
    vscode.commands.registerCommand('parallel.refreshContext', () =>
      refreshContext(context, logger).catch((err) =>
        handleError(err, 'Context refresh failed')
      )
    ),
    vscode.commands.registerCommand('parallel.agent.open', () => {
      agentPanel?.show();
      logger.audit('Agent panel opened');
    }),
    vscode.commands.registerCommand('parallel.toggleFullPermission', () =>
      toggleFullPermission(context, logger).catch((err) =>
        handleError(err, 'Permission toggle failed')
      )
    ),
    vscode.commands.registerCommand('parallel.agent.undo', () =>
      undoLastAgentEdit(logger).catch((err) =>
        handleError(err, 'Undo failed')
      )
    ),
    vscode.commands.registerCommand('parallel.indexWorkspace', () =>
      runWorkspaceIndex(logger).catch((err) =>
        handleError(err, 'Index workspace failed')
      )
    ),
    vscode.commands.registerCommand('parallel.explainSelection', () =>
      explainSelection(logger).catch((err) =>
        handleError(err, 'Explain selection failed')
      )
    ),
    vscode.commands.registerCommand('parallel.generateTests', () =>
      generateTestsForSelection(logger).catch((err) =>
        handleError(err, 'Generate tests failed')
      )
    ),
    vscode.commands.registerCommand('parallel.chat.askSelection', () =>
      askSelectionInChat(logger).catch((err) =>
        handleError(err, 'Chat selection failed')
      )
    ),
    vscode.commands.registerCommand('parallel.inlineCompletions.showAlternatives', () =>
      showInlineCompletionAlternatives(completionProvider).catch((err) =>
        handleError(err, 'Inline alternatives failed')
      )
    ),
    vscode.commands.registerCommand('parallel.cycleCompletionNext', () =>
      vscode.commands.executeCommand('editor.action.inlineSuggest.showNext')
    ),
    vscode.commands.registerCommand('parallel.cycleCompletionPrevious', () =>
      vscode.commands.executeCommand('editor.action.inlineSuggest.showPrevious')
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('parallel.logging.level')) {
        logger.setLevel(getLoggingLevel());
      }
      if (e.affectsConfiguration('parallel.cache.maxEntitiesPerType')) {
        store.setMaxEntitiesPerType(getCacheLimit());
      }
      if (
        e.affectsConfiguration('parallel.apiBaseUrl') ||
        e.affectsConfiguration('parallel.serverUrl')
      ) {
        client.setApiBaseUrl(readApiBaseUrl(context));
        contextService?.invalidate();
      }
      if (e.affectsConfiguration('parallel.requestTimeoutMs')) {
        client.setRequestTimeoutMs(readRequestTimeoutMs());
      }
      if (e.affectsConfiguration('parallel.dev.mockBackend')) {
        mockBackend = ensureMockBackend();
        syncService = buildSyncService(client, store, logger);
        restartRealtime(context, client, store, logger);
      }
      if (
        e.affectsConfiguration('parallel.sse.enabled') ||
        e.affectsConfiguration('parallel.apiBaseUrl') ||
        e.affectsConfiguration('parallel.serverUrl')
      ) {
        restartRealtime(context, client, store, logger);
      }
      if (e.affectsConfiguration('parallel.sync.intervalSeconds')) {
        startSyncLoop(context, syncService, store, logger, chatSidebarProvider ?? undefined);
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**/*' }, completionProvider)
  );
  setupInlineCompletionAutoTrigger(context, logger);
  terminalMonitor.activate(context);

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const enabled = !!vscode.workspace.getConfiguration().get<boolean>('parallel.indexing.enabled');
      const workspaceId = vscode.workspace.getConfiguration().get<string>(WORKSPACE_ID_KEY) ?? '';
      if (enabled && activeClient && workspaceId) {
        void indexDocument(activeClient, workspaceId, doc, logger);
      }
      void recordCodeEventFromSave(doc, context, logger);
    })
  );

  const disposeStore = store.onDidChange(() => {
    chatSidebarProvider?.refresh();
    searchProvider.refresh();
  });
  context.subscriptions.push({ dispose: disposeStore });

  bootstrapCache = (context.globalState.get(BOOTSTRAP_KEY) as BootstrapResponse | null) ?? null;
  const workspaceId = getWorkspaceId(context);
  if (workspaceId) {
    store.setActiveWorkspace(workspaceId);
    try {
      await store.load(workspaceId);
    } catch (err) {
      logger.error('Failed to load local cache; resetting.', err as Error);
      await store.clearWorkspace(workspaceId);
    }
    const mockEnabled = isMockEnabled();
    if (!pat && !mockEnabled) {
      updateStatusBar('Disconnected', workspaceId);
      return;
    }
    try {
      await runSync(context, syncService, store, logger, false, chatSidebarProvider ?? undefined);
    } catch (err) {
      logger.error('Initial sync failed', err as Error);
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showWarningMessage(`Parallel sync failed: ${message}`);
    }
    try {
      await startSyncLoop(context, syncService, store, logger, chatSidebarProvider ?? undefined);
    } catch (err) {
      logger.error('Failed to start sync loop', err as Error);
    }
    try {
      await startRealtime(context, client, store, logger);
    } catch (err) {
      logger.error('Failed to start realtime', err as Error);
    }
    const indexingEnabled = !!vscode.workspace.getConfiguration().get<boolean>('parallel.indexing.enabled');
    if (indexingEnabled && isSignedIn) {
      void indexWorkspaceFiles(client, workspaceId, logger);
    }
    startExtensionInboxAndHeartbeat(context, logger);
  } else {
    updateStatusBar('Disconnected', null);
  }
}

export function deactivate(): void {
  realtimeClient?.stop();
  mockStreamStop?.();
  stopExtensionInboxAndHeartbeat();
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

async function ensureStorageFolder(context: vscode.ExtensionContext): Promise<void> {
  await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });
}

function readApiBaseUrl(context: vscode.ExtensionContext): string {
  const stored =
    context.globalState.get<string>(API_BASE_URL_KEY) ??
    context.globalState.get<string>(LEGACY_SERVER_URL_KEY);
  const config = vscode.workspace.getConfiguration();
  const configured = readConfiguredString(config, API_BASE_URL_KEY);
  const legacyConfigured = readConfiguredString(config, LEGACY_SERVER_URL_KEY);
  const candidate =
    stored ?? configured ?? legacyConfigured ?? config.get<string>(API_BASE_URL_KEY) ?? DEFAULT_API_BASE_URL;
  return sanitizeBaseUrl(candidate) ?? DEFAULT_API_BASE_URL;
}

function readWebBaseUrl(): string {
  const config = vscode.workspace.getConfiguration();
  const configured = readConfiguredString(config, WEB_BASE_URL_KEY);
  const legacyConfigured = readConfiguredString(config, LEGACY_WEB_APP_URL_KEY);
  const candidate =
    configured ?? legacyConfigured ?? config.get<string>(WEB_BASE_URL_KEY) ?? DEFAULT_WEB_BASE_URL;
  return sanitizeBaseUrl(candidate) ?? DEFAULT_WEB_BASE_URL;
}

function readRequestTimeoutMs(): number | undefined {
  const value = vscode.workspace.getConfiguration().get<number>(REQUEST_TIMEOUT_KEY);
  if (value === undefined || value === null || value <= 0) {
    return undefined;
  }
  return value;
}

function readSyncRequestTimeoutMs(): number | undefined {
  const value = vscode.workspace.getConfiguration().get<number>(SYNC_REQUEST_TIMEOUT_KEY);
  if (value === undefined || value === null || value <= 0) {
    return undefined;
  }
  return value;
}

function readSyncPageSize(): number {
  const value = vscode.workspace.getConfiguration().get<number>(SYNC_PAGE_SIZE_KEY);
  if (value === undefined || value === null || value <= 0) {
    return 200;
  }
  return Math.min(Math.max(value, 1), 500);
}

function readStreamResponses(): boolean {
  return !!vscode.workspace.getConfiguration().get<boolean>(STREAM_RESPONSES_KEY);
}

function readConfiguredString(
  config: vscode.WorkspaceConfiguration,
  key: string
): string | undefined {
  const inspected = config.inspect<string>(key);
  return (
    inspected?.workspaceFolderValue ??
    inspected?.workspaceValue ??
    inspected?.globalValue
  );
}

function getWorkspaceId(context: vscode.ExtensionContext): string | null {
  return (
    context.globalState.get<string>(WORKSPACE_ID_KEY) ??
    vscode.workspace.getConfiguration().get<string>('parallel.workspaceId') ??
    null
  );
}

function getLoggingLevel(): LogLevel {
  return (
    (vscode.workspace.getConfiguration().get<string>('parallel.logging.level') as LogLevel) ??
    'info'
  );
}

function getCacheLimit(): number {
  const value = vscode.workspace.getConfiguration().get<number>('parallel.cache.maxEntitiesPerType');
  if (value === undefined || value === null || value <= 0) {
    return Infinity;
  }
  return value;
}

function getWorkspaceInfo(context: vscode.ExtensionContext): { id: string | null; name?: string } {
  const id = getWorkspaceId(context);
  const ws = bootstrapCache?.workspaces.find((w) => w.id === id);
  return { id, name: ws?.name };
}

async function signIn(
  context: vscode.ExtensionContext,
  client: ParallelClient,
  store: Store,
  logger: Logger,
  syncService: SyncService,
  viewRefresher?: ViewRefresher,
  options?: SignInOptions
): Promise<void> {
  const demoEnabled = isDemoModeEnabled();
  const mockEnabled = isMockEnabled();
  const mode = options?.mode ?? 'browser';
  const apiBaseUrl = await resolveApiBaseUrl(context, options?.apiBaseUrl);
  if (!apiBaseUrl) {
    return;
  }
  if (demoEnabled) {
    await signInWithDemo(context, client, store, logger, syncService, viewRefresher, apiBaseUrl);
    return;
  }
  if (mockEnabled) {
    await signInWithMock(context, client, store, logger, syncService, viewRefresher, apiBaseUrl);
    return;
  }
  if (mode === 'manual') {
    if (!options?.token) {
      throw new Error('Token sign-in is disabled. Use browser sign-in instead.');
    }
    await manualTokenSignIn(
      context,
      client,
      store,
      logger,
      syncService,
      viewRefresher,
      apiBaseUrl,
      options.token
    );
    return;
  }
  await beginBrowserSignIn(context, apiBaseUrl, logger);
}

async function signOut(
  context: vscode.ExtensionContext,
  client: ParallelClient,
  store: Store,
  logger: Logger,
  viewRefresher?: ViewRefresher
): Promise<void> {
  const previousWorkspaceId = getWorkspaceId(context);
  const refreshToken = await readRefreshToken(context);
  if (refreshToken) {
    await revokeOAuthToken(refreshToken, readApiBaseUrl(context), logger);
  }
  await clearAuthTokens(context);
  isSignedIn = false;
  authFingerprint = null;
  bootstrapCache = null;
  oauthPending = null;
  commandHistory?.clear();
  await context.globalState.update(BOOTSTRAP_KEY, undefined);
  await context.globalState.update(WORKSPACE_ID_KEY, undefined);
  await context.globalState.update(OAUTH_PENDING_KEY, undefined);
  store.setActiveWorkspace(null);
  client.setToken(undefined);
  realtimeClient?.stop();
  realtimeClient = null;
  mockStreamStop?.();
  mockStreamStop = null;
  stopExtensionInboxAndHeartbeat();
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  syncInFlight = false;
  connectionStatus = 'disconnected';
  await vscode.workspace.getConfiguration().update('parallel.workspaceId', '', true);
  if (previousWorkspaceId) {
    contextService?.invalidate(previousWorkspaceId);
  }
  updateStatusBar('Disconnected', null);
  viewRefresher?.handleSignedOut?.();
  viewRefresher?.refresh();
  logger.audit('Signed out');
  vscode.window.showInformationMessage('Signed out of Parallel.');
}

async function refreshAccessToken(
  context: vscode.ExtensionContext,
  client: ParallelClient,
  logger: Logger
): Promise<{ accessToken: string; refreshToken?: string } | null> {
  const refreshToken = await readRefreshToken(context);
  if (!refreshToken) {
    return null;
  }
  const apiBaseUrl = readApiBaseUrl(context);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });
  try {
    const response = await fetch(new URL('/api/oauth/token', apiBaseUrl).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      logger.error(`OAuth refresh failed (HTTP ${response.status})`, detail || undefined);
      return null;
    }
    const payload = (await response.json()) as OAuthTokenResponse;
    const accessToken = normalizeToken(payload.access_token);
    if (!accessToken) {
      return null;
    }
    await savePat(context, accessToken);
    await saveRefreshToken(context, payload.refresh_token ?? refreshToken);
    authFingerprint = hashToken(accessToken);
    isSignedIn = true;
    client.setToken(accessToken);
    return { accessToken, refreshToken: payload.refresh_token };
  } catch (err) {
    logger.error('OAuth refresh failed', err);
    return null;
  }
}

async function revokeOAuthToken(
  refreshToken: string,
  apiBaseUrl: string,
  logger: Logger
): Promise<void> {
  const body = new URLSearchParams({
    token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });
  try {
    const response = await fetch(new URL('/api/oauth/revoke', apiBaseUrl).toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) {
      logger.error(`OAuth revoke failed (HTTP ${response.status})`);
    }
  } catch (err) {
    logger.error('OAuth revoke failed', err);
  }
}

async function openProfileMenu(
  context: vscode.ExtensionContext,
  client: ParallelClient,
  store: Store,
  logger: Logger,
  syncService: SyncService,
  viewRefresher?: ViewRefresher
): Promise<void> {
  const demoEnabled = isDemoModeEnabled();
  const items = isSignedIn
    ? [
        { label: 'Sign out', action: 'signOut' },
        { label: 'Open Web App', action: 'openWebApp' },
        { label: 'Settings', action: 'settings' },
      ]
    : [
        { label: demoEnabled ? 'Sign in (Demo Mode)' : 'Sign in with Browser', action: 'signInBrowser' },
        { label: 'Settings', action: 'settings' },
      ];
  const pick = await vscode.window.showQuickPick(items, {
    title: 'Parallel Account',
    ignoreFocusOut: true,
  });
  if (!pick) {
    return;
  }
  switch (pick.action) {
    case 'signOut':
      logger.info('Profile menu: sign out');
      await signOut(context, client, store, logger, viewRefresher);
      return;
    case 'openWebApp':
      logger.info('Profile menu: open web app');
      await openWebApp(context);
      return;
    case 'settings':
      logger.info('Profile menu: open settings');
      await vscode.commands.executeCommand('workbench.action.openSettings', 'parallel');
      return;
    case 'signInBrowser':
      logger.info('Profile menu: sign in with browser');
      await signIn(context, client, store, logger, syncService, viewRefresher, {
        mode: 'browser',
      });
      return;
    default:
      return;
  }
}

async function resolveApiBaseUrl(
  context: vscode.ExtensionContext,
  provided?: string
): Promise<string | null> {
  if (provided !== undefined) {
    const candidate = provided.trim() || readApiBaseUrl(context);
    const sanitized = sanitizeBaseUrl(candidate);
    if (!sanitized) {
      vscode.window.showErrorMessage('Invalid API base URL. Use http(s)://host[:port].');
      return null;
    }
    return sanitized;
  }
  const existingServer = readApiBaseUrl(context);
  const apiBaseUrl = await vscode.window.showInputBox({
    prompt: 'Parallel API base URL',
    value: existingServer,
    ignoreFocusOut: true,
  });
  if (!apiBaseUrl) {
    return null;
  }
  const sanitized = sanitizeBaseUrl(apiBaseUrl);
  if (!sanitized) {
    vscode.window.showErrorMessage('Invalid API base URL. Use http(s)://host[:port].');
    return null;
  }
  return sanitized;
}

async function signInWithMock(
  context: vscode.ExtensionContext,
  client: ParallelClient,
  store: Store,
  logger: Logger,
  syncService: SyncService,
  viewRefresher: ViewRefresher | undefined,
  apiBaseUrl: string
): Promise<void> {
  client.setApiBaseUrl(apiBaseUrl);
  client.setToken('mock-token');
  const bootstrap = ensureMockBackend()?.bootstrap();
  if (!bootstrap) {
    vscode.window.showErrorMessage('Mock backend unavailable.');
    return;
  }
  await finalizeSignIn(
    context,
    client,
    store,
    logger,
    syncService,
    viewRefresher,
    apiBaseUrl,
    'mock-token',
    bootstrap,
    { storeToken: false, authFingerprint: 'mock' }
  );
}

async function signInWithDemo(
  context: vscode.ExtensionContext,
  client: ParallelClient,
  store: Store,
  logger: Logger,
  syncService: SyncService,
  viewRefresher: ViewRefresher | undefined,
  apiBaseUrl: string
): Promise<void> {
  const demoToken = 'demo-token';
  client.setApiBaseUrl(apiBaseUrl);
  client.setToken(demoToken);
  const bootstrap = await fetchBootstrap(client);
  await finalizeSignIn(
    context,
    client,
    store,
    logger,
    syncService,
    viewRefresher,
    apiBaseUrl,
    demoToken,
    bootstrap,
    { authFingerprint: 'demo' }
  );
}

async function manualTokenSignIn(
  context: vscode.ExtensionContext,
  client: ParallelClient,
  store: Store,
  logger: Logger,
  syncService: SyncService,
  viewRefresher: ViewRefresher | undefined,
  apiBaseUrl: string,
  tokenInput: string
): Promise<void> {
  const normalized = normalizeToken(tokenInput);
  if (!normalized) {
    throw new Error('Token is required for sign in.');
  }
  const previousBaseUrl = client.getApiBaseUrl();
  const previousToken = await readPat(context);
  client.setApiBaseUrl(apiBaseUrl);
  client.setToken(normalized);
  try {
    const bootstrap = await fetchBootstrap(client);
    await finalizeSignIn(
      context,
      client,
      store,
      logger,
      syncService,
      viewRefresher,
      apiBaseUrl,
      normalized,
      bootstrap
    );
  } catch (err) {
    client.setApiBaseUrl(previousBaseUrl);
    client.setToken(previousToken);
    throw new Error(formatAuthError(err, 'Authentication failed'));
  }
}

async function beginBrowserSignIn(
  context: vscode.ExtensionContext,
  apiBaseUrl: string,
  logger: Logger
): Promise<void> {
  const { verifier, challenge } = generatePkce();
  const state = randomBase64Url(16);
  const redirectUri = getRedirectUri(context);
  const authUrl = buildAuthorizeUrl(apiBaseUrl, redirectUri, state, challenge);
  const pending: OAuthPending = {
    state,
    verifier,
    redirectUri,
    apiBaseUrl,
    createdAt: Date.now(),
  };
  oauthPending = pending;
  await context.globalState.update(OAUTH_PENDING_KEY, pending);
  if (oauthCallbacks.size) {
    oauthCallbacks.forEach(({ reject, timeout }) => {
      clearTimeout(timeout);
      reject(new Error('Previous sign-in attempt canceled.'));
    });
    oauthCallbacks.clear();
  }
  const started = await vscode.env.openExternal(vscode.Uri.parse(authUrl));
  if (!started) {
    await context.globalState.update(OAUTH_PENDING_KEY, undefined);
    oauthPending = null;
    throw new Error('Unable to open browser for sign in.');
  }
  logger.info('OAuth sign-in started');
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      oauthCallbacks.delete(state);
      oauthPending = null;
      void context.globalState.update(OAUTH_PENDING_KEY, undefined);
      reject(new Error('Sign-in timed out. Please try again.'));
    }, OAUTH_TIMEOUT_MS);
    oauthCallbacks.set(state, { resolve, reject, timeout });
  });
}

async function handleAuthCallback(
  context: vscode.ExtensionContext,
  client: ParallelClient,
  store: Store,
  logger: Logger,
  syncService: SyncService,
  viewRefresher: ViewRefresher | undefined,
  uri: vscode.Uri
): Promise<void> {
  const route = uri.path.replace(/^\//, '');
  if (route !== 'auth-callback' && route !== 'auth') {
    return;
  }
  const params = new URLSearchParams(uri.query);
  const error = params.get('error');
  const errorDescription = params.get('error_description');
  const state = params.get('state') ?? '';
  const code = params.get('code');
  if (error) {
    const message = `OAuth error: ${error}${errorDescription ? ` (${errorDescription})` : ''}`;
    await failOAuth(context, state, new Error(message));
    return;
  }
  if (!code) {
    await failOAuth(context, state, new Error('OAuth response missing code.'));
    return;
  }
  const pending = await loadOAuthPending(context);
  if (!pending || !pending.state || pending.state !== state) {
    await failOAuth(context, state, new Error('OAuth state mismatch. Please retry sign in.'));
    return;
  }
  try {
    const tokenResponse = await exchangeAuthCode(
      client,
      pending.apiBaseUrl,
      pending.redirectUri,
      pending.verifier,
      code
    );
    const accessToken = normalizeToken(tokenResponse.access_token);
    if (!accessToken) {
      throw new Error('OAuth response missing access token.');
    }
    client.setApiBaseUrl(pending.apiBaseUrl);
    client.setToken(accessToken);
    const bootstrap = await fetchBootstrap(client);
    await finalizeSignIn(
      context,
      client,
      store,
      logger,
      syncService,
      viewRefresher,
      pending.apiBaseUrl,
      accessToken,
      bootstrap,
      { refreshToken: tokenResponse.refresh_token }
    );
    await completeOAuth(context, state);
  } catch (err) {
    logger.error('OAuth sign-in failed', err);
    await failOAuth(context, state, err);
  }
}

async function finalizeSignIn(
  context: vscode.ExtensionContext,
  client: ParallelClient,
  store: Store,
  logger: Logger,
  syncService: SyncService,
  viewRefresher: ViewRefresher | undefined,
  apiBaseUrl: string,
  token: string,
  bootstrap: BootstrapResponse,
  options?: { refreshToken?: string; storeToken?: boolean; authFingerprint?: string }
): Promise<void> {
  const shouldStore = options?.storeToken !== false;
  if (shouldStore) {
    await savePat(context, token);
    await saveRefreshToken(context, options?.refreshToken);
  }
  isSignedIn = true;
  authFingerprint = options?.authFingerprint ?? hashToken(token);
  contextService?.invalidate();
  bootstrapCache = bootstrap;
  await context.globalState.update(API_BASE_URL_KEY, apiBaseUrl);
  await context.globalState.update(BOOTSTRAP_KEY, bootstrap);
  await vscode.workspace.getConfiguration().update(API_BASE_URL_KEY, apiBaseUrl, true);
  const userLabel = bootstrap.user.name ?? bootstrap.user.id;
  const modeLabel = options?.storeToken === false ? ' (mock backend)' : '';
  vscode.window.showInformationMessage(`Signed in as ${userLabel}${modeLabel}`);
  logger.info('Sign-in complete');
  logger.audit('Sign-in completed');
  updateStatusBar(prettyStatus(), getWorkspaceId(context));
  if (bootstrap.workspaces.length) {
    await selectWorkspace(context, client, store, logger, syncService, viewRefresher);
  } else {
    viewRefresher?.refresh();
  }
}

async function selectWorkspace(
  context: vscode.ExtensionContext,
  client: ParallelClient,
  store: Store,
  logger: Logger,
  syncService: SyncService,
  viewRefresher?: ViewRefresher,
  options?: { forcePrompt?: boolean }
): Promise<void> {
  const mockEnabled = isMockEnabled();
  if (!bootstrapCache) {
    if (mockEnabled) {
      bootstrapCache = ensureMockBackend()?.bootstrap() ?? null;
    } else {
      const pat = await readPat(context);
      if (!pat) {
        vscode.window.showErrorMessage('Please sign in first.');
        return;
      }
      client.setToken(pat);
      client.setApiBaseUrl(readApiBaseUrl(context));
      bootstrapCache = await fetchBootstrap(client);
    }
    if (bootstrapCache) {
      await context.globalState.update(BOOTSTRAP_KEY, bootstrapCache);
    }
  }
  if (!bootstrapCache || !bootstrapCache.workspaces) {
    vscode.window.showErrorMessage('No workspaces available. Please sign in again.');
    return;
  }

  const workspaces = bootstrapCache.workspaces;
  const existingId = getWorkspaceId(context);
  let target = !options?.forcePrompt
    ? workspaces.find((w) => w.id === existingId)
    : undefined;
  if (!target && !options?.forcePrompt && workspaces.length === 1) {
    target = workspaces[0];
  }
  if (!target) {
    const pick = await vscode.window.showQuickPick(
      workspaces.map((w) => ({
        label: w.name ?? w.id,
        description: w.id,
        workspace: w,
      })),
      { title: 'Select Parallel workspace' }
    );
    if (!pick) {
      return;
    }
    target = pick.workspace;
  }

  const workspaceId = target.id;
  store.setActiveWorkspace(workspaceId);
  repoMetadataCache = null;
  await context.globalState.update(WORKSPACE_ID_KEY, workspaceId);
  await vscode.workspace.getConfiguration().update('parallel.workspaceId', workspaceId, true);
  vscode.window.showInformationMessage(`Workspace selected: ${target.name ?? workspaceId}`);
  contextService?.invalidate(workspaceId);
  logger.audit(`Workspace selected: ${workspaceId}`);
  updateStatusBar(prettyStatus(), workspaceId);
  await store.clearWorkspace(workspaceId);
  commandHistory?.clear();
  await runInitialSync(context, client, store, logger, syncService, viewRefresher);
  await viewRefresher?.refreshSessions?.();
  viewRefresher?.refresh();
}

async function runInitialSync(
  context: vscode.ExtensionContext, 
  client: ParallelClient,
  store: Store,
  logger: Logger,
  syncService?: SyncService,
  viewRefresher?: ViewRefresher
): Promise<void> {
  const workspaceId = getWorkspaceId(context);
  if (!workspaceId) {
    return;
  }
  const pat = await readPat(context);
  const mockEnabled = isMockEnabled();
  if (!pat && !mockEnabled) {
    vscode.window.showErrorMessage('Please sign in first.');
    return;
  }
  client.setToken(mockEnabled ? 'mock-token' : (pat ?? undefined));
  client.setApiBaseUrl(readApiBaseUrl(context));
  const runner = syncService ?? new SyncService(client, store, logger);
  await runSync(context, runner, store, logger, true, viewRefresher);
  await startSyncLoop(context, runner, store, logger, viewRefresher);
  await startRealtime(context, client, store, logger);
  startExtensionInboxAndHeartbeat(context, logger);
}

async function runSync(
  context: vscode.ExtensionContext,
  syncService: SyncService,
  store: Store,
  logger: Logger,
  forceFull = false,
  viewRefresher?: ViewRefresher
): Promise<void> {
  const workspaceId = getWorkspaceId(context);
  if (!workspaceId) {
    vscode.window.showErrorMessage('Select a workspace first.');
    return;
  }
  if (syncInFlight) {
    logger.debug('Sync skipped: already in progress');
    return;
  }
  syncInFlight = true;
  updateStatusBar('Syncing', workspaceId);
  try {
    if (forceFull) {
      await syncService.fullSync(workspaceId);
    } else {
      await syncService.incrementalSync(workspaceId);
    }
    contextService?.invalidate(workspaceId);
  } finally {
    syncInFlight = false;
    viewRefresher?.refresh();
    updateStatusBar(prettyStatus(), workspaceId);
  }
}

async function forceFullResync(
  context: vscode.ExtensionContext,
  syncService: SyncService,
  store: Store,
  logger: Logger,
  viewRefresher?: ViewRefresher
): Promise<void> {
  const workspaceId = getWorkspaceId(context);
  if (!workspaceId) {
    vscode.window.showErrorMessage('Select a workspace first.');
    return;
  }
  await store.clearWorkspace(workspaceId);
  await runSync(context, syncService, store, logger, true, viewRefresher);
}

async function startSyncLoop(
  context: vscode.ExtensionContext,
  syncService: SyncService,
  store: Store,
  logger: Logger,
  viewRefresher?: ViewRefresher
): Promise<void> {
  if (syncTimer) {
    clearInterval(syncTimer);
  }
  const intervalSeconds =
    vscode.workspace.getConfiguration().get<number>('parallel.sync.intervalSeconds') ?? 60;
  const workspaceId = getWorkspaceId(context);
  if (!workspaceId) {
    return;
  }
  const mockEnabled = isMockEnabled();
  const pat = await readPat(context);
  if (!pat && !mockEnabled) {
    return;
  }
  syncTimer = setInterval(() => {
    void runSync(context, syncService, store, logger, false, viewRefresher).catch((err) => {
      logger.error('Background sync failed', err as Error);
    });
  }, intervalSeconds * 1000);
}

async function startRealtime(
  context: vscode.ExtensionContext,
  client: ParallelClient,
  store: Store,
  logger: Logger
): Promise<void> {
  const workspaceId = getWorkspaceId(context);
  if (!workspaceId) {
    return;
  }
  const mockEnabled = isMockEnabled();
  if (mockEnabled) {
    mockStreamStop?.();
    realtimeClient?.stop();
    const mock = ensureMockBackend();
    if (!mock) {
      return;
    }
    connectionStatus = 'connecting';
    updateStatusBar(prettyStatus(), workspaceId);
    mockStreamStop = mock.startEvents(
      workspaceId,
      async (event: SyncEntity, cursor: string | null) => {
        const record: EntityRecord = {
          entity_type: event.entity_type,
          id: event.id,
          updated_at: event.updated_at ?? nowIso(),
          deleted: event.deleted ?? false,
          payload: event.payload,
        };
        await store.applyEvent(workspaceId, record, cursor ?? undefined);
        contextService?.invalidate(workspaceId);
      },
      (status) => {
        connectionStatus =
          status === 'live' ? 'live' : status === 'connecting' ? 'connecting' : 'disconnected';
        updateStatusBar(prettyStatus(), workspaceId);
      }
    );
    return;
  }
  const pat = await readPat(context);
  if (!pat) {
    return;
  }
  if (!vscode.workspace.getConfiguration().get<boolean>('parallel.sse.enabled')) {
    updateStatusBar('Syncing', workspaceId);
    return;
  }
  client.setToken(pat);
  client.setApiBaseUrl(readApiBaseUrl(context));
  const lastEventId = store.getLastEventId(workspaceId) ?? store.getCursor(workspaceId);
  realtimeClient?.stop();
  realtimeClient = new RealtimeClient(
    {
      apiBaseUrl: readApiBaseUrl(context),
      workspaceId,
      token: pat,
      cursor: lastEventId,
      lastEventId,
    },
    logger,
    async (event: SyncEntity, eventCursor?: string | null) => {
      const record: EntityRecord = {
        entity_type: event.entity_type,
        id: event.id,
        updated_at: event.updated_at ?? nowIso(),
        deleted: event.deleted ?? false,
        payload: event.payload,
      };
      await store.applyEvent(workspaceId, record, eventCursor ?? undefined);
      contextService?.invalidate(workspaceId);
    }
  );
  realtimeClient.onStatusChange((status) => {
    connectionStatus = status;
    updateStatusBar(prettyStatus(), workspaceId);
  });
  realtimeClient.start();
}

function restartRealtime(
  context: vscode.ExtensionContext,
  client: ParallelClient,
  store: Store,
  logger: Logger
): void {
  realtimeClient?.stop();
  mockStreamStop?.();
  void startRealtime(context, client, store, logger);
}

async function openWebApp(_context: vscode.ExtensionContext): Promise<void> {
  const webUrl = readWebBaseUrl().trim();
  if (!webUrl) {
    vscode.window.showErrorMessage(
      'Parallel web app URL is not set. Configure "parallel.webBaseUrl" (e.g. http://localhost:5173).'
    );
    return;
  }
  let target: URL;
  try {
    target = new URL(webUrl);
  } catch {
    vscode.window.showErrorMessage(
      'Parallel web app URL is invalid. Set "parallel.webBaseUrl" to a full URL (e.g. http://localhost:5173).'
    );
    return;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    vscode.window.showErrorMessage(
      'Parallel web app URL must start with http:// or https://. Update "parallel.webBaseUrl" in settings.'
    );
    return;
  }
  await vscode.env.openExternal(vscode.Uri.parse(target.toString()));
}

async function insertContextSummary(store: Store): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('Open a text editor to insert the summary.');
    return;
  }
  const messages = [
    ...(await store.getRecent('message', 5).catch(() => [])),
    ...(await store.getRecent('messages', 5).catch(() => [])),
  ];
  const tasks = [
    ...(await store.getRecent('task', 5).catch(() => [])),
    ...(await store.getRecent('tasks', 5).catch(() => [])),
  ];
  const summaryLines: string[] = [];
  summaryLines.push('Parallel context summary:');
  if (messages.length) {
    summaryLines.push('Messages:');
    messages.forEach((m) => summaryLines.push(`- [${m.updated_at}] ${JSON.stringify(m.payload)}`));
  }
  if (tasks.length) {
    summaryLines.push('Tasks:');
    tasks.forEach((t) => summaryLines.push(`- [${t.updated_at}] ${JSON.stringify(t.payload)}`));
  }
  await editor.edit((builder) => {
    builder.insert(editor.selection.active, summaryLines.join('\n') + '\n');
  });
}

async function refreshContext(context: vscode.ExtensionContext, logger: Logger): Promise<void> {
  if (!contextService) {
    return;
  }
  try {
    const payload = await contextService.refresh();
    if (!payload.workspaceId) {
      vscode.window.showWarningMessage('Select a workspace before refreshing context.');
      return;
    }
    vscode.window.showInformationMessage(
      `Parallel context refreshed: ${payload.tasks.length} tasks, ${payload.conversations.length} chats.`
    );
    logger.audit(
      `Context refreshed (tasks=${payload.tasks.length}, conversations=${payload.conversations.length})`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Context refresh failed: ${message}`);
    logger.error('Context refresh failed', err);
  }
}

async function toggleFullPermission(context: vscode.ExtensionContext, logger: Logger): Promise<void> {
  if (fullPermission) {
    fullPermission = false;
    permissionNeedsReconfirm = false;
    await context.globalState.update(FULL_PERMISSION_KEY, fullPermission);
    vscode.window.showInformationMessage('Full Permission disabled. Agent will stay read-only.');
    agentPanel?.updatePermissionState();
    logger.audit('Full Permission disabled');
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    'Full Permission allows the agent to write files. Enable for this session?',
    { modal: true },
    'Enable'
  );
  if (confirm === 'Enable') {
    fullPermission = true;
    permissionNeedsReconfirm = false;
    await context.globalState.update(FULL_PERMISSION_KEY, fullPermission);
    vscode.window.showInformationMessage('Full Permission enabled. Apply still requires confirmation.');
    agentPanel?.updatePermissionState();
    logger.audit('Full Permission enabled');
  }
}

type CommandRunResult = AgentCommandResult & {
  status: 'ok' | 'failed' | 'skipped';
  message?: string;
};

const MAX_COMMAND_OUTPUT = 4000;

async function runAgentCommands(
  commands: AgentCommand[],
  logger: Logger,
  history: CommandHistory | null
): Promise<CommandRunResult[]> {
  if (!commands.length) {
    return [];
  }
  if (!fullPermission) {
    return commands.map((cmd) => ({
      command: cmd.command,
      cwd: cmd.cwd,
      status: 'skipped',
      message: 'Full Permission is off.',
    }));
  }
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  if (!workspaceFolders.length) {
    return commands.map((cmd) => ({
      command: cmd.command,
      cwd: cmd.cwd,
      status: 'skipped',
      message: 'No workspace open.',
    }));
  }
  const commandList = commands
    .map((cmd) => (cmd.cwd ? `${cmd.command} (${cmd.cwd})` : cmd.command))
    .join('\n');
  const confirm = await vscode.window.showWarningMessage(
    `Run ${commands.length} command(s)?\n${commandList}`,
    { modal: true },
    'Run'
  );
  if (confirm !== 'Run') {
    return commands.map((cmd) => ({
      command: cmd.command,
      cwd: cmd.cwd,
      status: 'skipped',
      message: 'Command run canceled.',
    }));
  }
  if (permissionNeedsReconfirm) {
    permissionNeedsReconfirm = false;
  }
  const workspaceRoot = workspaceFolders[0].uri.fsPath;
  const results: CommandRunResult[] = [];
  for (const cmd of commands) {
    const trimmed = cmd.command?.trim();
    if (!trimmed) {
      results.push({
        command: cmd.command,
        cwd: cmd.cwd,
        status: 'skipped',
        message: 'Empty command.',
      });
      continue;
    }
    const resolved = await resolveCommandCwd(cmd.cwd, workspaceRoot);
    if (!resolved) {
      results.push({
        command: trimmed,
        cwd: cmd.cwd,
        status: 'skipped',
        message: 'Invalid command working directory.',
      });
      continue;
    }
    logger.audit(`Command run: ${trimmed}`);
    const runResult = await runShellCommand(trimmed, resolved.absolute);
    const finalized: CommandRunResult = {
      ...runResult,
      cwd: resolved.relative ?? cmd.cwd,
    };
    results.push(finalized);
    if (history) {
      history.add({
        command: trimmed,
        cwd: resolved.relative ?? cmd.cwd,
        exitCode: finalized.exitCode,
        stdout: finalized.stdout,
        stderr: finalized.stderr,
        durationMs: finalized.durationMs,
      });
    }
    await recordTerminalOutput(trimmed, finalized, logger);
  }
  return results;
}

async function resolveCommandCwd(
  cwd: string | undefined,
  workspaceRoot: string
): Promise<{ absolute: string; relative?: string } | null> {
  if (!cwd) {
    return { absolute: workspaceRoot };
  }
  try {
    const resolved = await ensureWorkspacePath(workspaceRoot, cwd);
    return { absolute: resolved.absolutePath, relative: resolved.relativePath };
  } catch {
    return null;
  }
}

async function showInlineCompletionAlternatives(
  provider: ParallelCompletionProvider
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('Open an editor to view inline completions.');
    return;
  }
  const suggestions = provider.getLastSuggestions(editor);
  if (!suggestions.length) {
    vscode.window.showInformationMessage('No inline completion alternatives available yet.');
    return;
  }
  const picks = suggestions.map((text, index) => ({
    label: truncateInline(text),
    description: `Suggestion ${index + 1}`,
    detail: text.length > 120 ? text : undefined,
    value: text,
  }));
  const pick = await vscode.window.showQuickPick(picks, {
    placeHolder: 'Select an inline completion alternative',
  });
  if (!pick) {
    return;
  }
  await editor.insertSnippet(new vscode.SnippetString(pick.value), editor.selection.active);
}

function truncateInline(text: string): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= 80) {
    return singleLine;
  }
  return `${singleLine.slice(0, 77)}...`;
}

function setupInlineCompletionAutoTrigger(
  context: vscode.ExtensionContext,
  logger: Logger
): void {
  const timers = new Map<string, NodeJS.Timeout>();
  const schedule = (document: vscode.TextDocument, delayMs: number) => {
    const key = document.uri.toString();
    const existing = timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const handle = setTimeout(async () => {
      timers.delete(key);
      const config = vscode.workspace.getConfiguration();
      if (!config.get<boolean>('parallel.completion.enabled')) {
        return;
      }
      const active = vscode.window.activeTextEditor;
      if (!active || active.document.uri.toString() !== key) {
        return;
      }
      await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    }, Math.max(0, delayMs));
    timers.set(key, handle);
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const config = vscode.workspace.getConfiguration();
      if (!config.get<boolean>('parallel.completion.enabled')) {
        return;
      }
      if (!config.get<boolean>('parallel.completion.autoTrigger')) {
        return;
      }
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.toString() !== event.document.uri.toString()) {
        return;
      }
      if (!event.contentChanges.length) {
        return;
      }
      const lastChange = event.contentChanges[event.contentChanges.length - 1];
      if (!lastChange.text) {
        return;
      }
      const baseDelay =
        config.get<number>('parallel.completion.autoTriggerDelayMs') ?? 180;
      const isDelimiter = /[\n\r\)\]\}\.;]/.test(lastChange.text);
      const delay = isDelimiter ? 0 : baseDelay;
      schedule(event.document, delay);
      logger.debug('Inline completion auto-trigger scheduled');
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      const key = doc.uri.toString();
      const timer = timers.get(key);
      if (timer) {
        clearTimeout(timer);
        timers.delete(key);
      }
    }),
    {
      dispose: () => {
        for (const timer of timers.values()) {
          clearTimeout(timer);
        }
        timers.clear();
      },
    }
  );
}

async function runShellCommand(command: string, cwd: string): Promise<CommandRunResult> {
  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let finished = false;

  return new Promise((resolve) => {
    const finish = (result: CommandRunResult) => {
      if (finished) {
        return;
      }
      finished = true;
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, { cwd, shell: true, env: process.env });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      finish({
        command,
        cwd,
        status: 'failed',
        message,
        exitCode: 1,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const next = appendOutput(stdout, chunk, MAX_COMMAND_OUTPUT);
      stdout = next.text;
      stdoutTruncated = stdoutTruncated || next.truncated;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const next = appendOutput(stderr, chunk, MAX_COMMAND_OUTPUT);
      stderr = next.text;
      stderrTruncated = stderrTruncated || next.truncated;
    });
    child.on('error', (err) => {
      finish({
        command,
        cwd,
        status: 'failed',
        message: err instanceof Error ? err.message : String(err),
        exitCode: 1,
        durationMs: Date.now() - startedAt,
        stdout: finalizeOutput(stdout, stdoutTruncated),
        stderr: finalizeOutput(stderr, stderrTruncated),
      });
    });
    child.on('close', (code) => {
      finish({
        command,
        cwd,
        status: code === 0 ? 'ok' : 'failed',
        exitCode: typeof code === 'number' ? code : undefined,
        durationMs: Date.now() - startedAt,
        stdout: finalizeOutput(stdout, stdoutTruncated),
        stderr: finalizeOutput(stderr, stderrTruncated),
      });
    });
  });
}

function appendOutput(
  current: string,
  chunk: Buffer,
  limit: number
): { text: string; truncated: boolean } {
  if (current.length >= limit) {
    return { text: current, truncated: true };
  }
  const incoming = chunk.toString('utf8');
  const remaining = limit - current.length;
  if (incoming.length > remaining) {
    return { text: current + incoming.slice(0, remaining), truncated: true };
  }
  return { text: current + incoming, truncated: false };
}

function finalizeOutput(text: string, truncated: boolean): string | undefined {
  if (!text && !truncated) {
    return undefined;
  }
  if (!text && truncated) {
    return '[output truncated]';
  }
  if (!truncated) {
    return text;
  }
  return `${text}\n...[truncated]`;
}

async function applyAgentEdits(
  edits: ProposedFileEdit[],
  options: { dryRun: boolean; proposalDryRun: boolean },
  logger: Logger
): Promise<ApplyResult> {
  const allFiles = edits.map((e) => e.filePath);
  if (containsStubEdits(edits)) {
    const message =
      'Agent edits look like stub output (LLM unavailable). Configure the LLM and re-run.';
    vscode.window.showErrorMessage(message);
    logger.audit('Apply blocked: stub edits detected');
    return { applied: [], skipped: allFiles, reason: 'blocked' };
  }
  if (options.dryRun || options.proposalDryRun) {
    logger.audit(`Dry run: ${edits.length} edits proposed, none applied`);
    return { applied: [], skipped: allFiles, reason: 'dry_run' };
  }
  if (!fullPermission) {
    logger.audit('Apply blocked: Full Permission is off');
    return { applied: [], skipped: allFiles, reason: 'blocked' };
  }
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  if (!workspaceFolders.length) {
    logger.audit('Apply blocked: No workspace open');
    return { applied: [], skipped: allFiles, reason: 'blocked' };
  }
  const fileList = edits
    .map((e) => e.relativePath ?? path.relative(workspaceFolders[0].uri.fsPath, e.filePath))
    .join('\n');
  const confirm = await vscode.window.showWarningMessage(
    `Apply ${edits.length} file(s)?\n${fileList}`,
    { modal: true },
    'Apply'
  );
  if (confirm !== 'Apply') {
    logger.audit('Apply cancelled by user');
    return { applied: [], skipped: allFiles, reason: 'cancelled' };
  }
  if (permissionNeedsReconfirm) {
    permissionNeedsReconfirm = false;
  }
  logger.audit(`Apply confirmed (files=${edits.length})`);
  const original = await captureOriginalContent(edits);
  const result = await applyWithWorkspace(edits, logger, { allowWrites: true, workspaceFolders });
  const rollbackOnFailure = vscode.workspace
    .getConfiguration()
    .get<boolean>('parallel.agent.rollbackOnFailure') ?? true;
  if (rollbackOnFailure && result.skipped.length && result.applied.length) {
    await revertAppliedFiles(original, result.applied);
    logger.audit('Rolled back applied edits due to failures');
    return { applied: [], skipped: allFiles, reason: 'rolled_back' };
  }
  if (result.applied.length) {
    const updated = await captureUpdatedContent(result.applied);
    const workspaceId = vscode.workspace.getConfiguration().get<string>(WORKSPACE_ID_KEY) ?? '';
    const entry: EditHistoryEntry = {
      id: crypto.randomUUID(),
      workspaceId,
      createdAt: Date.now(),
      files: result.applied,
      original,
      updated,
    };
    undoHistory.unshift(entry);
    if (undoHistory.length > MAX_UNDO_HISTORY) {
      undoHistory = undoHistory.slice(0, MAX_UNDO_HISTORY);
    }
    await recordEditHistory(entry, logger);
  }
  if (result.skipped.length) {
    return { ...result, reason: 'failed' };
  }
  return result;
}

function containsStubEdits(edits: ProposedFileEdit[]): boolean {
  return edits.some((edit) => {
    if (edit.description && edit.description.toLowerCase().includes('stub edit')) {
      return true;
    }
    if (edit.newText && edit.newText.includes('TODO: Replace with agent-generated content')) {
      return true;
    }
    return false;
  });
}

async function captureOriginalContent(edits: ProposedFileEdit[]): Promise<Record<string, string>> {
  const records: Record<string, string> = {};
  for (const edit of edits) {
    if (!edit.filePath) {
      continue;
    }
    records[edit.filePath] = await readFileTextIfExists(edit.filePath);
  }
  return records;
}

async function captureUpdatedContent(applied: string[]): Promise<Record<string, string>> {
  const records: Record<string, string> = {};
  for (const filePath of applied) {
    records[filePath] = await readFileTextIfExists(filePath);
  }
  return records;
}

async function revertAppliedFiles(
  original: Record<string, string>,
  applied: string[]
): Promise<void> {
  const workspaceEdit = new vscode.WorkspaceEdit();
  for (const filePath of applied) {
    const content = original[filePath] ?? '';
    const uri = vscode.Uri.file(filePath);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      workspaceEdit.replace(uri, fullRange, content);
    } catch {
      workspaceEdit.createFile(uri, { overwrite: true });
      workspaceEdit.insert(uri, new vscode.Position(0, 0), content);
    }
  }
  await vscode.workspace.applyEdit(workspaceEdit);
  await vscode.workspace.saveAll();
}

async function readFileTextIfExists(filePath: string): Promise<string> {
  try {
    const data = await fs.readFile(filePath);
    return data.toString('utf8');
  } catch {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      return doc.getText();
    } catch {
      return '';
    }
  }
}

async function recordEditHistory(entry: EditHistoryEntry, logger: Logger): Promise<void> {
  if (!activeClient || !entry.workspaceId) {
    return;
  }
  try {
    await activeClient.request(`/api/v1/workspaces/${entry.workspaceId}/vscode/agent/edits/record`, {
      method: 'POST',
      body: JSON.stringify({
        edit_id: entry.id,
        description: entry.description,
        source: 'vscode-extension',
        files_modified: entry.files,
        original_content: entry.original,
        new_content: entry.updated,
      }),
      redactBody: true,
    });
  } catch (err) {
    logger.error('Failed to record edit history', err as Error);
  }
}

type InboxTask = {
  id: string;
  taskType: string;
  payload: Record<string, unknown>;
  raw: Record<string, unknown>;
};

function startExtensionInboxAndHeartbeat(
  context: vscode.ExtensionContext,
  logger: Logger
): void {
  startHeartbeat(context, logger);
  startInboxPolling(context, logger);
}

function stopExtensionInboxAndHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (inboxPollTimer) {
    clearInterval(inboxPollTimer);
    inboxPollTimer = null;
  }
  inboxPollInFlight = false;
}

function startHeartbeat(context: vscode.ExtensionContext, logger: Logger): void {
  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      void sendHeartbeat(context, logger);
    }, HEARTBEAT_INTERVAL_MS);
  }
  void sendHeartbeat(context, logger);
}

function startInboxPolling(context: vscode.ExtensionContext, logger: Logger): void {
  if (!inboxPollTimer) {
    inboxPollTimer = setInterval(() => {
      void pollInboxOnce(context, logger);
    }, INBOX_POLL_INTERVAL_MS);
  }
  void pollInboxOnce(context, logger);
}

async function sendHeartbeat(
  context: vscode.ExtensionContext,
  logger: Logger
): Promise<void> {
  if (!activeClient || !isSignedIn || isMockEnabled()) {
    return;
  }
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    return;
  }
  const repo = await getRepoMetadata(workspaceRoot, logger);
  if (!repo) {
    return;
  }
  const deviceId = await ensureDeviceId(context);
  const branch = await readBranchName(repo.repoRoot);
  const headSha = await readHeadSha(repo.repoRoot);
  const payload: Record<string, unknown> = {
    device_id: deviceId,
    repo_id: repo.repoId,
    capabilities: ['apply_patch', 'agent_task', 'notify', 'code_events'],
  };
  if (branch) {
    payload.branch = branch;
  }
  if (headSha) {
    payload.head_sha = headSha;
  }
  try {
    await activeClient.request('/api/v1/extension/heartbeat', {
      method: 'POST',
      body: JSON.stringify(payload),
      redactBody: true,
    });
  } catch (err) {
    logger.debug(`Heartbeat failed: ${String(err)}`);
  }
}

async function pollInboxOnce(
  context: vscode.ExtensionContext,
  logger: Logger
): Promise<void> {
  if (inboxPollInFlight || !activeClient || !isSignedIn || isMockEnabled()) {
    return;
  }
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    return;
  }
  const repo = await getRepoMetadata(workspaceRoot, logger);
  if (!repo) {
    return;
  }
  inboxPollInFlight = true;
  try {
    const tasks = await fetchInboxTasks(repo.repoId, logger);
    for (const task of tasks) {
      if (inboxProcessedSet.has(task.id) || inboxInProgress.has(task.id)) {
        continue;
      }
      inboxInProgress.add(task.id);
      try {
        await handleInboxTask(task, context, logger);
      } finally {
        inboxInProgress.delete(task.id);
      }
    }
  } finally {
    inboxPollInFlight = false;
  }
}

async function fetchInboxTasks(repoId: string, logger: Logger): Promise<InboxTask[]> {
  if (!activeClient) {
    return [];
  }
  try {
    const response = await activeClient.request<unknown>('/api/v1/extension/inbox', {
      method: 'GET',
      query: {
        repo_id: repoId,
        status: 'pending',
        limit: INBOX_POLL_LIMIT,
      },
    });
    return normalizeInboxTasks(response);
  } catch (err) {
    logger.error('Inbox poll failed', err as Error);
    return [];
  }
}

function normalizeInboxTasks(response: unknown): InboxTask[] {
  if (!response) {
    return [];
  }
  let items: unknown[] = [];
  if (Array.isArray(response)) {
    items = response;
  } else if (typeof response === 'object') {
    const obj = response as Record<string, unknown>;
    if (Array.isArray(obj.items)) {
      items = obj.items;
    } else if (Array.isArray(obj.tasks)) {
      items = obj.tasks;
    } else if (Array.isArray(obj.data)) {
      items = obj.data;
    } else if (Array.isArray(obj.results)) {
      items = obj.results;
    }
  }
  return items
    .map((item) => (item && typeof item === 'object' ? coerceInboxTask(item as Record<string, unknown>) : null))
    .filter((item): item is InboxTask => !!item);
}

function coerceInboxTask(raw: Record<string, unknown>): InboxTask | null {
  const id = String(raw.id ?? raw.task_id ?? raw.resource_id ?? '');
  if (!id) {
    return null;
  }
  const payload =
    raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)
      ? (raw.payload as Record<string, unknown>)
      : raw;
  const taskType = String(raw.task_type ?? payload.task_type ?? '').toUpperCase();
  return { id, taskType, payload, raw };
}

async function handleInboxTask(
  task: InboxTask,
  context: vscode.ExtensionContext,
  logger: Logger
): Promise<void> {
  const taskType = task.taskType || String(task.payload.task_type ?? '').toUpperCase();
  if (taskType === 'APPLY_PATCH') {
    await handleApplyPatchTask(task, context, logger);
    return;
  }
  if (taskType === 'AGENT_TASK') {
    await handleAgentTask(task, context, logger);
    return;
  }
  if (taskType === 'NOTIFY') {
    await handleNotifyTask(task, context, logger);
    return;
  }
  await sendInboxAck(task.id, {
    status: 'error',
    result: {
      error_code: 'UNSUPPORTED_TASK',
      error_message: `Unsupported task type: ${taskType || 'unknown'}`,
    },
  }, logger);
  markInboxProcessed(context, task.id);
}

async function handleAgentTask(
  task: InboxTask,
  context: vscode.ExtensionContext,
  logger: Logger
): Promise<void> {
  if (!agentService) {
    await sendInboxAck(task.id, {
      status: 'error',
      result: {
        error_code: 'AGENT_UNAVAILABLE',
        error_message: 'Agent service is unavailable.',
      },
    }, logger);
    markInboxProcessed(context, task.id);
    return;
  }
  const request = extractAgentRequest(task.payload);
  if (!request) {
    await sendInboxAck(task.id, {
      status: 'error',
      result: {
        error_code: 'INVALID_REQUEST',
        error_message: 'Agent task missing request text.',
      },
    }, logger);
    markInboxProcessed(context, task.id);
    return;
  }
  await sendInboxAck(task.id, {
    status: 'accepted',
    result: { summary: 'Agent task accepted.' },
  }, logger);
  try {
    const proposal = await agentService.propose(request, 'dry-run');
    const workspaceRoot = getWorkspaceRoot() ?? '';
    const result = buildAgentResult(proposal, workspaceRoot);
    await sendInboxAck(task.id, { status: 'done', result }, logger);
    markInboxProcessed(context, task.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendInboxAck(task.id, {
      status: 'error',
      result: {
        error_code: 'AGENT_TASK_FAILED',
        error_message: message,
      },
    }, logger);
    markInboxProcessed(context, task.id);
  }
}

async function handleNotifyTask(
  task: InboxTask,
  context: vscode.ExtensionContext,
  logger: Logger
): Promise<void> {
  const title = getPayloadString(task.payload, 'title') ?? 'Parallel notification';
  const message = getPayloadString(task.payload, 'message') ?? '';
  const severity = (getPayloadString(task.payload, 'severity') ?? 'info').toLowerCase();
  const combined = message ? `${title}: ${message}` : title;
  if (severity === 'error') {
    void vscode.window.showErrorMessage(combined);
  } else if (severity === 'warn' || severity === 'warning') {
    void vscode.window.showWarningMessage(combined);
  } else {
    void vscode.window.showInformationMessage(combined);
  }
  logger.audit('Notify task displayed');
  await sendInboxAck(task.id, {
    status: 'done',
    result: { summary: 'Notification displayed.' },
  }, logger);
  markInboxProcessed(context, task.id);
}

function extractAgentRequest(payload: Record<string, unknown>): string | null {
  const primary = getPayloadString(payload, 'text');
  const fallback =
    primary ??
    getPayloadString(payload, 'content') ??
    getPayloadString(payload, 'prompt') ??
    getPayloadString(payload, 'instruction') ??
    getPayloadString(payload, 'instructions');
  if (!fallback) {
    return null;
  }
  const contextBrief = formatContextBrief(payload.context_brief);
  if (contextBrief) {
    return `${fallback}\n\nContext brief:\n${contextBrief}`;
  }
  return fallback;
}

function formatContextBrief(value: unknown): string | null {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? truncateText(trimmed, 4000) : null;
  }
  try {
    const serialized = JSON.stringify(value, null, 2);
    return truncateText(serialized, 4000);
  } catch {
    return null;
  }
}

function buildAgentResult(proposal: AgentProposal, workspaceRoot: string): Record<string, unknown> {
  const files = proposal.edits.map((edit) => {
    const relative =
      edit.relativePath ?? (workspaceRoot ? path.relative(workspaceRoot, edit.filePath) : edit.filePath);
    const diff = edit.diff ? truncateText(edit.diff, 4000) : undefined;
    return { file_path: relative.replace(/\\/g, '/'), diff };
  });
  const summary = `Generated ${proposal.edits.length} edit(s) and ${proposal.commands.length} command(s).`;
  const outputLines: string[] = [summary];
  if (proposal.plan.length) {
    outputLines.push(`Plan: ${proposal.plan.join(' | ')}`);
  }
  if (files.length) {
    outputLines.push(`Files: ${files.map((f) => f.file_path).join(', ')}`);
  }
  return {
    summary,
    output: truncateText(outputLines.join('\n'), 4000),
    files_processed: proposal.edits.length,
    plan: proposal.plan,
    edits: files,
    commands: proposal.commands,
    dry_run: proposal.dryRun,
  };
}

function truncateText(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n...[truncated]`;
}

async function handleApplyPatchTask(
  task: InboxTask,
  context: vscode.ExtensionContext,
  logger: Logger
): Promise<void> {
  if (!activeClient) {
    return;
  }
  const deviceId =
    getPayloadString(task.payload, 'device_id') ?? (await ensureDeviceId(context));
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    await sendInboxAck(task.id, {
      status: 'error',
      result: buildApplyPatchAckResult({
        applied: false,
        filesChanged: [],
        headShaBefore: null,
        headShaAfter: null,
        summary: 'Attempted patch apply but failed',
        details: 'No workspace open to apply patch.',
        systemsTouched: [],
        impactTags: [],
        deviceId: deviceId,
        errorCode: 'PERMISSION_DENIED',
        errorMessage: 'No workspace open to apply patch.',
      }),
    }, logger);
    markInboxProcessed(context, task.id);
    return;
  }
  if (!fullPermission) {
    await toggleFullPermission(context, logger);
  }
  if (!fullPermission) {
    await sendInboxAck(task.id, {
      status: 'error',
      result: buildApplyPatchAckResult({
        applied: false,
        filesChanged: [],
        headShaBefore: await readHeadSha(workspaceRoot),
        headShaAfter: null,
        summary: 'Patch apply canceled',
        details: 'User declined to enable Full Permission.',
        systemsTouched: [],
        impactTags: [],
        deviceId: deviceId,
        errorCode: 'USER_DECLINED',
        errorMessage: 'User declined to enable Full Permission.',
      }),
    }, logger);
    markInboxProcessed(context, task.id);
    return;
  }
  const patch = extractPatchString(task.payload);
  if (!patch) {
    await sendInboxAck(task.id, {
      status: 'error',
      result: buildApplyPatchAckResult({
        applied: false,
        filesChanged: [],
        headShaBefore: await readHeadSha(workspaceRoot),
        headShaAfter: null,
        summary: 'Attempted patch apply but failed',
        details: 'Patch payload missing or empty.',
        systemsTouched: [],
        impactTags: [],
        deviceId: deviceId,
        errorCode: 'VALIDATION_ERROR',
        errorMessage: 'Patch payload missing or empty.',
      }),
    }, logger);
    markInboxProcessed(context, task.id);
    return;
  }
  let parsed;
  try {
    parsed = parsePatch(patch);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Failed to parse patch.';
    await sendInboxAck(task.id, {
      status: 'error',
      result: buildApplyPatchAckResult({
        applied: false,
        filesChanged: [],
        headShaBefore: await readHeadSha(workspaceRoot),
        headShaAfter: null,
        summary: 'Attempted patch apply but failed',
        details: errorMessage,
        systemsTouched: [],
        impactTags: [],
        deviceId: deviceId,
        errorCode: 'VALIDATION_ERROR',
        errorMessage,
      }),
    }, logger);
    markInboxProcessed(context, task.id);
    return;
  }
  if (!parsed.length) {
    await sendInboxAck(task.id, {
      status: 'error',
      result: buildApplyPatchAckResult({
        applied: false,
        filesChanged: [],
        headShaBefore: await readHeadSha(workspaceRoot),
        headShaAfter: null,
        summary: 'Attempted patch apply but failed',
        details: 'Patch payload contained no file changes.',
        systemsTouched: [],
        impactTags: [],
        deviceId: deviceId,
        errorCode: 'VALIDATION_ERROR',
        errorMessage: 'Patch payload contained no file changes.',
      }),
    }, logger);
    markInboxProcessed(context, task.id);
    return;
  }
  const headShaBefore = await readHeadSha(workspaceRoot);
  const baseSha = getPayloadString(task.payload, 'base_sha');
  if (baseSha && headShaBefore && baseSha !== headShaBefore) {
    await sendInboxAck(task.id, {
      status: 'error',
      result: buildApplyPatchAckResult({
        applied: false,
        filesChanged: [],
        headShaBefore,
        headShaAfter: null,
        summary: 'Attempted patch apply but failed',
        details: `Base SHA mismatch (expected ${baseSha}, got ${headShaBefore}).`,
        systemsTouched: [],
        impactTags: [],
        deviceId: deviceId,
        errorCode: 'VALIDATION_ERROR',
        errorMessage: 'Base SHA does not match current HEAD.',
      }),
    }, logger);
    markInboxProcessed(context, task.id);
    return;
  }

  let editBundle: { edits: ProposedFileEdit[]; filesChanged: string[] };
  try {
    editBundle = await buildEditsFromPatch(parsed, workspaceRoot);
  } catch (err) {
    const { errorCode, errorMessage } = classifyPatchError(err);
    await sendInboxAck(task.id, {
      status: 'error',
      result: buildApplyPatchAckResult({
        applied: false,
        filesChanged: [],
        headShaBefore,
        headShaAfter: null,
        summary: 'Attempted patch apply but failed',
        details: errorMessage,
        systemsTouched: [],
        impactTags: [],
        deviceId: deviceId,
        errorCode,
        errorMessage,
      }),
    }, logger);
    markInboxProcessed(context, task.id);
    return;
  }
  if (!editBundle.edits.length) {
    await sendInboxAck(task.id, {
      status: 'error',
      result: buildApplyPatchAckResult({
        applied: false,
        filesChanged: editBundle.filesChanged,
        headShaBefore,
        headShaAfter: null,
        summary: 'Attempted patch apply but failed',
        details: 'Patch payload contained no applicable edits.',
        systemsTouched: [],
        impactTags: [],
        deviceId: deviceId,
        errorCode: 'VALIDATION_ERROR',
        errorMessage: 'Patch payload contained no applicable edits.',
      }),
    }, logger);
    markInboxProcessed(context, task.id);
    return;
  }

  const filesFromPatch = editBundle.filesChanged;
  const systemsTouched =
    getPayloadStringArray(task.payload, 'systems_touched') ??
    deriveSystemsTouched(filesFromPatch);
  const impactTags =
    getPayloadStringArray(task.payload, 'impact_tags') ?? deriveImpactTags(filesFromPatch);
  const acceptedSummary = getPayloadString(task.payload, 'summary') ?? 'Applying patch';
  const acceptedDetails = getPayloadString(task.payload, 'details');
  await sendInboxAck(task.id, {
    status: 'accepted',
    result: buildApplyPatchAckResult({
      applied: false,
      filesChanged: filesFromPatch,
      headShaBefore,
      headShaAfter: headShaBefore,
      summary: acceptedSummary,
      details: acceptedDetails,
      systemsTouched,
      impactTags,
      deviceId: deviceId,
    }),
  }, logger);

  const applyResult = await applyAgentEdits(editBundle.edits, {
    dryRun: false,
    proposalDryRun: false,
  }, logger);

  const appliedRelative = toRelativePaths(applyResult.applied, workspaceRoot);
  const filesChanged = appliedRelative.length ? appliedRelative : filesFromPatch;
  if (applyResult.skipped.length || !appliedRelative.length) {
    if (applyResult.reason === 'cancelled') {
      await sendInboxAck(task.id, {
        status: 'error',
        result: buildApplyPatchAckResult({
          applied: false,
          filesChanged,
          headShaBefore,
          headShaAfter: null,
          summary: 'Patch apply canceled',
          details: 'User declined to apply the patch.',
          systemsTouched,
          impactTags,
          deviceId: deviceId,
          errorCode: 'USER_DECLINED',
          errorMessage: 'User declined to apply the patch.',
        }),
      }, logger);
      markInboxProcessed(context, task.id);
      return;
    }
    if (applyResult.reason === 'blocked') {
      await sendInboxAck(task.id, {
        status: 'error',
        result: buildApplyPatchAckResult({
          applied: false,
          filesChanged,
          headShaBefore,
          headShaAfter: null,
          summary: 'Patch apply blocked',
          details: 'Apply blocked by extension settings.',
          systemsTouched,
          impactTags,
          deviceId: deviceId,
          errorCode: 'PERMISSION_DENIED',
          errorMessage: 'Apply blocked by extension settings.',
        }),
      }, logger);
      markInboxProcessed(context, task.id);
      return;
    }
    const detailsParts = [];
    if (applyResult.reason === 'rolled_back') {
      detailsParts.push('Applied edits were rolled back due to failures.');
    }
    if (applyResult.skipped.length) {
      detailsParts.push(
        `Skipped: ${toRelativePaths(applyResult.skipped, workspaceRoot).join(', ')}`
      );
    }
    if (!detailsParts.length) {
      detailsParts.push('Patch was not applied.');
    }
    const errorMessage = detailsParts.join(' ');
    await sendInboxAck(task.id, {
      status: 'error',
      result: buildApplyPatchAckResult({
        applied: false,
        filesChanged,
        headShaBefore,
        headShaAfter: null,
        summary: 'Attempted patch apply but failed',
        details: errorMessage,
        systemsTouched,
        impactTags,
        deviceId: deviceId,
        errorCode: 'PATCH_FAILED',
        errorMessage,
      }),
    }, logger);
    markInboxProcessed(context, task.id);
    return;
  }

  await sendInboxAck(task.id, {
    status: 'done',
    result: buildApplyPatchAckResult({
      applied: true,
      filesChanged,
      headShaBefore,
      headShaAfter: headShaBefore,
      summary:
        getPayloadString(task.payload, 'summary') ??
        `Applied patch to ${filesChanged.length} file(s).`,
      details: getPayloadString(task.payload, 'details'),
      systemsTouched,
      impactTags,
      deviceId: deviceId,
    }),
  }, logger);
  markInboxProcessed(context, task.id);
}

async function ensureDeviceId(context: vscode.ExtensionContext): Promise<string> {
  if (deviceIdCache) {
    return deviceIdCache;
  }
  const stored = context.globalState.get<string>(DEVICE_ID_KEY);
  if (stored) {
    deviceIdCache = stored;
    return stored;
  }
  const next = crypto.randomUUID();
  deviceIdCache = next;
  await context.globalState.update(DEVICE_ID_KEY, next);
  return next;
}

async function recordCodeEventFromSave(
  doc: vscode.TextDocument,
  context: vscode.ExtensionContext,
  logger: Logger
): Promise<void> {
  if (!activeClient || !isSignedIn || isMockEnabled()) {
    return;
  }
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    return;
  }
  const repo = await getRepoMetadata(workspaceRoot, logger);
  if (!repo) {
    return;
  }
  const deviceId = await ensureDeviceId(context);
  const branch = await readBranchName(repo.repoRoot);
  const headSha = await readHeadSha(repo.repoRoot);
  const relativePath = toRepoRelativePath(doc.uri.fsPath, repo.repoRoot, workspaceRoot);
  const filesTouched = relativePath ? [relativePath] : [];
  await sendCodeEvent(
    {
      deviceId,
      repoId: repo.repoId,
      branch,
      headShaBefore: headSha,
      headShaAfter: headSha,
      eventType: 'save',
      filesTouched,
      systemsTouched: deriveSystemsTouched(filesTouched),
      impactTags: deriveImpactTags(filesTouched),
      summary: relativePath ? `Saved ${relativePath}` : 'Saved file',
    },
    logger
  );
}

async function sendCodeEvent(
  event: {
    deviceId: string;
    repoId: string;
    branch?: string | null;
    headShaBefore?: string | null;
    headShaAfter?: string | null;
    eventType: string;
    filesTouched?: string[];
    systemsTouched?: string[];
    tags?: string[];
    summary?: string;
    details?: string;
    impactTags?: string[];
  },
  logger: Logger
): Promise<void> {
  if (!activeClient) {
    return;
  }
  const payload: Record<string, unknown> = {
    device_id: event.deviceId,
    repo_id: event.repoId,
    event_type: event.eventType,
  };
  if (event.branch) {
    payload.branch = event.branch;
  }
  if (event.headShaBefore) {
    payload.head_sha_before = event.headShaBefore;
  }
  if (event.headShaAfter) {
    payload.head_sha_after = event.headShaAfter;
  }
  if (event.filesTouched && event.filesTouched.length) {
    payload.files_touched = normalizeFilesChanged(event.filesTouched);
  }
  if (event.systemsTouched && event.systemsTouched.length) {
    payload.systems_touched = event.systemsTouched;
  }
  if (event.tags && event.tags.length) {
    payload.tags = event.tags;
  }
  if (event.summary) {
    payload.summary = event.summary;
  }
  if (event.details) {
    payload.details = event.details;
  }
  if (event.impactTags && event.impactTags.length) {
    payload.impact_tags = event.impactTags.slice(0, 3);
  }
  try {
    await activeClient.request('/api/v1/code-events', {
      method: 'POST',
      body: JSON.stringify(payload),
      redactBody: true,
    });
  } catch (err) {
    logger.debug(`Code event failed: ${String(err)}`);
  }
}

function toRepoRelativePath(
  filePath: string,
  repoRoot: string,
  workspaceRoot: string
): string | null {
  const repoRelative = path.relative(repoRoot, filePath).replace(/\\/g, '/');
  if (repoRelative && !repoRelative.startsWith('..')) {
    return repoRelative;
  }
  const workspaceRelative = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
  if (workspaceRelative && !workspaceRelative.startsWith('..')) {
    return workspaceRelative;
  }
  return null;
}

async function getRepoMetadata(
  workspaceRoot: string,
  logger: Logger
): Promise<{ workspaceRoot: string; repoRoot: string; repoId: string } | null> {
  if (repoMetadataCache && repoMetadataCache.workspaceRoot === workspaceRoot) {
    return repoMetadataCache;
  }
  const repoRoot = await resolveGitRoot(workspaceRoot);
  const remoteUrl = await readGitRemote(repoRoot);
  const basis = remoteUrl ?? repoRoot;
  if (!basis) {
    logger.debug('Repo metadata unavailable: missing repo root');
    return null;
  }
  const repoId = hashString(basis);
  repoMetadataCache = { workspaceRoot, repoRoot, repoId };
  return repoMetadataCache;
}

async function resolveGitRoot(workspaceRoot: string): Promise<string> {
  try {
    const result = await runShellCommand('git rev-parse --show-toplevel', workspaceRoot);
    if (result.status === 'ok' && result.stdout) {
      const trimmed = result.stdout.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  } catch {
    return workspaceRoot;
  }
  return workspaceRoot;
}

async function readGitRemote(repoRoot: string): Promise<string | null> {
  const commands = ['git config --get remote.origin.url', 'git remote get-url origin'];
  for (const command of commands) {
    const result = await runShellCommand(command, repoRoot);
    if (result.status === 'ok' && result.stdout) {
      const trimmed = result.stdout.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return null;
}

async function readBranchName(repoRoot: string): Promise<string | null> {
  const commands = ['git branch --show-current', 'git rev-parse --abbrev-ref HEAD'];
  for (const command of commands) {
    const result = await runShellCommand(command, repoRoot);
    if (result.status === 'ok' && result.stdout) {
      const trimmed = result.stdout.trim();
      if (trimmed && trimmed !== 'HEAD') {
        return trimmed;
      }
    }
  }
  return null;
}

function getWorkspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    return null;
  }
  return folders[0].uri.fsPath;
}

function extractPatchString(payload: Record<string, unknown>): string | null {
  const candidates = ['patch', 'diff', 'unified_diff', 'unifiedDiff'];
  for (const key of candidates) {
    const value = getPayloadString(payload, key);
    if (value) {
      return value;
    }
  }
  return null;
}

function getPayloadString(payload: Record<string, unknown>, key: string): string | null {
  const direct = payload[key];
  if (typeof direct === 'string' && direct.trim()) {
    return direct.trim();
  }
  const data = payload.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = (data as Record<string, unknown>)[key];
    if (typeof nested === 'string' && nested.trim()) {
      return nested.trim();
    }
  }
  return null;
}

function getPayloadStringArray(payload: Record<string, unknown>, key: string): string[] | null {
  const direct = payload[key];
  if (Array.isArray(direct)) {
    return normalizeFilesChanged(direct.map((item) => String(item ?? '')).filter(Boolean));
  }
  const data = payload.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const nested = (data as Record<string, unknown>)[key];
    if (Array.isArray(nested)) {
      return normalizeFilesChanged(nested.map((item) => String(item ?? '')).filter(Boolean));
    }
  }
  return null;
}

async function buildEditsFromPatch(
  parsed: ReturnType<typeof parsePatch>,
  workspaceRoot: string
): Promise<{ edits: ProposedFileEdit[]; filesChanged: string[] }> {
  const edits: ProposedFileEdit[] = [];
  const filesChanged: string[] = [];
  for (const patch of parsed) {
    const relativePath = normalizeDiffPath(
      patch.newFileName && patch.newFileName !== '/dev/null'
        ? patch.newFileName
        : patch.oldFileName
    );
    if (!relativePath) {
      continue;
    }
    const resolved = await ensureWorkspacePath(workspaceRoot, relativePath);
    filesChanged.push(resolved.relativePath);
    const mode = patch.newFileName === '/dev/null' ? 'delete' : 'diff';
    edits.push({
      filePath: resolved.absolutePath,
      relativePath: resolved.relativePath,
      diff: mode === 'diff' ? formatPatch(patch) : undefined,
      mode,
    });
  }
  const normalized = normalizeFilesChanged(filesChanged);
  return { edits, filesChanged: normalized };
}

function normalizeDiffPath(fileName: string | undefined): string | null {
  if (!fileName) {
    return null;
  }
  if (fileName === '/dev/null') {
    return null;
  }
  const normalized = fileName.replace(/\\/g, '/').replace(/^[ab]\//, '').replace(/^\/+/, '');
  return normalized ? normalized : null;
}

function classifyPatchError(err: unknown): { errorCode: string; errorMessage: string } {
  const message = err instanceof Error ? err.message : String(err);
  const lowered = message.toLowerCase();
  if (lowered.includes('path') || lowered.includes('workspace') || lowered.includes('permission')) {
    return { errorCode: 'VALIDATION_ERROR', errorMessage: message };
  }
  if (lowered.includes('not found') || lowered.includes('enoent')) {
    return { errorCode: 'VALIDATION_ERROR', errorMessage: message };
  }
  return { errorCode: 'PATCH_FAILED', errorMessage: message };
}

function buildApplyPatchAckResult(options: {
  applied: boolean;
  filesChanged: string[];
  headShaBefore: string | null;
  headShaAfter: string | null;
  summary: string;
  details?: string | null;
  systemsTouched?: string[];
  impactTags?: string[];
  deviceId?: string | null;
  errorCode?: string;
  errorMessage?: string;
}): Record<string, unknown> {
  const result: Record<string, unknown> = {
    applied: options.applied,
    files_changed: normalizeFilesChanged(options.filesChanged),
    head_sha_before: options.headShaBefore,
    head_sha_after: options.headShaAfter,
    summary: options.summary,
  };
  if (options.details) {
    result.details = options.details;
  }
  if (options.systemsTouched && options.systemsTouched.length) {
    result.systems_touched = options.systemsTouched;
  }
  if (options.impactTags && options.impactTags.length) {
    result.impact_tags = options.impactTags.slice(0, 3);
  }
  if (options.deviceId) {
    result.device_id = options.deviceId;
  }
  if (options.errorCode) {
    result.error_code = options.errorCode;
  }
  if (options.errorMessage) {
    result.error_message = options.errorMessage;
  }
  return result;
}

async function sendInboxAck(
  taskId: string,
  payload: { status: 'accepted' | 'done' | 'error'; result: Record<string, unknown> },
  logger: Logger
): Promise<void> {
  if (!activeClient) {
    return;
  }
  try {
    await activeClient.request(`/api/v1/extension/inbox/${encodeURIComponent(taskId)}/ack`, {
      method: 'POST',
      body: JSON.stringify(payload),
      redactBody: true,
    });
  } catch (err) {
    logger.error('Failed to send inbox ack', err as Error);
  }
}

async function readHeadSha(workspaceRoot: string): Promise<string | null> {
  try {
    const result = await runShellCommand('git rev-parse HEAD', workspaceRoot);
    if (result.status === 'ok' && result.stdout) {
      const trimmed = result.stdout.trim();
      return trimmed ? trimmed : null;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeFilesChanged(files: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const file of files) {
    const trimmed = String(file ?? '').trim();
    if (!trimmed) {
      continue;
    }
    const pathValue = trimmed.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!pathValue || seen.has(pathValue)) {
      continue;
    }
    seen.add(pathValue);
    normalized.push(pathValue);
    if (normalized.length >= 50) {
      break;
    }
  }
  return normalized;
}

function toRelativePaths(paths: string[], workspaceRoot: string): string[] {
  return normalizeFilesChanged(
    paths.map((filePath) => path.relative(workspaceRoot, filePath).replace(/\\/g, '/'))
  );
}

function deriveSystemsTouched(files: string[]): string[] {
  const tags = new Set<string>();
  files.forEach((file) => {
    const lower = file.toLowerCase();
    if (lower.includes('auth') || lower.includes('oauth') || lower.includes('jwt')) {
      tags.add('auth');
    }
    if (lower.includes('/api/') || lower.startsWith('api/')) {
      tags.add('api');
    }
    if (lower.includes('db') || lower.includes('database') || lower.includes('migrations')) {
      tags.add('database');
    }
    if (
      lower.includes('frontend') ||
      lower.includes('ui/') ||
      lower.includes('web/') ||
      lower.includes('components')
    ) {
      tags.add('frontend');
    }
    if (
      lower.includes('infra') ||
      lower.includes('deploy') ||
      lower.includes('terraform') ||
      lower.includes('k8s')
    ) {
      tags.add('infra');
    }
  });
  return Array.from(tags);
}

function deriveImpactTags(files: string[]): string[] {
  const tags = new Set<string>();
  files.forEach((file) => {
    const lower = file.toLowerCase();
    if (lower.includes('migrations') || lower.endsWith('.sql')) {
      tags.add('db_schema');
    }
    if (
      lower.includes('openapi') ||
      lower.includes('swagger') ||
      lower.endsWith('.proto') ||
      lower.includes('/api/')
    ) {
      tags.add('api_contract');
    }
    if (lower.includes('auth') || lower.includes('jwt') || lower.includes('session')) {
      tags.add('auth_flow');
    }
    if (lower.includes('permission') || lower.includes('rbac') || lower.includes('acl')) {
      tags.add('permissions');
    }
    if (
      lower.includes('package.json') ||
      lower.includes('package-lock.json') ||
      lower.includes('yarn.lock') ||
      lower.includes('pnpm-lock')
    ) {
      tags.add('deps');
    }
    if (lower.includes('config') || lower.includes('.env') || lower.endsWith('.yml')) {
      tags.add('config');
    }
    if (lower.includes('perf') || lower.includes('benchmark')) {
      tags.add('perf');
    }
  });
  return Array.from(tags).slice(0, 3);
}

function markInboxProcessed(context: vscode.ExtensionContext, taskId: string): void {
  if (inboxProcessedSet.has(taskId)) {
    return;
  }
  inboxProcessedSet.add(taskId);
  inboxProcessedTasks = inboxProcessedTasks.filter((entry) => entry !== taskId);
  inboxProcessedTasks.push(taskId);
  if (inboxProcessedTasks.length > MAX_INBOX_PROCESSED) {
    inboxProcessedTasks = inboxProcessedTasks.slice(-MAX_INBOX_PROCESSED);
    inboxProcessedSet = new Set(inboxProcessedTasks);
  }
  void context.globalState.update(INBOX_PROCESSED_KEY, inboxProcessedTasks);
}

async function recordTerminalOutput(
  command: string,
  result: { stdout?: string; stderr?: string; exitCode?: number; cwd?: string },
  logger: Logger
): Promise<void> {
  const enabled = !!vscode.workspace.getConfiguration().get<boolean>('parallel.terminal.capture');
  if (!enabled || !activeClient) {
    return;
  }
  const workspaceId = vscode.workspace.getConfiguration().get<string>(WORKSPACE_ID_KEY) ?? '';
  if (!workspaceId) {
    return;
  }
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  try {
    await activeClient.request(`/api/v1/workspaces/${workspaceId}/vscode/terminal/output`, {
      method: 'POST',
      body: JSON.stringify({
        command,
        output,
        exit_code: result.exitCode ?? 0,
        cwd: result.cwd,
      }),
      redactBody: true,
    });
  } catch (err) {
    logger.error('Terminal output upload failed', err as Error);
  }
}

async function undoLastAgentEdit(logger: Logger): Promise<void> {
  const entry = undoHistory.shift();
  if (!entry) {
    vscode.window.showInformationMessage('No agent edits to undo.');
    return;
  }
  const workspaceEdit = new vscode.WorkspaceEdit();
  for (const [filePath, content] of Object.entries(entry.original)) {
    const uri = vscode.Uri.file(filePath);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      workspaceEdit.replace(uri, fullRange, content ?? '');
    } catch {
      workspaceEdit.createFile(uri, { overwrite: true });
      workspaceEdit.insert(uri, new vscode.Position(0, 0), content ?? '');
    }
  }
  await vscode.workspace.applyEdit(workspaceEdit);
  await vscode.workspace.saveAll();
  logger.audit(`Undo applied for edit ${entry.id}`);
  vscode.window.showInformationMessage('Reverted last agent edit.');
}

async function runWorkspaceIndex(logger: Logger): Promise<void> {
  if (!activeClient) {
    vscode.window.showWarningMessage('Sign in to index the workspace.');
    return;
  }
  const workspaceId = vscode.workspace.getConfiguration().get<string>(WORKSPACE_ID_KEY) ?? '';
  if (!workspaceId) {
    vscode.window.showWarningMessage('Select a workspace before indexing.');
    return;
  }
  await indexWorkspaceFiles(activeClient, workspaceId, logger);
  vscode.window.showInformationMessage('Workspace indexing finished.');
}

async function explainSelection(logger: Logger): Promise<void> {
  if (!activeClient) {
    vscode.window.showWarningMessage('Sign in to use explain.');
    return;
  }
  const workspaceId = vscode.workspace.getConfiguration().get<string>(WORKSPACE_ID_KEY) ?? '';
  if (!workspaceId) {
    vscode.window.showWarningMessage('Select a workspace before explaining code.');
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const selection = editor.document.getText(editor.selection) || editor.document.getText();
  const filePath = vscode.workspace.asRelativePath(editor.document.uri);
  const response = await activeClient.request<{ explanation: string }>(
    `/api/v1/workspaces/${workspaceId}/vscode/agent/explain`,
    {
      method: 'POST',
      body: JSON.stringify({
        code: selection,
        file_path: filePath,
        language: editor.document.languageId,
        cursor_position: {
          line: editor.selection.active.line,
          character: editor.selection.active.character,
        },
      }),
      redactBody: true,
    }
  );
  const doc = await vscode.workspace.openTextDocument({
    content: response.explanation,
    language: 'markdown',
  });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
}

async function generateTestsForSelection(logger: Logger): Promise<void> {
  if (!activeClient) {
    vscode.window.showWarningMessage('Sign in to generate tests.');
    return;
  }
  const workspaceId = vscode.workspace.getConfiguration().get<string>(WORKSPACE_ID_KEY) ?? '';
  if (!workspaceId) {
    vscode.window.showWarningMessage('Select a workspace before generating tests.');
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const functionName = await vscode.window.showInputBox({
    prompt: 'Function name to generate tests for',
    placeHolder: 'my_function',
  });
  if (!functionName) {
    return;
  }
  const filePath = vscode.workspace.asRelativePath(editor.document.uri);
  const response = await activeClient.request<{ file_path: string; content: string }>(
    `/api/v1/workspaces/${workspaceId}/vscode/agent/generate-tests`,
    {
      method: 'POST',
      body: JSON.stringify({
        file_path: filePath,
        function_name: functionName,
        code: editor.document.getText(),
      }),
      redactBody: true,
    }
  );
  const doc = await vscode.workspace.openTextDocument({
    content: response.content,
    language: 'python',
  });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
}

async function askSelectionInChat(logger: Logger): Promise<void> {
  if (!chatSidebarProvider) {
    vscode.window.showWarningMessage('Chat panel is not available.');
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const selection = editor.document.getText(editor.selection) || editor.document.getText();
  const question = await vscode.window.showInputBox({
    prompt: 'Ask the Parallel assistant about the selected code',
    placeHolder: 'Explain this code and suggest improvements',
  });
  if (!question) {
    return;
  }
  const language = editor.document.languageId || 'text';
  const message = `${question}\n\n\`\`\`${language}\n${selection}\n\`\`\``;
  await chatSidebarProvider.sendMessage(message);
  logger.audit('Sent selection to chat');
}

async function migrateLegacyToken(
  context: vscode.ExtensionContext,
  existingToken?: string
): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration();
  const legacyRaw = config.get<string>(LEGACY_TOKEN_KEY);
  if (!legacyRaw) {
    return undefined;
  }
  const normalized = normalizeToken(legacyRaw);
  await config.update(LEGACY_TOKEN_KEY, undefined, vscode.ConfigurationTarget.Global);
  await config.update(LEGACY_TOKEN_KEY, undefined, vscode.ConfigurationTarget.Workspace);
  await config.update(LEGACY_TOKEN_KEY, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  if (!normalized) {
    return undefined;
  }
  if (!existingToken) {
    await savePat(context, normalized);
    vscode.window.showInformationMessage(
      'Migrated legacy Parallel token from settings into Secret Storage.'
    );
    return normalized;
  }
  return existingToken;
}

function sanitizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
  } catch {
    return null;
  }
  return trimmed.replace(/\/+$/, '');
}

function buildAuthorizeUrl(
  apiBaseUrl: string,
  redirectUri: string,
  state: string,
  challenge: string
): string {
  const base = sanitizeBaseUrl(apiBaseUrl) ?? apiBaseUrl;
  const url = new URL('/api/oauth/authorize', base);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', OAUTH_SCOPES.join(' '));
  url.searchParams.set('state', state);
  return url.toString();
}

function getRedirectUri(context: vscode.ExtensionContext): string {
  return `vscode://${context.extension.id}/auth-callback`;
}

function randomBase64Url(size: number): string {
  return toBase64Url(crypto.randomBytes(size));
}

function toBase64Url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBase64Url(32);
  const challenge = toBase64Url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

type OAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
};

async function exchangeAuthCode(
  client: ParallelClient,
  apiBaseUrl: string,
  redirectUri: string,
  verifier: string,
  code: string
): Promise<OAuthTokenResponse> {
  client.setApiBaseUrl(apiBaseUrl);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    client_id: OAUTH_CLIENT_ID,
  });
  return client.request<OAuthTokenResponse>('/api/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

async function loadOAuthPending(context: vscode.ExtensionContext): Promise<OAuthPending | null> {
  const cached = oauthPending ?? context.globalState.get<OAuthPending>(OAUTH_PENDING_KEY);
  if (
    cached &&
    typeof cached.state === 'string' &&
    typeof cached.verifier === 'string' &&
    typeof cached.redirectUri === 'string' &&
    typeof cached.apiBaseUrl === 'string'
  ) {
    return cached;
  }
  return null;
}

async function completeOAuth(context: vscode.ExtensionContext, state: string): Promise<void> {
  const callback = oauthCallbacks.get(state);
  if (callback) {
    clearTimeout(callback.timeout);
    callback.resolve();
    oauthCallbacks.delete(state);
  }
  oauthPending = null;
  await context.globalState.update(OAUTH_PENDING_KEY, undefined);
}

async function failOAuth(
  context: vscode.ExtensionContext,
  state: string,
  err: unknown
): Promise<void> {
  const message = formatAuthError(err, 'Sign in failed');
  const callback = oauthCallbacks.get(state);
  if (callback) {
    clearTimeout(callback.timeout);
    callback.reject(new Error(message));
    oauthCallbacks.delete(state);
  }
  oauthPending = null;
  await context.globalState.update(OAUTH_PENDING_KEY, undefined);
  vscode.window.showErrorMessage(message);
}

function formatAuthError(err: unknown, fallback: string): string {
  if (err instanceof HttpError) {
    const detail = err.body ? `: ${err.body}` : '';
    return `${fallback} (HTTP ${err.status})${detail}`;
  }
  return err instanceof Error ? err.message : fallback;
}

function handleError(err: unknown, message: string): void {
  const text = err instanceof Error ? err.message : String(err);
  vscode.window.showErrorMessage(`${message}: ${text}`);
}

function updateStatusBar(status: string, workspaceId: string | null): void {
  if (!statusBarItem) {
    return;
  }
  const authPart = isSignedIn ? 'Signed in' : 'Signed out';
  const wsPart = workspaceId ? ` • ${workspaceId}` : '';
  const statusPart = status ? ` • ${status}` : '';
  statusBarItem.text = `Parallel: ${authPart}${wsPart}${statusPart}`;
  chatSidebarProvider?.refresh();
}

function prettyStatus(): string {
  if (syncInFlight) {
    return 'Syncing';
  }
  switch (connectionStatus) {
    case 'live':
      return 'Live';
    case 'connecting':
      return 'Connecting';
    default:
      return 'Disconnected';
  }
}

function isMockEnabled(): boolean {
  return !!vscode.workspace.getConfiguration().get<boolean>('parallel.dev.mockBackend');
}

function isDemoModeEnabled(): boolean {
  return !!vscode.workspace.getConfiguration().get<boolean>('parallel.dev.demoMode');
}

function ensureMockBackend(): MockBackend | null {
  if (!isMockEnabled()) {
    return null;
  }
  if (!mockBackend) {
    mockBackend = new MockBackend();
  }
  return mockBackend;
}

function buildSyncService(client: ParallelClient, store: Store, logger: Logger): SyncService {
  const mock = ensureMockBackend();
  if (mock) {
    return new SyncService(
      client,
      store,
      logger,
      (workspaceId: string, cursor: string | null) => mock.syncPage(workspaceId, cursor)
    );
  }
  return new SyncService(
    client,
    store,
    logger,
    (workspaceId: string, cursor: string | null) =>
      fetchSyncPage(
        client,
        workspaceId,
        cursor,
        readSyncPageSize(),
        readSyncRequestTimeoutMs() ?? readRequestTimeoutMs()
      )
  );
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function hashString(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
