import { pool } from '../db/pool.js';
import { logAuditEvent } from '../audit/ledger.js';
import { processRazorpayWebhook } from '../webhooks/razorpay.js';

export interface DemoFailureInjection {
  correlationId: string;
  injectFailure: boolean;
  notes?: string;
}

export async function injectDemoFailure(correlationId: string, notes?: string): Promise<{ ok: boolean; session: string }> {
  await pool.query(`
    INSERT INTO demo_sessions (correlation_id, inject_failure, demo_notes)
    VALUES ($1, true, $2)
    ON CONFLICT (correlation_id) DO UPDATE SET inject_failure = true, demo_notes = EXCLUDED.demo_notes;
  `, [correlationId, notes || 'Forced payment failure injection active for live presentation']);

  await logAuditEvent({
    correlationId,
    actor: 'presenter:demo_controller',
    action: 'demo.inject_failure',
    decision: 'AUTO_EXECUTABLE',
    humanReadable: `⚠️ Forced failure injected for Session ${correlationId}. Next payment attempt will trigger card authorization decline.`,
    policyRuleId: 'RULE_DEMO_FAILURE_INJECTION',
    metadata: { correlationId, notes }
  });

  return { ok: true, session: correlationId };
}

export async function simulateWebhookPaymentFailure(orderId: string, correlationId: string) {
  const oRes = await pool.query(`
    SELECT o.*, c.cart_id
    FROM orders o
    JOIN checkouts c ON c.id = o.checkout_id
    WHERE o.id::text = $1 OR o.razorpay_order_id = $1;
  `, [orderId]);

  if (oRes.rows.length === 0) throw new Error('Order not found for failure injection');
  const order = oRes.rows[0];

  const payload = {
    event: 'payment.failed',
    id: `evt_fail_${Date.now()}`,
    payload: {
      payment: {
        entity: {
          id: `pay_declined_${Date.now()}`,
          order_id: order.razorpay_order_id,
          amount: Number(order.total_minor),
          currency: 'INR',
          status: 'failed',
          method: 'card',
          error_code: 'BAD_REQUEST_ERROR',
          error_description: 'Payment was declined by the bank due to insufficient funds (Test Mode Decline).',
          notes: { correlation_id: correlationId, cart_id: order.cart_id }
        }
      }
    }
  };

  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'demo_webhook_secret_abcde';
  return processRazorpayWebhook(payload, true, webhookSecret);
}

export async function simulateWebhookPaymentSuccess(orderId: string, correlationId: string) {
  const oRes = await pool.query(`
    SELECT o.*, c.cart_id
    FROM orders o
    JOIN checkouts c ON c.id = o.checkout_id
    WHERE o.id::text = $1 OR o.razorpay_order_id = $1;
  `, [orderId]);

  if (oRes.rows.length === 0) throw new Error('Order not found for payment capture');
  const order = oRes.rows[0];

  const payload = {
    event: 'payment.captured',
    id: `evt_cap_${Date.now()}`,
    payload: {
      payment: {
        entity: {
          id: `pay_captured_${Date.now()}`,
          order_id: order.razorpay_order_id,
          amount: Number(order.total_minor),
          currency: 'INR',
          status: 'captured',
          method: 'upi',
          notes: { correlation_id: correlationId, cart_id: order.cart_id }
        }
      }
    }
  };

  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'demo_webhook_secret_abcde';
  return processRazorpayWebhook(payload, true, webhookSecret);
}
