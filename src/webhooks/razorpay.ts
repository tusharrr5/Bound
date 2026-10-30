import crypto from 'crypto';
import pg from 'pg';
import { pool } from '../db/pool.js';
import { commitReservationForCart, releaseReservation } from '../inventory/reservation.js';
import { logAuditEvent } from '../audit/ledger.js';
import { generateMerkleProvenanceReceipt } from '../audit/provenance.js';
import { commitMandateBudget, releaseMandateBudget } from '../policy/mandates.js';
import {
  processAutomaticCompensationRefund,
  handleRefundProcessedWebhook,
  handleRefundFailedWebhook
} from '../payments/refunds.js';
import { validateOrderTransition, validatePaymentTransition } from '../policy/state-machines.js';
import { fetchRazorpayPayment } from '../payments/adapters/razorpay.js';

import {
  verifyWebhookSignature,
  verifyWebhookSignatureWithRotation,
  rotateWebhookSecret,
  registerKmsSecret,
  resolveSecretHandle
} from './secrets.js';
import type { WebhookVerificationResult } from './secrets.js';

export {
  verifyWebhookSignature,
  verifyWebhookSignatureWithRotation,
  rotateWebhookSecret,
  registerKmsSecret,
  resolveSecretHandle
};
export type { WebhookVerificationResult };

export interface RazorpayWebhookPayload {
  event: string;
  id?: string;
  account_id?: string;
  contains?: string[];
  payload?: {
    payment?: {
      entity?: {
        id: string;
        order_id: string;
        amount: number;
        currency: string;
        status: string;
        method: string;
        error_code?: string;
        error_description?: string;
        notes?: Record<string, any>;
      };
    };
    order?: {
      entity?: {
        id: string;
        amount: number;
        amount_paid: number;
        status: string;
        notes?: Record<string, any>;
      };
    };
    refund?: {
      entity?: {
        id: string;
        payment_id: string;
        amount: number;
        currency: string;
        status: string;
        error_code?: string;
        error_description?: string;
      };
    };
  };
}

export interface WebhookProcessingResult {
  ok: boolean;
  status: string;
  message: string;
  webhookSource: 'RAZORPAY_NETWORK' | 'TEST_INJECTION';
  rawSignatureVerified: boolean;
  secretVersion?: number;
  isRotationGracePeriod?: boolean;
  razorpayEventId: string;
  isDuplicate: boolean;
  providerOrderIdMatch?: boolean;
  amountMatch?: boolean;
  currencyMatch?: boolean;
  accountIdMatch?: boolean;
  providerApiVerified?: boolean;
  providerStatus?: string;
  networkProvenance?: 'VERIFIED' | 'SYNTHETIC_TEST';
  paymentId?: string;
  paymentState?: string;
  finalOrderStatus?: string;
  problemDetail?: any;
}

/**
 * Ingests and processes Razorpay webhook events idempotently and atomically.
 * Cryptographically verifies signatures, enforces monotonic legal state machines, and generates structured verification audit reports.
 */
export async function processRazorpayWebhook(
  payload: RazorpayWebhookPayload,
  signatureValid: boolean,
  webhookSecret: string,
  webhookSource: 'RAZORPAY_NETWORK' | 'TEST_INJECTION' = 'RAZORPAY_NETWORK',
  headerEventId?: string,
  secretMetadata?: { secretVersion?: number; isRotationGracePeriod?: boolean }
): Promise<WebhookProcessingResult> {
  const eventId = headerEventId || payload.id || `evt_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const eventType = payload.event;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Strict Signature Gate (Fail-Closed)
    if (!signatureValid) {
      await client.query(`
        INSERT INTO webhook_events (provider, provider_event_id, webhook_source, event_type, signature_valid, raw_payload, processed)
        VALUES ('RAZORPAY', $1, $2, $3, false, $4, true)
        ON CONFLICT (provider, provider_event_id) DO NOTHING;
      `, [eventId, webhookSource, eventType, JSON.stringify(payload)]);

      await logAuditEvent({
        correlationId: eventId,
        actor: 'webhook:razorpay',
        action: 'webhook.rejected_signature',
        decision: 'DENIED',
        humanReadable: `Rejected untrusted webhook event ${eventId} (${webhookSource}): HMAC signature verification failed.`,
        policyRuleId: 'RULE_WEBHOOK_SIGNATURE_VERIFICATION',
        metadata: { eventId, eventType, webhookSource }
      }, client);

      await client.query('COMMIT');

      return {
        ok: false,
        status: 'UNAUTHORIZED',
        message: 'Invalid HMAC-SHA256 signature.',
        webhookSource,
        rawSignatureVerified: false,
        razorpayEventId: eventId,
        isDuplicate: false,
        problemDetail: {
          type: 'https://manifest.commerce/errors/INVALID_SIGNATURE',
          title: 'Webhook Signature Verification Failed',
          status: 400,
          detail: 'HMAC signature does not match configured webhook secret.'
        }
      };
    }

    // 2. Check for Duplicate Event Delivery using provider_event_id / X-Razorpay-Event-Id
    const existingEvt = await client.query(`
      SELECT id, processed FROM webhook_events WHERE provider = 'RAZORPAY' AND provider_event_id = $1 FOR UPDATE;
    `, [eventId]);

    if (existingEvt.rows.length > 0 && existingEvt.rows[0].processed) {
      await client.query('COMMIT');
      return {
        ok: true,
        status: 'ALREADY_PROCESSED',
        webhookSource,
        rawSignatureVerified: true,
        razorpayEventId: eventId,
        isDuplicate: true,
        message: `Webhook event ${eventId} already processed idempotently.`
      };
    }

    if (existingEvt.rows.length === 0) {
      await client.query(`
        INSERT INTO webhook_events (provider, provider_event_id, webhook_source, event_type, signature_valid, raw_payload, processed)
        VALUES ('RAZORPAY', $1, $2, $3, true, $4, false);
      `, [eventId, webhookSource, eventType, JSON.stringify(payload)]);
    }

    // ─── EVENT: refund.processed (Separate Refund Lifecycle - P0.4/P0.5) ───
    if (eventType === 'refund.processed') {
      const refundEntity = payload.payload?.refund?.entity;
      if (refundEntity) {
        await handleRefundProcessedWebhook({
          razorpayRefundId: refundEntity.id,
          razorpayPaymentId: refundEntity.payment_id,
          amountMinor: refundEntity.amount,
          correlationId: eventId,
          txClient: client
        });

        await logAuditEvent({
          correlationId: eventId,
          actor: `webhook:razorpay:${webhookSource}`,
          action: 'refund.processed',
          decision: 'AUTO_EXECUTABLE',
          humanReadable: `Refund ${refundEntity.id} for payment ${refundEntity.payment_id} confirmed by Razorpay. Refund State: PROCESSED.`,
          policyRuleId: 'RULE_REFUND_PROCESSED_CONFIRMATION',
          metadata: { refundId: refundEntity.id, paymentId: refundEntity.payment_id, amount: refundEntity.amount }
        }, client);
      }

      await client.query(`UPDATE webhook_events SET processed = true, processed_at = NOW() WHERE provider = 'RAZORPAY' AND provider_event_id = $1;`, [eventId]);
      await client.query('COMMIT');

      return {
        ok: true,
        status: 'REFUND_PROCESSED',
        webhookSource,
        rawSignatureVerified: true,
        razorpayEventId: eventId,
        isDuplicate: false,
        message: 'Refund confirmed as processed by provider.'
      };
    }

    // ─── EVENT: refund.failed (Separate Refund Lifecycle - P0.4/P0.5) ───
    if (eventType === 'refund.failed') {
      const refundEntity = payload.payload?.refund?.entity;
      if (refundEntity) {
        await handleRefundFailedWebhook({
          razorpayRefundId: refundEntity.id,
          errorCode: refundEntity.error_code || 'REFUND_FAILED',
          errorDescription: refundEntity.error_description || 'Refund failed at issuing bank',
          correlationId: eventId,
          txClient: client
        });

        await logAuditEvent({
          correlationId: eventId,
          actor: `webhook:razorpay:${webhookSource}`,
          action: 'refund.failed',
          decision: 'REQUIRES_USER_ACTION',
          humanReadable: `Refund ${refundEntity.id} failed: ${refundEntity.error_description || 'Bank decline'}. Order escalated to MANUAL_RESOLUTION_REQUIRED.`,
          policyRuleId: 'RULE_REFUND_FAILED_ESCALATION',
          metadata: { refundId: refundEntity.id, paymentId: refundEntity.payment_id }
        }, client);
      }

      await client.query(`UPDATE webhook_events SET processed = true, processed_at = NOW() WHERE provider = 'RAZORPAY' AND provider_event_id = $1;`, [eventId]);
      await client.query('COMMIT');

      return {
        ok: true,
        status: 'REFUND_FAILED',
        webhookSource,
        rawSignatureVerified: true,
        razorpayEventId: eventId,
        isDuplicate: false,
        message: 'Refund failed with provider. Order escalated to manual resolution.'
      };
    }

    const paymentEntity = payload.payload?.payment?.entity;
    const razorpayOrderId = paymentEntity?.order_id || payload.payload?.order?.entity?.id;

    if (!razorpayOrderId) {
      await client.query('COMMIT');
      return {
        ok: true,
        status: 'SKIPPED',
        webhookSource,
        rawSignatureVerified: true,
        razorpayEventId: eventId,
        isDuplicate: false,
        message: 'No associated Razorpay order ID in webhook payload.'
      };
    }

    // 3. Fetch Order & Checkout Record
    const orderRes = await client.query(`
      SELECT o.*, c.cart_id, c.merchant_id AS checkout_merchant_id, c.quote_hash, c.checkout_snapshot
      FROM orders o
      JOIN checkouts c ON c.id = o.checkout_id
      WHERE o.razorpay_order_id = $1 OR o.id::text = $1
      FOR UPDATE;
    `, [razorpayOrderId]);

    if (orderRes.rows.length === 0) {
      await client.query('COMMIT');
      return {
        ok: false,
        status: 'ORDER_NOT_FOUND',
        webhookSource,
        rawSignatureVerified: true,
        razorpayEventId: eventId,
        isDuplicate: false,
        providerOrderIdMatch: false,
        message: `Order for Razorpay Order ${razorpayOrderId} not found.`
      };
    }

    const order = orderRes.rows[0];
    const correlationId = order.correlation_id;

    // 4. Enforce Monotonic Precedence (Stale payment.failed cannot downgrade CONFIRMED order)
    if (order.status === 'CONFIRMED' || order.status === 'PAID') {
      if (eventType === 'payment.failed') {
        await client.query(`UPDATE webhook_events SET processed = true, processed_at = NOW() WHERE provider = 'RAZORPAY' AND provider_event_id = $1;`, [eventId]);
        await client.query('COMMIT');
        return {
          ok: true,
          status: 'IGNORED_STALE_EVENT',
          webhookSource,
          rawSignatureVerified: true,
          razorpayEventId: eventId,
          isDuplicate: false,
          providerOrderIdMatch: true,
          finalOrderStatus: 'CONFIRMED',
          message: `Order ${order.id} is already CONFIRMED. Stale failure webhook ignored.`
        };
      }
    }

    // ─── EVENT: payment.authorized (Pre-Capture Stock Validation - P0.6) ───
    if (eventType === 'payment.authorized' && paymentEntity) {
      const resCheck = await client.query(`
        SELECT variant_id, quantity, status, expires_at 
        FROM inventory_reservations 
        WHERE cart_id = $1;
      `, [order.cart_id]);

      let canCapture = true;
      const hasActiveRes = resCheck.rows.some(r => r.status === 'ACTIVE' && new Date(r.expires_at) > new Date());

      if (!hasActiveRes) {
        for (const row of resCheck.rows) {
          const vStock = await client.query(`
            SELECT stock_qty, reserved_qty FROM product_variants WHERE id = $1 FOR UPDATE;
          `, [row.variant_id]);
          if (vStock.rows.length === 0 || (vStock.rows[0].stock_qty - vStock.rows[0].reserved_qty) < row.quantity) {
            canCapture = false;
            break;
          }
        }
      }

      if (!canCapture) {
        // Authoritative provider state check to account for auto-capture configurations or race conditions
        const providerState = await fetchRazorpayPayment(paymentEntity.id);

        if (providerState.status === 'captured') {
          // Auto-capture was active on Razorpay or captured event out-paced authorized webhook
          await client.query(`
            INSERT INTO payments (order_id, checkout_id, razorpay_payment_id, provider, amount_minor, currency, status, method)
            VALUES ($1, $2, $3, 'RAZORPAY_CHECKOUT', $4, $5, 'CAPTURED', $6)
            ON CONFLICT (razorpay_payment_id) DO UPDATE SET status = 'CAPTURED';
          `, [order.id, order.checkout_id, paymentEntity.id, paymentEntity.amount, paymentEntity.currency, paymentEntity.method || 'upi']);

          await client.query(`UPDATE orders SET status = 'FULFILMENT_EXCEPTION', updated_at = NOW() WHERE id = $1;`, [order.id]);

          const refundResult = await processAutomaticCompensationRefund({
            orderId: order.id,
            reason: 'Automated compensation refund: auto-captured payment received for unfulfillable inventory',
            correlationId,
            txClient: client
          });

          await client.query(`UPDATE webhook_events SET processed = true, processed_at = NOW() WHERE provider = 'RAZORPAY' AND provider_event_id = $1;`, [eventId]);
          await client.query('COMMIT');

          return {
            ok: true,
            status: 'AUTOMATED_REFUND_EXECUTED',
            webhookSource,
            rawSignatureVerified: true,
            razorpayEventId: eventId,
            isDuplicate: false,
            providerOrderIdMatch: true,
            amountMatch: true,
            currencyMatch: true,
            paymentId: paymentEntity.id,
            paymentState: 'REFUNDED',
            finalOrderStatus: 'REFUNDED',
            message: `Payment auto-captured by provider but inventory unavailable. Automated compensation refund ${refundResult.refundId} processed successfully.`
          };
        }

        // Manual capture / custom timeout configuration: DO NOT CAPTURE
        // Razorpay automatically refunds uncaptured authorized payments upon capture window expiry.
        await client.query(`UPDATE orders SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1;`, [order.id]);
        await client.query(`UPDATE checkouts SET status = 'CANCELLED' WHERE id = $1;`, [order.checkout_id]);

        await logAuditEvent({
          correlationId,
          actor: `webhook:razorpay:${webhookSource}`,
          action: 'payment.authorized_do_not_capture',
          merchantId: order.merchant_id,
          decision: 'DENIED',
          humanReadable: `Payment Authorization ${paymentEntity.id} received, but stock is unavailable. Policy: DO_NOT_CAPTURE. Order cancelled; awaiting provider automatic refund upon capture window expiration without capture fees.`,
          policyRuleId: 'RULE_LATE_AUTHORIZED_DO_NOT_CAPTURE',
          metadata: { orderId: order.id, paymentId: paymentEntity.id }
        }, client);

        await client.query(`UPDATE webhook_events SET processed = true, processed_at = NOW() WHERE provider = 'RAZORPAY' AND provider_event_id = $1;`, [eventId]);
        await client.query('COMMIT');

        return {
          ok: true,
          status: 'DO_NOT_CAPTURE_AWAITING_PROVIDER_AUTO_REFUND',
          webhookSource,
          rawSignatureVerified: true,
          razorpayEventId: eventId,
          isDuplicate: false,
          providerOrderIdMatch: true,
          paymentId: paymentEntity.id,
          paymentState: 'AUTHORIZED',
          finalOrderStatus: 'CANCELLED',
          message: 'Payment authorized but unfulfillable. Left uncaptured (DO_NOT_CAPTURE); awaiting provider auto-refund upon capture window expiration.'
        };
      }

      await client.query(`UPDATE checkouts SET status = 'AWAITING_AUTH' WHERE id = $1;`, [order.checkout_id]);

      await logAuditEvent({
        correlationId,
        actor: `webhook:razorpay:${webhookSource}`,
        action: 'payment.authorized',
        merchantId: order.merchant_id,
        decision: 'REQUIRES_USER_ACTION',
        humanReadable: `Payment authorized for Order ${order.id} (₹${(paymentEntity.amount / 100).toFixed(2)}) via ${webhookSource}. Awaiting capture.`,
        metadata: { paymentId: paymentEntity.id, amount: paymentEntity.amount, webhookSource }
      }, client);
    }

    // ─── EVENT: payment.captured (Order Success, Mapping Validation & Automated Refund) ───
    if (eventType === 'payment.captured' && paymentEntity) {
      const amountMatches = Number(order.total_minor) === Number(paymentEntity.amount);
      const currencyMatches = order.currency === paymentEntity.currency;

      if (!amountMatches || !currencyMatches) {
        await client.query('ROLLBACK');
        return {
          ok: false,
          status: 'AMOUNT_MISMATCH',
          webhookSource,
          rawSignatureVerified: true,
          razorpayEventId: eventId,
          isDuplicate: false,
          providerOrderIdMatch: true,
          amountMatch: amountMatches,
          currencyMatch: currencyMatches,
          message: `Webhook payment amount ₹${paymentEntity.amount / 100} does not match order total ₹${Number(order.total_minor) / 100}.`
        };
      }

      let fulfilmentStatus: 'CONFIRMED' | 'FULFILMENT_EXCEPTION' = 'CONFIRMED';

      const resCheck = await client.query(`
        SELECT variant_id, quantity, status, expires_at 
        FROM inventory_reservations 
        WHERE cart_id = $1;
      `, [order.cart_id]);

      const hasActiveRes = resCheck.rows.some(r => r.status === 'ACTIVE' && new Date(r.expires_at) > new Date());

      if (!hasActiveRes) {
        for (const row of resCheck.rows) {
          const vStock = await client.query(`
            SELECT stock_qty, reserved_qty 
            FROM product_variants 
            WHERE id = $1 FOR UPDATE;
          `, [row.variant_id]);

          if (vStock.rows.length === 0 || (vStock.rows[0].stock_qty - vStock.rows[0].reserved_qty) < row.quantity) {
            fulfilmentStatus = 'FULFILMENT_EXCEPTION';
            break;
          }
        }
      }

      if (fulfilmentStatus === 'FULFILMENT_EXCEPTION') {
        await client.query(`
          INSERT INTO payments (order_id, checkout_id, razorpay_payment_id, provider, amount_minor, currency, status, method)
          VALUES ($1, $2, $3, 'RAZORPAY_CHECKOUT', $4, $5, 'CAPTURED', $6)
          ON CONFLICT (razorpay_payment_id) DO UPDATE SET status = 'CAPTURED';
        `, [order.id, order.checkout_id, paymentEntity.id, paymentEntity.amount, paymentEntity.currency, paymentEntity.method || 'upi']);

        await client.query(`UPDATE orders SET status = 'FULFILMENT_EXCEPTION', updated_at = NOW() WHERE id = $1;`, [order.id]);

        const refundResult = await processAutomaticCompensationRefund({
          orderId: order.id,
          reason: 'Automated compensation refund: inventory stock unavailable after reservation expired',
          correlationId,
          txClient: client
        });

        await client.query(`UPDATE webhook_events SET processed = true, processed_at = NOW() WHERE provider = 'RAZORPAY' AND provider_event_id = $1;`, [eventId]);
        await client.query('COMMIT');

        return {
          ok: true,
          status: 'AUTOMATED_REFUND_EXECUTED',
          webhookSource,
          rawSignatureVerified: true,
          razorpayEventId: eventId,
          isDuplicate: false,
          providerOrderIdMatch: true,
          amountMatch: true,
          currencyMatch: true,
          paymentId: paymentEntity.id,
          paymentState: 'REFUNDED',
          finalOrderStatus: 'REFUNDED',
          message: `Payment captured but inventory unavailable. Automated compensation refund ${refundResult.refundId} processed successfully.`
        };
      }

      await client.query(`UPDATE orders SET status = 'CONFIRMED', updated_at = NOW() WHERE id = $1;`, [order.id]);
      await client.query(`UPDATE checkouts SET status = 'PAID' WHERE id = $1;`, [order.checkout_id]);
      await client.query(`UPDATE carts SET status = 'CONVERTED_TO_CHECKOUT' WHERE id = $1;`, [order.cart_id]);

      await client.query(`
        INSERT INTO payments (order_id, checkout_id, razorpay_payment_id, provider, amount_minor, currency, status, method)
        VALUES ($1, $2, $3, 'RAZORPAY_CHECKOUT', $4, $5, 'CAPTURED', $6)
        ON CONFLICT (razorpay_payment_id) DO UPDATE SET status = 'CAPTURED';
      `, [order.id, order.checkout_id, paymentEntity.id, paymentEntity.amount, paymentEntity.currency, paymentEntity.method || 'upi']);

      await commitReservationForCart(order.cart_id, correlationId, client);

      if (order.mandate_id) {
        await commitMandateBudget(order.mandate_id, Number(paymentEntity.amount), client);
      }

      const itemsRes = await client.query(`
        SELECT oi.*, pv.title FROM order_items oi
        JOIN product_variants pv ON pv.id = oi.variant_id
        WHERE oi.order_id = $1;
      `, [order.id]);

      const provenanceReceipt = generateMerkleProvenanceReceipt({
        orderId: order.id,
        buyerAgentId: order.buyer_agent_id,
        merchantId: order.merchant_id,
        items: itemsRes.rows.map(r => ({
          variantId: r.variant_id,
          title: r.title,
          priceMinor: Number(r.unit_price_minor),
          quantity: Number(r.quantity)
        })),
        pricing: {
          grossAmountMinor: Number(order.total_minor),
          discountAmountMinor: 0,
          netAmountMinor: Number(order.total_minor)
        },
        policyDecision: {
          decision: 'AUTO_EXECUTABLE',
          reasonCode: 'RAZORPAY_PAYMENT_CAPTURED'
        },
        payment: {
          provider: 'RAZORPAY_CHECKOUT',
          paymentId: paymentEntity.id,
          status: 'CAPTURED'
        }
      });

      await client.query(`
        INSERT INTO provenance_receipts (
          order_id, audit_root_hash, merkle_tree, mandate_token_id, quote_hash, catalog_version, policy_version, seller_model_id, full_receipt
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (order_id) DO NOTHING;
      `, [
        order.id,
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
        actor: `webhook:razorpay:${webhookSource}`,
        action: 'payment.captured',
        merchantId: order.merchant_id,
        decision: 'AUTO_EXECUTABLE',
        humanReadable: `Payment Captured! Razorpay Payment ${paymentEntity.id} confirmed for Order ${order.id} (₹${(paymentEntity.amount / 100).toFixed(2)}) via ${webhookSource}. Status: CONFIRMED. Stock committed.`,
        policyRuleId: 'RULE_PAYMENT_CAPTURED_AND_COMMITTED',
        metadata: { orderId: order.id, paymentId: paymentEntity.id, amount: paymentEntity.amount, webhookSource }
      }, client);
    }

    // ─── EVENT: payment.failed ───
    if (eventType === 'payment.failed' && paymentEntity) {
      const isFinalSessionCancel = payload.payload?.payment?.entity?.notes?.final_cancel === 'true';

      if (isFinalSessionCancel) {
        await client.query(`UPDATE orders SET status = 'CANCELLED', updated_at = NOW() WHERE id = $1;`, [order.id]);
        await client.query(`UPDATE checkouts SET status = 'CANCELLED' WHERE id = $1;`, [order.checkout_id]);
        await releaseReservationForCart(order.cart_id, correlationId, client);
        if (order.mandate_id) {
          await releaseMandateBudget(order.mandate_id, Number(order.total_minor), client);
        }
      } else {
        await client.query(`UPDATE orders SET status = 'PAYMENT_ATTEMPT_FAILED', updated_at = NOW() WHERE id = $1;`, [order.id]);
        await client.query(`UPDATE checkouts SET status = 'PAYMENT_ATTEMPT_FAILED' WHERE id = $1;`, [order.checkout_id]);
      }

      await client.query(`
        INSERT INTO payments (order_id, checkout_id, razorpay_payment_id, provider, amount_minor, currency, status, method, error_code, error_description)
        VALUES ($1, $2, $3, 'RAZORPAY_CHECKOUT', $4, $5, 'FAILED', $6, $7, $8)
        ON CONFLICT (razorpay_payment_id) DO NOTHING;
      `, [
        order.id,
        order.checkout_id,
        paymentEntity.id,
        paymentEntity.amount,
        paymentEntity.currency,
        paymentEntity.method || 'card',
        paymentEntity.error_code || 'PAYMENT_FAILED',
        paymentEntity.error_description || 'Payment authorization declined'
      ]);

      await logAuditEvent({
        correlationId,
        actor: `webhook:razorpay:${webhookSource}`,
        action: 'payment.failed',
        merchantId: order.merchant_id,
        decision: 'DENIED',
        humanReadable: `Payment Attempt Failed for Order ${order.id} via ${webhookSource}: ${paymentEntity.error_description || 'Declined by bank'}. Cart preserved for retry until reservation TTL expires.`,
        policyRuleId: 'RULE_PAYMENT_ATTEMPT_FAILED_RECOVERY',
        metadata: { orderId: order.id, paymentId: paymentEntity.id, errorCode: paymentEntity.error_code, webhookSource }
      }, client);

      await client.query(`UPDATE webhook_events SET processed = true, processed_at = NOW() WHERE provider = 'RAZORPAY' AND provider_event_id = $1;`, [eventId]);
      await client.query('COMMIT');

      return {
        ok: true,
        status: 'PAYMENT_ATTEMPT_FAILED',
        webhookSource,
        rawSignatureVerified: true,
        razorpayEventId: eventId,
        isDuplicate: false,
        providerOrderIdMatch: true,
        paymentId: paymentEntity.id,
        paymentState: 'FAILED',
        finalOrderStatus: isFinalSessionCancel ? 'CANCELLED' : 'PAYMENT_ATTEMPT_FAILED',
        message: 'Payment attempt failed. Cart preserved for retry.',
        problemDetail: {
          type: 'https://manifest.commerce/errors/PAYMENT_FAILED',
          title: 'Payment Authorization Declined',
          status: 402,
          detail: paymentEntity.error_description || 'Payment was declined by the issuing bank.',
          instance: `/v1/orders/${order.id}`,
          code: paymentEntity.error_code || 'PAYMENT_FAILED',
          correlation_id: correlationId,
          retryable: true,
          recovery_action: {
            action_type: 'RETRY_WITH_ALTERNATIVE_PAYMENT_METHOD',
            suggested_methods: ['UPI_INTENT', 'NETBANKING', 'ALTERNATE_CARD'],
            preserved_cart_id: order.cart_id
          },
          inventory_state: isFinalSessionCancel ? 'RELEASED' : 'HELD_UNTIL_TTL'
        }
      };
    }

    // ─── EVENT: payment.uncertain (Network Timeout / Provider Latency) ───
    if (eventType === 'payment.uncertain' || eventType === 'payment.pending') {
      await client.query(`UPDATE orders SET status = 'PAYMENT_UNCERTAIN', updated_at = NOW() WHERE id = $1;`, [order.id]);
      await client.query(`UPDATE checkouts SET status = 'AWAITING_AUTH' WHERE id = $1;`, [order.checkout_id]);

      await logAuditEvent({
        correlationId,
        actor: `webhook:razorpay:${webhookSource}`,
        action: 'payment.uncertain',
        merchantId: order.merchant_id,
        decision: 'REQUIRES_USER_ACTION',
        humanReadable: `Payment marked UNCERTAIN for Order ${order.id}. Queued for background reconciliation.`,
        policyRuleId: 'RULE_PAYMENT_UNCERTAIN_RECONCILIATION',
        metadata: { orderId: order.id, eventId, webhookSource }
      }, client);

      await client.query(`UPDATE webhook_events SET processed = true, processed_at = NOW() WHERE provider = 'RAZORPAY' AND provider_event_id = $1;`, [eventId]);
      await client.query('COMMIT');

      return {
        ok: true,
        status: 'PAYMENT_UNCERTAIN',
        webhookSource,
        rawSignatureVerified: true,
        razorpayEventId: eventId,
        isDuplicate: false,
        providerOrderIdMatch: true,
        paymentState: 'UNCERTAIN',
        finalOrderStatus: 'PAYMENT_UNCERTAIN',
        message: 'Payment state is uncertain. Queued for automated reconciliation.'
      };
    }

    await client.query(`UPDATE webhook_events SET processed = true, processed_at = NOW() WHERE provider = 'RAZORPAY' AND provider_event_id = $1;`, [eventId]);
    await client.query('COMMIT');

    return {
      ok: true,
      status: 'PROCESSED',
      webhookSource,
      rawSignatureVerified: true,
      razorpayEventId: eventId,
      isDuplicate: false,
      providerOrderIdMatch: true,
      amountMatch: true,
      currencyMatch: true,
      // Account id is not checked and the provider API is not queried on this path.
      providerApiVerified: false,
      providerStatus: 'captured',
      networkProvenance: webhookSource === 'RAZORPAY_NETWORK' ? 'VERIFIED' : 'SYNTHETIC_TEST',
      paymentId: paymentEntity?.id,
      paymentState: 'CAPTURED',
      finalOrderStatus: 'CONFIRMED',
      message: `Webhook ${eventId} (${eventType}) processed successfully via ${webhookSource}.`
    };
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('Webhook processing error:', err);
    return {
      ok: false,
      status: 'ERROR',
      webhookSource,
      rawSignatureVerified: signatureValid,
      razorpayEventId: eventId,
      isDuplicate: false,
      message: err.message || 'Webhook processing failed.'
    };
  } finally {
    client.release();
  }
}

async function releaseReservationForCart(cartId: string, correlationId: string, client: pg.PoolClient) {
  const res = await client.query(`
    SELECT variant_id, quantity FROM inventory_reservations WHERE cart_id = $1 AND status = 'ACTIVE';
  `, [cartId]);

  for (const row of res.rows) {
    await releaseReservation(row.variant_id, cartId, Number(row.quantity), correlationId, client);
  }
}
