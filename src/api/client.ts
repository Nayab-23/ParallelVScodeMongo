import { computeBackoff, sleep } from '../util/backoff';
import { Logger } from '../util/logger';
import { normalizeToken } from '../util/token';

export interface RequestOptions extends RequestInit {
  retry?: number;
  query?: Record<string, string | number | undefined>;
  redactBody?: boolean;
  timeoutMs?: number;
  retryOn?: number[];
  skipAuthRefresh?: boolean;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: string
  ) {
    super(message);
  }
}

export type RefreshResult = {
  accessToken: string;
  refreshToken?: string;
};

export type RefreshHandler = (currentToken?: string) => Promise<RefreshResult | null>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_STATUSES = [408, 429, 500, 502, 503, 504];

export class ParallelClient {
  private apiBaseUrl: string;
  private token: string | undefined;
  private requestTimeoutMs: number;
  private maxRetries: number;
  private refreshHandler?: RefreshHandler;

  constructor(
    apiBaseUrl: string,
    token: string | undefined,
    private logger: Logger,
    options?: {
      requestTimeoutMs?: number;
      maxRetries?: number;
      refreshHandler?: RefreshHandler;
    }
  ) {
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, '');
    this.token = normalizeToken(token);
    this.requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.refreshHandler = options?.refreshHandler;
  }

  setToken(token: string | undefined): void {
    this.token = normalizeToken(token);
  }

  setApiBaseUrl(apiBaseUrl: string): void {
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, '');
  }

  getApiBaseUrl(): string {
    return this.apiBaseUrl;
  }

  setRequestTimeoutMs(timeoutMs: number | undefined): void {
    if (timeoutMs !== undefined && timeoutMs !== null && timeoutMs > 0) {
      this.requestTimeoutMs = timeoutMs;
    } else {
      this.requestTimeoutMs = DEFAULT_TIMEOUT_MS;
    }
  }

  setMaxRetries(maxRetries: number | undefined): void {
    if (maxRetries !== undefined && maxRetries !== null && maxRetries >= 0) {
      this.maxRetries = maxRetries;
    } else {
      this.maxRetries = DEFAULT_MAX_RETRIES;
    }
  }

  setRefreshHandler(handler: RefreshHandler | undefined): void {
    this.refreshHandler = handler;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.requestResponse(path, options);
    if (response.status === 204) {
      return undefined as T;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return (await response.json()) as T;
    }
    return (await response.text()) as T;
  }

  async requestStream(path: string, options: RequestOptions = {}): Promise<Response> {
    return this.requestResponse(path, { ...options, timeoutMs: options.timeoutMs ?? 0 });
  }

  private async requestResponse(path: string, options: RequestOptions): Promise<Response> {
    const url = this.buildUrl(path, options.query);
    const headers = this.buildHeaders(options.headers);
    const method = (options.method ?? 'GET').toUpperCase();
    const idempotent = ['GET', 'HEAD', 'OPTIONS'].includes(method);
    const maxRetries = options.retry ?? (idempotent ? this.maxRetries : 0);
    const retryOn = options.retryOn ?? DEFAULT_RETRY_STATUSES;
    const timeoutMs =
      options.timeoutMs !== undefined ? options.timeoutMs : this.requestTimeoutMs;
    let attempt = 0;
    let refreshed = false;
    let lastError: unknown;

    // Log HTTP request start
    const startTime = Date.now();
    this.logger.info(`[HTTP] ${method} ${path}`);

    while (attempt <= maxRetries) {
      try {
        const response = await this.fetchWithTimeout(url, { ...options, headers }, timeoutMs);
        const duration = Date.now() - startTime;
        const requestId = response.headers.get('X-Request-Id');

        if (response.ok) {
          // Log successful response
          this.logger.info(`[HTTP] ${method} ${path} ${response.status} ${duration}ms${requestId ? ` [req:${requestId}]` : ''}`);
          return response;
        }

        // Log non-2xx response
        this.logger.error(`[HTTP] ${method} ${path} ${response.status} ${duration}ms${requestId ? ` [req:${requestId}]` : ''}`);

        // Try to extract error details
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.includes('application/json')) {
          try {
            const errorBody = await response.clone().json();
            if (errorBody.error_code || errorBody.request_id) {
              this.logger.error(`[HTTP] Error: ${errorBody.error_code || 'UNKNOWN'} - ${errorBody.message || ''} ${errorBody.request_id ? `[req:${errorBody.request_id}]` : ''}`);
            }
          } catch (e) {
            // Failed to parse error JSON
          }
        }

        if (
          response.status === 401 &&
          this.refreshHandler &&
          !options.skipAuthRefresh &&
          !refreshed
        ) {
          const refresh = await this.refreshHandler(this.token);
          if (refresh?.accessToken) {
            this.setToken(refresh.accessToken);
            refreshed = true;
            continue;
          }
        }

        const error = await this.buildHttpError(response, options);
        lastError = error;
        if (attempt < maxRetries && retryOn.includes(response.status)) {
          attempt += 1;
          const waitMs = computeBackoff(attempt - 1, 250, 4000);
          this.logger.debug(
            `request retry ${attempt}/${maxRetries} after HTTP ${response.status}`
          );
          await sleep(waitMs);
          continue;
        }
        throw error;
      } catch (err) {
        const timeoutError = this.asTimeoutError(err);
        lastError = timeoutError ?? err;
        if (
          attempt < maxRetries &&
          this.shouldRetryError(timeoutError ?? err, retryOn)
        ) {
          attempt += 1;
          const waitMs = computeBackoff(attempt - 1, 250, 4000);
          this.logger.debug(`request retry ${attempt}/${maxRetries} after error: ${String(err)}`);
          await sleep(waitMs);
          continue;
        }
        throw timeoutError ?? (err instanceof Error ? err : new Error('Request failed'));
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Request failed');
  }

  private buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    const url = new URL(path, this.apiBaseUrl);
    if (query) {
      Object.entries(query).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      });
    }
    return url.toString();
  }

  private buildHeaders(extra?: HeadersInit): Record<string, string> {
    const headers: Record<string, string> = {
      ...(extra as Record<string, string> | undefined),
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
    return headers;
  }

  private async fetchWithTimeout(
    url: string,
    options: RequestInit,
    timeoutMs: number | undefined
  ): Promise<Response> {
    if (!timeoutMs || timeoutMs <= 0) {
      return fetch(url, options);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async buildHttpError(
    response: Response,
    options: RequestOptions
  ): Promise<HttpError> {
    let text = '';
    if (!options.redactBody) {
      try {
        text = await response.text();
      } catch {
        text = '';
      }
    }
    const safeText = sanitizeBody(text);
    const detail = extractErrorDetail(text, response.headers.get('content-type') ?? '');
    if (safeText) {
      this.logger.debug(`HTTP ${response.status} ${response.statusText}: ${safeText}`);
    } else {
      this.logger.debug(`HTTP ${response.status} ${response.statusText}`);
    }
    const message = detail || response.statusText || `HTTP ${response.status}`;
    return new HttpError(message, response.status, detail || safeText || undefined);
  }

  private shouldRetryError(err: unknown, retryOn: number[]): boolean {
    if (err instanceof HttpError) {
      return retryOn.includes(err.status);
    }
    if (err instanceof Error) {
      return err.name === 'AbortError' || err.message.toLowerCase().includes('timeout');
    }
    return false;
  }

  private asTimeoutError(err: unknown): HttpError | null {
    if (err instanceof Error && err.name === 'AbortError') {
      return new HttpError('Request timed out', 408, 'Request timed out');
    }
    return null;
  }
}

function sanitizeBody(text: string): string {
  if (!text) {
    return '';
  }
  const trimmed = text.slice(0, 1000);
  return trimmed
    .replace(/"access_token"\s*:\s*"[^"]*"/gi, '"access_token":"[redacted]"')
    .replace(/"refresh_token"\s*:\s*"[^"]*"/gi, '"refresh_token":"[redacted]"')
    .replace(/"token"\s*:\s*"[^"]*"/gi, '"token":"[redacted]"')
    .replace(/(access_token|refresh_token|token)=([^&\s]+)/gi, '$1=[redacted]');
}

function extractErrorDetail(text: string, contentType: string): string {
  if (!text) {
    return '';
  }
  const normalized = text.trim();
  if (!normalized) {
    return '';
  }
  const isJson =
    contentType.includes('application/json') ||
    normalized.startsWith('{') ||
    normalized.startsWith('[');
  if (!isJson) {
    return normalized.slice(0, 512);
  }
  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    const detail =
      (typeof parsed.detail === 'string' && parsed.detail) ||
      (typeof parsed.error_description === 'string' && parsed.error_description) ||
      (typeof parsed.error === 'string' && parsed.error) ||
      (typeof parsed.message === 'string' && parsed.message) ||
      '';
    if (detail) {
      return detail.slice(0, 512);
    }
  } catch {
    return normalized.slice(0, 512);
  }
  return normalized.slice(0, 512);
}
