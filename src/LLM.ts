import axios, { AxiosInstance } from "axios";

/**
 * A single chat message in OpenAI-compatible format.
 */
export interface LLMMessage {
  /** Message role, e.g. "system", "user", "assistant" */
  role: string;
  /** Message content */
  content: string;
}

/**
 * Minimal logger interface expected by the LLM client.
 * Matches the subset of the OTel logger used by devopsplaybook.io projects.
 */
export interface LLMLogger {
  info(message: string): void;
  error(message: string, err?: unknown): void;
}

/**
 * Configuration for {@link LLMClient}.
 */
export interface LLMClientConfig {
  /** API key used for Bearer authentication */
  apiKey: string;
  /** Chat completions endpoint URL (e.g., "https://api.deepseek.com/chat/completions") */
  apiUrl: string;
  /** Model name to use (e.g., "deepseek-chat") */
  model: string;
  /** Request timeout in milliseconds (defaults to 120000) */
  timeoutMs?: number;
  /** Optional logger; falls back to console when omitted */
  logger?: LLMLogger;
}

/**
 * Per-request options for {@link LLMClient.request}.
 */
export interface LLMRequestOptions {
  /** Request JSON output (`response_format: json_object`). Defaults to false. */
  jsonMode?: boolean;
  /** Override the configured model for this call */
  model?: string;
  /**
   * Override the configured timeout for this call, in milliseconds.
   * Set `0` to disable the timeout entirely, for slow models or very large
   * completions that legitimately exceed the client-level timeout.
   * When omitted, the client-level `timeoutMs` applies.
   */
  timeoutMs?: number;
}

/**
 * Normalized response from a chat completion call.
 */
export interface LLMResponse {
  /** Content of the first choice (empty string when the model returned none) */
  content: string;
  /** Total tokens used, as reported by the provider (0 when unavailable) */
  totalTokens: number;
}

/** Console fallback used when no logger is injected. */
const consoleLogger: LLMLogger = {
  info: (message: string) => console.log(message),
  error: (message: string, err?: unknown) => console.error(message, err),
};

/**
 * Client for OpenAI-compatible chat completions APIs (DeepSeek, Moonshot,
 * Ollama, etc.).
 *
 * The client follows the same fail-safe pattern as {@link NotificationsClient}:
 *
 * - It is disabled when `apiKey`, `apiUrl` or `model` is missing, so a
 *   partially configured parent application still starts.
 * - The integration status is logged exactly once, at construction time.
 * - Calling `request` on a disabled client throws, since an LLM call that
 *   silently returns nothing is rarely what the caller wants. Check
 *   `isEnabled()` before relying on the client.
 * - Provider errors are rethrown as `Error` with the provider message when
 *   available, so callers get actionable failure reasons.
 *
 * @example
 * ```ts
 * const llm = new LLMClient({
 *   apiKey: config.LLM_API_KEY,
 *   apiUrl: config.LLM_API_URL,
 *   model: config.LLM_MODEL,
 *   logger: OTelLogger().createModuleLogger("llm"),
 * });
 *
 * if (llm.isEnabled()) {
 *   const response = await llm.request([
 *     { role: "system", content: "You summarize text." },
 *     { role: "user", content: someText },
 *   ]);
 *   console.log(response.content, response.totalTokens);
 * }
 * ```
 */
export class LLMClient {
  private client: AxiosInstance | null = null;
  private readonly enabled: boolean;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly logger: LLMLogger;

  constructor(config: LLMClientConfig) {
    this.enabled = !!(config.apiKey && config.apiUrl && config.model);
    this.model = config.model;
    this.timeoutMs = config.timeoutMs || 120000;
    this.logger = config.logger || consoleLogger;

    if (this.enabled) {
      this.client = axios.create({
        baseURL: config.apiUrl,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        timeout: this.timeoutMs,
      });
      this.logger.info(`LLM integration enabled (model: ${this.model})`);
    } else {
      this.logger.info(
        "LLM integration disabled (apiKey, apiUrl or model not set)",
      );
    }
  }

  /**
   * Check whether the client is properly configured.
   */
  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Send a chat completion request.
   *
   * @param messages  The chat messages to send.
   * @param options   Optional per-request overrides (JSON mode, model,
   *                  timeout). `timeoutMs: 0` disables the request timeout.
   * @returns The first choice content and total token usage.
   * @throws When the client is disabled, the provider returns an error, or
   *         the response has no choices.
   */
  public async request(
    messages: LLMMessage[],
    options?: LLMRequestOptions,
  ): Promise<LLMResponse> {
    if (!this.enabled || !this.client) {
      throw new Error(
        "LLM integration disabled (apiKey, apiUrl or model not set)",
      );
    }

    const model = options?.model || this.model;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: Record<string, any> = {
      model,
      messages,
      stream: false,
    };
    if (options?.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    try {
      const response =
        options?.timeoutMs !== undefined
          ? await this.client.post("", body, { timeout: options.timeoutMs })
          : await this.client.post("", body);
      const choice = response.data?.choices?.[0];
      if (!choice) {
        throw new Error("LLM response has no choices");
      }
      return {
        content: choice.message?.content || "",
        totalTokens: response.data?.usage?.total_tokens || 0,
      };
    } catch (err) {
      const message = this.extractErrorMessage(err);
      this.logger.error(`LLMClient: request failed (${message})`, err);
      throw new Error(message, { cause: err });
    }
  }

  /**
   * Extract a readable error message, preferring the provider's error
   * payload when the failure comes from an HTTP response.
   */
  private extractErrorMessage(err: unknown): string {
    if (axios.isAxiosError(err)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const providerMessage = (err.response?.data as any)?.error?.message;
      if (providerMessage) {
        return providerMessage;
      }
    }
    return err instanceof Error ? err.message : String(err);
  }
}
