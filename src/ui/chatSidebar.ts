import * as path from 'path';
import * as vscode from 'vscode';

import {
  sendChatMessage,
  createChatSession,
  fetchChatMessages,
  fetchChatSessions,
  ChatMessage,
  ChatSession,
  ChatRepoContext,
} from '../api/chats';
import { collectRepoContext, RepoContext, RepoSemanticContext } from '../agent/promptCollector';
import { HttpError, ParallelClient } from '../api/client';
import { readPat } from '../auth/session';
import { RealtimeStatus } from '../realtime/sse';
import { EntityRecord, Store } from '../store/store';
import { Logger } from '../util/logger';

type ConnectionState = 'connected' | 'connecting' | 'disconnected' | 'auth-required';

interface AuthActions {
  startBrowserSignIn: (apiBaseUrl?: string) => Promise<void>;
}

interface AgentActions {
  submitAgentPrompt: (text: string, mode: 'dry-run' | 'apply') => Promise<void> | void;
}

interface SidebarState {
  auth: { signedIn: boolean; inProgress: boolean };
  apiBaseUrl: string;
  user: { id: string; name?: string } | null;
  workspace: { id: string | null; name?: string };
  connection: { status: ConnectionState; label: string };
  sessions: ChatSession[];
  activeChatId: string | null;
  messages: ChatMessage[];
  error?: string | null;
  errorIsAuth?: boolean;
  isThinking: boolean;
}

interface WebviewMessage {
  type: string;
  chatId?: string;
  content?: string;
  text?: string;
  name?: string;
  apiBaseUrl?: string;
  mode?: string;
}

export class ChatSidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private sessions: ChatSession[] = [];
  private activeChatId: string | null = null;
  private messages: ChatMessage[] = [];
  private lastError: string | null = null;
  private lastErrorIsAuth = false;
  private forceSignedOut = false;
  private currentWorkspaceId: string | null = null;
  private storeDispose: (() => void) | null = null;
  private sessionsInFlight = false;
  private messagesInFlight = false;
  private storeRefreshInFlight = false;
  private lastMessageIds = '';
  private authInProgress = false;
  private createChatInFlight = false;
  private thinking = false;
  private autoCreateChatOnStart = true;

  constructor(
    private context: vscode.ExtensionContext,
    private client: ParallelClient,
    private store: Store,
    private logger: Logger,
    private getWorkspaceInfo: () => { id: string | null; name?: string },
    private getUserInfo: () => { id: string; name?: string } | null,
    private getRealtimeStatus: () => RealtimeStatus,
    private isSignedIn: () => boolean,
    private authActions: AuthActions,
    private agentActions?: AgentActions
  ) {
    this.storeDispose = this.store.onDidChange(() => {
      void this.refreshMessagesFromStore();
    });
    this.refreshSessions = this.refreshSessions.bind(this);
  }

  dispose(): void {
    this.storeDispose?.();
    this.storeDispose = null;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.buildHtml(view.webview);
    view.onDidDispose(() => {
      this.view = null;
    });
    view.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });
    void this.refreshSessions();
    this.postState();
  }

  refresh(): void {
    this.postState();
  }

  async refreshSessions(): Promise<void> {
    if (this.sessionsInFlight) {
      return;
    }
    try {
      const workspace = this.getWorkspaceInfo();
      if (!workspace.id || !this.isAuthenticated()) {
        this.sessions = [];
        this.activeChatId = null;
        this.messages = [];
        this.currentWorkspaceId = workspace.id ?? null;
        this.postState();
        return;
      }
      if (this.currentWorkspaceId && this.currentWorkspaceId !== workspace.id) {
        this.sessions = [];
        this.activeChatId = null;
        this.messages = [];
      }
      this.currentWorkspaceId = workspace.id;
      this.sessionsInFlight = true;
      try {
        if (this.isMockEnabled()) {
          this.sessions = await this.deriveSessionsFromStore(workspace.id);
          this.forceSignedOut = false;
          this.clearError();
        } else {
          await this.ensureClientAuth();
          this.sessions = await fetchChatSessions(this.client, workspace.id, 20);
          this.forceSignedOut = false;
          this.clearError();
        }
      } catch (err) {
        this.handleBackendError(err, 'Failed to load chat sessions');
        this.sessions = await this.deriveSessionsFromStore(workspace.id);
      } finally {
        this.sessionsInFlight = false;
      }
      let autoCreated = false;
      if (this.autoCreateChatOnStart && this.isAuthenticated() && workspace.id) {
        this.autoCreateChatOnStart = false;
        const session = await this.createChatSessionForContent('', 'Parallel Assistant');
        autoCreated = !!session;
      }
      if (!autoCreated) {
        await this.ensureActiveChat();
      }
      this.postState();
    } catch (err) {
      this.sessionsInFlight = false;
      this.handleBackendError(err, 'Failed to refresh chat sessions');
    }
  }

  private async refreshActiveChat(): Promise<void> {
    await this.refreshSessions();
    if (this.activeChatId) {
      await this.loadMessages(this.activeChatId);
      this.postState();
    }
  }

  private async ensureActiveChat(): Promise<void> {
    const preferred = this.pickPreferredSession(this.sessions);
    const nextId = preferred?.id ?? null;
    if (!nextId) {
      this.activeChatId = null;
      this.messages = [];
      return;
    }
    if (this.activeChatId !== nextId) {
      this.activeChatId = nextId;
      await this.loadMessages(nextId);
      return;
    }
  }

  private pickPreferredSession(sessions: ChatSession[]): ChatSession | null {
    if (!sessions.length) {
      return null;
    }
    const preferred = sessions.find((session) =>
      session.name?.toLowerCase().includes('parallel assistant')
    );
    return preferred ?? sessions[0];
  }

  async setActiveChat(chatId: string): Promise<void> {
    if (!chatId || chatId === this.activeChatId) {
      return;
    }
    this.activeChatId = chatId;
    await this.loadMessages(chatId);
    this.postState();
  }

  async sendMessage(content: string): Promise<void> {
    const trimmed = content?.trim();
    if (!trimmed) {
      return;
    }
    const workspace = this.getWorkspaceInfo();
    if (!workspace.id) {
      this.postError('Select a workspace before sending messages.');
      return;
    }
    if (!this.isAuthenticated()) {
      this.postError('Not signed in. Sign in to send messages.', true);
      return;
    }
    if (!this.activeChatId) {
      await this.createChatAndSend(trimmed);
      return;
    }
    await this.sendMessageToChat(this.activeChatId, trimmed);
  }

  private async createChatAndSend(content: string): Promise<void> {
    const nameHint = this.sessions.length ? undefined : 'Parallel Assistant';
    const nameContent = nameHint ? '' : content;
    const session = await this.createChatSessionForContent(nameContent, nameHint);
    if (!session) {
      return;
    }
    const trimmed = content?.trim();
    if (!trimmed) {
      return;
    }
    await this.sendMessageToChat(session.id, trimmed);
  }

  private async createChatSessionForContent(
    content?: string,
    nameHint?: string
  ): Promise<ChatSession | null> {
    if (this.createChatInFlight) {
      return null;
    }
    const workspace = this.getWorkspaceInfo();
    if (!workspace.id) {
      this.postError('Select a workspace before creating a chat.');
      return null;
    }
    if (!this.isAuthenticated()) {
      this.postError('Not signed in. Sign in to create chats.', true);
      return null;
    }
    const name = this.buildChatName(content, nameHint);
    this.createChatInFlight = true;
    try {
      if (this.isMockEnabled()) {
        const session: ChatSession = {
          id: `local-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          name,
          updatedAt: null,
          lastMessageAt: null,
        };
        this.sessions = [session, ...this.sessions];
        this.activeChatId = session.id;
        this.messages = [];
        this.forceSignedOut = false;
        this.postState();
        return session;
      }
      await this.ensureClientAuth();
      const session = await createChatSession(this.client, workspace.id, name);
      this.sessions = [session, ...this.sessions.filter((item) => item.id !== session.id)];
      this.activeChatId = session.id;
      this.messages = [];
      this.forceSignedOut = false;
      this.postState();
      await this.loadMessages(session.id);
      this.clearError();
      return session;
    } catch (err) {
      this.handleBackendError(err, 'Failed to create chat');
      return null;
    } finally {
      this.createChatInFlight = false;
    }
  }

  private async sendMessageToChat(chatId: string, content: string): Promise<void> {
    const trimmed = content?.trim();
    if (!trimmed) {
      return;
    }
    const workspace = this.getWorkspaceInfo();
    if (!workspace.id) {
      this.postError('Select a workspace before sending messages.');
      return;
    }
    if (this.activeChatId !== chatId) {
      this.activeChatId = chatId;
    }
    const agentDirective = parseAgentDirective(trimmed);
    if (agentDirective) {
      if (!agentDirective.text) {
        this.postError('Add a request after the /agent or /apply prefix.');
        return;
      }
      if (!this.agentActions?.submitAgentPrompt) {
        this.postError('Agent panel is unavailable in this session.');
        return;
      }
      await this.agentActions.submitAgentPrompt(agentDirective.text, agentDirective.mode);
      return;
    }
    const optimisticId = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const optimistic: ChatMessage = {
      id: optimisticId,
      chatId,
      role: 'user',
      content: trimmed,
      createdAt: new Date().toISOString(),
      senderName: 'You',
    };
    this.messages = mergeMessages(this.messages, [optimistic]);
    this.thinking = true;
    this.postState();
    const streamEnabled = this.isStreamResponsesEnabled();
    let assistantPlaceholderId: string | null = null;
    try {
      if (this.isMockEnabled()) {
        this.postError('Mock backend enabled: messages are not sent to a server.');
        return;
      }
      await this.ensureClientAuth();
      let repoPayload: ChatRepoContext | undefined;
      try {
        const semanticContext = await this.fetchSemanticContext(trimmed, workspace.id);
        const repoContext = await collectRepoContext(trimmed, { semanticContext });
        repoPayload = buildRepoPayload(workspace, repoContext);
      } catch (err) {
        this.logger.error('Failed to collect repo context for chat', err as Error);
      }
      const createdMessages = await sendChatMessage(this.client, workspace.id, chatId, trimmed, {
        stream: streamEnabled,
        onChunk: (chunk) => {
          if (!chunk) {
            return;
          }
          if (!assistantPlaceholderId) {
            assistantPlaceholderId = `local-assistant-${Date.now()}-${Math.random()
              .toString(16)
              .slice(2)}`;
            const placeholder: ChatMessage = {
              id: assistantPlaceholderId,
              chatId,
              role: 'assistant',
              content: '',
              createdAt: new Date().toISOString(),
            };
            this.messages = mergeMessages(this.messages, [placeholder]);
          }
          this.appendStreamingChunk(assistantPlaceholderId, chunk);
        },
        repo: repoPayload,
      });
      const filtered = this.messages.filter(
        (m) => m.id !== optimisticId && m.id !== assistantPlaceholderId
      );
      const hasUserEcho = createdMessages.some(
        (m) => m.role === 'user' && m.content === trimmed
      );
      const base = hasUserEcho ? filtered : mergeMessages(filtered, [optimistic]);
      this.messages = createdMessages.length ? mergeMessages(base, createdMessages) : base;
      this.forceSignedOut = false;
      this.clearError();
      await this.refreshSessions();
    } catch (err) {
      this.handleBackendError(err, 'Failed to send message');
      this.messages = this.messages.filter(
        (m) => m.id !== optimisticId && m.id !== assistantPlaceholderId
      );
      this.postState();
    } finally {
      this.thinking = false;
      this.postState();
    }
  }

  private async fetchSemanticContext(
    query: string,
    workspaceId: string | null
  ): Promise<RepoSemanticContext[]> {
    if (!workspaceId || !query.trim()) {
      return [];
    }
    const config = vscode.workspace.getConfiguration();
    const enabled = !!config.get<boolean>('parallel.indexing.useSemanticContext');
    const indexingEnabled = !!config.get<boolean>('parallel.indexing.enabled');
    if (!enabled || !indexingEnabled) {
      return [];
    }
    try {
      const response = await this.client.request<{ results: any[] }>(
        `/api/v1/workspaces/${workspaceId}/vscode/index/search`,
        {
          method: 'POST',
          body: JSON.stringify({ query, limit: 6 }),
          redactBody: true,
        }
      );
      return (response?.results ?? []).map((entry) => ({
        file_path: entry.file_path ?? entry.file ?? '',
        content: entry.content ?? '',
        score: entry.score,
        metadata: entry.metadata,
      }));
    } catch {
      return [];
    }
  }

  private appendStreamingChunk(messageId: string | null, chunk: string): void {
    if (!messageId || !chunk) {
      return;
    }
    this.messages = this.messages.map((message) => {
      if (message.id !== messageId) {
        return message;
      }
      return { ...message, content: `${message.content ?? ''}${chunk}` };
    });
    this.thinking = false;
    this.postState();
  }

  private async startNewChat(): Promise<void> {
    await this.createChatSessionForContent('', 'Parallel Assistant');
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message?.type) {
        case 'ui/ready':
          this.postState();
          return;
        case 'ui/newChat':
          this.logger.info('Sidebar action: new chat');
          await this.startNewChat();
          return;
        case 'ui/refresh':
          this.logger.info('Sidebar action: refresh chat');
          await this.refreshActiveChat();
          return;
        case 'ui/retry':
          this.logger.info('Sidebar action: retry');
          await this.retryLastAction();
          return;
        case 'ui/reconnect':
          this.logger.info('Sidebar action: reconnect');
          await this.handleConnect();
          return;
        case 'ui/copyTranscript':
          this.logger.info('Sidebar action: copy transcript');
          await this.copyTranscript();
          return;
        case 'ui/openWebApp':
          this.logger.info('Sidebar action: open web app');
          await vscode.commands.executeCommand('parallel.openWebApp');
          return;
        case 'ui/openSettings':
          this.logger.info('Sidebar action: open settings');
          await vscode.commands.executeCommand('workbench.action.openSettings', 'parallel');
          return;
        case 'ui/openProfileMenu':
          this.logger.info('Sidebar action: open profile menu');
          await vscode.commands.executeCommand('parallel.openProfileMenu');
          return;
        case 'ui/selectWorkspace':
          await vscode.commands.executeCommand('parallel.selectWorkspace');
          return;
        case 'ui/forceSync':
          await vscode.commands.executeCommand('parallel.forceSync');
          return;
        case 'ui/forceFullResync':
          await vscode.commands.executeCommand('parallel.forceFullResync');
          return;
        case 'auth/signIn':
          this.logger.info('Sidebar action: sign in');
          await this.runAuthAction(async () => {
            if (message.mode === 'browser' || !message.mode) {
              await this.authActions.startBrowserSignIn(message.apiBaseUrl);
              return;
            }
            await vscode.commands.executeCommand('parallel.signIn');
          });
          return;
        case 'auth/signOut':
          this.logger.info('Sidebar action: sign out');
          await vscode.commands.executeCommand('parallel.signOut');
          return;
        case 'composer/clearLocal':
          this.logger.info('Sidebar action: clear transcript');
          this.clearLocalMessages();
          return;
        case 'composer/attachFiles':
          this.logger.info('Sidebar action: attach files');
          await this.pickAttachments();
          return;
        case 'chat/sendMessage':
          this.logger.info(
            `Sidebar action: send message (${(message.text ?? message.content ?? '').length} chars)`
          );
          await this.sendMessage(message.text ?? message.content ?? '');
          return;
        case 'chat/selectChat':
          if (message.chatId) {
            await this.setActiveChat(message.chatId);
          }
          return;
        default:
          return;
      }
    } catch (err) {
      this.handleBackendError(err, 'Sidebar action failed');
    }
  }

  private async handleConnect(): Promise<void> {
    const workspace = this.getWorkspaceInfo();
    if (!this.isAuthenticated()) {
      await vscode.commands.executeCommand('parallel.signIn');
      return;
    }
    if (!workspace.id) {
      await vscode.commands.executeCommand('parallel.selectWorkspace');
      return;
    }
    await this.refreshSessions();
  }

  private async retryLastAction(): Promise<void> {
    this.clearError();
    this.postState();
    if (this.activeChatId) {
      await this.loadMessages(this.activeChatId);
      return;
    }
    await this.refreshSessions();
  }

  private async runAuthAction(action: () => Promise<void>): Promise<void> {
    if (this.authInProgress) {
      return;
    }
    this.authInProgress = true;
    this.clearError();
    this.postState();
    try {
      await action();
      this.forceSignedOut = false;
      this.clearError();
      await this.refreshSessions();
    } catch (err) {
      this.postError(formatAuthError(err, 'Sign in failed'));
    } finally {
      this.authInProgress = false;
      this.postState();
    }
  }

  private clearLocalMessages(): void {
    this.messages = [];
    this.lastMessageIds = '';
    this.thinking = false;
    this.postState();
  }

  private async copyTranscript(): Promise<void> {
    if (!this.messages.length) {
      this.postToast('info', 'No messages to copy.');
      return;
    }
    const text = this.formatTranscript(this.messages);
    await vscode.env.clipboard.writeText(text);
    this.postClipboard(text);
    this.postToast('info', 'Transcript copied to clipboard.');
  }

  private formatTranscript(messages: ChatMessage[]): string {
    return messages
      .map((message) => {
        const role = message.role === 'user' ? 'User' : 'Assistant';
        const timestamp = formatIsoTimestamp(message.createdAt);
        const heading = timestamp ? `### ${role} (${timestamp})` : `### ${role}`;
        return `${heading}\n${message.content}`;
      })
      .join('\n\n');
  }

  private async pickAttachments(): Promise<void> {
    const picks = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: 'Attach',
    });
    if (!picks || !picks.length) {
      return;
    }
    const files = await Promise.all(
      picks.map(async (uri) => {
        let size: number | undefined;
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          size = stat.size;
        } catch {
          size = undefined;
        }
        return {
          name: path.basename(uri.fsPath),
          uri: uri.toString(),
          size,
        };
      })
    );
    this.postAttachedFiles(files);
    this.postToast('info', `Attached ${files.length} file(s).`);
  }

  private async loadMessages(chatId: string): Promise<void> {
    if (this.messagesInFlight) {
      return;
    }
    const workspace = this.getWorkspaceInfo();
    if (!workspace.id || !this.isAuthenticated()) {
      this.messages = [];
      this.postState();
      return;
    }
    this.messagesInFlight = true;
    try {
      if (this.isMockEnabled()) {
        this.messages = await this.collectMessagesFromStore(chatId);
        this.forceSignedOut = false;
        this.clearError();
      } else {
        await this.ensureClientAuth();
        this.messages = await fetchChatMessages(this.client, chatId, 50);
        this.forceSignedOut = false;
        this.clearError();
        this.lastMessageIds = '';
      }
    } catch (err) {
      this.handleBackendError(err, 'Failed to load chat messages');
      this.messages = await this.collectMessagesFromStore(chatId);
    } finally {
      this.messagesInFlight = false;
    }
    this.postState();
  }

  private async refreshMessagesFromStore(): Promise<void> {
    if (this.storeRefreshInFlight || !this.activeChatId) {
      return;
    }
    this.storeRefreshInFlight = true;
    try {
      const fromStore = await this.collectMessagesFromStore(this.activeChatId);
      if (!fromStore.length) {
        return;
      }
      const merged = mergeMessages(this.messages, fromStore);
      const ids = merged.map((m) => m.id).join('|');
      if (ids !== this.lastMessageIds) {
        this.lastMessageIds = ids;
        this.messages = merged;
        this.postState();
      }
    } finally {
      this.storeRefreshInFlight = false;
    }
  }

  private async collectMessagesFromStore(chatId: string): Promise<ChatMessage[]> {
    const workspaceId = this.getWorkspaceInfo().id;
    if (!workspaceId) {
      return [];
    }
    const records = await this.store.getRecent('message', 200, workspaceId).catch(() => []);
    const mapped: ChatMessage[] = [];
    for (const record of records) {
      const message = recordToChatMessage(record, chatId);
      if (message) {
        mapped.push(message);
      }
    }
    return mapped.sort((a, b) => compareIso(a.createdAt, b.createdAt));
  }

  private async deriveSessionsFromStore(workspaceId: string): Promise<ChatSession[]> {
    const records = await this.store.getRecent('message', 200, workspaceId).catch(() => []);
    const byChat = new Map<string, { name: string; lastMessageAt: string }>();
    records.forEach((record) => {
      const payload = record.payload as Record<string, unknown> | undefined;
      const chatId = typeof payload?.chat_id === 'string' ? payload.chat_id : 'session';
      const lastMessageAt = (payload?.created_at as string | undefined) ?? record.updated_at;
      const name =
        typeof payload?.chat_name === 'string'
          ? payload.chat_name
          : chatId === 'session'
          ? 'Recent Session'
          : chatId;
      if (!byChat.has(chatId)) {
        byChat.set(chatId, { name, lastMessageAt });
      }
    });
    return Array.from(byChat.entries()).map(([id, info]) => ({
      id,
      name: info.name,
      lastMessageAt: info.lastMessageAt,
    }));
  }

  private async ensureClientAuth(): Promise<void> {
    const pat = await readPat(this.context);
    if (!pat) {
      throw new Error('Please sign in to Parallel to load chats.');
    }
    this.client.setToken(pat);
  }

  private isMockEnabled(): boolean {
    return !!vscode.workspace.getConfiguration().get<boolean>('parallel.dev.mockBackend');
  }

  private isStreamResponsesEnabled(): boolean {
    return !!vscode.workspace.getConfiguration().get<boolean>('parallel.streamResponses');
  }

  private isAuthenticated(): boolean {
    return this.isSignedIn() && !this.forceSignedOut;
  }

  private postState(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ type: 'state/update', state: this.buildState() });
  }

  private clearError(): void {
    this.lastError = null;
    this.lastErrorIsAuth = false;
  }

  private postError(message: string, isAuthError = false): void {
    this.lastError = message;
    this.lastErrorIsAuth = isAuthError;
    this.postToast('error', message);
    this.postState();
  }

  private postToast(level: 'info' | 'warning' | 'error', message: string): void {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ type: 'action/toast', level, message });
  }

  private postAttachedFiles(files: { name: string; uri: string; size?: number }[]): void {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ type: 'action/attachedFiles', files });
  }

  private postClipboard(text: string): void {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ type: 'action/clipboard', text });
  }

  handleSignedOut(): void {
    this.forceSignedOut = false;
    this.sessions = [];
    this.activeChatId = null;
    this.messages = [];
    this.lastMessageIds = '';
    this.currentWorkspaceId = null;
    this.clearError();
    this.postState();
  }

  private handleBackendError(err: unknown, fallbackMessage: string): string {
    const httpInfo = this.extractHttpInfo(err);
    if (httpInfo?.status === 401 || httpInfo?.status === 403) {
      this.forceSignedOut = true;
      const message = httpInfo.status === 403 ? 'Authorization required' : 'Not authenticated';
      this.postError(message, true);
      return message;
    }

    let message = fallbackMessage;
    if (httpInfo?.status) {
      message = `${fallbackMessage} (HTTP ${httpInfo.status})`;
      if (httpInfo.detail) {
        message = `${message}: ${httpInfo.detail}`;
      }
    } else if (err instanceof Error && err.message) {
      message = `${fallbackMessage}: ${err.message}`;
    }

    this.postError(message);
    this.logger.error(fallbackMessage, err);
    return message;
  }

  private extractHttpInfo(
    err: unknown
  ): { status: number; detail?: string } | null {
    if (err instanceof HttpError) {
      return { status: err.status, detail: err.body };
    }
    if (err && typeof err === 'object') {
      const maybeStatus = (err as { status?: unknown }).status;
      if (typeof maybeStatus === 'number') {
        const detailRaw = (err as { body?: unknown; message?: unknown }).body;
        const detail =
          typeof detailRaw === 'string'
            ? detailRaw
            : detailRaw
            ? JSON.stringify(detailRaw)
            : undefined;
        return { status: maybeStatus, detail };
      }
      const response = (err as { response?: unknown }).response;
      if (response && typeof response === 'object') {
        const status = (response as { status?: unknown }).status;
        if (typeof status === 'number') {
          const data = (response as { data?: unknown }).data;
          const detail =
            typeof data === 'string' ? data : data ? JSON.stringify(data) : undefined;
          return { status, detail };
        }
      }
    }
    return null;
  }

  private buildState(): SidebarState {
    const workspace = this.getWorkspaceInfo();
    const signedIn = this.isAuthenticated();
    const connection = this.buildConnectionState(signedIn, workspace.id);
    return {
      auth: { signedIn, inProgress: this.authInProgress },
      apiBaseUrl: this.client.getApiBaseUrl(),
      user: this.getUserInfo(),
      workspace,
      connection,
      sessions: this.sessions,
      activeChatId: this.activeChatId,
      messages: this.messages,
      error: this.lastError,
      errorIsAuth: this.lastErrorIsAuth,
      isThinking: this.thinking,
    };
  }

  private buildConnectionState(
    signedIn: boolean,
    workspaceId: string | null
  ): SidebarState['connection'] {
    if (!signedIn || this.lastErrorIsAuth) {
      return { status: 'auth-required', label: 'Auth required' };
    }
    if (!workspaceId) {
      return { status: 'disconnected', label: 'Offline' };
    }
    const realtime = this.getRealtimeStatus();
    if (realtime === 'live') {
      return { status: 'connected', label: 'Connected' };
    }
    if (realtime === 'connecting') {
      return { status: 'connecting', label: 'Connecting' };
    }
    return { status: 'disconnected', label: 'Offline' };
  }

  private buildChatName(content?: string, nameHint?: string): string {
    const firstLine = (content ?? '').trim().split(/\r?\n/)[0];
    const trimmed = firstLine.slice(0, 60).trim();
    const base =
      trimmed ||
      nameHint ||
      `Chat ${new Date().toISOString().replace('T', ' ').slice(0, 19)}`;
    const existing = new Set(this.sessions.map((session) => (session.name ?? '').toLowerCase()));
    if (!existing.has(base.toLowerCase())) {
      return base;
    }
    const suffix = new Date().toISOString().slice(11, 19);
    return `${base} (${suffix})`;
  }

  private buildHtml(webview: vscode.Webview): string {
    const nonce = `${Date.now()}`;
    const cspSource = webview.cspSource;
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          :root {
            color-scheme: light dark;
            --panel-bg: linear-gradient(155deg, rgba(18, 34, 43, 0.55), rgba(6, 10, 15, 0.85)), var(--vscode-sideBar-background);
            --panel-surface: color-mix(in srgb, var(--vscode-editorWidget-background) 72%, #0b1a21 28%);
            --panel-surface-strong: color-mix(in srgb, var(--vscode-editorWidget-background) 60%, #06141b 40%);
            --panel-border: color-mix(in srgb, var(--vscode-panel-border) 55%, #1aa39a 45%);
            --panel-muted: color-mix(in srgb, var(--vscode-descriptionForeground) 70%, #c7b392 30%);
            --panel-accent: #2fc4b2;
            --panel-accent-strong: #f0a84b;
            --panel-shadow: rgba(0, 0, 0, 0.28);
          }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            padding: 0;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background: var(--panel-bg);
          }
          .app {
            display: flex;
            flex-direction: column;
            height: 100vh;
            position: relative;
          }
          .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 12px 14px;
            border-bottom: 1px solid var(--panel-border);
            background: var(--panel-surface-strong);
          }
          .header-left {
            display: flex;
            flex-direction: column;
            gap: 4px;
            min-width: 160px;
          }
          .header-label {
            font-size: 0.65em;
            letter-spacing: 0.35em;
            color: var(--panel-muted);
          }
          .header-title {
            font-weight: 600;
            font-size: 1.05em;
          }
          .header-meta {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 0.78em;
            color: var(--panel-muted);
            flex-wrap: wrap;
          }
          .header-meta-sep {
            opacity: 0.6;
          }
          .header-right {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 6px;
            flex-wrap: wrap;
          }
          button {
            font: inherit;
            border-radius: 6px;
            border: 1px solid var(--panel-border);
            padding: 4px 10px;
            color: var(--vscode-button-foreground);
            background: color-mix(in srgb, var(--vscode-button-background) 70%, var(--panel-accent) 30%);
            cursor: pointer;
          }
          button.secondary {
            background: transparent;
            color: var(--vscode-foreground);
          }
          button.primary {
            background: var(--panel-accent);
            color: var(--vscode-button-foreground);
          }
          button:disabled {
            opacity: 0.55;
            cursor: not-allowed;
          }
          .icon-btn {
            width: 30px;
            height: 30px;
            padding: 0;
            border-radius: 8px;
            border: 1px solid var(--panel-border);
            background: var(--panel-surface-strong);
            display: inline-flex;
            align-items: center;
            justify-content: center;
          }
          .icon-btn svg {
            width: 14px;
            height: 14px;
            stroke: currentColor;
            stroke-width: 1.6;
            fill: none;
          }
          .status-pill {
            font-size: 0.7em;
            padding: 4px 10px;
            border-radius: 999px;
            border: 1px solid var(--panel-border);
            background: color-mix(in srgb, var(--panel-surface-strong) 70%, #0d2a30 30%);
            color: var(--vscode-badge-foreground);
            text-transform: uppercase;
            letter-spacing: 0.08em;
          }
          .status-pill[data-status="connected"] {
            border-color: var(--panel-accent);
          }
          .status-pill[data-status="connecting"] {
            border-color: var(--panel-accent-strong);
          }
          .status-pill[data-status="disconnected"] {
            border-color: color-mix(in srgb, var(--vscode-gitDecoration-deletedResourceForeground) 70%, #5a2222 30%);
          }
          .status-pill[data-status="auth-required"] {
            border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-gitDecoration-deletedResourceForeground));
          }
          .chat-panel {
            display: flex;
            flex-direction: column;
            min-height: 0;
            flex: 1;
            background: var(--panel-surface);
          }
          .chat-list {
            display: none;
            flex-direction: column;
            gap: 10px;
            padding: 16px;
            overflow: auto;
          }
          .chat-list-item {
            border: 1px solid var(--panel-border);
            border-radius: 12px;
            padding: 10px 12px;
            background: var(--panel-surface-strong);
            cursor: pointer;
            display: flex;
            flex-direction: column;
            gap: 4px;
          }
          .chat-list-item.active {
            border-color: var(--panel-accent);
            box-shadow: 0 12px 18px -16px var(--panel-shadow);
          }
          .chat-list-title {
            font-weight: 600;
          }
          .chat-list-meta {
            font-size: 0.75em;
            color: var(--panel-muted);
            display: flex;
            gap: 8px;
            align-items: center;
            flex-wrap: wrap;
          }
          .chat-list-empty {
            text-align: center;
            color: var(--panel-muted);
            padding: 24px 10px;
          }
          .messages {
            flex: 1;
            overflow: auto;
            padding: 16px 16px 8px;
            display: flex;
            flex-direction: column;
            gap: 10px;
          }
          .hero {
            margin: auto;
            text-align: center;
            display: flex;
            flex-direction: column;
            gap: 10px;
            align-items: center;
            padding: 24px 12px;
          }
          .hero-mark {
            width: 52px;
            height: 52px;
            border-radius: 16px;
            border: 1px solid var(--panel-border);
            background: var(--panel-surface-strong);
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: 700;
            font-size: 1.1em;
          }
          .hero-title {
            font-size: 1.2em;
            font-weight: 600;
          }
          .hero-subtitle {
            color: var(--panel-muted);
            font-size: 0.9em;
          }
          .hero-actions {
            display: flex;
            flex-direction: column;
            gap: 10px;
            width: min(320px, 100%);
            margin-top: 10px;
          }
          .action-card {
            border: 1px solid var(--panel-border);
            background: var(--panel-surface);
            border-radius: 14px;
            padding: 12px;
            text-align: left;
            cursor: pointer;
            box-shadow: 0 12px 24px -18px var(--panel-shadow);
          }
          .action-title {
            font-weight: 600;
            margin-bottom: 4px;
          }
          .action-desc {
            font-size: 0.85em;
            color: var(--panel-muted);
          }
          .message-row {
            display: flex;
            gap: 10px;
            align-items: flex-start;
          }
          .message-row.user {
            flex-direction: row-reverse;
          }
          .avatar {
            width: 26px;
            height: 26px;
            border-radius: 50%;
            background: color-mix(in srgb, var(--panel-accent) 70%, #0b2227 30%);
            color: var(--vscode-badge-foreground);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.7em;
            font-weight: 600;
          }
          .avatar.assistant {
            background: var(--panel-surface-strong);
            border: 1px solid var(--panel-border);
          }
          .message-bubble {
            max-width: 82%;
            padding: 10px 12px;
            border-radius: 14px;
            border: 1px solid var(--panel-border);
            background: var(--panel-surface);
            white-space: pre-wrap;
            position: relative;
          }
          .message-bubble.user {
            background: color-mix(in srgb, var(--vscode-input-background) 70%, #123943 30%);
          }
          .message-meta {
            font-size: 0.7em;
            color: var(--panel-muted);
            margin-top: 6px;
          }
          .message-card {
            margin-top: 8px;
            padding: 8px;
            border-radius: 10px;
            border: 1px dashed var(--panel-border);
            background: var(--panel-surface-strong);
            font-size: 0.8em;
          }
          .message-card-label {
            font-weight: 600;
            letter-spacing: 0.12em;
            font-size: 0.75em;
            color: var(--panel-muted);
            margin-bottom: 4px;
          }
          .message-card-content {
            white-space: pre-wrap;
          }
          .thinking {
            opacity: 0.7;
            font-style: italic;
          }
          .composer {
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 10px 12px;
            border-top: 1px solid var(--panel-border);
            background: var(--panel-surface-strong);
          }
          .composer-toolbar {
            display: flex;
            align-items: center;
            gap: 6px;
          }
          .composer-toolbar .toolbar-spacer {
            flex: 1;
          }
          .token-chip {
            font-size: 0.75em;
            color: var(--panel-muted);
            padding: 2px 8px;
            border-radius: 999px;
            border: 1px solid var(--panel-border);
            background: var(--panel-surface);
          }
          .composer-row {
            display: flex;
            gap: 8px;
            align-items: flex-end;
          }
          textarea {
            flex: 1;
            resize: vertical;
            min-height: 70px;
            max-height: 180px;
            padding: 8px;
            border-radius: 10px;
            border: 1px solid var(--vscode-input-border, var(--panel-border));
            background: color-mix(in srgb, var(--vscode-input-background) 70%, #0a1c24 30%);
            color: var(--vscode-input-foreground);
            font-family: inherit;
            font-size: inherit;
          }
          textarea:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
            box-shadow: 0 0 0 1px var(--vscode-focusBorder);
          }
          .send-btn {
            width: 44px;
            height: 44px;
            border-radius: 12px;
            padding: 0;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            border: 1px solid var(--panel-border);
            background: var(--panel-accent);
            color: var(--vscode-button-foreground);
          }
          .send-btn[data-disabled="true"] {
            opacity: 0.5;
            cursor: not-allowed;
          }
          .attachment-list {
            display: none;
            flex-wrap: wrap;
            gap: 6px;
          }
          .attachment-chip {
            font-size: 0.75em;
            color: var(--panel-muted);
            padding: 2px 8px;
            border-radius: 999px;
            border: 1px solid var(--panel-border);
            background: var(--panel-surface);
          }
          .error-panel {
            margin: 10px 16px 0;
            padding: 10px;
            border-radius: 10px;
            border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-panel-border));
            background: color-mix(in srgb, var(--vscode-inputValidation-errorBackground, var(--panel-surface)) 70%, #3a1b1b 30%);
            color: var(--vscode-errorForeground);
            display: none;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            font-size: 0.85em;
          }
          .error-message {
            flex: 1;
          }
          .error-actions {
            display: flex;
            gap: 6px;
          }
          .toast {
            position: absolute;
            right: 14px;
            bottom: 88px;
            padding: 8px 12px;
            border-radius: 10px;
            border: 1px solid var(--panel-border);
            background: var(--panel-surface-strong);
            color: var(--vscode-foreground);
            box-shadow: 0 6px 18px var(--panel-shadow);
            display: none;
            font-size: 0.85em;
            max-width: 70%;
          }
          .toast[data-level="error"] {
            border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-panel-border));
            color: var(--vscode-errorForeground);
          }
          .toast[data-level="warning"] {
            border-color: var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
          }
        </style>
      </head>
      <body>
        <div class="app">
          <div class="header">
            <div class="header-left">
              <div class="header-label">CHAT</div>
              <div class="header-title">PARALLEL: CHAT</div>
              <div class="header-meta">
                <span class="header-meta-item" id="workspaceLabel">Workspace: None</span>
                <span class="header-meta-sep">•</span>
                <span class="header-meta-item" id="userLabel">Signed out</span>
              </div>
            </div>
            <div class="header-right">
              <div class="status-pill" id="connectionStatus" data-status="disconnected">Offline</div>
              <button class="icon-btn" id="chatHistoryBtn" title="Show chats">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M15 6l-6 6 6 6"></path>
                </svg>
              </button>
              <button class="icon-btn" id="newChatHeaderBtn" title="New chat">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 5v14"></path>
                  <path d="M5 12h14"></path>
                </svg>
              </button>
              <button class="icon-btn" id="refreshChatBtn" title="Refresh">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-3-6.7"></path>
                  <path d="M21 4v6h-6"></path>
                </svg>
              </button>
              <button class="icon-btn" id="copyTranscriptBtn" title="Copy transcript">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M8 8h12v12H8z"></path>
                  <path d="M4 4h12v12H4z"></path>
                </svg>
              </button>
              <button class="icon-btn" id="selectWorkspaceBtn" title="Select workspace">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 7h16"></path>
                  <path d="M4 17h16"></path>
                  <path d="M7 7v10"></path>
                </svg>
              </button>
              <button class="icon-btn" id="openWebBtn" title="Open Web App">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M14 3h7v7"></path>
                  <path d="M10 14L21 3"></path>
                  <path d="M21 14v7h-7"></path>
                  <path d="M3 10V3h7"></path>
                </svg>
              </button>
              <button class="icon-btn" id="forceSyncBtn" title="Force Sync">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 12h6"></path>
                  <path d="M15 12h6"></path>
                  <path d="M9 6v12"></path>
                  <path d="M15 6v12"></path>
                </svg>
              </button>
              <button class="icon-btn" id="forceFullResyncBtn" title="Full Resync">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 4h7v7H4z"></path>
                  <path d="M13 13h7v7h-7z"></path>
                  <path d="M13 4h7"></path>
                  <path d="M4 20h7"></path>
                </svg>
              </button>
              <button class="icon-btn" id="settingsBtn" title="Settings">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"></path>
                  <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 0 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1A2 2 0 0 1 7.1 3.3l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V2a2 2 0 0 1 4 0v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 0 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1Z"></path>
                </svg>
              </button>
              <button class="icon-btn" id="profileBtn" title="Profile">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Z"></path>
                  <path d="M4 20a8 8 0 0 1 16 0"></path>
                </svg>
              </button>
              <button class="primary" id="signInBtn">Sign in</button>
              <button class="secondary" id="signOutBtn">Sign out</button>
            </div>
          </div>
          <main class="chat-panel">
            <div class="error-panel" id="errorPanel">
              <div class="error-message" id="errorText"></div>
              <div class="error-actions">
                <button class="secondary" id="errorRetryBtn">Retry</button>
                <button class="secondary" id="errorReconnectBtn">Reconnect</button>
              </div>
            </div>
            <div class="chat-list" id="chatList"></div>
            <div class="messages" id="messageList"></div>
            <div class="composer" id="composerPanel">
              <div class="attachment-list" id="attachmentList"></div>
              <div class="composer-toolbar">
                <button class="icon-btn" id="toolbarNewChatBtn" title="New chat">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 5v14"></path>
                    <path d="M5 12h14"></path>
                  </svg>
                </button>
                <button class="icon-btn" id="toolbarClearBtn" title="Clear transcript">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 6h16"></path>
                    <path d="M9 6V4h6v2"></path>
                    <path d="M7 6l1 14h8l1-14"></path>
                  </svg>
                </button>
                <button class="icon-btn" id="toolbarAttachBtn" title="Attach files">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M7 13l7-7a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8"></path>
                  </svg>
                </button>
                <div class="toolbar-spacer"></div>
                <div class="token-chip" id="tokenChip">0 / 8000</div>
              </div>
              <div class="composer-row">
                <textarea id="composerInput" placeholder="Message Parallel"></textarea>
                <button id="sendBtn" class="send-btn" data-disabled="true" aria-label="Send">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 12h12"></path>
                    <path d="M12 6l6 6-6 6"></path>
                  </svg>
                </button>
              </div>
            </div>
          </main>
          <div class="toast" id="toast"></div>
        </div>
        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          let state = null;
          let attachedFiles = [];
          let localError = null;
          let localErrorIsAuth = false;
          let toastTimer = null;
          let viewMode = 'chat';

          const connectionStatus = document.getElementById('connectionStatus');
          const workspaceLabel = document.getElementById('workspaceLabel');
          const userLabel = document.getElementById('userLabel');
          const chatHistoryBtn = document.getElementById('chatHistoryBtn');
          const messageList = document.getElementById('messageList');
          const chatList = document.getElementById('chatList');
          const composerPanel = document.getElementById('composerPanel');
          const attachmentList = document.getElementById('attachmentList');
          const selectWorkspaceBtn = document.getElementById('selectWorkspaceBtn');
          const newChatHeaderBtn = document.getElementById('newChatHeaderBtn');
          const refreshChatBtn = document.getElementById('refreshChatBtn');
          const copyTranscriptBtn = document.getElementById('copyTranscriptBtn');
          const sendBtn = document.getElementById('sendBtn');
          const composerInput = document.getElementById('composerInput');
          const signInBtn = document.getElementById('signInBtn');
          const signOutBtn = document.getElementById('signOutBtn');
          const errorPanel = document.getElementById('errorPanel');
          const errorText = document.getElementById('errorText');
          const errorRetryBtn = document.getElementById('errorRetryBtn');
          const errorReconnectBtn = document.getElementById('errorReconnectBtn');
          const tokenChip = document.getElementById('tokenChip');
          const toolbarNewChatBtn = document.getElementById('toolbarNewChatBtn');
          const toolbarClearBtn = document.getElementById('toolbarClearBtn');
          const toolbarAttachBtn = document.getElementById('toolbarAttachBtn');
          const toast = document.getElementById('toast');

          const quickActions = [
            {
              id: 'build',
              title: 'Build Component',
              desc: 'Create a new component using current workspace files.',
              template:
                'Build a new component for [feature] in {workspace}. Use current workspace files and recent changes. Provide file paths and code.',
            },
            {
              id: 'debug',
              title: 'Debug Code',
              desc: 'Identify the root cause and propose a fix.',
              template:
                'Debug the issue in {workspace}. Use current workspace files and recent changes. Explain the root cause and propose a fix.',
            },
            {
              id: 'optimize',
              title: 'Optimize Code',
              desc: 'Improve performance and readability safely.',
              template:
                'Optimize the current implementation in {workspace}. Use current workspace files and recent changes. Suggest specific edits and files.',
            },
            {
              id: 'tests',
              title: 'Generate Tests',
              desc: 'Create tests aligned with existing patterns.',
              template:
                'Generate tests for recent changes in {workspace}. Follow existing test patterns and list files to add or update.',
            },
          ];

          document.getElementById('settingsBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'ui/openSettings' });
          });
          document.getElementById('profileBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'ui/openProfileMenu' });
          });
          document.getElementById('openWebBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'ui/openWebApp' });
          });
          document.getElementById('forceSyncBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'ui/forceSync' });
          });
          document.getElementById('forceFullResyncBtn').addEventListener('click', () => {
            vscode.postMessage({ type: 'ui/forceFullResync' });
          });
          selectWorkspaceBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'ui/selectWorkspace' });
          });
          chatHistoryBtn.addEventListener('click', () => {
            setViewMode(viewMode === 'chat' ? 'list' : 'chat');
          });
          newChatHeaderBtn.addEventListener('click', () => {
            setViewMode('chat');
            vscode.postMessage({ type: 'ui/newChat' });
          });
          refreshChatBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'ui/refresh' });
          });
          copyTranscriptBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'ui/copyTranscript' });
          });
          toolbarNewChatBtn.addEventListener('click', () => {
            setViewMode('chat');
            vscode.postMessage({ type: 'ui/newChat' });
          });
          toolbarClearBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'composer/clearLocal' });
          });
          toolbarAttachBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'composer/attachFiles' });
          });
          signInBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'auth/signIn' });
          });
          signOutBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'auth/signOut' });
          });
          errorRetryBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'ui/retry' });
          });
          errorReconnectBtn.addEventListener('click', () => {
            vscode.postMessage({ type: 'ui/reconnect' });
          });
          sendBtn.addEventListener('click', () => sendMessage());
          composerInput.addEventListener('keydown', (event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              sendMessage();
            }
          });
          composerInput.addEventListener('input', () => {
            updateTokenChip();
          });

          function canSend() {
            return (
              state &&
              state.auth &&
              state.auth.signedIn &&
              state.workspace &&
              state.workspace.id &&
              !state.auth.inProgress
            );
          }

          function sendMessage() {
            const text = composerInput.value.trim();
            if (!text) {
              return;
            }
            if (!canSend()) {
              if (!state || !state.auth || !state.auth.signedIn) {
                showInlineError('Sign in to send messages.', true);
              } else if (!state.workspace || !state.workspace.id) {
                showInlineError('Select a workspace before sending messages.');
              }
              return;
            }
            clearInlineError();
            setViewMode('chat');
            vscode.postMessage({ type: 'chat/sendMessage', text });
            composerInput.value = '';
            updateTokenChip();
          }

          window.addEventListener('message', (event) => {
            const msg = event.data || {};
            if (msg.type === 'state/update') {
              state = msg.state;
              renderState();
              return;
            }
            if (msg.type === 'action/toast') {
              showToast(msg.level || 'info', msg.message || '');
              return;
            }
            if (msg.type === 'action/attachedFiles') {
              attachedFiles = Array.isArray(msg.files) ? msg.files : [];
              renderAttachments();
              return;
            }
            if (msg.type === 'action/clipboard') {
              handleClipboard(msg.text || '');
              return;
            }
          });

          function renderState() {
            if (!state) {
              return;
            }
            const auth = state.auth || { signedIn: false, inProgress: false };
            const workspaceValue = (state.workspace && (state.workspace.name || state.workspace.id)) || 'No workspace';
            workspaceLabel.textContent = 'Workspace: ' + workspaceValue;
            const userValue = state.user && (state.user.name || state.user.id) ? state.user.name || state.user.id : '';
            userLabel.textContent = auth.signedIn ? 'Signed in' + (userValue ? ' as ' + userValue : '') : 'Signed out';
            if (state.connection) {
              connectionStatus.textContent = state.connection.label;
              connectionStatus.dataset.status = state.connection.status;
            } else {
              connectionStatus.textContent = 'Offline';
              connectionStatus.dataset.status = 'disconnected';
            }
            selectWorkspaceBtn.disabled = !auth.signedIn || auth.inProgress;
            chatHistoryBtn.disabled = !auth.signedIn || auth.inProgress;
            newChatHeaderBtn.disabled = auth.inProgress;
            refreshChatBtn.disabled = auth.inProgress;
            signInBtn.style.display = auth.signedIn ? 'none' : 'inline-flex';
            signOutBtn.style.display = auth.signedIn ? 'inline-flex' : 'none';
            signOutBtn.disabled = auth.inProgress;
            errorRetryBtn.disabled = auth.inProgress;
            errorReconnectBtn.disabled = auth.inProgress;
            renderSendState();
            renderMainView();
            renderError();
            updateTokenChip();
          }

          function setViewMode(mode) {
            viewMode = mode === 'list' ? 'list' : 'chat';
            renderMainView();
          }

          function renderMainView() {
            const listMode = viewMode === 'list';
            chatList.style.display = listMode ? 'flex' : 'none';
            messageList.style.display = listMode ? 'none' : 'flex';
            composerPanel.style.display = listMode ? 'none' : 'flex';
            if (listMode) {
              renderChatList();
            } else {
              renderMessages();
            }
            updateChatHistoryButton();
          }

          function renderChatList() {
            chatList.innerHTML = '';
            const sessions = state && Array.isArray(state.sessions) ? state.sessions : [];
            if (!sessions.length) {
              const empty = document.createElement('div');
              empty.className = 'chat-list-empty';
              empty.textContent = 'No chats yet. Start a new chat to begin.';
              chatList.appendChild(empty);
              return;
            }
            sessions.forEach((session) => {
              const item = document.createElement('div');
              item.className =
                'chat-list-item' +
                (state && state.activeChatId === session.id ? ' active' : '');
              item.setAttribute('role', 'button');
              item.tabIndex = 0;
              const title = document.createElement('div');
              title.className = 'chat-list-title';
              title.textContent = session.name || 'Untitled chat';
              const meta = document.createElement('div');
              meta.className = 'chat-list-meta';
              const lastMessage = session.lastMessageAt || session.updatedAt;
              meta.textContent = lastMessage ? formatTimestamp(lastMessage) : 'No messages yet';
              item.appendChild(title);
              item.appendChild(meta);
              const handleSelect = () => {
                setViewMode('chat');
                vscode.postMessage({ type: 'chat/selectChat', chatId: session.id });
              };
              item.addEventListener('click', handleSelect);
              item.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  handleSelect();
                }
              });
              chatList.appendChild(item);
            });
          }

          function updateChatHistoryButton() {
            const label = viewMode === 'list' ? 'Back to chat' : 'Show chats';
            chatHistoryBtn.title = label;
            chatHistoryBtn.setAttribute('aria-label', label);
          }

          function renderMessages() {
            messageList.innerHTML = '';
            if (!state || !state.messages || !state.messages.length) {
              renderHero();
              return;
            }
            const shouldScroll =
              messageList.scrollTop + messageList.clientHeight >= messageList.scrollHeight - 40;
            state.messages.forEach((message) => {
              messageList.appendChild(buildMessageRow(message));
            });
            if (state.isThinking) {
              messageList.appendChild(buildThinkingRow());
            }
            if (shouldScroll) {
              messageList.scrollTop = messageList.scrollHeight;
            }
          }

          function renderHero() {
            const hero = document.createElement('div');
            hero.className = 'hero';
            const mark = document.createElement('div');
            mark.className = 'hero-mark';
            mark.textContent = 'P';
            hero.appendChild(mark);
            const title = document.createElement('div');
            title.className = 'hero-title';
            title.textContent = 'Parallel';
            hero.appendChild(title);
            const subtitle = document.createElement('div');
            subtitle.className = 'hero-subtitle';
            subtitle.textContent = 'AI-Powered Development Assistant';
            hero.appendChild(subtitle);
            const actions = document.createElement('div');
            actions.className = 'hero-actions';
            quickActions.forEach((action) => {
              const btn = document.createElement('button');
              btn.type = 'button';
              btn.className = 'action-card';
              btn.dataset.action = action.id;
              const heading = document.createElement('div');
              heading.className = 'action-title';
              heading.textContent = action.title;
              const desc = document.createElement('div');
              desc.className = 'action-desc';
              desc.textContent = action.desc;
              btn.appendChild(heading);
              btn.appendChild(desc);
              btn.addEventListener('click', () => {
                const workspaceValue =
                  state && state.workspace && (state.workspace.name || state.workspace.id)
                    ? state.workspace.name || state.workspace.id
                    : 'this workspace';
                const prompt = action.template.replace('{workspace}', workspaceValue);
                composerInput.value = prompt;
                clearInlineError();
                composerInput.focus();
                composerInput.selectionStart = composerInput.value.length;
                composerInput.selectionEnd = composerInput.value.length;
                updateTokenChip();
              });
              actions.appendChild(btn);
            });
            hero.appendChild(actions);
            messageList.appendChild(hero);
          }

          function buildMessageRow(message) {
            const isUser = message.role === 'user';
            const row = document.createElement('div');
            row.className = 'message-row ' + (isUser ? 'user' : 'assistant');
            const avatar = document.createElement('div');
            avatar.className = 'avatar ' + (isUser ? 'user' : 'assistant');
            avatar.textContent = isUser ? 'YOU' : 'P';
            const bubble = document.createElement('div');
            bubble.className = 'message-bubble ' + (isUser ? 'user' : 'assistant');
            const content = document.createElement('div');
            content.textContent = message.content || '';
            bubble.appendChild(content);
            appendMessageCards(bubble, message.metadata);
            const meta = document.createElement('div');
            meta.className = 'message-meta';
            meta.textContent = formatTimestamp(message.createdAt);
            bubble.appendChild(meta);
            row.appendChild(avatar);
            row.appendChild(bubble);
            return row;
          }

          function buildThinkingRow() {
            const row = document.createElement('div');
            row.className = 'message-row assistant';
            const avatar = document.createElement('div');
            avatar.className = 'avatar assistant';
            avatar.textContent = 'P';
            const bubble = document.createElement('div');
            bubble.className = 'message-bubble assistant thinking';
            bubble.textContent = 'Thinking...';
            row.appendChild(avatar);
            row.appendChild(bubble);
            return row;
          }

          function appendMessageCards(container, metadata) {
            if (!metadata || typeof metadata !== 'object') {
              return;
            }
            const filePath = typeof metadata.file_path === 'string' ? metadata.file_path : '';
            const command = typeof metadata.command === 'string' ? metadata.command : '';
            const selection = metadata.selection && typeof metadata.selection === 'object' ? metadata.selection : null;
            if (filePath) {
              const extra = formatSelection(selection);
              container.appendChild(buildMessageCard('READ', filePath + extra));
            }
            if (command) {
              container.appendChild(buildMessageCard('BASH', command));
            }
          }

          function formatSelection(selection) {
            if (!selection || typeof selection !== 'object') {
              return '';
            }
            const start = selection.start_line || selection.startLine || selection.start;
            const end = selection.end_line || selection.endLine || selection.end;
            if (typeof start === 'number' && typeof end === 'number') {
              return ' (lines ' + start + '-' + end + ')';
            }
            if (typeof start === 'number') {
              return ' (line ' + start + ')';
            }
            return '';
          }

          function buildMessageCard(label, content) {
            const card = document.createElement('div');
            card.className = 'message-card';
            const title = document.createElement('div');
            title.className = 'message-card-label';
            title.textContent = label;
            const body = document.createElement('div');
            body.className = 'message-card-content';
            body.textContent = content;
            card.appendChild(title);
            card.appendChild(body);
            return card;
          }

          function renderSendState() {
            const auth = state && state.auth ? state.auth : { signedIn: false, inProgress: false };
            const canSendMessage =
              state &&
              auth.signedIn &&
              state.workspace &&
              state.workspace.id &&
              !auth.inProgress;
            sendBtn.dataset.disabled = canSendMessage ? 'false' : 'true';
            sendBtn.setAttribute('aria-disabled', canSendMessage ? 'false' : 'true');
            if (!state || !auth.signedIn) {
              composerInput.placeholder = 'Sign in to send messages';
            } else if (!state.workspace || !state.workspace.id) {
              composerInput.placeholder = 'Select a workspace to send messages';
            } else if (!state.activeChatId) {
              composerInput.placeholder = 'Start a new chat...';
            } else {
              composerInput.placeholder = 'Message Parallel';
            }
          }

          function renderError() {
            const stateError = state && state.error ? state.error : '';
            const message = stateError || localError;
            if (!message) {
              errorPanel.style.display = 'none';
              errorText.textContent = '';
              return;
            }
            errorText.textContent = message;
            const authError = stateError
              ? !!(state && state.errorIsAuth)
              : localErrorIsAuth || !(state && state.auth && state.auth.signedIn);
            errorReconnectBtn.style.display = authError ? 'inline-flex' : 'none';
            errorRetryBtn.style.display = authError ? 'none' : 'inline-flex';
            errorPanel.style.display = 'flex';
          }

          function renderAttachments() {
            attachmentList.innerHTML = '';
            if (!attachedFiles.length) {
              attachmentList.style.display = 'none';
              return;
            }
            attachedFiles.forEach((file) => {
              const chip = document.createElement('div');
              chip.className = 'attachment-chip';
              const sizeLabel = typeof file.size === 'number' ? ' (' + formatBytes(file.size) + ')' : '';
              chip.textContent = file.name + sizeLabel;
              attachmentList.appendChild(chip);
            });
            attachmentList.style.display = 'flex';
          }

          function showInlineError(message, isAuth) {
            if (!message) {
              return;
            }
            localError = message;
            localErrorIsAuth = !!isAuth;
            renderError();
          }

          function clearInlineError() {
            localError = null;
            localErrorIsAuth = false;
            renderError();
          }

          function showToast(level, message) {
            if (!message) {
              return;
            }
            toast.textContent = message;
            toast.dataset.level = level || 'info';
            toast.style.display = 'block';
            if (toastTimer) {
              clearTimeout(toastTimer);
            }
            toastTimer = setTimeout(() => {
              toast.style.display = 'none';
            }, 2600);
          }

          async function handleClipboard(text) {
            if (!text) {
              return;
            }
            if (navigator.clipboard && navigator.clipboard.writeText) {
              try {
                await navigator.clipboard.writeText(text);
              } catch {
                return;
              }
            }
          }

          function formatTimestamp(iso) {
            if (!iso) {
              return '';
            }
            const date = new Date(iso);
            if (Number.isNaN(date.getTime())) {
              return '';
            }
            return date.toLocaleString();
          }

          function formatBytes(bytes) {
            if (!bytes && bytes !== 0) {
              return '0 B';
            }
            const units = ['B', 'KB', 'MB', 'GB'];
            let value = bytes;
            let idx = 0;
            while (value >= 1024 && idx < units.length - 1) {
              value /= 1024;
              idx += 1;
            }
            return value.toFixed(value >= 10 || idx === 0 ? 0 : 1) + ' ' + units[idx];
          }

          function updateTokenChip() {
            const count = composerInput.value.length;
            tokenChip.textContent = count + ' / 8000';
          }

          vscode.postMessage({ type: 'ui/ready' });
        </script>
      </body>
      </html>
`;
  }
}

function buildRepoPayload(
  workspace: { id: string | null; name?: string },
  repoContext: RepoContext
): ChatRepoContext | undefined {
  if (!workspace.id) {
    return undefined;
  }
  const hasContext =
    repoContext.files.length > 0 ||
    repoContext.openFiles.length > 0 ||
    repoContext.diagnostics.length > 0 ||
    repoContext.searchResults.length > 0 ||
    repoContext.guides.length > 0 ||
    repoContext.symbols.length > 0 ||
    repoContext.references.length > 0 ||
    !!repoContext.hoverInfo ||
    !!repoContext.git ||
    repoContext.semanticContext.length > 0 ||
    !!repoContext.gitDiffStat;
  if (!hasContext) {
    return undefined;
  }
  return {
    name: workspace.name ?? workspace.id,
    root: repoContext.root,
    open_files: repoContext.openFiles,
    files: repoContext.files,
    diagnostics: repoContext.diagnostics,
    gitDiffStat: repoContext.gitDiffStat,
    searchResults: repoContext.searchResults,
    guides: repoContext.guides,
    symbols: repoContext.symbols,
    references: repoContext.references,
    hoverInfo: repoContext.hoverInfo,
    git: repoContext.git,
    semanticContext: repoContext.semanticContext,
  };
}

function parseAgentDirective(
  message: string
): { mode: 'dry-run' | 'apply'; text: string } | null {
  const trimmed = message.trim();
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith('/apply')) {
    return { mode: 'apply', text: trimmed.slice('/apply'.length).trim() };
  }
  if (lowered.startsWith('/agent')) {
    return { mode: 'dry-run', text: trimmed.slice('/agent'.length).trim() };
  }
  if (lowered.startsWith('/edit')) {
    return { mode: 'dry-run', text: trimmed.slice('/edit'.length).trim() };
  }
  return null;
}

function recordToChatMessage(record: EntityRecord, chatId: string): ChatMessage | null {
  const payload = record.payload as Record<string, unknown> | undefined;
  if (!payload) {
    return null;
  }
  const payloadChat = typeof payload.chat_id === 'string' ? payload.chat_id : '';
  if (payloadChat && payloadChat !== chatId) {
    return null;
  }
  const content =
    typeof payload.content === 'string'
      ? payload.content
      : typeof payload.text === 'string'
      ? payload.text
      : '';
  if (!content) {
    return null;
  }
  const createdAt =
    (typeof payload.created_at === 'string' && payload.created_at) ||
    record.updated_at ||
    new Date().toISOString();
  const role = typeof payload.role === 'string' ? payload.role : 'assistant';
  return {
    id: record.id,
    chatId: payloadChat || chatId,
    role,
    content,
    createdAt,
    senderName: typeof payload.sender_name === 'string' ? payload.sender_name : undefined,
    metadata:
      payload.metadata && typeof payload.metadata === 'object'
        ? (payload.metadata as Record<string, unknown>)
        : undefined,
  };
}

function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const map = new Map<string, ChatMessage>();
  existing.forEach((m) => map.set(m.id, m));
  incoming.forEach((m) => map.set(m.id, m));
  const merged = Array.from(map.values());
  merged.sort((a, b) => compareIso(a.createdAt, b.createdAt));
  return merged;
}

function compareIso(a: string, b: string): number {
  const aTime = Date.parse(a);
  const bTime = Date.parse(b);
  if (Number.isNaN(aTime) || Number.isNaN(bTime)) {
    return 0;
  }
  return aTime - bTime;
}

function formatIsoTimestamp(iso?: string): string {
  if (!iso) {
    return '';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleString();
}

function formatAuthError(err: unknown, fallback: string): string {
  if (err instanceof HttpError) {
    const detail = err.body ? `: ${err.body}` : '';
    return `${fallback} (HTTP ${err.status})${detail}`;
  }
  return err instanceof Error ? err.message : fallback;
}
