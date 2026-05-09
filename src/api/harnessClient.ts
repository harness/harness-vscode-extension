import { HarnessConfig } from '../config/configManager';

export class HarnessApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly endpoint: string
  ) {
    super(message);
    this.name = 'HarnessApiError';
  }
}

export class HarnessClient {
  constructor(private readonly config: HarnessConfig) {}

  private get headers(): Record<string, string> {
    return {
      'x-api-key': this.config.apiKey,
      'Content-Type': 'application/json',
      'Harness-Account': this.config.accountIdentifier,
    };
  }

  private url(path: string, params: Record<string, string> = {}): string {
    const qs = new URLSearchParams({
      accountIdentifier: this.config.accountIdentifier,
      orgIdentifier:     this.config.orgIdentifier,
      projectIdentifier: this.config.projectIdentifier,
      ...params,
    });
    return `${this.config.baseUrl}${path}?${qs}`;
  }

  async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    return this.request<T>('GET', this.url(path, params));
  }

  async post<T>(path: string, body: unknown, params: Record<string, string> = {}): Promise<T> {
    return this.request<T>('POST', this.url(path, params), body);
  }

  private async request<T>(
    method: string, url: string, body?: unknown, attempt = 0
  ): Promise<T> {
    // Add timeout to prevent hanging forever on slow/stuck requests
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

    try {
      const res = await fetch(url, {
        method,
        headers: this.headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (res.status === 429 && attempt < 3) {
        const wait = parseInt(res.headers.get('Retry-After') ?? '5', 10);
        await new Promise(r => setTimeout(r, wait * 1000));
        return this.request<T>(method, url, body, attempt + 1);
      }

      if (res.status === 401) {
        throw new HarnessApiError(
          'Invalid or expired API key — run "Harness: Configure API Key".', 401, url
        );
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new HarnessApiError(`HTTP ${res.status}: ${text.slice(0, 200)}`, res.status, url);
      }

      return res.json() as Promise<T>;
    } catch (err) {
      clearTimeout(timeoutId);
      if ((err as Error).name === 'AbortError') {
        throw new HarnessApiError('Request timeout after 30s', 408, url);
      }
      throw err;
    }
  }
}
