/**
 * Limits and checks applied to a model-driven run before any tool executes. The model is
 * treated as untrusted: its arguments are validated here, its run is bounded, and an
 * authorization refusal ends the run instead of letting it keep trying.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RUN_LIMITS = {
  maxToolCalls: 16,
  maxToolCallsPerTurn: 4,
  /** add_to_cart and request_negotiation calls. */
  maxMutations: 6,
  maxCarts: 2,
  maxCheckouts: 1,
  maxInvalidCalls: 3
} as const;

/** Refusals that mean the agent tried to buy something the human did not authorize. */
export const INTENT_REJECTION_CODES = new Set([
  'PRODUCT_NOT_AUTHORIZED_FOR_TASK', 'PRODUCT_ATTRIBUTE_MISMATCH', 'PRODUCT_EXCLUDED', 'VARIANT_NOT_AUTHORIZED',
  'PRODUCT_REQUIRES_HUMAN_APPROVAL', 'QUANTITY_NOT_ALLOWED', 'TASK_BUDGET_EXCEEDED', 'MERCHANT_MISMATCH'
]);

/** Refusals after which the run stops and the human decides. */
export const STOP_CODES = new Set([
  ...INTENT_REJECTION_CODES,
  'CART_NOT_OWNED', 'ORDER_NOT_OWNED', 'CART_TASK_MISMATCH', 'MANDATE_NOT_PERMITTED',
  'TASK_NOT_ACTIVE', 'TASK_EXPIRED', 'TASK_INTEGRITY_FAILED', 'AUTONOMOUS_CHECKOUT_REQUIRES_TASK', 'MANDATE_TASK_MISMATCH'
]);

type FieldRule = { type: 'string' | 'integer' | 'boolean' | 'object'; uuid?: boolean; min?: number; max?: number; maxLength?: number };

const TOOL_ARGS: Record<string, { required: string[]; fields: Record<string, FieldRule> }> = {
  discover_capabilities: { required: [], fields: {} },
  search_products: {
    required: ['query'],
    fields: {
      query: { type: 'string', maxLength: 100 },
      category: { type: 'string', maxLength: 100 },
      max_price_minor: { type: 'integer', min: 0, max: 100_000_000 },
      in_stock_only: { type: 'boolean' }
    }
  },
  get_product_detail: { required: ['variant_id'], fields: { variant_id: { type: 'string', uuid: true } } },
  create_cart: { required: [], fields: {} },
  add_to_cart: {
    required: ['cart_id', 'variant_id', 'quantity'],
    fields: {
      cart_id: { type: 'string', uuid: true },
      variant_id: { type: 'string', uuid: true },
      quantity: { type: 'integer', min: 1, max: 100 }
    }
  },
  request_negotiation: {
    required: ['variant_id', 'proposed_price_minor'],
    fields: { variant_id: { type: 'string', uuid: true }, proposed_price_minor: { type: 'integer', min: 1, max: 100_000_000 } }
  },
  start_checkout: {
    required: ['cart_id'],
    fields: { cart_id: { type: 'string', uuid: true }, mandate_token_id: { type: 'string', maxLength: 200 }, shipping_address: { type: 'object' } }
  },
  get_order_status: { required: ['order_id'], fields: { order_id: { type: 'string', uuid: true } } }
};

/** Returns why the call is malformed, or null. Unknown arguments are rejected, not ignored. */
export function validateToolArgs(name: string, args: unknown): string | null {
  const spec = TOOL_ARGS[name];
  if (!spec) return `Unknown tool "${name}".`;
  if (args == null || typeof args !== 'object' || Array.isArray(args)) return 'Arguments must be a JSON object.';
  const a = args as Record<string, unknown>;
  for (const key of spec.required) {
    if (a[key] === undefined || a[key] === null) return `Missing required argument "${key}".`;
  }
  for (const [key, value] of Object.entries(a)) {
    const rule = spec.fields[key];
    if (!rule) return `Unexpected argument "${key}".`;
    if (value === undefined || value === null) continue;
    switch (rule.type) {
      case 'string':
        if (typeof value !== 'string') return `"${key}" must be a string.`;
        if (rule.uuid && !UUID_RE.test(value)) return `"${key}" must be an id returned by an earlier tool call.`;
        if (rule.maxLength && value.length > rule.maxLength) return `"${key}" is too long.`;
        break;
      case 'integer':
        if (typeof value !== 'number' || !Number.isInteger(value)) return `"${key}" must be an integer.`;
        if (rule.min !== undefined && value < rule.min) return `"${key}" must be at least ${rule.min}.`;
        if (rule.max !== undefined && value > rule.max) return `"${key}" must be at most ${rule.max}.`;
        break;
      case 'boolean':
        if (typeof value !== 'boolean') return `"${key}" must be true or false.`;
        break;
      case 'object':
        if (typeof value !== 'object' || Array.isArray(value)) return `"${key}" must be an object.`;
        break;
    }
  }
  return null;
}

/** Counts what a run has done and refuses calls past the limits. */
export class RunBudget {
  toolCalls = 0;
  mutations = 0;
  carts = 0;
  checkouts = 0;
  invalidCalls = 0;

  /** Returns a refusal reason, or null and records the call. */
  admit(name: string, callsThisTurn: number): string | null {
    if (this.toolCalls >= RUN_LIMITS.maxToolCalls) return `Run limit reached: ${RUN_LIMITS.maxToolCalls} tool calls.`;
    if (callsThisTurn > RUN_LIMITS.maxToolCallsPerTurn) return `Too many tool calls in one turn (limit ${RUN_LIMITS.maxToolCallsPerTurn}).`;
    if ((name === 'add_to_cart' || name === 'request_negotiation') && this.mutations >= RUN_LIMITS.maxMutations) {
      return `Run limit reached: ${RUN_LIMITS.maxMutations} cart changes.`;
    }
    if (name === 'create_cart' && this.carts >= RUN_LIMITS.maxCarts) return `Run limit reached: ${RUN_LIMITS.maxCarts} carts.`;
    if (name === 'start_checkout' && this.checkouts >= RUN_LIMITS.maxCheckouts) return 'Checkout was already attempted in this run.';
    this.toolCalls++;
    if (name === 'add_to_cart' || name === 'request_negotiation') this.mutations++;
    if (name === 'create_cart') this.carts++;
    if (name === 'start_checkout') this.checkouts++;
    return null;
  }

  /** Records a malformed call; true once the run has made too many. */
  recordInvalid(): boolean {
    this.invalidCalls++;
    return this.invalidCalls >= RUN_LIMITS.maxInvalidCalls;
  }
}

/** The refusal code in a tool result that should end the run, if any. */
export function stopCodeOf(result: any): string | undefined {
  const code = result?.code ?? result?.errorCode;
  if (result?.ok === false || result?.executionMode === 'DENIED') {
    if (typeof code === 'string' && STOP_CODES.has(code)) return code;
  }
  return undefined;
}
