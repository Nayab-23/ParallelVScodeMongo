import { ParallelClient } from './client';

export interface ChatSession {
  id: string;
  name: string;
  updatedAt?: string | null;
  lastMessageAt?: string | null;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  role: string;
  content: string;
  createdAt: string;
  senderName?: string;
  metadata?: Record<string, unknown>;
}

interface ChatListResponse {
  items?: Array<{
    id: string;
    name: string;
    updated_at?: string | null;
    last_message_at?: string | null;
  }>;
  next_cursor?: string | null;
}

interface ChatMessageResponse {
  id: string;
  chat_id: string;
  role: string;
  content: string;
  created_at: string;
  sender_name?: string;
  metadata?: Record<string, unknown>;
}

interface ChatCreateResponse {
  id: string;
  room_id?: string;
  name: string;
  created_at?: string;
  last_message_at?: string | null;
}

interface VSCodeChatResponse {
  request_id: string;
  workspace_id: string;
  chat_id: string;
  user_message_id: string;
  assistant_message_id: string;
  reply: string;
  model: string;
  created_at: string;
  duration_ms: number;
}

export interface SendChatMessageOptions {
  stream?: boolean;
  onChunk?: (chunk: string) => void;
  repo?: ChatRepoContext;
}

export interface ChatRepoContext {
  name: string;
  root?: string;
  open_files?: string[];
  files?: Array<{
    absolute?: string;
    relative?: string;
    content?: string;
    language?: string;
    size?: number;
    truncated?: boolean;
  }>;
  diagnostics?: Array<{
    file: string;
    message: string;
    severity?: string;
  }>;
  gitDiffStat?: string;
  searchResults?: Array<{
    file: string;
    line?: number;
    preview: string;
  }>;
  guides?: Array<{ path: string; content: string }>;
  symbols?: Array<{ name: string; kind?: string; detail?: string; file?: string }>;
  references?: Array<{ file: string; line: number; character: number; preview?: string }>;
  hoverInfo?: string;
  git?: { branch?: string; staged_files?: string[]; unstaged_files?: string[]; recent_commits?: any[] };
  semanticContext?: Array<{ file_path: string; content: string; score?: number; metadata?: Record<string, unknown> }>;
}

export async function fetchChatSessions(
  client: ParallelClient,
  workspaceId: string,
  limit = 20
): Promise<ChatSession[]> {
  const response = await client.request<ChatListResponse>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chats`,
    {
      method: 'GET',
      query: { limit },
    }
  );
  return (response.items ?? []).map((item) => ({
    id: item.id,
    name: item.name,
    updatedAt: item.updated_at ?? null,
    lastMessageAt: item.last_message_at ?? null,
  }));
}

export async function fetchChatMessages(
  client: ParallelClient,
  chatId: string,
  limit = 50
): Promise<ChatMessage[]> {
  const response = await client.request<ChatMessageResponse[]>(
    `/api/v1/chats/${encodeURIComponent(chatId)}/messages`,
    {
      method: 'GET',
      query: { limit },
    }
  );
  return response.map((item) => ({
    id: item.id,
    chatId: item.chat_id,
    role: item.role,
    content: item.content,
    createdAt: item.created_at,
    senderName: item.sender_name,
    metadata: item.metadata,
  }));
}

export async function createChatSession(
  client: ParallelClient,
  workspaceId: string,
  name: string
): Promise<ChatSession> {
  const response = await client.request<ChatCreateResponse>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/chats`,
    {
      method: 'POST',
      body: JSON.stringify({ name }),
    }
  );
  return {
    id: response.id,
    name: response.name ?? name,
    updatedAt: response.last_message_at ?? response.created_at ?? null,
    lastMessageAt: response.last_message_at ?? null,
  };
}

export async function sendChatMessage(
  client: ParallelClient,
  workspaceId: string,
  chatId: string,
  content: string,
  options: SendChatMessageOptions = {}
): Promise<ChatMessage[]> {
  const response = await client.request<VSCodeChatResponse>('/api/v1/vscode/chat', {
    method: 'POST',
    body: JSON.stringify({
      workspace_id: workspaceId,
      chat_id: chatId,
      message: content,
      repo: options.repo,
    }),
  });
  const resolvedChatId = response.chat_id || chatId;
  if (options.stream && options.onChunk && response.reply) {
    options.onChunk(response.reply);
  }
  const createdAt = response.created_at || new Date().toISOString();
  const messages: ChatMessage[] = [];
  if (response.user_message_id) {
    messages.push({
      id: response.user_message_id,
      chatId: resolvedChatId,
      role: 'user',
      content,
      createdAt,
      senderName: 'You',
    });
  }
  if (response.reply) {
    messages.push({
      id: response.assistant_message_id ?? `assistant-${Date.now()}`,
      chatId: resolvedChatId,
      role: 'assistant',
      content: response.reply,
      createdAt,
      senderName: 'Parallel',
    });
  }
  return messages;
}
