import { describe, it, expect, vi, afterEach } from 'vitest';

// Provider failures must never become success. The Razorpay SDK is mocked so these tests never
// touch the network; each scenario loads the adapter fresh under a specific configuration.

const ENV_KEYS = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'BOUND_SIMULATED_PAYMENTS'] as const;
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  vi.doUnmock('razorpay');
  vi.resetModules();
});

async function loadAdapter(env: Partial<Record<(typeof ENV_KEYS)[number], string>>, sdkError?: unknown) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  vi.resetModules();
  if (sdkError !== undefined) {
    const fail = () => Promise.reject(sdkError);
    vi.doMock('razorpay', () => ({
      default: class {
        orders = { create: fail };
        payments = { fetch: fail, capture: fail, refund: fail, fetchRefund: fail };
        refunds = { fetch: fail };
      }
    }));
  }
  return import('../../src/payments/adapters/razorpay.js');
}

const REAL_LOOKING_KEYS = { RAZORPAY_KEY_ID: 'rzp_test_A1b2C3d4E5f6G7', RAZORPAY_KEY_SECRET: 'q9w8e7r6t5y4u3i2o1p0' };

describe('Razorpay adapter with real keys never reports a failure as success', () => {
  it.each([
    ['network failure', new Error('ETIMEDOUT'), 'UNAVAILABLE'],
    ['provider rejection', { statusCode: 400, error: { description: 'The id provided does not exist' } }, 'REJECTED'],
    ['provider outage', { statusCode: 503 }, 'UNAVAILABLE']
  ])('%s → PaymentProviderError(%s) from every operation', async (_label, sdkError, kind) => {
    const a = await loadAdapter(REAL_LOOKING_KEYS, sdkError);
    expect(a.razorpayMode).toBe('razorpay');
    for (const call of [
      () => a.createRazorpayOrder({ amountMinor: 1000 }),
      () => a.fetchRazorpayPayment('pay_x'),
      () => a.captureRazorpayPayment('pay_x', 1000),
      () => a.createRazorpayRefund({ paymentId: 'pay_x', amountMinor: 1000 }),
      () => a.fetchRazorpayRefund('rfnd_x', 'pay_x')
    ]) {
      await expect(call()).rejects.toMatchObject({ name: 'PaymentProviderError', kind });
    }
  });
});

describe('Without keys', () => {
  it('refuses every operation unless simulation is explicitly enabled', async () => {
    const a = await loadAdapter({});
    expect(a.razorpayMode).toBe('unconfigured');
    await expect(a.createRazorpayOrder({ amountMinor: 1000 })).rejects.toMatchObject({ kind: 'NOT_CONFIGURED' });
    await expect(a.captureRazorpayPayment('pay_x', 1000)).rejects.toMatchObject({ kind: 'NOT_CONFIGURED' });
    await expect(a.createRazorpayRefund({ paymentId: 'pay_x', amountMinor: 1000 })).rejects.toMatchObject({ kind: 'NOT_CONFIGURED' });
  });

  it('labels simulated results so they cannot pass for provider records', async () => {
    const a = await loadAdapter({ BOUND_SIMULATED_PAYMENTS: 'true' });
    expect(a.razorpayMode).toBe('simulated');
    const order = await a.createRazorpayOrder({ amountMinor: 1000 });
    expect(order.simulated).toBe(true);
    expect(order.id).toMatch(/^order_sim_/);
    const refund = await a.createRazorpayRefund({ paymentId: 'pay_x', amountMinor: 500 });
    expect(refund).toMatchObject({ simulated: true });
    expect(refund.id).toMatch(/^rfnd_sim_/);
  });

  it('treats placeholder keys from .env.example as no keys', async () => {
    const a = await loadAdapter({ RAZORPAY_KEY_ID: 'rzp_test_your_key_id', RAZORPAY_KEY_SECRET: 'your_key_secret' });
    expect(a.razorpayMode).toBe('unconfigured');
  });
});
