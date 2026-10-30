import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { seedDatabase } from '../../src/db/seed.js';
import { pool } from '../../src/db/pool.js';
import { fastify } from '../../src/server.js';
import { issueAgentIdentityToken, issueHumanIdentityToken } from '../../src/middleware/auth.js';
import { loadConfig, ConfigError } from '../../src/config.js';
import { verifyWebhookSignatureWithRotation, registerKmsSecret, verifyRazorpayWebhook } from '../../src/webhooks/secrets.js';

// Exercises the real HTTP routes with fastify.inject. Demo routes and sandbox auth are off
// (vitest.config.ts), which is how a non-demo deployment runs.

const MERCHANT = '11111111-1111-1111-1111-111111111111';
const FLASK = 'FLASK-STEEL-750-SLV';
let agentA: string;
let agentB: string;
let tokenA: string;
let tokenB: string;
let flaskVariant: string;

async function newAgent() {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO buyer_agents (id, label, principal_name) VALUES ($1, 'API test agent', 'API test')`, [id]);
  return id;
}
const agentToken = (agentId: string) => issueAgentIdentityToken({ agentId, principalName: 'API test', merchantId: MERCHANT });
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  await seedDatabase();
  await fastify.ready();
  agentA = await newAgent();
  agentB = await newAgent();
  tokenA = agentToken(agentA);
  tokenB = agentToken(agentB);
  flaskVariant = (await pool.query('SELECT id FROM product_variants WHERE sku = $1', [FLASK])).rows[0].id;
});

describe('Authentication', () => {
  it('refuses requests with no credentials (no sandbox fallback)', async () => {
    const res = await fastify.inject({ method: 'POST', url: '/v1/carts', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('UNAUTHENTICATED');
  });

  it('refuses an invalid token instead of falling back to another identity', async () => {
    const res = await fastify.inject({ method: 'POST', url: '/v1/carts', headers: auth('a.b.c'), payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_TOKEN');
  });

  it('refuses the retired x-gateway-secret header with spoofed identity', async () => {
    const res = await fastify.inject({
      method: 'POST', url: '/v1/carts', payload: {},
      headers: { 'x-gateway-secret': 'trusted_internal_gateway_secret_key_xyz', 'x-buyer-agent-id': agentA }
    });
    expect(res.statusCode).toBe(401);
  });

  it('keeps public discovery public and bounded', async () => {
    expect((await fastify.inject({ method: 'GET', url: '/v1/capabilities' })).statusCode).toBe(200);
    expect((await fastify.inject({ method: 'GET', url: '/v1/catalog/search?q=flask' })).statusCode).toBe(200);
    expect((await fastify.inject({ method: 'GET', url: '/v1/catalog/search?q=flask&limit=5000' })).statusCode).toBe(400);
  });
});

describe('Demo and simulation routes are absent unless explicitly enabled', () => {
  it.each([
    ['POST', '/v1/demo/simulate-payment-success'],
    ['POST', '/v1/demo/inject-failure'],
    ['POST', '/v1/demo/run-agent'],
    ['POST', '/internal/test/webhooks/razorpay'],
    ['POST', '/v1/arena/run'],
    ['PUT', '/v1/arena/listing']
  ])('%s %s → 404', async (method, url) => {
    const res = await fastify.inject({ method: method as any, url, payload: {} });
    expect(res.statusCode).toBe(404);
  });
});

describe('Ownership', () => {
  it('lets only the owning agent read, change, negotiate or check out a cart', async () => {
    const created = await fastify.inject({ method: 'POST', url: '/v1/carts', headers: auth(tokenA), payload: {} });
    expect(created.statusCode).toBe(200);
    const cartId = created.json().cartId;

    expect((await fastify.inject({ method: 'GET', url: `/v1/carts/${cartId}`, headers: auth(tokenA) })).statusCode).toBe(200);

    for (const req of [
      { method: 'GET', url: `/v1/carts/${cartId}` },
      { method: 'POST', url: `/v1/carts/${cartId}/items`, payload: { variant_id: flaskVariant, quantity: 1 } },
      { method: 'DELETE', url: `/v1/carts/${cartId}/items/${flaskVariant}` },
      { method: 'POST', url: `/v1/carts/${cartId}/negotiate`, payload: { variant_id: flaskVariant, proposed_price_minor: 100 } },
      { method: 'POST', url: '/v1/checkouts', payload: { cart_id: cartId } }
    ]) {
      const res = await fastify.inject({ ...(req as any), headers: auth(tokenB) });
      expect(res.statusCode, `${req.method} ${req.url}`).toBe(404);
    }
  });

  it('hides another agent\'s order', async () => {
    const created = await fastify.inject({ method: 'POST', url: '/v1/carts', headers: auth(tokenA), payload: {} });
    const cartId = created.json().cartId;
    await fastify.inject({ method: 'POST', url: `/v1/carts/${cartId}/items`, headers: auth(tokenA), payload: { variant_id: flaskVariant, quantity: 1 } });
    const chk = await fastify.inject({ method: 'POST', url: '/v1/checkouts', headers: auth(tokenA), payload: { cart_id: cartId } });
    expect(chk.statusCode).toBe(200);
    const orderId = chk.json().orderId;

    expect((await fastify.inject({ method: 'GET', url: `/v1/orders/${orderId}`, headers: auth(tokenA) })).statusCode).toBe(200);
    expect((await fastify.inject({ method: 'GET', url: `/v1/orders/${orderId}`, headers: auth(tokenB) })).statusCode).toBe(404);
  });

  it('validates input shapes', async () => {
    const created = await fastify.inject({ method: 'POST', url: '/v1/carts', headers: auth(tokenA), payload: {} });
    const cartId = created.json().cartId;
    for (const payload of [{ variant_id: 'x' }, { variant_id: flaskVariant, quantity: 0 }, { variant_id: flaskVariant, quantity: 1e9 }]) {
      const res = await fastify.inject({ method: 'POST', url: `/v1/carts/${cartId}/items`, headers: auth(tokenA), payload });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('Human-only and operator routes', () => {
  it('blocks agents from delegating to themselves', async () => {
    const res = await fastify.inject({ method: 'POST', url: '/v1/agents/delegations', headers: auth(tokenA), payload: { buyer_agent_id: agentA, max_total_amount_minor: 100 } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('AGENT_CANNOT_SELF_DELEGATE');
  });

  it('never accepts a private key in a request body outside sandbox mode', async () => {
    const human = issueHumanIdentityToken({ userId: 'usr_api_test', principalName: 'API human', authLevel: 'WEBAUTHN_PASSKEY' });
    const res = await fastify.inject({
      method: 'POST', url: '/v1/mandates', headers: auth(human),
      payload: { delegation_id: crypto.randomUUID(), buyer_agent_id: agentA, merchant_id: MERCHANT, max_total_amount_minor: 1000, private_key_pem: 'x' }
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().code).toBe('CLIENT_SIDE_SIGNING_REQUIRED');
  });

  it('keeps audit and reconciliation away from agents and anonymous callers', async () => {
    expect((await fastify.inject({ method: 'GET', url: '/v1/audit' })).statusCode).toBe(401);
    expect((await fastify.inject({ method: 'GET', url: '/v1/audit', headers: auth(tokenA) })).statusCode).toBe(403);
    expect((await fastify.inject({ method: 'POST', url: '/v1/payments/reconcile', headers: auth(tokenA) })).statusCode).toBe(403);
    const ops = issueHumanIdentityToken({ userId: 'usr_ops', principalName: 'Ops', scopes: ['ops:read'] });
    expect((await fastify.inject({ method: 'GET', url: '/v1/audit/verify', headers: auth(ops) })).statusCode).toBe(200);
  });

  it('only allows configured CORS origins', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/v1/capabilities', headers: { origin: 'https://evil.example' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const ok = await fastify.inject({ method: 'GET', url: '/v1/capabilities', headers: { origin: 'http://localhost:4000' } });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:4000');
  });
});

describe('Webhook secrets are scoped to the merchant', () => {
  it('does not let merchant B\'s secret authenticate merchant A\'s events, or unknown-merchant events', async () => {
    const merchantB = crypto.randomUUID();
    await pool.query(`INSERT INTO merchants (id, name, slug, razorpay_key_id, currency) VALUES ($1, 'Merchant B', $2, 'rzp_test_b', 'INR')`, [merchantB, `mb-${merchantB.slice(0, 8)}`]);
    const secretB = crypto.randomBytes(24).toString('hex');
    registerKmsSecret('kms://test/merchant-b', secretB);
    await pool.query(`INSERT INTO webhook_secrets (merchant_id, version, secret_handle, status, valid_from) VALUES ($1, 1, 'kms://test/merchant-b', 'PRIMARY', NOW())`, [merchantB]);

    const body = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { order_id: 'order_unknown' } } } }));
    const sigB = crypto.createHmac('sha256', secretB).update(body).digest('hex');

    expect((await verifyWebhookSignatureWithRotation(body, sigB, merchantB)).valid).toBe(true);
    expect((await verifyWebhookSignatureWithRotation(body, sigB, MERCHANT)).valid).toBe(false);
    expect((await verifyWebhookSignatureWithRotation(body, sigB, undefined)).valid).toBe(false);
    expect((await verifyRazorpayWebhook(body, sigB, JSON.parse(body.toString()))).valid).toBe(false);
  });
});

describe('Production configuration fails closed', () => {
  const base = {
    NODE_ENV: 'production',
    AGENT_AUTH_SECRET: crypto.randomBytes(32).toString('hex'),
    GATEWAY_SHARED_SECRET: crypto.randomBytes(32).toString('hex'),
    RAZORPAY_KEY_ID: 'rzp_live_example',
    RAZORPAY_KEY_SECRET: crypto.randomBytes(16).toString('hex'),
    RAZORPAY_WEBHOOK_SECRET: crypto.randomBytes(16).toString('hex'),
    BOUND_CORS_ORIGINS: 'https://shop.example'
  };

  it('accepts a complete production configuration', () => {
    expect(loadConfig(base as any).isProduction).toBe(true);
  });

  it.each([
    ['missing auth secret', { AGENT_AUTH_SECRET: '' }],
    ['the old published auth secret', { AGENT_AUTH_SECRET: 'manifest_agent_jwt_auth_secret_secure_key_2026' }],
    ['a short gateway secret', { GATEWAY_SHARED_SECRET: 'short' }],
    ['sandbox auth', { BOUND_SANDBOX_AUTH: 'true' }],
    ['demo routes', { BOUND_DEMO_ROUTES: 'true' }],
    ['simulated payments', { BOUND_SIMULATED_PAYMENTS: 'true' }],
    ['no CORS allowlist', { BOUND_CORS_ORIGINS: '' }],
    ['no webhook secret', { RAZORPAY_WEBHOOK_SECRET: '' }]
  ])('refuses %s', (_label, override) => {
    expect(() => loadConfig({ ...base, ...override } as any)).toThrow(ConfigError);
  });
});
