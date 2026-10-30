import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { pool } from './db/pool.js';
import { searchCatalog, getProductDetail } from './catalog/service.js';
import { createCart, addToCart, removeFromCart, getCart } from './cart/service.js';
import { negotiatePrice } from './negotiation/engine.js';
import { startCheckout, getOrderStatus } from './checkout/service.js';
import { processRazorpayWebhook, verifyWebhookSignature, verifyWebhookSignatureWithRotation, rotateWebhookSecret } from './webhooks/razorpay.js';
import { runFullReconciliationCycle } from './payments/reconciliation.js';
import { getAuditTrail, createAuditCheckpoint, verifyAuditLedger } from './audit/ledger.js';
import { processAuditOutboxBatch, verifyCommerceAuditAtomicity } from './audit/outbox.js';
import { verifyExternalWormAnchors } from './audit/anchoring.js';
import { registerSSEClient } from './audit/stream.js';
import { injectDemoFailure, simulateWebhookPaymentFailure, simulateWebhookPaymentSuccess } from './demo/failure-injection.js';
import { runBuyerAgent } from './agent/buyer-agent.js';
import { checkIdempotency, saveIdempotencyResponse } from './middleware/idempotency.js';
import { extractPrincipal, PrincipalContext, requireHumanStepUpAuth } from './middleware/auth.js';
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
import { runArena, runDirectCheck, getArenaStats, getBaitListing, updateBaitListing, listAttackPresets, ArenaBusyError } from './arena/service.js';
import { DEFAULT_ARENA_GOAL, ARENA_MANDATE_CEILING_MINOR, ARENA_ALLOWED_CATEGORIES, PAYLOAD_VARIANT_ID } from './arena/catalog.js';
import { llmModel, LlmUnavailableError, warmModel } from './agent/llm.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const fastify = Fastify({
  logger: false
});

// Register Plugins
await fastify.register(cors, { origin: '*' });
await fastify.register(fastifyStatic, {
  root: path.join(__dirname, '../dashboard/dist'),
  prefix: '/'
});

// Capture raw body for authentic HMAC signature verification
fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  try {
    (req as any).rawBody = body;
    const json = JSON.parse(body.toString('utf8'));
    done(null, json);
  } catch (err: any) {
    done(err, undefined);
  }
});

// ─── HEALTH & METADATA ───────────────────────────────────────────────────────
fastify.get('/health', async () => ({ status: 'UP', timestamp: new Date().toISOString() }));

// ─── DISCOVERABLE AGENT CAPABILITIES (P2.19) ────────────────────────────────
fastify.get('/v1/capabilities', async () => {
  return getMerchantCapabilities();
});

// ─── CATALOG ────────────────────────────────────────────────────────────────
fastify.get('/v1/catalog/search', async (req, reply) => {
  const query = req.query as Record<string, string>;
  const results = await searchCatalog({
    query: query.q || query.query || 'coffee',
    category: query.category,
    maxPriceMinor: query.max_price ? Number(query.max_price) : undefined,
    inStockOnly: query.in_stock === 'true',
    limit: query.limit ? Number(query.limit) : 10
  });

  if (results.error) {
    return reply.status(400).send({
      type: 'https://manifest.commerce/errors/QUERY_BUDGET_EXCEEDED',
      title: 'Query Complexity Cost Exceeded',
      status: 400,
      detail: results.error,
      costScore: results.queryCostScore
    });
  }

  return results;
});

fastify.get('/v1/catalog/products/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const product = await getProductDetail(id);
  if (!product) return reply.status(404).send({ error: 'Product not found' });
  return product;
});

// ─── AGENT DELEGATIONS & ENROLLMENT (P0.3 - HUMAN STEP-UP AUTH) ───────────────
fastify.post('/v1/agents/delegations', { preHandler: requireHumanStepUpAuth }, async (req, reply) => {
  const principal = req.principal || extractPrincipal(req.headers);
  const body = req.body as {
    principal_name?: string;
    buyer_agent_id?: string;
    merchant_id?: string;
    allowed_categories?: string[];
    max_total_amount_minor: number;
    autonomous_purchase_allowed?: boolean;
    validity_hours?: number;
  };
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_del_${Date.now()}`;

  const delegation = await createAgentDelegation({
    principalName: body.principal_name || principal.principalName,
    buyerAgentId: body.buyer_agent_id || principal.agentId,
    merchantId: body.merchant_id || principal.merchantId,
    allowedCategories: body.allowed_categories,
    maxTotalAmountMinor: body.max_total_amount_minor,
    autonomousPurchaseAllowed: body.autonomous_purchase_allowed,
    validityHours: body.validity_hours
  }, correlationId);

  return reply.status(201).send(delegation);
});

fastify.patch('/v1/agents/delegations/:id/budget', { preHandler: requireHumanStepUpAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { max_total_amount_minor: number };
  const principal = req.principal || extractPrincipal(req.headers);
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_bud_${Date.now()}`;

  const res = await updateDelegationBudget(id, body.max_total_amount_minor, correlationId, `principal:${principal.principalName}`);
  if (!res.ok) {
    return reply.status(400).send(res);
  }
  return res.delegation;
});

fastify.post('/v1/agents/delegations/:id/revoke', { preHandler: requireHumanStepUpAuth }, async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { reason?: string };
  const principal = req.principal || extractPrincipal(req.headers);
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_del_rev_${Date.now()}`;

  const res = await revokeAgentDelegation(id, body?.reason || 'Revoked by human principal with step-up verification', correlationId, `principal:${principal.principalName}`);
  if (!res.ok) {
    return reply.status(400).send(res);
  }
  return res;
});

fastify.post('/v1/mandates', async (req, reply) => {
  const principal = extractPrincipal(req.headers);
  const body = req.body as {
    delegation_id: string;
    merchant_id: string;
    max_total_amount_minor: number;
    per_txn_limit_minor?: number;
    allowed_categories?: string[];
    cart_hash?: string;
    quote_hash?: string;
    validity_hours?: number;
    private_key_pem?: string;
  };
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_man_${Date.now()}`;

  // Use provided private key or in-memory mock signer key for agent
  const privateKey = body.private_key_pem || (process.env.AGENT_TEST_PRIVATE_KEY || '');

  const result = await createPurchaseMandateFromDelegation({
    delegationId: body.delegation_id,
    buyerAgentId: principal.agentId,
    merchantId: body.merchant_id,
    maxTotalAmountMinor: body.max_total_amount_minor,
    perTxnLimitMinor: body.per_txn_limit_minor,
    allowedCategories: body.allowed_categories,
    cartHash: body.cart_hash,
    quoteHash: body.quote_hash,
    validityHours: body.validity_hours
  }, privateKey, correlationId);

  if (!result.ok) {
    return reply.status(400).send(result);
  }

  return reply.status(201).send(result);
});

fastify.get('/v1/mandates/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const details = await getMandateDetails(id);
  if (!details) return reply.status(404).send({ error: 'Mandate not found' });
  return details;
});

fastify.post('/v1/mandates/:id/revoke', async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { reason?: string };
  const principal = extractPrincipal(req.headers);
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_rev_${Date.now()}`;

  const res = await revokeMandate(id, body?.reason || 'Revoked by user principal', correlationId, `principal:${principal.principalName}`);
  if (!res.ok) {
    return reply.status(400).send(res);
  }
  return res;
});

// ─── CART (AUTHENTICATED PRINCIPAL CONTEXT - P0.2) ───────────────────────────
fastify.post('/v1/carts', async (req, reply) => {
  const principal = extractPrincipal(req.headers);
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_${Date.now()}`;
  const idempotencyKey = req.headers['idempotency-key'] as string;

  const cached = await checkIdempotency(idempotencyKey, principal.agentId, 'POST /v1/carts', req.body);
  if (cached.isConflict) return reply.status(409).send({ error: cached.errorMessage });
  if (cached.isCached) return reply.status(cached.statusCode!).send(cached.responseBody);

  const cart = await createCart(principal.agentId, correlationId, principal.merchantId);
  await saveIdempotencyResponse(idempotencyKey, 200, cart);
  return cart;
});

fastify.post('/v1/carts/:id/items', async (req, reply) => {
  const { id } = req.params as { id: string };
  const body = req.body as { variant_id: string; quantity: number };
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_${Date.now()}`;
  const idempotencyKey = req.headers['idempotency-key'] as string;

  const cached = await checkIdempotency(idempotencyKey, id, `POST /v1/carts/${id}/items`, body);
  if (cached.isConflict) return reply.status(409).send({ error: cached.errorMessage });
  if (cached.isCached) return reply.status(cached.statusCode!).send(cached.responseBody);

  const res = await addToCart(id, body.variant_id, body.quantity || 1, correlationId);
  if (!res.ok) {
    return reply.status(400).send({ ok: false, code: res.code, message: res.message });
  }

  await saveIdempotencyResponse(idempotencyKey, 200, res);
  return res;
});

fastify.delete('/v1/carts/:id/items/:variantId', async (req, reply) => {
  const { id, variantId } = req.params as { id: string; variantId: string };
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_${Date.now()}`;
  const res = await removeFromCart(id, variantId, correlationId);
  if (!res.ok) return reply.status(400).send(res);
  return res;
});

fastify.get('/v1/carts/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const cart = await getCart(id);
  if (!cart) return reply.status(404).send({ error: 'Cart not found' });
  return cart;
});

fastify.post('/v1/carts/:id/negotiate', async (req, reply) => {
  const principal = extractPrincipal(req.headers);
  const body = req.body as { variant_id: string; proposed_price_minor: number };
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_${Date.now()}`;
  const res = await negotiatePrice(principal.agentId, body.variant_id, body.proposed_price_minor, correlationId);
  return res;
});

// ─── CHECKOUT & ORDERS ──────────────────────────────────────────────────────
fastify.post('/v1/checkouts', async (req, reply) => {
  const body = req.body as {
    cart_id: string;
    mandate_token_id?: string;
    shipping_address?: Record<string, any>;
  };
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_${Date.now()}`;
  const idempotencyKey = req.headers['idempotency-key'] as string;

  const cached = await checkIdempotency(idempotencyKey, body.cart_id, 'POST /v1/checkouts', body);
  if (cached.isConflict) return reply.status(409).send({ error: cached.errorMessage });
  if (cached.isCached) return reply.status(cached.statusCode!).send(cached.responseBody);

  const res = await startCheckout(
    body.cart_id,
    body.shipping_address || {
      line1: '100 Silicon Valley, Indiranagar',
      city: 'Bengaluru',
      state: 'Karnataka',
      postal_code: '560038',
      country: 'IN'
    },
    correlationId,
    body.mandate_token_id
  );

  if (!res.ok) {
    return reply.status(400).send(res);
  }

  await saveIdempotencyResponse(idempotencyKey, 200, res);
  return res;
});

fastify.get('/v1/orders/:id', async (req, reply) => {
  const { id } = req.params as { id: string };
  const tenantMerchantId = req.headers['x-merchant-id'] as string;

  const order = await getOrderStatus(id);
  if (!order) return reply.status(404).send({ error: 'Order not found' });

  // Cross-tenant isolation
  if (tenantMerchantId) {
    const oRes = await pool.query('SELECT merchant_id FROM orders WHERE id = $1', [order.id]);
    if (oRes.rows.length > 0 && oRes.rows[0].merchant_id !== tenantMerchantId) {
      return reply.status(403).send({ error: 'Forbidden: Access denied to orders belonging to other merchant tenants.' });
    }
  }

  return order;
});

// ─── RECONCILIATION WORKER ENDPOINT ─────────────────────────────────────────
fastify.post('/v1/payments/reconcile', async () => {
  return runFullReconciliationCycle();
});

// ─── RAZORPAY WEBHOOKS (AUTHENTIC PUBLIC ROUTE) ─────────────────────────────
fastify.post('/v1/webhooks/razorpay', async (req, reply) => {
  const signature = req.headers['x-razorpay-signature'] as string;
  const eventIdHeader = req.headers['x-razorpay-event-id'] as string;
  const rawBody = (req as any).rawBody || Buffer.from(JSON.stringify(req.body));
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'demo_webhook_secret_abcde';

  // Multi-Secret Verification with Rotation & Grace Period
  const verification = await verifyWebhookSignatureWithRotation(rawBody, signature);
  
  // Strict Security Invariant: Public endpoint ALWAYS stamps authenticated source as RAZORPAY_NETWORK.
  // External clients cannot manipulate or spoof this field.
  const webhookSource = 'RAZORPAY_NETWORK';
  const result = await processRazorpayWebhook(
    req.body as any,
    verification.valid,
    webhookSecret,
    webhookSource,
    eventIdHeader,
    {
      secretVersion: verification.secretVersion,
      isRotationGracePeriod: verification.isRotationGracePeriod
    }
  );

  if (!result.ok) {
    return reply.status(400).send(result);
  }
  return result;
});

// Admin Webhook Secret Rotation (Protected by Human Step-Up WebAuthn Auth)
fastify.post('/v1/webhooks/rotate-secret', { preHandler: [requireHumanStepUpAuth] }, async (req, reply) => {
  const body = req.body as {
    merchant_id?: string;
    new_secret_handle: string;
    grace_period_hours?: number;
  };
  const correlationId = (req.headers['x-correlation-id'] as string) || `corr_${Date.now()}`;
  const res = await rotateWebhookSecret({
    merchantId: body.merchant_id,
    newSecretHandle: body.new_secret_handle,
    gracePeriodHours: body.grace_period_hours || 24,
    correlationId,
    actor: 'principal:security_officer'
  });
  if (!res.ok) return reply.status(400).send(res);
  return res;
});

// Internal Test Webhook Simulation (Non-Production Only)
if (process.env.NODE_ENV !== 'production') {
  fastify.post('/internal/test/webhooks/razorpay', async (req) => {
    const rawBody = (req as any).rawBody || Buffer.from(JSON.stringify(req.body));
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'demo_webhook_secret_abcde';
    return processRazorpayWebhook(req.body as any, true, webhookSecret, 'TEST_INJECTION');
  });
}

// ─── AUDIT TRAIL, SSE STREAM & SIGNED CHECKPOINTS ───────────────────────────
fastify.get('/v1/audit', async (req) => {
  const query = req.query as { correlation_id?: string; limit?: string };
  const trail = await getAuditTrail(query.correlation_id, query.limit ? Number(query.limit) : 50);
  return trail;
});

fastify.get('/v1/audit/stream', async (req, reply) => {
  const clientId = `client_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  registerSSEClient(clientId, reply);
});

fastify.post('/v1/audit/checkpoint', async () => {
  return createAuditCheckpoint();
});

fastify.get('/v1/audit/verify', async () => {
  return verifyAuditLedger();
});

fastify.get('/v1/audit/verify-atomicity', async () => {
  return verifyCommerceAuditAtomicity();
});

fastify.get('/v1/audit/verify-worm', async () => {
  return verifyExternalWormAnchors();
});

fastify.post('/v1/audit/outbox/process', async (req) => {
  const query = req.query as { limit?: string };
  return processAuditOutboxBatch(query.limit ? Number(query.limit) : 50);
});

// ─── DEMO CONTROLS & ADVERSARIAL ATTACKS ────────────────────────────────────
fastify.post('/v1/demo/inject-failure', async (req) => {
  const body = req.body as { correlation_id?: string; notes?: string };
  const correlationId = body.correlation_id || `corr_demo_${Date.now()}`;
  return injectDemoFailure(correlationId, body.notes);
});

fastify.post('/v1/demo/simulate-payment-success', async (req) => {
  const body = req.body as { order_id: string; correlation_id?: string };
  return simulateWebhookPaymentSuccess(body.order_id, body.correlation_id || `corr_${Date.now()}`);
});

fastify.post('/v1/demo/simulate-payment-failure', async (req) => {
  const body = req.body as { order_id: string; correlation_id?: string };
  return simulateWebhookPaymentFailure(body.order_id, body.correlation_id || `corr_${Date.now()}`);
});

fastify.post('/v1/demo/run-agent', async (req, reply) => {
  const body = (req.body || {}) as { task?: string };
  const task = body.task || 'Find a compact black coffee machine under ₹5,000, negotiate best discount, and buy with active mandate.';
  try {
    return await runBuyerAgent(task);
  } catch (err) {
    if (err instanceof LlmUnavailableError) {
      return reply.status(503).send({ ok: false, error: 'LLM_UNAVAILABLE', message: err.message });
    }
    throw err;
  }
});

fastify.post('/v1/demo/playbook/autonomous', async () => {
  return executeAutonomousMandatePlaybook();
});

fastify.post('/v1/demo/playbook/razorpay', async () => {
  return executeRazorpayInteractivePlaybook();
});

fastify.post('/v1/demo/playbook/failure-recovery', async () => {
  return executeFailureRecoveryPlaybook();
});

fastify.post('/v1/demo/playbook/fulfilment-compensation', async () => {
  return executeFulfilmentCompensationPlaybook();
});

// ─── ARENA: LIVE PROMPT-INJECTION DEMO ──────────────────────────────────────
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

// The same over-limit cart sent straight to checkout with no model involved
fastify.post('/v1/arena/direct', async (req, reply) => {
  const body = (req.body || {}) as { includePayload?: boolean };
  try {
    return await runDirectCheck({ includePayload: body.includePayload });
  } catch (err) {
    if (err instanceof ArenaBusyError) {
      return reply.status(409).send({ ok: false, error: 'ARENA_BUSY', message: err.message });
    }
    throw err;
  }
});

// The Arena page calls this on load and every few minutes so the model stays in memory.
fastify.post('/v1/arena/warm', async () => {
  void warmModel();
  return { ok: true };
});

fastify.put('/v1/arena/listing', async (req, reply) => {
  const body = (req.body || {}) as { description?: string | null };
  if (body.description !== null && typeof body.description !== 'string') {
    return reply.status(400).send({ ok: false, error: 'description must be a string, or null to restore the default' });
  }
  return updateBaitListing(body.description);
});

// Runs the local Gemma agent once against the current listing. Steps stream live as `arena_event` on /v1/audit/stream.
fastify.post('/v1/arena/run', async (req, reply) => {
  const body = (req.body || {}) as { goal?: string };
  try {
    return await runArena({ goal: body.goal });
  } catch (err) {
    if (err instanceof ArenaBusyError) {
      return reply.status(409).send({ ok: false, error: 'ARENA_BUSY', message: err.message });
    }
    if (err instanceof LlmUnavailableError) {
      return reply.status(503).send({ ok: false, error: 'LLM_UNAVAILABLE', message: err.message });
    }
    throw err;
  }
});

// ─── START SERVER ───────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 4000;

export async function startServer() {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🚀 Bound backend & dashboard live at http://localhost:${PORT}`);
    console.log(`📡 SSE Audit Stream available at http://localhost:${PORT}/v1/audit/stream`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  startServer();
}
