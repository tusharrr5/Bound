import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

// The agent loop with a scripted model in place of Gemma: each test decides exactly which
// tool calls "the model" makes, so the guards are tested without depending on model behaviour.
type Reply = { content: string | null; tool_calls?: any[] };
let script: (messages: any[]) => Reply;
let modelCalls = 0;

vi.mock('../../src/agent/llm.js', async importOriginal => {
  const real = await importOriginal<typeof import('../../src/agent/llm.js')>();
  return {
    ...real,
    chatCompletion: async ({ messages }: { messages: any[] }) => {
      modelCalls++;
      return { message: { role: 'assistant', ...script(messages) }, durationMs: 1 };
    }
  };
});

const { seedDatabase } = await import('../../src/db/seed.js');
const { pool } = await import('../../src/db/pool.js');
const { runBuyerAgent } = await import('../../src/agent/buyer-agent.js');
const { executeToolCall } = await import('../../src/agent/tools.js');
const { createTaskBoundMandate } = await import('../../src/arena/service.js');
const { validateToolArgs, RUN_LIMITS } = await import('../../src/agent/guard.js');
const { ARENA_AGENT_ID, PAYLOAD_VARIANT_ID, DEFAULT_ARENA_GOAL } = await import('../../src/arena/catalog.js');

let n = 0;
const call = (name: string, args: unknown) => ({
  id: `call_${++n}`, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
});
const toolMessages = (messages: any[]) => messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
const lastCartId = (messages: any[]) => [...toolMessages(messages)].reverse().find(r => r?.cartId)?.cartId;

let flaskVariant: string;

async function run(steps: Array<(messages: any[]) => Reply>, goal = DEFAULT_ARENA_GOAL) {
  const correlationId = `guard_${crypto.randomBytes(4).toString('hex')}`;
  const mandate = await createTaskBoundMandate({ correlationId, goal });
  let i = 0;
  script = messages => (i < steps.length ? steps[i++](messages) : { content: 'Done.' });
  modelCalls = 0;
  const result = await runBuyerAgent(goal, {
    buyerAgentId: ARENA_AGENT_ID, mandateTokenId: mandate.mandateTokenId, correlationId,
    spendingLimitMinor: mandate.ceilingMinor, purchaseTaskId: mandate.task.id
  });
  return { result, mandate };
}

beforeAll(async () => {
  await seedDatabase();
  flaskVariant = (await pool.query(`SELECT id FROM product_variants WHERE sku LIKE 'ARENA-BAIT%' LIMIT 1`)).rows[0].id;
});

beforeEach(async () => {
  await pool.query(`UPDATE inventory_reservations SET status = 'RELEASED' WHERE buyer_agent_id = $1 AND status = 'ACTIVE'`, [ARENA_AGENT_ID]);
});

describe('Agent loop guards', () => {
  it('stops the run at the first authorization refusal: no checkout, no further model turns', async () => {
    const { result } = await run([
      () => ({ content: null, tool_calls: [call('create_cart', {})] }),
      m => ({ content: null, tool_calls: [call('add_to_cart', { cart_id: lastCartId(m), variant_id: PAYLOAD_VARIANT_ID, quantity: 1 })] }),
      m => ({ content: null, tool_calls: [call('start_checkout', { cart_id: lastCartId(m) })] })
    ]);
    expect(result.finalStatus).toBe('BLOCKED_BY_POLICY');
    expect(result.stopReason?.code).toBe('PRODUCT_NOT_AUTHORIZED_FOR_TASK');
    expect(result.steps.some(s => s.tool === 'start_checkout')).toBe(false);
    expect(modelCalls).toBe(2);
    expect(result.orderId).toBeUndefined();
  });

  it('still completes an honest purchase', async () => {
    const { result } = await run([
      () => ({ content: null, tool_calls: [call('search_products', { query: 'flask' })] }),
      () => ({ content: null, tool_calls: [call('create_cart', {})] }),
      m => ({ content: null, tool_calls: [call('add_to_cart', { cart_id: lastCartId(m), variant_id: flaskVariant, quantity: 1 })] }),
      m => ({ content: null, tool_calls: [call('start_checkout', { cart_id: lastCartId(m) })] }),
      () => ({ content: 'Bought the flask.' })
    ]);
    expect(result.finalStatus).toBe('COMPLETED');
    expect(result.totalPaidMinor).toBe(99900);
  });

  it('marks seller-written listing text as seller content, apart from platform facts', async () => {
    let seen: any;
    await run([
      () => ({ content: null, tool_calls: [call('search_products', { query: 'flask' })] }),
      m => { seen = toolMessages(m)[0]; return { content: 'Stopping.' }; }
    ]);
    const first = seen.results[0];
    expect(first.variant_id).toBeDefined();
    expect(first.price_minor).toBeTypeOf('number');
    expect(first.seller_listing.description).toBeTypeOf('string');
    expect(first.description).toBeUndefined();
  });

  it('rejects malformed calls without executing them, and stops after repeated ones', async () => {
    const { result } = await run([
      () => ({ content: null, tool_calls: [call('add_to_cart', '{not json')] }),
      () => ({ content: null, tool_calls: [call('add_to_cart', { cart_id: 'cart_1', variant_id: PAYLOAD_VARIANT_ID, quantity: 1 })] }),
      () => ({ content: null, tool_calls: [call('transfer_funds', { amount: 1 })] })
    ]);
    expect(result.steps.map(s => s.toolResult?.code)).toEqual(['INVALID_TOOL_CALL', 'INVALID_TOOL_CALL', 'INVALID_TOOL_CALL']);
    expect(result.stopReason?.code).toBe('TOO_MANY_INVALID_CALLS');
    expect(result.finalStatus).toBe('FAILED');
  });

  it('enforces run limits', async () => {
    // Two calls per turn, so the call limit is reached before the model-turn limit
    const { result } = await run(Array.from({ length: 30 }, () => () => ({ content: null, tool_calls: [call('search_products', { query: 'flask' }), call('search_products', { query: 'mug' })] })));
    expect(result.steps.filter(s => s.tool === 'search_products' && s.toolResult?.ok !== false).length).toBe(RUN_LIMITS.maxToolCalls);
    expect(result.stopReason?.code).toBe('RUN_LIMIT_REACHED');

    const burst = await run([() => ({ content: null, tool_calls: Array.from({ length: 6 }, () => call('search_products', { query: 'mug' })) })]);
    expect(burst.result.stopReason?.code).toBe('RUN_LIMIT_REACHED');
    expect(burst.result.steps.length).toBe(RUN_LIMITS.maxToolCallsPerTurn + 1);
  });

  it('refuses a cart that belongs to another agent or another task', async () => {
    const other = await pool.query(`INSERT INTO carts (buyer_agent_id, merchant_id, status, expires_at, correlation_id) VALUES ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'OPEN', NOW() + INTERVAL '10 minutes', 'guard_foreign') RETURNING id`);
    const foreign = other.rows[0].id;
    const { result } = await run([
      () => ({ content: null, tool_calls: [call('add_to_cart', { cart_id: foreign, variant_id: flaskVariant, quantity: 1 })] })
    ]);
    expect(result.stopReason?.code).toBe('CART_NOT_OWNED');

    const untasked = await pool.query(`INSERT INTO carts (buyer_agent_id, merchant_id, status, expires_at, correlation_id) VALUES ($1, '11111111-1111-1111-1111-111111111111', 'OPEN', NOW() + INTERVAL '10 minutes', 'guard_untasked') RETURNING id`, [ARENA_AGENT_ID]);
    const second = await run([
      () => ({ content: null, tool_calls: [call('start_checkout', { cart_id: untasked.rows[0].id })] })
    ]);
    expect(second.result.stopReason?.code).toBe('CART_TASK_MISMATCH');
  });

  it('uses only the mandate issued for the run', async () => {
    const { result } = await run([
      () => ({ content: null, tool_calls: [call('create_cart', {})] }),
      m => ({ content: null, tool_calls: [call('add_to_cart', { cart_id: lastCartId(m), variant_id: flaskVariant, quantity: 1 })] }),
      m => ({ content: null, tool_calls: [call('start_checkout', { cart_id: lastCartId(m), mandate_token_id: 'mandate_tok_demo_2026' })] })
    ]);
    expect(result.stopReason?.code).toBe('MANDATE_NOT_PERMITTED');
    expect(result.orderId).toBeUndefined();
  });

  it('takes identity from the principal, never from model arguments', async () => {
    const res: any = await executeToolCall('create_cart', { buyer_agent_id: ARENA_AGENT_ID }, 'corr_no_principal');
    expect(res).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' });
    expect(validateToolArgs('create_cart', { buyer_agent_id: ARENA_AGENT_ID })).toContain('Unexpected argument');
  });
});
