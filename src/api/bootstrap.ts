import { ParallelClient } from './client';

export interface WorkspaceSummary {
  id: string;
  name?: string;
  [key: string]: unknown;
}

export interface BootstrapResponse {
  user: { id: string; name?: string; email?: string; [key: string]: unknown };
  workspaces: WorkspaceSummary[];
}

export async function fetchBootstrap(client: ParallelClient): Promise<BootstrapResponse> {
  return client.request<BootstrapResponse>('/api/v1/bootstrap', { method: 'GET' });
}
