import pg from 'pg';
import { pool } from '../db/pool.js';
import { logAuditEvent } from '../audit/ledger.js';
import { commitReservationForCart } from '../inventory/reservation.js';
import { generateMerkleProvenanceReceipt } from '../audit/provenance.js';
import { processAutomaticCompensationRefund } from './refunds.js';
import { fetchRazorpayRefund } from './adapters/razorpay.js';
import {
  validateRefundTransition,
  validatePaymentTransition,
  validateOrderTransition
} from '../policy/state-machines.js';
import { releaseMandateBudget } from '../policy/mandates.js';

export interface ReconciliationIncident {
  type:
    | 'PAYMENT_UNCERTAIN_RESOLVED'
    | 'REFUND_UNCERTAIN_RESOLVED'
    | 'REFUND_FAILED'
    | 'CAPTURED_WITHOUT_ORDER_RECOVERED'
    | 'FULFILMENT_EXCEPTION_ALERT'
    | 'COMPENSATION_REFUND_EXECUTED'
    | 'DEAD_LETTER_EXHAUSTION'
    | 'RECONCILIATION_FAILED';
  paymentId?: string;
  orderId?: string;
  checkoutId?: string;
  resolvedStatus: string;
  details: string;
  timestamp: string;
}

export interface ReconciliationReport {
  timestamp: string;
  uncertainProcessed: number;
  orphansProcessed: number;
  refundsProcessed: number;
  incidents: ReconciliationIncident[];
  success: boolean;
}

const MAX_RECONCILIATION_ATTEMPTS = 5;

/**
 * Calculates exponential backoff delay in milliseconds with random jitter (P1.5).
 */
function calculateBackoffMs(attempts: number): number {
  const baseDelay = 1000 * Math.pow(2, attempts); // 2s, 4s, 8s, 16s, 32s
  const jitter = Math.floor(Math.random() * 1000);
  return Math.min(baseDelay + jitter, 60000); // Capped at 1 minute
}

/**
 * P0.4 & P1.5: Reconciles payments left in PAYMENT_UNCERTAIN state with exponential backoff & dead-letter path.
 */
export async function reconcileUncertainPayments(txClient?: pg.PoolClient): Promise<ReconciliationIncident[]> {
  const runner = txClient || pool;
  const incidents: ReconciliationIncident[] = [];

  // Find checkouts/orders/payments in PAYMENT_UNCERTAIN that are ready for retry
  const uncertainRes = await runner.query(`
    SELECT COALESCE(p.id, o.id) as payment_id, o.checkout_id, o.id as order_id, 
           COALESCE(p.razorpay_payment_id, o.razorpay_order_id) as razorpay_payment_id, 
           o.total_minor as amount_minor, o.currency, 
           COALESCE(p.provider, 'RAZORPAY_CHECKOUT') as provider,
           COALESCE(p.reconciliation_attempts, c.reconciliation_attempts, 0) as reconciliation_attempts, 
           c.cart_id, o.merchant_id, o.mandate_id, o.correlation_id, c.quote_hash, c.checkout_snapshot,
           p.id as existing_payment_id
    FROM orders o
    JOIN checkouts c ON c.id = o.checkout_id
    LEFT JOIN payments p ON p.order_id = o.id
    WHERE o.status = 'PAYMENT_UNCERTAIN'
       OR (p.status = 'PAYMENT_UNCERTAIN' AND (p.next_reconciliation_attempt_at IS NULL OR p.next_reconciliation_attempt_at <= NOW()))
    FOR UPDATE OF o SKIP LOCKED;
  `);

  for (const row of uncertainRes.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const currentAttempts = Number(row.reconciliation_attempts || 0) + 1;

      // Check for Max Attempts Dead-Letter Path (P1.5)
      if (currentAttempts > MAX_RECONCILIATION_ATTEMPTS) {
        if (row.existing_payment_id) {
          await client.query(`
            UPDATE payments 
            SET status = 'PAYMENT_UNCERTAIN', 
                reconciliation_error = 'EXCEEDED_MAX_RECONCILIATION_ATTEMPTS' 
            WHERE id = $1;
          `, [row.existing_payment_id]);
        }

        if (row.order_id) {
          await client.query(`
            UPDATE orders 
            SET status = 'MANUAL_RESOLUTION_REQUIRED', updated_at = NOW() 
            WHERE id = $1;
          `, [row.order_id]);
        }

        await logAuditEvent({
          correlationId: row.correlation_id,
          actor: 'worker:reconciliation_engine',
          action: 'reconciliation.dead_letter',
          merchantId: row.merchant_id,
          decision: 'REQUIRES_USER_ACTION',
          humanReadable: `Reconciliation Worker: Payment ${row.payment_id} exceeded ${MAX_RECONCILIATION_ATTEMPTS} attempts. Moved to MANUAL_RESOLUTION_REQUIRED.`,
          policyRuleId: 'RULE_RECONCILIATION_DEAD_LETTER',
          metadata: { paymentId: row.payment_id, attempts: currentAttempts }
        }, client);

        await client.query('COMMIT');

        incidents.push({
          type: 'DEAD_LETTER_EXHAUSTION',
          paymentId: row.payment_id,
          orderId: row.order_id,
          checkoutId: row.checkout_id,
          resolvedStatus: 'MANUAL_RESOLUTION_REQUIRED',
          details: `Exceeded max retry count (${MAX_RECONCILIATION_ATTEMPTS}). Moved to manual dead-letter queue.`,
          timestamp: new Date().toISOString()
        });
        continue;
      }

      // Check Webhook Store for authoritative provider status
      const whRes = await client.query(`
        SELECT event_type FROM webhook_events 
        WHERE raw_payload->'payload'->'payment'->'entity'->>'id' = $1
           OR raw_payload->'payload'->'payment'->'entity'->>'order_id' = (SELECT razorpay_order_id FROM checkouts WHERE id = $2)
        ORDER BY created_at DESC LIMIT 1;
      `, [row.razorpay_payment_id, row.checkout_id]);

      const isAuthoritativelyCaptured = whRes.rows.length > 0 && whRes.rows[0].event_type === 'payment.captured';

      if (isAuthoritativelyCaptured || row.provider === 'MOCK_SIMULATED_RAIL') {
        // Resolve to CAPTURED and CONFIRMED (P0.4)
        if (row.existing_payment_id) {
          await client.query(`
            UPDATE payments 
            SET status = 'CAPTURED', reconciliation_attempts = $1, last_reconciliation_attempt_at = NOW() 
            WHERE id = $2;
          `, [currentAttempts, row.existing_payment_id]);
        }

        await client.query(`UPDATE checkouts SET status = 'PAID' WHERE id = $1;`, [row.checkout_id]);
        if (row.order_id) {
          await client.query(`UPDATE orders SET status = 'CONFIRMED', updated_at = NOW() WHERE id = $1;`, [row.order_id]);
        }
        await client.query(`UPDATE carts SET status = 'CONVERTED_TO_CHECKOUT' WHERE id = $1;`, [row.cart_id]);

        // Commit stock reservation
        await commitReservationForCart(row.cart_id, row.correlation_id, client);

        await logAuditEvent({
          correlationId: row.correlation_id,
          actor: 'worker:reconciliation_engine',
          action: 'reconciliation.uncertain_resolved_captured',
          merchantId: row.merchant_id,
          decision: 'AUTO_EXECUTABLE',
          humanReadable: `Reconciliation Worker: Resolved PAYMENT_UNCERTAIN to CAPTURED for Checkout ${row.checkout_id}. Order CONFIRMED and stock committed.`,
          policyRuleId: 'RULE_PAYMENT_UNCERTAIN_RECONCILIATION',
          metadata: { paymentId: row.payment_id, checkoutId: row.checkout_id, status: 'CONFIRMED' }
        }, client);

        await client.query('COMMIT');

        incidents.push({
          type: 'PAYMENT_UNCERTAIN_RESOLVED',
          paymentId: row.payment_id,
          orderId: row.order_id,
          checkoutId: row.checkout_id,
          resolvedStatus: 'CONFIRMED',
          details: 'Payment verified as captured with provider. Order confirmed and stock committed.',
          timestamp: new Date().toISOString()
        });
      } else {
        // Increment attempt counter and apply exponential backoff
        const nextAttemptDelay = calculateBackoffMs(currentAttempts);
        const nextAttemptAt = new Date(Date.now() + nextAttemptDelay);

        if (row.existing_payment_id) {
          await client.query(`
            UPDATE payments 
            SET reconciliation_attempts = $1,
                last_reconciliation_attempt_at = NOW(),
                next_reconciliation_attempt_at = $2
            WHERE id = $3;
          `, [currentAttempts, nextAttemptAt, row.existing_payment_id]);
        }

        if (row.order_id) {
          await client.query(`
            UPDATE orders 
            SET status = 'PAYMENT_ATTEMPT_FAILED', 
                updated_at = NOW() 
            WHERE id = $1;
          `, [row.order_id]);
        }

        await client.query(`
          UPDATE checkouts 
          SET status = 'PAYMENT_ATTEMPT_FAILED',
              reconciliation_attempts = $1,
              last_reconciliation_attempt_at = NOW(),
              next_reconciliation_attempt_at = $2
          WHERE id = $3;
        `, [currentAttempts, nextAttemptAt, row.checkout_id]);

        await logAuditEvent({
          correlationId: row.correlation_id,
          actor: 'worker:reconciliation_engine',
          action: 'reconciliation.uncertain_backoff_scheduled',
          merchantId: row.merchant_id,
          decision: 'REQUIRES_USER_ACTION',
          humanReadable: `Reconciliation Worker: Payment ${row.payment_id} unconfirmed. Scheduled retry #${currentAttempts + 1} at ${nextAttemptAt.toISOString()}.`,
          policyRuleId: 'RULE_PAYMENT_UNCERTAIN_RECONCILIATION',
          metadata: { paymentId: row.payment_id, currentAttempts, nextAttemptAt }
        }, client);

        await client.query('COMMIT');

        incidents.push({
          type: 'PAYMENT_UNCERTAIN_RESOLVED',
          paymentId: row.payment_id,
          orderId: row.order_id,
          checkoutId: row.checkout_id,
          resolvedStatus: 'PAYMENT_ATTEMPT_FAILED',
          details: `Payment unconfirmed with provider. Scheduled backoff retry #${currentAttempts + 1}.`,
          timestamp: new Date().toISOString()
        });
      }
    } catch (err: any) {
      await client.query('ROLLBACK');
      console.error('Error reconciling uncertain payment:', err);
    } finally {
      client.release();
    }
  }

  return incidents;
}

/**
 * P0.5: Discovers captured payments that have NO associated order record.
 * Reconstructs strictly from immutable checkout_snapshot.
 * If stock is unavailable, executes automated compensation refund (P0.5 & P0.6).
 */
export async function reconcileCapturedPaymentsWithoutOrder(txClient?: pg.PoolClient): Promise<ReconciliationIncident[]> {
  const runner = txClient || pool;
  const incidents: ReconciliationIncident[] = [];

  // Find captured payments where order_id IS NULL
  const orphanedPayments = await runner.query(`
    SELECT p.id as payment_id, p.checkout_id, p.razorpay_payment_id, p.amount_minor, p.currency, p.provider,
           c.cart_id, c.merchant_id, c.mandate_id, c.correlation_id, c.quote_hash, c.razorpay_order_id, c.checkout_snapshot
    FROM payments p
    JOIN checkouts c ON c.id = p.checkout_id
    WHERE p.status = 'CAPTURED' AND p.order_id IS NULL
    FOR UPDATE SKIP LOCKED;
  `);

  for (const pRow of orphanedPayments.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const correlationId = pRow.correlation_id || `recon_corr_${Date.now()}`;
      const rzpOrderId = pRow.razorpay_order_id || `rzp_recov_${Date.now()}`;

      // 1. Load Immutable Frozen Checkout Snapshot (P0.5: Never reconstruct from current mutable cart!)
      let snapshot = pRow.checkout_snapshot;
      if (typeof snapshot === 'string') {
        snapshot = JSON.parse(snapshot);
      }

      const buyerAgentId = snapshot?.buyer_agent_id || '22222222-2222-2222-2222-222222222222';
      const lines = snapshot?.lines || [];
      const shippingAddress = snapshot?.shipping_address || { line1: 'Auto-Reconciled Delivery', city: 'Bengaluru', country: 'IN' };

      // 2. Check Inventory Reservation & Stock Availability (P0.6: Expired reservation recovery)
      let fulfilmentStatus: 'CONFIRMED' | 'FULFILMENT_EXCEPTION' = 'CONFIRMED';

      const resCheck = await client.query(`
        SELECT variant_id, quantity, status, expires_at 
        FROM inventory_reservations 
        WHERE cart_id = $1;
      `, [pRow.cart_id]);

      const hasActiveRes = resCheck.rows.some(r => r.status === 'ACTIVE' && new Date(r.expires_at) > new Date());

      if (!hasActiveRes && lines.length > 0) {
        for (const line of lines) {
          const vStock = await client.query(`
            SELECT stock_qty, reserved_qty 
            FROM product_variants 
            WHERE id = $1 FOR UPDATE;
          `, [line.variant_id]);

          if (vStock.rows.length === 0 || (vStock.rows[0].stock_qty - vStock.rows[0].reserved_qty) < line.quantity) {
            fulfilmentStatus = 'FULFILMENT_EXCEPTION';
            break;
          }
        }
      }

      // 3. Create missing order with appropriate status
      const orderRes = await client.query(`
        INSERT INTO orders (
          checkout_id, merchant_id, buyer_agent_id, mandate_id,
          razorpay_order_id, total_minor, currency, status,
          shipping_address, correlation_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id;
      `, [
        pRow.checkout_id,
        pRow.merchant_id,
        buyerAgentId,
        pRow.mandate_id || null,
        rzpOrderId,
        pRow.amount_minor,
        pRow.currency || 'INR',
        fulfilmentStatus,
        JSON.stringify(shippingAddress),
        correlationId
      ]);

      const orderId = orderRes.rows[0].id;

      // 4. Insert order items strictly from frozen snapshot lines
      for (const line of lines) {
        await client.query(`
          INSERT INTO order_items (order_id, variant_id, quantity, unit_price_minor, cogs_minor)
          VALUES ($1, $2, $3, $4, $5);
        `, [orderId, line.variant_id, line.quantity, line.unit_price_minor, line.cogs_minor || 0]);
      }

      // 5. Link payment to recovered order
      await client.query(`
        UPDATE payments SET order_id = $1 WHERE id = $2;
      `, [orderId, pRow.payment_id]);

      // 6. Update checkout and cart status
      await client.query(`UPDATE checkouts SET status = 'PAID' WHERE id = $1;`, [pRow.checkout_id]);
      await client.query(`UPDATE carts SET status = 'CONVERTED_TO_CHECKOUT' WHERE id = $1;`, [pRow.cart_id]);

      if (fulfilmentStatus === 'CONFIRMED') {
        await commitReservationForCart(pRow.cart_id, correlationId, client);
      } else {
        // Trigger automated compensation refund immediately
        await processAutomaticCompensationRefund({
          orderId,
          reason: 'Disaster recovery: stock unavailable for orphan captured payment',
          correlationId,
          txClient: client
        });
      }

      // 7. Generate Merkle Provenance Receipt
      const provenanceReceipt = generateMerkleProvenanceReceipt({
        orderId,
        buyerAgentId,
        merchantId: pRow.merchant_id,
        items: lines.map((l: any) => ({
          variantId: l.variant_id,
          title: l.title || 'Product',
          priceMinor: Number(l.unit_price_minor),
          quantity: Number(l.quantity)
        })),
        pricing: {
          grossAmountMinor: Number(pRow.amount_minor),
          discountAmountMinor: 0,
          netAmountMinor: Number(pRow.amount_minor)
        },
        policyDecision: {
          decision: 'AUTO_EXECUTABLE',
          reasonCode: 'RECONCILIATION_ORPHAN_RECOVERED'
        },
        payment: {
          provider: pRow.provider,
          paymentId: pRow.razorpay_payment_id || `pay_recov_${orderId}`,
          status: 'CAPTURED'
        }
      });

      await client.query(`
        INSERT INTO provenance_receipts (
          order_id, audit_root_hash, merkle_tree, mandate_token_id, quote_hash, catalog_version, policy_version, seller_model_id, full_receipt
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (order_id) DO NOTHING;
      `, [
        orderId,
        provenanceReceipt.auditRootHash,
        JSON.stringify(provenanceReceipt.merkleTree),
        provenanceReceipt.mandateTokenId,
        provenanceReceipt.quoteHash,
        provenanceReceipt.catalogVersion,
        provenanceReceipt.policyVersion,
        provenanceReceipt.sellerModelId,
        JSON.stringify(provenanceReceipt)
      ]);

      await logAuditEvent({
        correlationId,
        actor: 'worker:reconciliation_engine',
        action: 'reconciliation.orphan_recovered',
        merchantId: pRow.merchant_id,
        decision: 'AUTO_EXECUTABLE',
        humanReadable: `Disaster Recovery: Reconstructed Order ${orderId} from immutable checkout snapshot for captured payment ${pRow.payment_id}. Status: ${fulfilmentStatus}.`,
        policyRuleId: 'RULE_DISASTER_RECOVERY_ORPHAN_RECONCILIATION',
        metadata: { orderId, paymentId: pRow.payment_id, status: fulfilmentStatus }
      }, client);

      await client.query('COMMIT');

      incidents.push({
        type: fulfilmentStatus === 'CONFIRMED' ? 'CAPTURED_WITHOUT_ORDER_RECOVERED' : 'COMPENSATION_REFUND_EXECUTED',
        paymentId: pRow.payment_id,
        orderId,
        checkoutId: pRow.checkout_id,
        resolvedStatus: fulfilmentStatus === 'CONFIRMED' ? 'CONFIRMED' : 'REFUNDED',
        details: `Order reconstructed strictly from immutable snapshot. Status: ${fulfilmentStatus}.`,
        timestamp: new Date().toISOString()
      });
    } catch (err: any) {
      await client.query('ROLLBACK');
      console.error('Error recovering orphaned payment:', err);
    } finally {
      client.release();
    }
  }

  return incidents;
}

/**
 * Reconciles refunds left in REFUND_UNCERTAIN or PROCESSING state with exponential backoff & dead-letter path.
 */
export async function reconcileUncertainRefunds(txClient?: pg.PoolClient): Promise<ReconciliationIncident[]> {
  const runner = txClient || pool;
  const incidents: ReconciliationIncident[] = [];

  const uncertainRefRes = await runner.query(`
    SELECT r.*, o.id as order_id, o.merchant_id, o.mandate_id, o.checkout_id,
           p.id as payment_pk, p.razorpay_payment_id
    FROM refunds r
    JOIN orders o ON o.id = r.order_id
    LEFT JOIN payments p ON p.id = r.payment_id
    WHERE r.status IN ('REFUND_UNCERTAIN', 'PROCESSING')
      AND (r.next_reconciliation_attempt_at IS NULL OR r.next_reconciliation_attempt_at <= NOW());
  `);

  for (const refRow of uncertainRefRes.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const attempts = Number(refRow.reconciliation_attempts) + 1;

      if (attempts >= MAX_RECONCILIATION_ATTEMPTS) {
        validateRefundTransition(refRow.status, 'MANUAL_RESOLUTION_REQUIRED');
        validateOrderTransition('FULFILMENT_EXCEPTION', 'MANUAL_RESOLUTION_REQUIRED');

        await client.query(`
          UPDATE refunds 
          SET status = 'MANUAL_RESOLUTION_REQUIRED', 
              reconciliation_attempts = $1,
              reconciliation_error = 'MAX_RECONCILIATION_ATTEMPTS_EXHAUSTED',
              updated_at = NOW()
          WHERE id = $2;
        `, [attempts, refRow.id]);

        await client.query(`
          UPDATE orders 
          SET status = 'MANUAL_RESOLUTION_REQUIRED', updated_at = NOW() 
          WHERE id = $1;
        `, [refRow.order_id]);

        await logAuditEvent({
          correlationId: refRow.correlation_id,
          actor: 'worker:refund_reconciliation',
          action: 'refund.dead_letter_exhaustion',
          merchantId: refRow.merchant_id,
          decision: 'REQUIRES_USER_ACTION',
          humanReadable: `Refund ${refRow.id} failed reconciliation after ${attempts} attempts. Escalated to MANUAL_RESOLUTION_REQUIRED.`,
          policyRuleId: 'RULE_REFUND_DEAD_LETTER_ESCALATION',
          metadata: { refundId: refRow.id, orderId: refRow.order_id, attempts }
        }, client);

        await client.query('COMMIT');

        incidents.push({
          type: 'DEAD_LETTER_EXHAUSTION',
          paymentId: refRow.payment_pk,
          orderId: refRow.order_id,
          checkoutId: refRow.checkout_id,
          resolvedStatus: 'MANUAL_RESOLUTION_REQUIRED',
          details: `Refund reconciliation exceeded ${MAX_RECONCILIATION_ATTEMPTS} attempts. Escalated to manual queue.`,
          timestamp: new Date().toISOString()
        });
        continue;
      }

      // Check authoritative status with provider. If the provider cannot answer, the refund stays
      // uncertain and is retried later: an unanswered query is never treated as processed.
      let pspStatus: { id: string; status: string; amount: number };
      try {
        pspStatus = await fetchRazorpayRefund(refRow.razorpay_refund_id || refRow.id, refRow.razorpay_payment_id);
      } catch (err: any) {
        await client.query(`
          UPDATE refunds SET reconciliation_attempts = $1, reconciliation_error = $2,
            next_reconciliation_attempt_at = NOW() + INTERVAL '60 seconds', updated_at = NOW()
          WHERE id = $3;
        `, [attempts, String(err?.message || err).slice(0, 300), refRow.id]);
        await client.query('COMMIT');
        incidents.push({
          type: 'RECONCILIATION_FAILED',
          paymentId: refRow.payment_pk,
          orderId: refRow.order_id,
          checkoutId: refRow.checkout_id,
          resolvedStatus: refRow.status,
          details: `Provider did not answer for refund ${refRow.id}; still ${refRow.status}, retrying later.`,
          timestamp: new Date().toISOString()
        });
        continue;
      }

      if (pspStatus.status === 'processed') {
        validateRefundTransition(refRow.status, 'PROCESSED');
        validatePaymentTransition('CAPTURED', 'REFUNDED');
        validateOrderTransition('FULFILMENT_EXCEPTION', 'REFUNDED');

        await client.query(`
          UPDATE refunds 
          SET status = 'PROCESSED', 
              razorpay_refund_id = COALESCE(razorpay_refund_id, $1),
              reconciliation_attempts = $2,
              updated_at = NOW()
          WHERE id = $3;
        `, [pspStatus.id, attempts, refRow.id]);

        if (refRow.payment_pk) {
          await client.query(`UPDATE payments SET status = 'REFUNDED' WHERE id = $1;`, [refRow.payment_pk]);
        }

        await client.query(`UPDATE orders SET status = 'REFUNDED', updated_at = NOW() WHERE id = $1;`, [refRow.order_id]);
        await client.query(`UPDATE checkouts SET status = 'CANCELLED' WHERE id = $1;`, [refRow.checkout_id]);

        if (refRow.mandate_id) {
          await releaseMandateBudget(refRow.mandate_id, Number(refRow.amount_minor), client);
        }

        await logAuditEvent({
          correlationId: refRow.correlation_id,
          actor: 'worker:refund_reconciliation',
          action: 'refund.uncertain_resolved',
          merchantId: refRow.merchant_id,
          decision: 'AUTO_EXECUTABLE',
          humanReadable: `Refund ${refRow.id} (Order ${refRow.order_id}) verified PROCESSED via provider reconciliation. Order & Payment marked REFUNDED.`,
          policyRuleId: 'RULE_REFUND_RECONCILIATION_RESOLVED',
          metadata: { refundId: refRow.id, orderId: refRow.order_id, pspRefundId: pspStatus.id }
        }, client);

        await client.query('COMMIT');

        incidents.push({
          type: 'REFUND_UNCERTAIN_RESOLVED',
          paymentId: refRow.payment_pk,
          orderId: refRow.order_id,
          checkoutId: refRow.checkout_id,
          resolvedStatus: 'REFUNDED',
          details: `Uncertain refund ${refRow.id} reconciled successfully with provider.`,
          timestamp: new Date().toISOString()
        });
      } else if (pspStatus.status === 'failed') {
        validateRefundTransition(refRow.status, 'FAILED');
        validateOrderTransition('FULFILMENT_EXCEPTION', 'MANUAL_RESOLUTION_REQUIRED');

        await client.query(`
          UPDATE refunds 
          SET status = 'FAILED', 
              reconciliation_attempts = $1,
              error_code = 'PROVIDER_REFUND_FAILED',
              error_description = 'Provider declined refund processing',
              updated_at = NOW()
          WHERE id = $2;
        `, [attempts, refRow.id]);

        await client.query(`UPDATE orders SET status = 'MANUAL_RESOLUTION_REQUIRED', updated_at = NOW() WHERE id = $1;`, [refRow.order_id]);

        await client.query('COMMIT');

        incidents.push({
          type: 'REFUND_FAILED',
          paymentId: refRow.payment_pk,
          orderId: refRow.order_id,
          checkoutId: refRow.checkout_id,
          resolvedStatus: 'MANUAL_RESOLUTION_REQUIRED',
          details: `Refund ${refRow.id} failed on provider side. Escalated to manual resolution.`,
          timestamp: new Date().toISOString()
        });
      } else {
        // Still processing on provider side: backoff with jitter
        const backoffMs = calculateBackoffMs(attempts);
        const nextAttempt = new Date(Date.now() + backoffMs);

        await client.query(`
          UPDATE refunds 
          SET status = 'PROCESSING',
              reconciliation_attempts = $1,
              last_reconciliation_attempt_at = NOW(),
              next_reconciliation_attempt_at = $2,
              updated_at = NOW()
          WHERE id = $3;
        `, [attempts, nextAttempt, refRow.id]);

        await client.query('COMMIT');
      }
    } catch (err: any) {
      await client.query('ROLLBACK');
      console.error('Error in refund reconciliation worker:', err);
    } finally {
      client.release();
    }
  }

  return incidents;
}

/**
 * Runs full reconciliation loop across uncertain payments, orphaned captured payments, and uncertain refunds.
 */
export async function runFullReconciliationCycle(): Promise<ReconciliationReport> {
  const uncertainIncidents = await reconcileUncertainPayments();
  const orphanIncidents = await reconcileCapturedPaymentsWithoutOrder();
  const refundIncidents = await reconcileUncertainRefunds();

  const allIncidents = [...uncertainIncidents, ...orphanIncidents, ...refundIncidents];

  return {
    timestamp: new Date().toISOString(),
    uncertainProcessed: uncertainIncidents.length,
    orphansProcessed: orphanIncidents.length,
    refundsProcessed: refundIncidents.length,
    incidents: allIncidents,
    success: true
  };
}
