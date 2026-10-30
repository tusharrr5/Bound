import Razorpay from 'razorpay';
import { config } from '../../config.js';

/**
 * The ONLY file permitted to import or instantiate the Razorpay SDK.
 *
 * Three modes, chosen once:
 * - razorpay:     real keys are configured. Every provider error is thrown as a
 *                 PaymentProviderError; an error is never reported as authorized, captured
 *                 or processed.
 * - simulated:    no keys and BOUND_SIMULATED_PAYMENTS=true (refused in production). Returns
 *                 synthetic results marked `simulated: true`, with ids prefixed `order_sim_`,
 *                 `rfnd_sim_`, so they can never be mistaken for provider records.
 * - unconfigured: no keys and no simulation. Every call fails.
 */

export class PaymentProviderError extends Error {
  constructor(
    /** REJECTED: the provider answered no. UNAVAILABLE: no answer, outcome unknown. NOT_CONFIGURED: no keys. */
    public kind: 'REJECTED' | 'UNAVAILABLE' | 'NOT_CONFIGURED',
    message: string
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}

const isRealKey = (v?: string) => !!v && !/your_|manifest2026|demo_secret/i.test(v);
const keysConfigured = isRealKey(process.env.RAZORPAY_KEY_ID) && isRealKey(process.env.RAZORPAY_KEY_SECRET);

export const razorpayMode: 'razorpay' | 'simulated' | 'unconfigured' =
  keysConfigured ? 'razorpay' : config.simulatedPayments ? 'simulated' : 'unconfigured';

const razorpay = keysConfigured
  ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID!, key_secret: process.env.RAZORPAY_KEY_SECRET! })
  : null;

function client(): Razorpay {
  if (!razorpay) throw new PaymentProviderError('NOT_CONFIGURED', 'Razorpay keys are not configured.');
  return razorpay;
}

/** Maps an SDK error to rejected (4xx: the provider decided) or unavailable (anything else: unknown). */
function providerError(op: string, err: any): PaymentProviderError {
  const status = Number(err?.statusCode ?? err?.status);
  const detail = err?.error?.description || err?.message || String(err);
  return new PaymentProviderError(status >= 400 && status < 500 ? 'REJECTED' : 'UNAVAILABLE', `Razorpay ${op} failed: ${detail}`);
}

const simId = (prefix: string) => `${prefix}_sim_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

export interface CreateRazorpayOrderParams {
  amountMinor: number;
  currency?: string;
  receipt?: string;
  notes?: Record<string, any>;
}

export interface RazorpayOrderResult {
  id: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  receipt: string;
  checkoutUrl?: string;
  /** True when no provider was called. */
  simulated?: boolean;
}

export async function createRazorpayOrder(params: CreateRazorpayOrderParams): Promise<RazorpayOrderResult> {
  const currency = params.currency || 'INR';
  const receipt = params.receipt || `rcpt_${Date.now()}`;
  if (razorpayMode === 'simulated') {
    const id = simId('order');
    return { id, orderId: id, amountMinor: params.amountMinor, currency, receipt, checkoutUrl: `/checkout/hosted/${id}`, simulated: true };
  }
  try {
    const order = await client().orders.create({ amount: params.amountMinor, currency, receipt, notes: params.notes || {} });
    return {
      id: order.id,
      orderId: order.id,
      amountMinor: Number(order.amount),
      currency: order.currency,
      receipt: order.receipt || receipt,
      checkoutUrl: `/checkout/hosted/${order.id}`
    };
  } catch (err) {
    throw err instanceof PaymentProviderError ? err : providerError('order creation', err);
  }
}

/**
 * Authoritatively fetches current payment status from Razorpay. Throws if the provider cannot
 * answer: callers must treat that as unknown, never as authorized.
 */
export async function fetchRazorpayPayment(paymentId: string): Promise<{ id: string; status: string; amount: number; currency: string; simulated?: boolean }> {
  if (razorpayMode === 'simulated') {
    // The simulated provider never auto-captures: a payment stays authorized until captured
    return { id: paymentId, status: 'authorized', amount: 0, currency: 'INR', simulated: true };
  }
  try {
    const payment = await client().payments.fetch(paymentId);
    return { id: payment.id, status: payment.status, amount: Number(payment.amount), currency: payment.currency };
  } catch (err) {
    throw err instanceof PaymentProviderError ? err : providerError('payment fetch', err);
  }
}

/** Captures an authorized payment. A failure throws; it is never reported as captured. */
export async function captureRazorpayPayment(paymentId: string, amountMinor: number, currency: string = 'INR'): Promise<{ id: string; status: string; simulated?: boolean }> {
  if (razorpayMode === 'simulated') return { id: paymentId, status: 'captured', simulated: true };
  try {
    const payment = await client().payments.capture(paymentId, amountMinor, currency);
    return { id: payment.id, status: payment.status };
  } catch (err) {
    throw err instanceof PaymentProviderError ? err : providerError('capture', err);
  }
}

/** Requests a refund. A failure throws (callers mark the refund uncertain); it is never reported as processed. */
export async function createRazorpayRefund(params: {
  paymentId: string;
  amountMinor: number;
  receipt?: string;
  notes?: Record<string, any>;
}): Promise<{ id: string; status: string; amount: number; simulated?: boolean }> {
  if (razorpayMode === 'simulated') {
    return { id: simId('rfnd'), status: 'processed', amount: params.amountMinor, simulated: true };
  }
  try {
    const refund = await (client().payments as any).refund(params.paymentId, {
      amount: params.amountMinor,
      receipt: params.receipt || `rcpt_rfnd_${Date.now()}`,
      notes: params.notes || {}
    });
    if (!refund?.id || !refund?.status) throw new PaymentProviderError('UNAVAILABLE', 'Razorpay refund response had no id or status.');
    return { id: refund.id, status: refund.status, amount: Number(refund.amount) };
  } catch (err) {
    throw err instanceof PaymentProviderError ? err : providerError('refund', err);
  }
}

/** Fetches a refund's status for reconciliation. Throws if the provider cannot answer. */
export async function fetchRazorpayRefund(refundId: string, paymentId?: string): Promise<{ id: string; status: string; amount: number; simulated?: boolean }> {
  if (razorpayMode === 'simulated') return { id: refundId, status: 'processed', amount: 0, simulated: true };
  try {
    const api = client() as any;
    const refund = paymentId && api.payments.fetchRefund
      ? await api.payments.fetchRefund(paymentId, refundId)
      : await api.refunds?.fetch(refundId);
    if (!refund?.id || !refund?.status) throw new PaymentProviderError('UNAVAILABLE', 'Razorpay refund response had no id or status.');
    return { id: refund.id, status: refund.status, amount: Number(refund.amount) };
  } catch (err) {
    throw err instanceof PaymentProviderError ? err : providerError('refund fetch', err);
  }
}
