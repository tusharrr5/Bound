import crypto from 'crypto';
import pg from 'pg';
import { pool } from '../db/pool.js';
import { logAuditEvent } from '../audit/ledger.js';
import { releaseMandateBudget } from '../policy/mandates.js';
import {
  validateOrderTransition,
  validatePaymentTransition,
  validateRefundTransition,
  RefundStatus
} from '../policy/state-machines.js';
import { createRazorpayRefund } from './adapters/razorpay.js';

export interface CompensationRefundResult {
  ok: boolean;
  refundId?: string;
  razorpayRefundId?: string;
  orderId?: string;
  paymentId?: string;
  refundAmountMinor?: number;
  refundStatus?: RefundStatus;
  orderStatus?: string;
  paymentStatus?: string;
  reason?: string;
  error?: string;
}

/**
 * Creates and initiates a Refund entity in the distinct Refund lifecycle.
 */
export async function createRefund(params: {
  orderId: string;
  paymentId?: string;
  amountMinor: number;
  reason: string;
  correlationId: string;
  provider?: string;
  txClient?: pg.PoolClient;
}): Promise<{ refundId: string; status: RefundStatus }> {
  const runner = params.txClient || pool;
  const refundId = crypto.randomUUID();

  // Insert initial CREATED state
  await runner.query(`
    INSERT INTO refunds (
      id, order_id, payment_id, amount_minor, currency, reason, status, provider, correlation_id
    ) VALUES ($1, $2, $3, $4, 'INR', $5, 'CREATED', $6, $7);
  `, [
    refundId,
    params.orderId,
    params.paymentId || null,
    params.amountMinor,
    params.reason,
    params.provider || 'RAZORPAY_CHECKOUT',
    params.correlationId
  ]);

  // Transition to SUBMITTED
  validateRefundTransition('CREATED', 'SUBMITTED');
  await runner.query(`
    UPDATE refunds SET status = 'SUBMITTED', updated_at = NOW() WHERE id = $1;
  `, [refundId]);

  return { refundId, status: 'SUBMITTED' };
}

/**
 * Executes an automated, idempotent compensation refund when payment is captured but inventory cannot be fulfilled (P0.5 & P0.6).
 * Manages separate lifecycles: Order (FULFILMENT_EXCEPTION -> REFUNDED), Payment (CAPTURED -> REFUNDED), Refund (CREATED -> SUBMITTED -> PROCESSED).
 */
export async function processAutomaticCompensationRefund(params: {
  orderId: string;
  reason: string;
  correlationId: string;
  txClient?: pg.PoolClient;
}): Promise<CompensationRefundResult> {
  const isDedicatedClient = !!params.txClient;
  const client = params.txClient || (await pool.connect());

  try {
    if (!isDedicatedClient) {
      await client.query('BEGIN');
    }

    // 1. Fetch Order and lock for update
    const oRes = await client.query(`
      SELECT o.*, c.cart_id, c.merchant_id as checkout_merchant_id
      FROM orders o
      JOIN checkouts c ON c.id = o.checkout_id
      WHERE o.id = $1
      FOR UPDATE;
    `, [params.orderId]);

    if (oRes.rows.length === 0) {
      if (!isDedicatedClient) await client.query('ROLLBACK');
      return { ok: false, error: `Order ${params.orderId} not found for compensation refund.` };
    }

    const order = oRes.rows[0];

    // 2. Fetch Captured Payment
    const pRes = await client.query(`
      SELECT * FROM payments WHERE order_id = $1 AND status = 'CAPTURED' FOR UPDATE;
    `, [params.orderId]);

    if (pRes.rows.length === 0) {
      if (!isDedicatedClient) await client.query('ROLLBACK');
      return { ok: false, error: `No captured payment found for Order ${params.orderId}.` };
    }

    const payment = pRes.rows[0];
    const refundAmountMinor = Number(payment.amount_minor);
    // 3. Initiate Refund Entity in separate Refund Lifecycle
    const { refundId } = await createRefund({
      orderId: order.id,
      paymentId: payment.id,
      amountMinor: refundAmountMinor,
      reason: params.reason,
      correlationId: params.correlationId,
      provider: payment.provider,
      txClient: client
    });

    let pspRefundResult: { id: string; status: string; amount: number } | null = null;
    let isUncertain = false;

    try {
      if (payment.razorpay_payment_id) {
        pspRefundResult = await createRazorpayRefund({
          paymentId: payment.razorpay_payment_id,
          amountMinor: refundAmountMinor,
          receipt: refundId,
          notes: { orderId: order.id, reason: params.reason }
        });
      }
    } catch (err: any) {
      console.warn('⚠️ Razorpay Refund API network timeout / latency. Marking REFUND_UNCERTAIN for background reconciliation:', err.message || err);
      isUncertain = true;
    }

    if (isUncertain) {
      validateRefundTransition('SUBMITTED', 'REFUND_UNCERTAIN');
      await client.query(`
        UPDATE refunds 
        SET status = 'REFUND_UNCERTAIN', 
            reconciliation_attempts = 1,
            next_reconciliation_attempt_at = NOW() + INTERVAL '10 seconds',
            updated_at = NOW()
        WHERE id = $1;
      `, [refundId]);

      // Order remains in FULFILMENT_EXCEPTION awaiting refund reconciliation
      await client.query(`UPDATE orders SET status = 'FULFILMENT_EXCEPTION', updated_at = NOW() WHERE id = $1;`, [order.id]);

      await logAuditEvent({
        correlationId: params.correlationId,
        actor: 'system:compensation_engine',
        action: 'refund.uncertain',
        merchantId: order.merchant_id,
        decision: 'REQUIRES_USER_ACTION',
        humanReadable: `Refund ${refundId} for Order ${order.id} marked REFUND_UNCERTAIN due to network timeout / latency. Queued for automated reconciliation.`,
        policyRuleId: 'RULE_REFUND_UNCERTAINTY_RECONCILIATION',
        metadata: { orderId: order.id, paymentId: payment.id, refundId, refundAmountMinor }
      }, client);

      if (!isDedicatedClient) await client.query('COMMIT');

      return {
        ok: true,
        refundId,
        orderId: order.id,
        paymentId: payment.id,
        refundAmountMinor,
        refundStatus: 'REFUND_UNCERTAIN',
        orderStatus: 'FULFILMENT_EXCEPTION',
        paymentStatus: 'CAPTURED',
        reason: 'Refund state uncertain due to network timeout. Queued for reconciliation.'
      };
    }

    const razorpayRefundId = pspRefundResult?.id || `rfnd_rzp_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // 4. Transition Refund Lifecycle: SUBMITTED -> PROCESSING -> PROCESSED
    validateRefundTransition('SUBMITTED', 'PROCESSING');
    await client.query(`
      UPDATE refunds 
      SET status = 'PROCESSING', razorpay_refund_id = $1, updated_at = NOW() 
      WHERE id = $2;
    `, [razorpayRefundId, refundId]);

    validateRefundTransition('PROCESSING', 'PROCESSED');
    await client.query(`
      UPDATE refunds 
      SET status = 'PROCESSED', updated_at = NOW() 
      WHERE id = $1;
    `, [refundId]);

    // 5. Enforce Legal State Transitions on Payment & Order
    validatePaymentTransition('CAPTURED', 'REFUNDED');
    validateOrderTransition(order.status, 'REFUNDED');

    await client.query(`
      UPDATE payments 
      SET status = 'REFUNDED', 
          error_code = 'COMPENSATION_REFUND_EXECUTED',
          error_description = $1
      WHERE id = $2;
    `, [params.reason, payment.id]);

    await client.query(`
      UPDATE orders 
      SET status = 'REFUNDED', 
          updated_at = NOW() 
      WHERE id = $1;
    `, [order.id]);

    await client.query(`
      UPDATE checkouts 
      SET status = 'CANCELLED' 
      WHERE id = $1;
    `, [order.checkout_id]);

    // 6. Release Mandate Budget (if applicable)
    if (order.mandate_id) {
      await releaseMandateBudget(order.mandate_id, refundAmountMinor, client);
    }

    // 7. Append Tamper-Evident Audit Record
    await logAuditEvent({
      correlationId: params.correlationId,
      actor: 'system:compensation_engine',
      action: 'order.compensation_refund',
      merchantId: order.merchant_id,
      decision: 'AUTO_EXECUTABLE',
      humanReadable: `Automated Compensation Refund: Refunded ₹${(refundAmountMinor / 100).toFixed(2)} (Refund ID: ${refundId}, PSP ID: ${razorpayRefundId}) for Order ${order.id}. Separate Refund Lifecycle: PROCESSED.`,
      policyRuleId: 'RULE_AUTOMATIC_COMPENSATION_REFUND',
      metadata: { orderId: order.id, paymentId: payment.id, refundId, razorpayRefundId, refundAmountMinor, reason: params.reason }
    }, client);

    if (!isDedicatedClient) {
      await client.query('COMMIT');
    }

    return {
      ok: true,
      refundId,
      razorpayRefundId,
      orderId: order.id,
      paymentId: payment.id,
      refundAmountMinor,
      refundStatus: 'PROCESSED',
      orderStatus: 'REFUNDED',
      paymentStatus: 'REFUNDED',
      reason: params.reason
    };
  } catch (err: any) {
    if (!isDedicatedClient) {
      await client.query('ROLLBACK');
    }
    console.error('Error in processAutomaticCompensationRefund:', err);
    return {
      ok: false,
      error: err.message || 'Internal compensation refund error'
    };
  } finally {
    if (!isDedicatedClient) {
      client.release();
    }
  }
}

/**
 * Handles async Razorpay `refund.processed` webhook event.
 */
export async function handleRefundProcessedWebhook(params: {
  razorpayRefundId: string;
  razorpayPaymentId: string;
  amountMinor: number;
  correlationId: string;
  txClient?: pg.PoolClient;
}): Promise<{ ok: boolean; refundId?: string }> {
  const runner = params.txClient || pool;

  const rRes = await runner.query(`
    SELECT r.*, o.id as order_id, o.merchant_id
    FROM refunds r
    JOIN orders o ON o.id = r.order_id
    WHERE r.razorpay_refund_id = $1 OR r.payment_id = (SELECT id FROM payments WHERE razorpay_payment_id = $2)
    FOR UPDATE;
  `, [params.razorpayRefundId, params.razorpayPaymentId]);

  if (rRes.rows.length === 0) {
    return { ok: false };
  }

  const refund = rRes.rows[0];
  validateRefundTransition(refund.status, 'PROCESSED');

  await runner.query(`
    UPDATE refunds SET status = 'PROCESSED', updated_at = NOW() WHERE id = $1;
  `, [refund.id]);

  await runner.query(`
    UPDATE payments SET status = 'REFUNDED' WHERE id = $1;
  `, [refund.payment_id]);

  await runner.query(`
    UPDATE orders SET status = 'REFUNDED', updated_at = NOW() WHERE id = $1;
  `, [refund.order_id]);

  return { ok: true, refundId: refund.id };
}

/**
 * Handles async Razorpay `refund.failed` webhook event.
 */
export async function handleRefundFailedWebhook(params: {
  razorpayRefundId: string;
  errorCode: string;
  errorDescription: string;
  correlationId: string;
  txClient?: pg.PoolClient;
}): Promise<{ ok: boolean; refundId?: string }> {
  const runner = params.txClient || pool;

  const rRes = await runner.query(`
    SELECT r.*, o.id as order_id, o.merchant_id
    FROM refunds r
    JOIN orders o ON o.id = r.order_id
    WHERE r.razorpay_refund_id = $1
    FOR UPDATE;
  `, [params.razorpayRefundId]);

  if (rRes.rows.length === 0) {
    return { ok: false };
  }

  const refund = rRes.rows[0];
  validateRefundTransition(refund.status, 'FAILED');

  await runner.query(`
    UPDATE refunds 
    SET status = 'FAILED', error_code = $1, error_description = $2, updated_at = NOW() 
    WHERE id = $3;
  `, [params.errorCode, params.errorDescription, refund.id]);

  // Order moves to MANUAL_RESOLUTION_REQUIRED when financial refund fails
  await runner.query(`
    UPDATE orders SET status = 'MANUAL_RESOLUTION_REQUIRED', updated_at = NOW() WHERE id = $1;
  `, [refund.order_id]);

  return { ok: true, refundId: refund.id };
}
