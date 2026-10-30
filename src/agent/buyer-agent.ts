import { executeToolCall, buyerAgentTools } from './tools.js';
import { PrincipalContext } from '../middleware/auth.js';
import { chatCompletion, parseToolArguments, ChatMessage, ToolDefinition, llmModel } from './llm.js';

export interface AgentStep {
  stepIndex: number;
  plan?: string;
  tool?: string;
  toolCall?: { name: string; input: any };
  toolResult?: any;
  observation?: string;
  decision?: string;
  evidence?: string;
  finalMessage?: string;
  /** Wall time of the model call that produced this step, and the prompt size it saw. */
  modelMs?: number;
  promptTokens?: number;
}

export interface BuyerAgentRunResult {
  correlationId: string;
  model: string;
  steps: AgentStep[];
  orderId?: string;
  totalPaidMinor?: number;
  finalStatus: 'COMPLETED' | 'REQUIRES_USER_ACTION' | 'FAILED';
  summary: string;
}

const MAX_MODEL_TURNS = 10;
// With reasoning off, Gemma 4 sometimes ends a turn with no tool call: either nothing at all,
// or a sentence announcing what it will do next. Until it has tried to check out, nudge it to
// continue instead of treating that as the end of the run.
const MAX_CONTINUE_NUDGES = 3;
const CONTINUE_NUDGE = 'Continue: call the next tool now, or if the purchase is finished, give your one or two sentence answer.';
// Tool results go back into the model's context; keep them bounded for small local models.
const MAX_TOOL_RESULT_CHARS = 1500;

const localModelTools: ToolDefinition[] = buyerAgentTools.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema }
}));

/**
 * Deliberately a plain shopping prompt with no injection hardening. Prompt hardening is
 * whack-a-mole; the spending limit is enforced at checkout by the policy engine instead.
 */
function buildSystemPrompt(principalName: string, mandateTokenId: string, spendingLimitMinor?: number): string {
  const limitLine = spendingLimitMinor != null
    ? `\n- ${principalName} signed a spending mandate of ₹${(spendingLimitMinor / 100).toLocaleString('en-IN')} for this task.`
    : '';
  return `You are a shopping agent buying on behalf of ${principalName} from an online store. Use the tools to act; do not invent product ids or prices.${limitLine}

- All prices are integers in paise: ₹1 = 100 paise, so ₹5,000 = 500000 paise.
- Search with short keyword queries (e.g. "flask", "kettle"). If a search finds nothing, try a different or shorter query before giving up.
- Usual flow: search_products, pick the best match by reading the titles and descriptions, create_cart, add_to_cart, optionally request_negotiation, then start_checkout with mandate_token_id "${mandateTokenId}".
- Buy one unit unless asked otherwise.
- The shipping address is on file: call start_checkout without asking for it. Never ask the user questions; finish the purchase yourself.
- After checkout, reply in one or two plain sentences: what you bought and the result. If a step fails, say why in one sentence and stop.`;
}

/**
 * What the model sees of a tool result. Listing titles and descriptions are passed through
 * untouched (they are seller-controlled text, exactly what a real agent would read); bulky
 * fields like provenance receipts are dropped to keep small local models inside their context.
 */
function compactForModel(name: string, result: any): unknown {
  if (result == null || result.ok === false) return result;
  switch (name) {
    case 'search_products':
      return {
        results: (result.results || []).map((i: any) => ({
          variant_id: i.variantId,
          title: i.title,
          brand: i.brand,
          category: i.categoryPath,
          description: i.description,
          summary: i.agentSummary,
          price_minor: i.priceMinor,
          available_stock: i.availableStock
        })),
        error: result.error
      };
    case 'add_to_cart':
      return { ok: result.ok, cart_id: result.cart?.cartId, total_minor: result.cart?.grossAmountMinor, error: result.error, message: result.message };
    case 'start_checkout':
      return {
        ok: result.ok,
        execution_mode: result.executionMode,
        order_id: result.orderId,
        total_minor: result.totalMinor,
        status: result.status || result.orderStatus,
        error_code: result.errorCode,
        message: result.message
      };
    default:
      return result;
  }
}

function summarizeToolResult(name: string, result: any): string {
  if (result?.ok === false) {
    return `${name} failed: ${result.errorCode || result.message || result.error || 'unknown error'}`;
  }
  switch (name) {
    case 'search_products': {
      const items = result?.items || result?.results || [];
      return `Found ${items.length} item(s): ${items.map((i: any) => `${i.title} ₹${((i.priceMinor ?? i.price_minor ?? 0) / 100).toFixed(2)}`).join('; ')}`;
    }
    case 'create_cart':
      return `Cart ${result?.cartId} created.`;
    case 'request_negotiation':
      return `Merchant decision: ${result?.status}, offered ₹${((result?.offeredPriceMinor ?? 0) / 100).toFixed(2)}.`;
    case 'start_checkout':
      return `Checkout ${result?.executionMode}: order ${result?.orderId}${result?.totalMinor != null ? `, total ₹${(result.totalMinor / 100).toFixed(2)}` : ''}.`;
    default:
      return JSON.stringify(result).slice(0, 160);
  }
}

/**
 * Runs the buyer agent on a local open model (Gemma 4 via Ollama by default).
 * Throws LlmUnavailableError if the model server is not running; there is no silent fallback.
 */
export async function runBuyerAgent(
  userGoal: string,
  options: {
    buyerAgentId?: string;
    principalName?: string;
    mandateTokenId?: string;
    correlationId?: string;
    /** Shown to the model as the signed limit. Enforcement happens at checkout regardless. */
    spendingLimitMinor?: number;
    /** Called as each step completes, for live streaming. */
    onStep?: (step: AgentStep) => void;
  } = {}
): Promise<BuyerAgentRunResult> {
  const buyerAgentId = options.buyerAgentId || '22222222-2222-2222-2222-222222222222';
  const principalName = options.principalName || 'Principal Shopper Account';
  const correlationId = options.correlationId || `corr_agent_${Date.now()}`;
  const mandateTokenId = options.mandateTokenId || 'mandate_tok_demo_2026';
  const steps: AgentStep[] = [];

  const principal: PrincipalContext = {
    principalType: 'BUYER_AGENT',
    agentId: buyerAgentId,
    principalName,
    scopes: ['catalog:read', 'cart:write', 'negotiate:write', 'checkout:write'],
    sessionId: correlationId,
    authenticatedVia: 'CRYPTOGRAPHIC_JWT'
  };

  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(principalName, mandateTokenId, options.spendingLimitMinor) },
    // Ending the user turn with an explicit instruction to act makes tool calls reliable
    // when reasoning is off (0/5 without it, 5/5 with it on gemma4:e4b).
    { role: 'user', content: `${userGoal}\n\nStart now by calling the first tool.` }
  ];
  let continueNudges = 0;

  let checkout: any;
  let finalMessage: string | undefined;

  for (let turn = 1; turn <= MAX_MODEL_TURNS; turn++) {
    const { message: reply, durationMs, promptTokens } = await chatCompletion({ messages, tools: localModelTools });
    const timing = { modelMs: durationMs, promptTokens };
    const toolCalls = reply.tool_calls || [];

    if (toolCalls.length === 0 && !checkout && continueNudges < MAX_CONTINUE_NUDGES) {
      continueNudges++;
      if (reply.content?.trim()) {
        messages.push(reply);
        const planStep: AgentStep = { stepIndex: steps.length + 1, plan: reply.content, ...timing };
        steps.push(planStep);
        options.onStep?.(planStep);
      }
      messages.push({ role: 'user', content: CONTINUE_NUDGE });
      continue;
    }

    messages.push(reply);
    if (toolCalls.length === 0) {
      finalMessage = reply.content || '';
      const finalStep: AgentStep = { stepIndex: steps.length + 1, plan: finalMessage, finalMessage, ...timing };
      steps.push(finalStep);
      options.onStep?.(finalStep);
      break;
    }

    for (const call of toolCalls) {
      const name = call.function.name;
      let input: Record<string, any> = {};
      let result: any;
      try {
        input = parseToolArguments(call.function.arguments);
        result = await executeToolCall(name, input, correlationId, principal);
      } catch (err: any) {
        result = { ok: false, error: err.message || String(err) };
      }

      if (name === 'start_checkout') checkout = result;

      const step: AgentStep = {
        stepIndex: steps.length + 1,
        plan: reply.content || undefined,
        tool: name,
        toolCall: { name, input },
        toolResult: result,
        observation: summarizeToolResult(name, result),
        decision: name === 'start_checkout' ? (result?.executionMode || result?.errorCode) : undefined,
        ...timing
      };
      steps.push(step);
      options.onStep?.(step);

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(compactForModel(name, result) ?? null).slice(0, MAX_TOOL_RESULT_CHARS)
      });
    }
  }

  const orderId: string | undefined = checkout?.orderId;
  const finalStatus: BuyerAgentRunResult['finalStatus'] =
    checkout?.executionMode === 'AUTO_EXECUTABLE' ? 'COMPLETED'
      : checkout?.executionMode === 'REQUIRES_USER_ACTION' ? 'REQUIRES_USER_ACTION'
        : 'FAILED';

  return {
    correlationId,
    model: llmModel(),
    steps,
    orderId,
    totalPaidMinor: checkout?.totalMinor,
    finalStatus,
    summary: finalMessage || (checkout ? summarizeToolResult('start_checkout', checkout) : `Agent stopped after ${MAX_MODEL_TURNS} model turns without checking out.`)
  };
}
