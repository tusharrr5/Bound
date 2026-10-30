// config must load first: it reads .env and validates security settings before other modules read process.env
import { config, configReport, ConfigError } from './config.js';
import Fastify, { FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './db/pool.js';
import { searchCatalog, getProductDetail } from './catalog/service.js';
import { createCart, addToCart, removeFromCart, getCart, CartTaskBindingError } from './cart/service.js';
import { negotiatePrice } from './negotiation/engine.js';
import { startCheckout, getOrderStatus } from './checkout/service.js';
import { processRazorpayWebhook, rotateWebhookSecret } from './webhooks/razorpay.js';
import { verifyRazorpayWebhook } from './webhooks/secrets.js';
import { runFullReconciliationCycle } from './payments/reconciliation.js';
import { getAuditTrail, createAuditCheckpoint, verifyAuditLedger } from './audit/ledger.js';
import { processAuditOutboxBatch, verifyCommerceAuditAtomicity } from './audit/outbox.js';
import { verifyExternalWormAnchors } from './audit/anchoring.js';
import { registerSSEClient } from './audit/stream.js';
import { injectDemoFailure, simulateWebhookPaymentFailure, simulateWebhookPaymentSuccess } from './demo/failure-injection.js';
import { runBuyerAgent } from './agent/buyer-agent.js';
import { checkIdempotency, saveIdempotencyResponse } from './middleware/idempotency.js';
import { authenticate, requireAgent, requireHuman, requireHumanStepUpAuth, AuthError } from './middleware/auth.js';
import {
  createAgentDelegation,
  createPurchaseMandateFromDelegation,
  getMandateDetails,
  revokeMandate,
  updateDelegationBudget,
  revokeAgentDelegation
} from './policy/delegation.js';
import { getMerchantCapabilities } from './agent/capabilities.js';
import {
  executeAutonomousMandatePlaybook,
  executeRazorpayInteractivePlaybook,
  executeFailureRecoveryPlaybook,
  executeFulfilmentCompensationPlaybook
} from './demo/playbooks.js';
import {
  runArena, runDirectCheck, getArenaStats, getBaitListing, updateBaitListing, listAttackPresets,
  createTaskBoundMandate, ArenaBusyError, ArenaTaskError
} from './arena/service.js';
import { DEFAULT_ARENA_GOAL, ARENA_MANDATE_CEILING_MINOR, ARENA_ALLOWED_CATEGORIES, PAYLOAD_VARIANT_ID } from './arena/catalog.js';
import { llmModel, LlmUnavailableError, warmModel } from './agent/llm.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEMO_SANDBOX_AGENT = '22222222-2222-2222-2222-222222222222';
const DEFAULT_SHIPPING = { line1: '100 Silicon Valley, Indiranagar', city: 'Bengaluru', state: 'Karnataka', postal_code: '560038', country: 'IN' };

export const fastify = Fastify({
  logger: false,
  bodyLimit: 256 * 1024
});

// ─── PLUGINS ────────────────────────────────────────────────────────────────
await fastify.register(cors, { origin: config.corsOrigins, credentials: false });
await fastify.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
await fastify.register(fastifyStatic, {
  root: path.join(__dirname, '../dashboard/dist'),
  prefix: '/'
});

// Capture raw body for authentic HMAC signature verification
fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  try {
    (req as any).rawBody = body;
    const json = body.length ? JSON.parse(body.toString('utf8')) : {};
    done(null, json);
  } catch (err: any) {
    err.statusCode = 400;
    done(err, undefined);
  }
});

// Never leak internals: known errors map to their status, everything else is a generic 500
fastify.setErrorHandler((err: any, _req, reply) => {
  if (err instanceof AuthError) return reply.status(err.statusCode).send({ ok: false, code: err.code, error: err.message });
  if (err instanceof CartTaskBindingError) return reply.status(400).send({ ok: false, code: err.code, error: err.message });
  if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ ok: false, error: err.message });
  console.error('Unhandled error:', err);
  return reply.status(500).send({ ok: false, error: 'Internal error' });
});

// ─── ACCESS HELPERS ─────────────────────────────────────────────────────────
const bad = (reply: FastifyReply, error: string) => reply.status(400).send({ ok: false, code: 'INVALID_INPUT', error });
const notFound = (reply: FastifyReply, what: string) => reply.status(404).send({ ok: false, code: 'NOT_FOUND', error: `${what} not found` });
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const posInt = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max;

/** Operators (audit, reconciliation): a human with ops scope, or anyone when demo routes are explicitly on. */
async function requireOperator(req: FastifyRequest, reply: FastifyReply) {
  if (config.demoRoutes) return;
  return requireHuman('ops:read')(req, reply);
}

/** Returns the cart only if the calling agent owns it. Unknown and foreign carts look identical (404). */
async function ownedCart(req: FastifyRequest, cartId: string) {
  if (!isUuid(cartId)) return null;
  const cart = await getCart(cartId);
  return cart && cart.buyerAgentId === req.principal!.agentId ? cart : null;
}

// ─── HEALTH & METADATA (public) ─────────────────────────────────────────────
fastify.get('/health', async () => ({ status: 'UP', timestamp: new Date().toISOString() }));

fastify.get('/v1/capabilities', async () => getMerchantCapabilities());

// ─── CATALOG (public, bounded) ──────────────────────────────────────────────
fastify.get('/v1/catalog/search', async (req, reply) => {
  const q = req.query as Record<string, string>;
  const query = (q.q || q.query || '').slice(0, 200);
  const limit = q.limit ? Number(q.limit) : 10;
  const maxPrice = q.max_price ? Number(q.max_price) : undefined;
  if (!posInt(limit, 50)) return bad(reply, 'limit must be an integer from 1 to 50');
  if (maxPrice !== undefined && !posInt(maxPrice, 1_000_000_000)) return bad(reply, 'max_price must be a positive integer in paise');

  const results = await searchCatalog({
    query: query || 'coffee',
    category: q.category?.slice(0, 100),
    maxPriceMinor: maxPrice,
    inStockOnly: q.in_stock === 'true',
    limit
  });
  if (results.error) {
    return reply.status(400).send({ ok: false, code: 'QUERY_BUDGET_EXCEEDED', error: results.error, costScore: results.queryCostScore });
  }
  return results;
});

fastify.get('/v1/catalog/products/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (typeof id !== 'string' || id.length > 100) return bad(reply, 'invalid product id');
  const product = await getProductDetail(id);
  if (!product) return notFound(reply, 'Product');
  return product;
});

// ─── DELEGATIONS (human with step-up) ───────────────────────────────────────
fastify.post('/v1/agents/delegations', { preHandler: requireHumanStepUpAuth }, async (req, reply) => {
  const principal = req.principal!;
  const body = (req.body || {}) as {
    buyer_agent_id?: string; merchant_id?: string; allowed_categories?: string[];
    max_total_amount_minor?: number; autonomous_purchase_allowed?: boolean; validity_hours?: number;
  };
  if (!isUuid(body.buyer_agent_id)) return bad(reply, 'buyer_agent_id must be the agent being delegated to');
  if (!posInt(body.max_total_amount_minor, 1_000_000_000)) return bad(reply, 'max_total_amount_minor must be a positive integer');
  if (body.allowed_categories && (!Array.isArray(body.allowed_categories) || body.allowed_categories.length > 50)) return bad(reply, 'allowed_categories must be a short list');
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_del_${Date.now()}`;

  const delegation = await createAgentDelegation({
    principalName: principal.principalName,
    buyerAgentId: body.buyer_agent_id,
    merchantId: body.merchant_id,
    allowedCategories: body.allowed_categories,
    maxTotalAmountMinor: body.max_total_amount_minor!,
    autonomousPurchaseAllowed: body.autonomous_purchase_allowed,
    validityHours: body.validity_hours
  }, correlationId);
  return reply.status(201).send(delegation);
});

fastify.patch('/v1/agents/delegations/:id/budget', { preHandler: requireHumanStepUpAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = (req.body || {}) as { max_total_amount_minor?: number };
  if (!isUuid(id)) return bad(reply, 'invalid delegation id');
  if (!posInt(body.max_total_amount_minor, 1_000_000_000)) return bad(reply, 'max_total_amount_minor must be a positive integer');
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_bud_${Date.now()}`;
  const res = await updateDelegationBudget(id, body.max_total_amount_minor!, correlationId, `principal:${req.principal!.principalName}`);
  if (!res.ok) return reply.status(400).send(res);
  return res.delegation;
});

fastify.post('/v1/agents/delegations/:id/revoke', { preHandler: requireHumanStepUpAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = (req.body || {}) as { reason?: string };
  if (!isUuid(id)) return bad(reply, 'invalid delegation id');
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_del_rev_${Date.now()}`;
  const res = await revokeAgentDelegation(id, (body.reason || 'Revoked by human principal with step-up verification').slice(0, 500), correlationId, `principal:${req.principal!.principalName}`);
  if (!res.ok) return reply.status(400).send(res);
  return res;
});

// ─── MANDATES ───────────────────────────────────────────────────────────────
// Issued by a human with step-up. The signing key belongs to the human: a raw private key in a
// request body is accepted only in explicit sandbox mode, never in production.
fastify.post('/v1/mandates', { preHandler: requireHumanStepUpAuth }, async (req, reply) => {
  const body = (req.body || {}) as {
    delegation_id?: string; buyer_agent_id?: string; merchant_id?: string; purchase_task_id?: string;
    max_total_amount_minor?: number; per_txn_limit_minor?: number; allowed_categories?: string[];
    cart_hash?: string; quote_hash?: string; validity_hours?: number; private_key_pem?: string;
  };
  if (!config.sandboxAuth || config.isProduction) {
    return reply.status(501).send({
      ok: false,
      code: 'CLIENT_SIDE_SIGNING_REQUIRED',
      error: 'Mandates must be signed by the principal\'s own key. Server-side signing with a submitted private key is only available in sandbox mode.'
    });
  }
  if (!isUuid(body.delegation_id) || !isUuid(body.buyer_agent_id) || !isUuid(body.merchant_id)) return bad(reply, 'delegation_id, buyer_agent_id and merchant_id are required');
  if (body.purchase_task_id !== undefined && !isUuid(body.purchase_task_id)) return bad(reply, 'invalid purchase_task_id');
  if (!posInt(body.max_total_amount_minor, 1_000_000_000)) return bad(reply, 'max_total_amount_minor must be a positive integer');
  if (typeof body.private_key_pem !== 'string' || body.private_key_pem.length > 4096) return bad(reply, 'private_key_pem is required in sandbox mode');
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_man_${Date.now()}`;

  const result = await createPurchaseMandateFromDelegation({
    delegationId: body.delegation_id,
    buyerAgentId: body.buyer_agent_id,
    merchantId: body.merchant_id,
    purchaseTaskId: body.purchase_task_id,
    maxTotalAmountMinor: body.max_total_amount_minor!,
    perTxnLimitMinor: body.per_txn_limit_minor,
    allowedCategories: body.allowed_categories,
    cartHash: body.cart_hash,
    quoteHash: body.quote_hash,
    validityHours: body.validity_hours
  }, body.private_key_pem, correlationId);
  if (!result.ok) return reply.status(400).send(result);
  return reply.status(201).send(result);
});

fastify.get('/v1/mandates/:id', { preHandler: authenticate }, async (req, reply) => {
  const { id } = req.params as { id: string };
  if (typeof id !== 'string' || id.length > 200) return bad(reply, 'invalid mandate id');
  const owner = await pool.query('SELECT buyer_agent_id FROM purchase_mandates WHERE mandate_token_id = $1', [id]);
  const p = req.principal!;
  const allowed = owner.rows.length > 0 && (
    (p.principalType === 'BUYER_AGENT' && owner.rows[0].buyer_agent_id === p.agentId) ||
    (p.principalType === 'HUMAN_PRINCIPAL' && p.scopes.includes('mandate:read'))
  );
  if (!allowed) return notFound(reply, 'Mandate');
  return getMandateDetails(id);
});

fastify.post('/v1/mandates/:id/revoke', { preHandler: requireHumanStepUpAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = (req.body || {}) as { reason?: string };
  if (typeof id !== 'string' || id.length > 200) return bad(reply, 'invalid mandate id');
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_rev_${Date.now()}`;
  const res = await revokeMandate(id, (body.reason || 'Revoked by user principal').slice(0, 500), correlationId, `principal:${req.principal!.principalName}`);
  if (!res.ok) return reply.status(400).send(res);
  return res;
});

// ─── CARTS (buyer agent; owner only) ────────────────────────────────────────
fastify.post('/v1/carts', { preHandler: requireAgent('cart:write') }, async (req, reply) => {
  const principal = req.principal!;
  const body = (req.body || {}) as { purchase_task_id?: string };
  if (body.purchase_task_id !== undefined && !isUuid(body.purchase_task_id)) return bad(reply, 'invalid purchase_task_id');
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_${Date.now()}`;
  const idempotencyKey = req.headers['idempotency-key'] as string;

  const cached = await checkIdempotency(idempotencyKey, principal.agentId, 'POST /v1/carts', body);
  if (cached.isConflict) return reply.status(409).send({ error: cached.errorMessage });
  if (cached.isCached) return reply.status(cached.statusCode!).send(cached.responseBody);

  // The cart's merchant comes from the verified token claim, never from a request header
  const cart = await createCart(principal.agentId, correlationId, principal.merchantId, { purchaseTaskId: body.purchase_task_id });
  await saveIdempotencyResponse(idempotencyKey, 200, cart);
  return cart;
});

fastify.post('/v1/carts/:id/items', { preHandler: requireAgent('cart:write') }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = (req.body || {}) as { variant_id?: string; quantity?: number };
  if (!(await ownedCart(req, id))) return notFound(reply, 'Cart');
  if (!isUuid(body.variant_id)) return bad(reply, 'variant_id must be a UUID');
  const quantity = body.quantity ?? 1;
  if (!posInt(quantity, 100)) return bad(reply, 'quantity must be an integer from 1 to 100');
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_${Date.now()}`;
  const idempotencyKey = req.headers['idempotency-key'] as string;

  const cached = await checkIdempotency(idempotencyKey, `${req.principal!.agentId}:${id}`, `POST /v1/carts/${id}/items`, body);
  if (cached.isConflict) return reply.status(409).send({ error: cached.errorMessage });
  if (cached.isCached) return reply.status(cached.statusCode!).send(cached.responseBody);

  const res = await addToCart(id, body.variant_id, quantity, correlationId);
  if (!res.ok) return reply.status(400).send({ ok: false, code: res.code, message: res.message });
  await saveIdempotencyResponse(idempotencyKey, 200, res);
  return res;
});

fastify.delete('/v1/carts/:id/items/:variantId', { preHandler: requireAgent('cart:write') }, async (req, reply) => {
  const { id, variantId } = req.params as { id: string; variantId: string };
  if (!(await ownedCart(req, id))) return notFound(reply, 'Cart');
  if (!isUuid(variantId)) return bad(reply, 'variantId must be a UUID');
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_${Date.now()}`;
  const res = await removeFromCart(id, variantId, correlationId);
  if (!res.ok) return reply.status(400).send(res);
  return res;
});

fastify.get('/v1/carts/:id', { preHandler: requireAgent('cart:write') }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const cart = await ownedCart(req, id);
  if (!cart) return notFound(reply, 'Cart');
  return cart;
});

fastify.post('/v1/carts/:id/negotiate', { preHandler: requireAgent('negotiate:write') }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = (req.body || {}) as { variant_id?: string; proposed_price_minor?: number };
  const cart = await ownedCart(req, id);
  if (!cart) return notFound(reply, 'Cart');
  if (!isUuid(body.variant_id)) return bad(reply, 'variant_id must be a UUID');
  if (!posInt(body.proposed_price_minor, 1_000_000_000)) return bad(reply, 'proposed_price_minor must be a positive integer in paise');
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_${Date.now()}`;
  return negotiatePrice(req.principal!.agentId, body.variant_id, body.proposed_price_minor!, correlationId);
});

// ─── CHECKOUT & ORDERS ──────────────────────────────────────────────────────
fastify.post('/v1/checkouts', { preHandler: requireAgent('checkout:write'), config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
  const body = (req.body || {}) as { cart_id?: string; mandate_token_id?: string; shipping_address?: Record<string, unknown> };
  if (!body.cart_id || !(await ownedCart(req, body.cart_id))) return notFound(reply, 'Cart');
  if (body.mandate_token_id !== undefined && (typeof body.mandate_token_id !== 'string' || body.mandate_token_id.length > 200)) return bad(reply, 'invalid mandate_token_id');
  if (body.shipping_address !== undefined) {
    const a = body.shipping_address;
    const ok = a && typeof a === 'object' && Object.keys(a).length <= 10 &&
      Object.values(a).every(v => typeof v === 'string' && v.length <= 200);
    if (!ok) return bad(reply, 'shipping_address must be a small object of strings');
  }
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_${Date.now()}`;
  const idempotencyKey = req.headers['idempotency-key'] as string;

  const cached = await checkIdempotency(idempotencyKey, `${req.principal!.agentId}:${body.cart_id}`, 'POST /v1/checkouts', body);
  if (cached.isConflict) return reply.status(409).send({ error: cached.errorMessage });
  if (cached.isCached) return reply.status(cached.statusCode!).send(cached.responseBody);

  const res = await startCheckout(body.cart_id, body.shipping_address || DEFAULT_SHIPPING, correlationId, body.mandate_token_id);
  if (!res.ok) return reply.status(400).send(res);
  await saveIdempotencyResponse(idempotencyKey, 200, res);
  return res;
});

fastify.get('/v1/orders/:id', { preHandler: authenticate }, async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!isUuid(id)) return notFound(reply, 'Order');
  const owner = await pool.query('SELECT buyer_agent_id, merchant_id FROM orders WHERE id = $1', [id]);
  const p = req.principal!;
  const allowed = owner.rows.length > 0 && (
    (p.principalType === 'BUYER_AGENT' && owner.rows[0].buyer_agent_id === p.agentId) ||
    (p.principalType === 'HUMAN_PRINCIPAL' && p.scopes.includes('ops:read') && (!p.merchantId || p.merchantId === owner.rows[0].merchant_id))
  );
  if (!allowed) return notFound(reply, 'Order');
  return getOrderStatus(id);
});

// ─── RECONCILIATION (operator) ──────────────────────────────────────────────
fastify.post('/v1/payments/reconcile', { preHandler: requireOperator }, async () => runFullReconciliationCycle());

// ─── RAZORPAY WEBHOOKS (public; authenticated by HMAC signature) ────────────
fastify.post('/v1/webhooks/razorpay', async (req, reply) => {
  const signature = req.headers['x-razorpay-signature'] as string;
  const eventIdHeader = req.headers['x-razorpay-event-id'] as string;
  const rawBody: Buffer | undefined = (req as any).rawBody;
  if (!rawBody) return bad(reply, 'webhook body must be JSON');

  const verification = await verifyRazorpayWebhook(rawBody, signature, req.body as any);
  const result = await processRazorpayWebhook(
    req.body as any,
    verification.valid,
    verification.secret ?? '',
    'RAZORPAY_NETWORK',
    eventIdHeader,
    { secretVersion: verification.secretVersion, isRotationGracePeriod: verification.isRotationGracePeriod }
  );
  if (!result.ok) return reply.status(400).send(result);
  return result;
});

fastify.post('/v1/webhooks/rotate-secret', { preHandler: [requireHumanStepUpAuth] }, async (req, reply) => {
  const body = (req.body || {}) as { merchant_id?: string; new_secret_handle?: string; grace_period_hours?: number };
  if (body.merchant_id !== undefined && !isUuid(body.merchant_id)) return bad(reply, 'invalid merchant_id');
  if (typeof body.new_secret_handle !== 'string' || body.new_secret_handle.length > 300) return bad(reply, 'new_secret_handle is required');
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_${Date.now()}`;
  const res = await rotateWebhookSecret({
    merchantId: body.merchant_id,
    newSecretHandle: body.new_secret_handle,
    gracePeriodHours: Math.min(Math.max(body.grace_period_hours || 24, 1), 168),
    correlationId,
    actor: `principal:${req.principal!.principalName}`
  });
  if (!res.ok) return reply.status(400).send(res);
  return res;
});

// ─── AUDIT (operator) ───────────────────────────────────────────────────────
fastify.get('/v1/audit', { preHandler: requireOperator }, async req => {
  const query = req.query as { correlation_id?: string; limit?: string };
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
  return getAuditTrail(query.correlation_id?.slice(0, 200), limit);
});

fastify.get('/v1/audit/stream', { preHandler: requireOperator }, async (_req, reply) => {
  const clientId = `client_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  registerSSEClient(clientId, reply);
});

fastify.post('/v1/audit/checkpoint', { preHandler: requireOperator }, async () => createAuditCheckpoint());
fastify.get('/v1/audit/verify', { preHandler: requireOperator }, async () => verifyAuditLedger());
fastify.get('/v1/audit/verify-atomicity', { preHandler: requireOperator }, async () => verifyCommerceAuditAtomicity());
fastify.get('/v1/audit/verify-worm', { preHandler: requireOperator }, async () => verifyExternalWormAnchors());
fastify.post('/v1/audit/outbox/process', { preHandler: requireOperator }, async req => {
  const query = req.query as { limit?: string };
  return processAuditOutboxBatch(Math.min(Math.max(Number(query.limit) || 50, 1), 500));
});

// ─── DEMO, PLAYBOOKS & ARENA ────────────────────────────────────────────────
// Registered only when BOUND_DEMO_ROUTES=true, which config.ts refuses in production. These routes
// can fake payment outcomes and mutate demo listings, so they must never exist on a real deployment.
if (config.demoRoutes) {
  fastify.post('/internal/test/webhooks/razorpay', async req => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET || 'demo-only-webhook-secret';
    return processRazorpayWebhook(req.body as any, true, secret, 'TEST_INJECTION');
  });

  fastify.post('/v1/demo/inject-failure', async req => {
    const body = (req.body || {}) as { correlation_id?: string; notes?: string };
    return injectDemoFailure(body.correlation_id || `corr_demo_${Date.now()}`, body.notes?.slice(0, 500));
  });

  fastify.post('/v1/demo/simulate-payment-success', async (req, reply) => {
    const body = (req.body || {}) as { order_id?: string; correlation_id?: string };
    if (!isUuid(body.order_id)) return bad(reply, 'order_id must be a UUID');
    return simulateWebhookPaymentSuccess(body.order_id, body.correlation_id || `corr_${Date.now()}`);
  });

  fastify.post('/v1/demo/simulate-payment-failure', async (req, reply) => {
    const body = (req.body || {}) as { order_id?: string; correlation_id?: string };
    if (!isUuid(body.order_id)) return bad(reply, 'order_id must be a UUID');
    return simulateWebhookPaymentFailure(body.order_id, body.correlation_id || `corr_${Date.now()}`);
  });

  fastify.post('/v1/demo/run-agent', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = (req.body || {}) as { task?: string };
    const goal = (body.task || 'Find a compact espresso coffee machine under ₹5,000 and buy it.').slice(0, 500);
    const correlationId = `corr_agent_${Date.now()}`;
    try {
      const mandate = await createTaskBoundMandate({ correlationId, goal, buyerAgentId: DEMO_SANDBOX_AGENT, ceilingMinor: 1_000_000, allowedCategories: [] });
      return await runBuyerAgent(goal, {
        buyerAgentId: DEMO_SANDBOX_AGENT, mandateTokenId: mandate.mandateTokenId, correlationId,
        spendingLimitMinor: mandate.ceilingMinor, purchaseTaskId: mandate.task.id
      });
    } catch (err) {
      if (err instanceof LlmUnavailableError) return reply.status(503).send({ ok: false, error: 'LLM_UNAVAILABLE', message: err.message });
      if (err instanceof ArenaTaskError) return reply.status(422).send({ ok: false, error: 'TASK_NEEDS_HUMAN_CONFIRMATION', message: err.message, candidates: err.candidates });
      throw err;
    }
  });

  fastify.post('/v1/demo/playbook/autonomous', async () => executeAutonomousMandatePlaybook());
  fastify.post('/v1/demo/playbook/razorpay', async () => executeRazorpayInteractivePlaybook());
  fastify.post('/v1/demo/playbook/failure-recovery', async () => executeFailureRecoveryPlaybook());
  fastify.post('/v1/demo/playbook/fulfilment-compensation', async () => executeFulfilmentCompensationPlaybook());

  fastify.get('/v1/arena', async () => ({
    defaultGoal: DEFAULT_ARENA_GOAL,
    mandateTemplate: { ceilingMinor: ARENA_MANDATE_CEILING_MINOR, allowedCategories: ARENA_ALLOWED_CATEGORIES },
    payloadVariantId: PAYLOAD_VARIANT_ID,
    model: llmModel(),
    listing: await getBaitListing(),
    stats: await getArenaStats()
  }));

  fastify.get('/v1/arena/stats', async () => getArenaStats());

  // Listing texts from attacks/ with the hit rates measured in rehearsal
  fastify.get('/v1/arena/attacks', async () => listAttackPresets());

  // The same attack cart built without a model and sent through the real cart and checkout
  fastify.post('/v1/arena/direct', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = (req.body || {}) as { includePayload?: boolean };
    try {
      return await runDirectCheck({ includePayload: body.includePayload !== false });
    } catch (err) {
      if (err instanceof ArenaBusyError) return reply.status(409).send({ ok: false, error: 'ARENA_BUSY', message: err.message });
      throw err;
    }
  });

  // The Arena page calls this on load and every few minutes so the model stays in memory.
  fastify.post('/v1/arena/warm', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async () => {
    void warmModel();
    return { ok: true };
  });

  fastify.put('/v1/arena/listing', async (req, reply) => {
    const body = (req.body || {}) as { description?: string | null };
    if (body.description !== null && typeof body.description !== 'string') {
      return bad(reply, 'description must be a string, or null to restore the default');
    }
    return updateBaitListing(body.description ?? null);
  });

  // Runs the local Gemma agent once against the current listing. Steps stream live as `arena_event` on /v1/audit/stream.
  fastify.post('/v1/arena/run', { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = (req.body || {}) as { goal?: string };
    try {
      return await runArena({ goal: typeof body.goal === 'string' ? body.goal : undefined });
    } catch (err) {
      if (err instanceof ArenaBusyError) return reply.status(409).send({ ok: false, error: 'ARENA_BUSY', message: err.message });
      if (err instanceof ArenaTaskError) return reply.status(422).send({ ok: false, error: 'TASK_NEEDS_HUMAN_CONFIRMATION', message: err.message, candidates: err.candidates });
      if (err instanceof LlmUnavailableError) return reply.status(503).send({ ok: false, error: 'LLM_UNAVAILABLE', message: err.message });
      throw err;
    }
  });
}

// ─── START SERVER ───────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 4000;

export async function startServer() {
  try {
    await fastify.listen({ port: PORT, host: config.isProduction ? '0.0.0.0' : '127.0.0.1' });
    console.log(`🚀 Bound backend & dashboard live at http://localhost:${PORT}`);
    console.log('🔐 Security configuration:', JSON.stringify(configReport()));
  } catch (err) {
    console.error(err instanceof ConfigError ? `Configuration error: ${err.message}` : err);
    process.exit(1);
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  startServer();
}
