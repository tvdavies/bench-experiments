/**
 * Minimal client for any OpenAI-compatible Chat Completions endpoint.
 *
 * Deliberately dependency-free and provider-neutral: point BENCH_BASE_URL at
 * a gateway (CLIProxyAPI, LiteLLM, OpenRouter, vLLM, LM Studio, ...) and pass
 * whatever model id that gateway understands.
 */

export interface ModelConfig {
  model: string;
  baseUrl: string;
  apiKey?: string;
  /** Passed through as `reasoning_effort` when set. */
  reasoningEffort?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Extra fields merged into the request body. */
  extraBody?: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  arguments: unknown;
  rawArguments: string;
}

export interface Usage {
  inputTokens: number;
  /** All generated tokens, including hidden reasoning tokens when reported. */
  outputTokens: number;
  reasoningTokens: number;
}

export interface ChatResult {
  content: string;
  reasoningText: string;
  toolCalls: ToolCall[];
  usage: Usage;
  latencyMs: number;
  attempts: number;
  finishReason?: string;
  /** Set when the call failed after retries (network, 4xx/5xx, bad JSON). */
  error?: string;
}

export const DEFAULT_BASE_URL = "http://127.0.0.1:8317/v1";

export function resolveModelConfig(
  partial: Partial<ModelConfig> & { model: string },
): ModelConfig {
  return {
    baseUrl: process.env.BENCH_BASE_URL ?? DEFAULT_BASE_URL,
    apiKey: process.env.BENCH_API_KEY ?? process.env.OPENAI_API_KEY,
    timeoutMs: 300_000,
    ...partial,
  };
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

interface RawToolCall {
  function?: { name?: string; arguments?: string };
}

interface RawResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null | Array<{ type?: string; text?: string }>;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: RawToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("");
  }
  return "";
}

export async function chat(
  config: ModelConfig,
  messages: ChatMessage[],
  tools: ToolDef[] = [],
  maxAttempts = 4,
): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    ...(config.maxTokens !== undefined && { max_tokens: config.maxTokens }),
    ...(config.temperature !== undefined && { temperature: config.temperature }),
    ...(config.reasoningEffort !== undefined && {
      reasoning_effort: config.reasoningEffort,
    }),
    ...(tools.length > 0 && {
      tools: tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: "auto",
    }),
    ...config.extraBody,
  };

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

  let lastError = "unknown error";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = performance.now();
    try {
      const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs ?? 300_000),
      });
      const latencyMs = performance.now() - started;
      const text = await res.text();
      if (!res.ok) {
        lastError = `HTTP ${res.status}: ${text.slice(0, 500)}`;
        if (RETRYABLE_STATUS.has(res.status) && attempt < maxAttempts) {
          await Bun.sleep(1000 * 2 ** (attempt - 1));
          continue;
        }
        break;
      }
      const json = JSON.parse(text) as RawResponse;
      const choice = json.choices?.[0];
      const message = choice?.message ?? {};
      const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc) => {
        const rawArguments = tc.function?.arguments ?? "";
        let args: unknown = null;
        try {
          args = rawArguments ? JSON.parse(rawArguments) : {};
        } catch {
          args = null;
        }
        return { name: tc.function?.name ?? "", arguments: args, rawArguments };
      });
      return {
        content: textOf(message.content),
        reasoningText: textOf(message.reasoning_content ?? message.reasoning),
        toolCalls,
        usage: {
          inputTokens: json.usage?.prompt_tokens ?? 0,
          outputTokens: json.usage?.completion_tokens ?? 0,
          reasoningTokens: json.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
        },
        latencyMs,
        attempts: attempt,
        finishReason: choice?.finish_reason,
      };
    } catch (err) {
      lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      if (attempt < maxAttempts) {
        await Bun.sleep(1000 * 2 ** (attempt - 1));
        continue;
      }
    }
  }

  return {
    content: "",
    reasoningText: "",
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    latencyMs: 0,
    attempts: maxAttempts,
    error: lastError,
  };
}
