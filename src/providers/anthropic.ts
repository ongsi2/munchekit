import type { RewriteProvider, RewriteProviderRequest } from '../types.js';

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  apiVersion?: string;
  fetch?: typeof globalThis.fetch;
  /** Explicitly permits an http:// base URL for local development gateways. */
  allowInsecureHttp?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
}

export class AnthropicProvider implements RewriteProvider {
  readonly name = 'anthropic';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: AnthropicProviderOptions) {
    if (!options.apiKey) throw new Error('Anthropic API key is required.');
    if (!options.model) throw new Error('Anthropic model is required.');
    this.apiKey = options.apiKey;
    this.model = options.model;
    const baseUrl = new URL(options.baseUrl ?? 'https://api.anthropic.com');
    if (baseUrl.username || baseUrl.password) throw new Error('Anthropic base URL must not contain credentials.');
    if (baseUrl.protocol !== 'https:' && !(options.allowInsecureHttp && baseUrl.protocol === 'http:')) {
      throw new Error('Anthropic base URL must use https. Set allowInsecureHttp only for a trusted local gateway.');
    }
    this.baseUrl = baseUrl.toString().replace(/\/$/u, '');
    this.apiVersion = options.apiVersion ?? '2023-06-01';
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new Error('Anthropic timeoutMs must be between 1 and 120000.');
    }
    if (!Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1 || this.maxResponseBytes > 10_485_760) {
      throw new Error('Anthropic maxResponseBytes must be an integer between 1 and 10485760.');
    }
  }

  async complete(request: RewriteProviderRequest): Promise<string> {
    const response = await this.fetchImplementation(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.apiVersion,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxTokens,
        temperature: 0,
        system: request.system,
        messages: [{ role: 'user', content: request.prompt }],
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
      throw new Error('Anthropic API response exceeded the configured size limit.');
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!/^application\/(?:[a-z0-9.+-]*\+)?json\b/iu.test(contentType)) {
      throw new Error(`Anthropic API returned an unexpected content type: ${contentType || '<missing>'}.`);
    }
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > this.maxResponseBytes) {
      throw new Error('Anthropic API response exceeded the configured size limit.');
    }
    let payload: AnthropicResponse;
    try {
      payload = JSON.parse(raw) as AnthropicResponse;
    } catch {
      throw new Error('Anthropic API returned invalid JSON.');
    }
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `Anthropic API request failed (${String(response.status)}).`);
    }
    const text = payload.content
      ?.filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n');
    if (!text) throw new Error('Anthropic API response did not contain a text block.');
    return text;
  }
}
