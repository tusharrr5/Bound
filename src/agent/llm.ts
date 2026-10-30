/**
 * Client for a locally running open model over the OpenAI-compatible chat API.
 *
 * Defaults to Gemma 4 (E4B) served by Ollama on this machine, so the agent works with no
 * network and no API key. Any server that speaks /v1/chat/completions with tool calls
 * (llama.cpp server, LM Studio, vLLM) works by changing LLM_BASE_URL and LLM_MODEL.
 */

// Read lazily: server.ts loads .env after its imports have been evaluated.
export const llmBaseUrl = () => (process.env.LLM_BASE_URL || 'http://localhost:11434/v1').replace(/\/$/, '');
export const llmModel = () => process.env.LLM_MODEL || 'gemma4:e4b';
const llmTimeoutMs = () => Number(process.env.LLM_TIMEOUT_MS) || 120_000;
// Gemma 4 turns on hidden reasoning when many tools are attached (~15s per step on an M2).
// 'none' brings a step to about 1s. Set LLM_REASONING_EFFORT=low|medium|high to re-enable.
const llmReasoningEffort = () => process.env.LLM_REASONING_EFFORT || 'none';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string | Record<string, unknown> };
}

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** Thrown when the local model server is down or the model has not been pulled. */
export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

export async function chatCompletion(params: {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
}): Promise<{
  message: { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] };
  promptTokens?: number;
  durationMs: number;
}> {
  const baseUrl = llmBaseUrl();
  const model = llmModel();
  const timeoutMs = llmTimeoutMs();
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: params.messages,
        tools: params.tools,
        temperature: params.temperature ?? 0.2,
        reasoning_effort: llmReasoningEffort(),
        stream: false
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err: any) {
    if (err?.name === 'TimeoutError') {
      throw new LlmUnavailableError(`Local model ${model} did not answer within ${timeoutMs / 1000}s.`);
    }
    throw new LlmUnavailableError(
      `Local model server not reachable at ${baseUrl}. Start it with "ollama serve" and run "ollama pull ${model}".`
    );
  }

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 404) {
      throw new LlmUnavailableError(`Model ${model} is not available on ${baseUrl}. Run "ollama pull ${model}". (${body.slice(0, 200)})`);
    }
    throw new Error(`Local model request failed (${res.status}): ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as any;
  const message = data?.choices?.[0]?.message;
  if (!message) {
    throw new Error(`Local model returned no message: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return {
    message: { role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls },
    promptTokens: data?.usage?.prompt_tokens,
    durationMs: Date.now() - started
  };
}

/**
 * Loads the model and asks Ollama to keep it in memory, so the first Arena step isn't a
 * ~13s cold load. Ollama-specific (native API); failures are ignored.
 */
export async function warmModel(keepAlive = '30m'): Promise<void> {
  const root = llmBaseUrl().replace(/\/v1$/, '');
  try {
    await fetch(`${root}/api/generate`, {
      method: 'POST',
      body: JSON.stringify({ model: llmModel(), keep_alive: keepAlive }),
      signal: AbortSignal.timeout(60_000)
    });
  } catch {
    // Not Ollama, or not running; the run itself will report that clearly.
  }
}

/** Parses tool-call arguments, which some servers send as a JSON string and others as an object. */
export function parseToolArguments(raw: ToolCall['function']['arguments']): Record<string, any> {
  if (typeof raw !== 'string') return raw ?? {};
  if (raw.trim() === '') return {};
  return JSON.parse(raw);
}
