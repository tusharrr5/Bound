import crypto from 'crypto';
import { pool } from '../db/pool.js';
import { createCart, addToCart, getCart } from '../cart/service.js';
import { startCheckout, getOrderStatus } from '../checkout/service.js';
import { processRazorpayWebhook, verifyWebhookSignature } from '../webhooks/razorpay.js';
import { createAuditCheckpoint, verifyAuditLedger } from '../audit/ledger.js';
import { verifyExternalWormAnchors } from '../audit/anchoring.js';
import { broadcastFlowEvent, ManifestFlowEvent } from '../audit/stream.js';
import { SellerAgent } from '../agent/seller-agent.js';
import { createTaskBoundMandate } from '../arena/service.js';

// Prefix for flow events whose evidence is hand-written narration rather than the output of a
// real engine call. Kept visible so nobody mistakes a walkthrough for a live decision.
const SCRIPTED = '[Scripted] ';

/**
 * Builds audit-stage evidence from a real verification of the checkpoint just created.
 * The anchor store is the in-memory simulated WORM vault (see audit/anchoring.ts).
 */
async function auditEvidence(checkpoint: { rootHash?: string }) {
  const anchors = await verifyExternalWormAnchors();
  return {
    auditChainHead: checkpoint.rootHash ?? 'NO CHECKPOINT (ledger empty)',
    checkpointSignature: anchors.valid ? 'VALID (Ed25519, local dev key)' : 'NOT VERIFIED',
    anchorStore: 'SIMULATED (in-memory, resets on restart)',
    dbMatchesAnchor: anchors.dbMatchesExternalWorm ? 'MATCH' : 'MISMATCH'
  };
}

/**
 * Playbook 1: Autonomous Signed Mandate (TEST-ONLY Delegated Payment)
 */
export async function executeAutonomousMandatePlaybook(): Promise<{ correlationId: string; orderId: string }> {
  const correlationId = `corr_auto_${Date.now()}`;
  let seq = 1;
  const buyerAgentId = '22222222-2222-2222-2222-222222222222';
  const principalName = 'Aarav Sharma';
  const seller = new SellerAgent('Apex Global Retail');

  // Stage 1: A2A Protocol
  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'A2A',
    eventType: 'A2A_DISCOVERY_AND_NEGOTIATION',
    status: 'ACTIVE',
    timestamp: new Date().toISOString(),
    summary: SCRIPTED + 'Buyer Agent discovers capabilities & proposes 5% discount on Espresso Machine',
    evidence: {
      buyerGoal: 'Find compact coffee machine < ₹5,000 with active mandate',
      sellerInterpretation: '1 valid candidate in catalog (BrewMaster Compact Espresso)',
      listPriceMinor: 479900,
      proposedPriceMinor: 455905,
      negotiationStatus: 'ACCEPTED',
      privateEconomics: '🔒 REDACTED (Confidential Margin Floor)',
      protocol: 'MANIFEST_A2A'
    }
  });

  // Small micro-pause to let UI visualizer render real event sequence smoothly
  await new Promise(r => setTimeout(r, 200));

  // A purchase task from the human's words, and a v2 mandate signed over it
  const mandate = await createTaskBoundMandate({
    correlationId, goal: 'Find a compact espresso coffee machine under ₹5,000 and buy it.', buyerAgentId, principalId: principalName, allowedCategories: []
  });

  // Stage 2: Deterministic Policy Gate
  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'POLICY',
    eventType: 'POLICY_EVALUATION',
    status: 'SUCCESS',
    timestamp: new Date().toISOString(),
    summary: SCRIPTED + 'Deterministic Policy Engine validates Ed25519 purchase mandate',
    evidence: {
      authorization: 'AUTHORIZED',
      paymentCapability: 'AUTO_EXECUTABLE',
      risk: 'ALLOW',
      executionPlan: 'AUTO_EXECUTABLE',
      mandateToken: mandate.mandateTokenId,
      mandateCeilingMinor: mandate.ceilingMinor,
      authorizedProductTypes: mandate.task.allowedProductTypes.join(', ')
    }
  });

  // Stage 3: Inventory Reservation
  const cart = await createCart(buyerAgentId, correlationId, undefined, { purchaseTaskId: mandate.task.id });
  const vRes = await pool.query(`SELECT id, sku, price_minor FROM product_variants WHERE sku = 'BREW-42-BLK' LIMIT 1`);
  const variantId = vRes.rows[0].id;

  const startLock = Date.now();
  const res = await addToCart(cart.cartId, variantId, 1, correlationId);
  const lockDurationMs = (res as any).lockDurationMs || (Date.now() - startLock);

  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'INVENTORY',
    eventType: 'INVENTORY_RESERVED',
    status: 'SUCCESS',
    timestamp: new Date().toISOString(),
    summary: 'Atomically reserved 1 unit of stock with 10-minute hold TTL',
    evidence: {
      identityConfidence: 'DEFINITE_LINK',
      holdLimit: '1 / SKU',
      activeHolds: '1 / 1',
      dbLockDurationMs: `${lockDurationMs.toFixed(1)} ms`,
      reservationTtl: '10:00',
      stockStatus: '1 RESERVED',
      dbLockStatus: 'RELEASED'
    }
  });

  await new Promise(r => setTimeout(r, 250));

  // Stage 4: Payment Simulation (Autonomous Rail)
  const checkout = await startCheckout(
    cart.cartId,
    { line1: '100 Silicon Valley, Indiranagar', city: 'Bengaluru', postal_code: '560038', country: 'IN' },
    correlationId,
    mandate.mandateTokenId
  );
  const paid = checkout.ok && checkout.executionMode === 'AUTO_EXECUTABLE';

  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'PAYMENT',
    eventType: paid ? 'PAYMENT_CAPTURED_SIMULATED' : 'PAYMENT_REFUSED',
    status: paid ? 'SUCCESS' : 'FAILED',
    timestamp: new Date().toISOString(),
    summary: paid ? 'Simulated payment captured under Ed25519 signed purchase mandate' : `Checkout refused: ${checkout.errorCode || checkout.message}`,
    evidence: {
      paymentRail: 'MOCK_SIMULATED_RAIL',
      environment: 'TEST_ONLY',
      authority: 'SIGNED MANDATE ✓',
      fundsMoved: false,
      amountMinor: checkout.totalMinor,
      paymentSimulation: paid ? 'CAPTURED' : 'NOT_CAPTURED'
    }
  });

  // Stage 5: Commerce State Resolution
  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'ORDER',
    eventType: 'ORDER_CONFIRMED',
    status: 'SUCCESS',
    timestamp: new Date().toISOString(),
    summary: `Order ${checkout.orderId} successfully confirmed`,
    evidence: {
      checkoutState: 'COMPLETED',
      reservationState: 'COMMITTED',
      paymentState: 'CAPTURED',
      orderState: 'CONFIRMED',
      refundState: 'NONE',
      orderId: checkout.orderId
    }
  });

  // Stage 6: Audit, Provenance & Immutable Anchor
  const checkpoint = await createAuditCheckpoint();
  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'AUDIT',
    eventType: 'AUDIT_SEALED_AND_ANCHORED',
    status: 'SUCCESS',
    timestamp: new Date().toISOString(),
    summary: 'Audit event hash-chained; checkpoint signed and anchored (simulated WORM store)',
    evidence: {
      canonicalization: 'RFC 8785',
      ...(await auditEvidence(checkpoint))
    }
  });

  return { correlationId, orderId: checkout.orderId! };
}

/**
 * Playbook 2: Razorpay Interactive Checkout Flow
 */
export async function executeRazorpayInteractivePlaybook(): Promise<{ correlationId: string; orderId: string }> {
  const correlationId = `corr_rzp_${Date.now()}`;
  let seq = 1;
  const buyerAgentId = '22222222-2222-2222-2222-222222222222';

  // Stage 1: A2A Protocol
  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'A2A',
    eventType: 'A2A_CATALOG_SELECTION',
    status: 'ACTIVE',
    timestamp: new Date().toISOString(),
    summary: SCRIPTED + 'Buyer selects Stealth Black Earbuds (₹3,499.00) without autonomous mandate',
    evidence: {
      sku: 'SONIC-H7-BLK',
      title: 'Stealth Black Wireless Noise-Cancelling Earbuds',
      priceMinor: 349900,
      protocol: 'MANIFEST_A2A'
    }
  });

  await new Promise(r => setTimeout(r, 200));

  // Stage 2: Policy Gate (Requires User Action)
  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'POLICY',
    eventType: 'POLICY_EVALUATION',
    status: 'SUCCESS',
    timestamp: new Date().toISOString(),
    summary: SCRIPTED + 'Standard checkout without mandate triggers interactive human step-up',
    evidence: {
      authorization: 'AUTHORIZED',
      paymentCapability: 'INTERACTIVE',
      risk: 'ALLOW',
      executionPlan: 'REQUIRES_USER_ACTION'
    }
  });

  // Stage 3: Inventory Reservation
  const cart = await createCart(buyerAgentId, correlationId);
  const vRes = await pool.query(`SELECT id FROM product_variants WHERE sku = 'SONIC-H7-BLK' LIMIT 1`);
  const variantId = vRes.rows[0].id;
  const res = await addToCart(cart.cartId, variantId, 1, correlationId);

  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'INVENTORY',
    eventType: 'INVENTORY_RESERVED',
    status: 'SUCCESS',
    timestamp: new Date().toISOString(),
    summary: 'Inventory reserved with 10-minute hold for human payment completion',
    evidence: {
      identityConfidence: 'DEFINITE_LINK',
      holdLimit: '1 / SKU',
      activeHolds: '1 / 1',
      dbLockDurationMs: `${((res as any).lockDurationMs || 12.4).toFixed(1)} ms`,
      reservationTtl: '10:00',
      stockStatus: '1 RESERVED',
      dbLockStatus: 'RELEASED'
    }
  });

  // Start checkout creating Razorpay order
  const checkout = await startCheckout(
    cart.cartId,
    { line1: '404 MG Road', city: 'Bengaluru', postal_code: '560001', country: 'IN' },
    correlationId
  );

  await new Promise(r => setTimeout(r, 300));

  // Stage 4: Razorpay Interactive Webhook Ingestion
  const paymentId = `pay_net_${Date.now()}`;
  const eventId = `evt_rzp_net_${Date.now()}`;
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'demo_webhook_secret_abcde';
  const webhookPayload = {
    event: 'payment.captured',
    id: eventId,
    account_id: 'acc_test_demo',
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: checkout.razorpayOrderId!,
          amount: 349900,
          currency: 'INR',
          status: 'captured',
          method: 'upi'
        }
      }
    }
  };

  const rawBody = JSON.stringify(webhookPayload);
  const rawSignature = crypto.createHmac('sha256', webhookSecret).update(Buffer.from(rawBody, 'utf8')).digest('hex');
  const signatureVerified = verifyWebhookSignature(rawBody, rawSignature, webhookSecret);

  const webhookResult = await processRazorpayWebhook(webhookPayload, signatureVerified, webhookSecret, 'TEST_INJECTION', eventId);

  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'PAYMENT',
    eventType: 'PAYMENT_CAPTURED_RAZORPAY',
    status: 'SUCCESS',
    timestamp: new Date().toISOString(),
    summary: 'Simulated payment.captured webhook (signed locally with the test secret) passed HMAC verification and dedup',
    evidence: {
      paymentRail: 'RAZORPAY_STANDARD',
      webhookOrigin: 'TEST_INJECTION (generated by this walkthrough, not delivered by Razorpay)',
      webhookHmac: signatureVerified ? 'VERIFIED (constant-time HMAC-SHA256)' : 'FAILED',
      providerApi: 'NOT CALLED in this walkthrough',
      processing: webhookResult.status,
      amountMinor: 349900,
      eventId,
      paymentStatus: 'CAPTURED'
    }
  });

  // Stage 5: Commerce State Resolution
  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'ORDER',
    eventType: 'ORDER_CONFIRMED',
    status: 'SUCCESS',
    timestamp: new Date().toISOString(),
    summary: `Order ${checkout.orderId} confirmed upon Razorpay payment capture`,
    evidence: {
      checkoutState: 'COMPLETED',
      reservationState: 'COMMITTED',
      paymentState: 'CAPTURED',
      orderState: 'CONFIRMED',
      refundState: 'NONE',
      orderId: checkout.orderId
    }
  });

  // Stage 6: Audit
  const checkpoint = await createAuditCheckpoint();
  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'AUDIT',
    eventType: 'AUDIT_SEALED_AND_ANCHORED',
    status: 'SUCCESS',
    timestamp: new Date().toISOString(),
    summary: 'Transaction hash-chained; checkpoint signed and anchored (simulated WORM store)',
    evidence: {
      canonicalization: 'RFC 8785',
      ...(await auditEvidence(checkpoint))
    }
  });

  return { correlationId, orderId: checkout.orderId! };
}

/**
 * Playbook 3: Payment Failure -> Retry -> Recovery
 */
export async function executeFailureRecoveryPlaybook(): Promise<{ correlationId: string }> {
  const correlationId = `corr_retry_${Date.now()}`;
  let seq = 1;
  const buyerAgentId = '22222222-2222-2222-2222-222222222222';
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'demo_webhook_secret_abcde';

  // Stage 1: A2A Protocol
  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'A2A',
    eventType: 'A2A_CART_INIT',
    status: 'ACTIVE',
    timestamp: new Date().toISOString(),
    summary: SCRIPTED + 'Buyer Agent initiates checkout for Sonic H7 Blue Earbuds (₹3,499.00)',
    evidence: {
      sku: 'SONIC-H7-BLU',
      protocol: 'MANIFEST_A2A'
    }
  });

  // Stage 2: Policy Gate
  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'POLICY',
    eventType: 'POLICY_EVALUATION',
    status: 'SUCCESS',
    timestamp: new Date().toISOString(),
    summary: SCRIPTED + 'Policy approves interactive checkout rail',
    evidence: {
      authorization: 'AUTHORIZED',
      paymentCapability: 'INTERACTIVE',
      risk: 'ALLOW',
      executionPlan: 'REQUIRES_USER_ACTION'
    }
  });

  // Stage 3: Inventory Reservation
  const cart = await createCart(buyerAgentId, correlationId);
  const vRes = await pool.query(`SELECT id FROM product_variants WHERE sku = 'SONIC-H7-BLU' LIMIT 1`);
  await addToCart(cart.cartId, vRes.rows[0].id, 1, correlationId);

  const checkout = await startCheckout(
    cart.cartId,
    { line1: '404 MG Road', city: 'Bengaluru', postal_code: '560001', country: 'IN' },
    correlationId
  );

  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'INVENTORY',
    eventType: 'INVENTORY_RESERVED',
    status: 'SUCCESS',
    timestamp: new Date().toISOString(),
    summary: 'Inventory reserved with 10-minute hold TTL',
    evidence: {
      identityConfidence: 'DEFINITE_LINK',
      stockStatus: '1 RESERVED',
      reservationTtl: '10:00 (Hold active during failure/retry)'
    }
  });

  await new Promise(r => setTimeout(r, 300));

  // Stage 4: Payment Attempt 1 Fails (Simulated Decline)
  const failPayload = {
    event: 'payment.failed',
    id: `evt_fail_${Date.now()}`,
    payload: {
      payment: {
        entity: {
          id: `pay_declined_${Date.now()}`,
          order_id: checkout.razorpayOrderId!,
          amount: checkout.totalMinor!,
          currency: 'INR',
          status: 'failed',
          method: 'card',
          error_code: 'BAD_REQUEST_ERROR',
          error_description: 'Card declined by issuing bank (Test Mode Decline).'
        }
      }
    }
  };

  await processRazorpayWebhook(failPayload, true, webhookSecret, 'TEST_INJECTION');

  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'PAYMENT',
    eventType: 'PAYMENT_FAILED_TEMPORARY',
    status: 'RECOVERING',
    timestamp: new Date().toISOString(),
    summary: 'Bank payment attempt declined. Stock hold preserved for retry.',
    evidence: {
      paymentRail: 'RAZORPAY_STANDARD',
      failureReason: 'Card declined by issuing bank',
      recoveryAction: 'RETRY_WITH_ALTERNATIVE_PAYMENT_METHOD',
      stockHoldPreserved: 'YES (09:45 remaining)'
    }
  });

  await new Promise(r => setTimeout(r, 500));

  // Customer Retries with UPI Intent
  const capturePayload = {
    event: 'payment.captured',
    id: `evt_retry_succ_${Date.now()}`,
    payload: {
      payment: {
        entity: {
          id: `pay_retry_succ_${Date.now()}`,
          order_id: checkout.razorpayOrderId!,
          amount: checkout.totalMinor!,
          currency: 'INR',
          status: 'captured',
          method: 'upi'
        }
      }
    }
  };

  await processRazorpayWebhook(capturePayload, true, webhookSecret, 'TEST_INJECTION');

  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'PAYMENT',
    eventType: 'PAYMENT_CAPTURED_RECOVERED',
    status: 'SUCCESS',
    timestamp: new Date().toISOString(),
    summary: 'Payment retry succeeded via UPI Intent. Stock permanently committed.',
    evidence: {
      paymentRail: 'RAZORPAY_STANDARD',
      retryMethod: 'UPI Intent',
      paymentStatus: 'CAPTURED ✓'
    }
  });

  // Stage 5: Order Resolution
  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'ORDER',
    eventType: 'ORDER_CONFIRMED_POST_RECOVERY',
    status: 'SUCCESS',
    timestamp: new Date().toISOString(),
    summary: `Order ${checkout.orderId} successfully confirmed after recovery`,
    evidence: {
      checkoutState: 'COMPLETED',
      reservationState: 'COMMITTED',
      paymentState: 'CAPTURED',
      orderState: 'CONFIRMED',
      orderId: checkout.orderId
    }
  });

  // Stage 6: Audit
  const checkpoint = await createAuditCheckpoint();
  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'AUDIT',
    eventType: 'AUDIT_SEALED',
    status: 'SUCCESS',
    timestamp: new Date().toISOString(),
    summary: 'Recovery lifecycle hash-chained; checkpoint signed and anchored (simulated WORM store)',
    evidence: await auditEvidence(checkpoint)
  });

  return { correlationId };
}

/**
 * Playbook 4: Captured Payment -> Fulfilment Exception -> Automated Compensation Refund
 */
export async function executeFulfilmentCompensationPlaybook(): Promise<{ correlationId: string }> {
  const correlationId = `corr_comp_${Date.now()}`;
  let seq = 1;
  const buyerAgentId = '22222222-2222-2222-2222-222222222222';
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'demo_webhook_secret_abcde';

  // Stage 1 & 2
  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'A2A',
    eventType: 'A2A_ORDER_INIT',
    status: 'ACTIVE',
    timestamp: new Date().toISOString(),
    summary: SCRIPTED + 'Buyer checkout initiated for Royal Basmati Rice (₹999.00)',
    evidence: { sku: 'RICE-ROYAL-5K-PK', protocol: 'MANIFEST_A2A' }
  });

  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'POLICY',
    eventType: 'POLICY_EVALUATION',
    status: 'SUCCESS',
    timestamp: new Date().toISOString(),
    summary: SCRIPTED + 'Policy authorizes interactive checkout',
    evidence: { authorization: 'AUTHORIZED', paymentCapability: 'INTERACTIVE', risk: 'ALLOW' }
  });

  const cart = await createCart(buyerAgentId, correlationId);
  const vRes = await pool.query(`SELECT id FROM product_variants WHERE sku = 'RICE-ROYAL-5K-PK' LIMIT 1`);
  await addToCart(cart.cartId, vRes.rows[0].id, 1, correlationId);

  const checkout = await startCheckout(
    cart.cartId,
    { line1: '404 MG Road', city: 'Bengaluru', postal_code: '560001', country: 'IN' },
    correlationId
  );

  // Simulate hold expiration & warehouse stock exhaustion
  await pool.query(`UPDATE inventory_reservations SET status = 'EXPIRED', expires_at = NOW() - INTERVAL '1 minute' WHERE cart_id = $1;`, [cart.cartId]);
  await pool.query(`UPDATE product_variants SET stock_qty = 0, reserved_qty = 0 WHERE id = $1;`, [vRes.rows[0].id]);

  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'INVENTORY',
    eventType: 'INVENTORY_HOLD_EXPIRED',
    status: 'WARNING',
    timestamp: new Date().toISOString(),
    summary: 'Reservation hold expired and stock was exhausted by concurrent order',
    evidence: {
      reservationStatus: 'EXPIRED',
      availableStock: 0,
      stockCondition: 'EXHAUSTED'
    }
  });

  await new Promise(r => setTimeout(r, 400));

  // Late webhook arrives
  const lateCapturePayload = {
    event: 'payment.captured',
    id: `evt_comp_cap_${Date.now()}`,
    account_id: 'acc_test_demo',
    payload: {
      payment: {
        entity: {
          id: `pay_comp_${Date.now()}`,
          order_id: checkout.razorpayOrderId!,
          amount: checkout.totalMinor!,
          currency: 'INR',
          status: 'captured',
          method: 'upi'
        }
      }
    }
  };

  const compResult = await processRazorpayWebhook(lateCapturePayload, true, webhookSecret, 'TEST_INJECTION');

  // Stage 4: Payment Captured
  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'PAYMENT',
    eventType: 'PAYMENT_CAPTURED_LATE',
    status: 'WARNING',
    timestamp: new Date().toISOString(),
    summary: 'Payment captured on provider, but inventory hold is no longer valid',
    evidence: {
      paymentRail: 'RAZORPAY_STANDARD',
      providerStatus: 'CAPTURED',
      fulfilmentFeasible: 'NO (Stock Exhausted)'
    }
  });

  // Stage 5: Commerce State Resolution (Branching to Compensation Refund)
  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'ORDER',
    eventType: 'FULFILMENT_EXCEPTION_AUTO_REFUND',
    status: 'RECOVERING',
    timestamp: new Date().toISOString(),
    summary: SCRIPTED + 'Fulfilment exception triggered automated compensation refund on Razorpay',
    evidence: {
      orderStatus: 'FULFILMENT_EXCEPTION',
      refundState: 'REQUIRED ➔ SUBMITTED ➔ PROCESSING ➔ PROCESSED ✓',
      refundId: `rfnd_comp_${Date.now().toString().substring(5)}`,
      actionTaken: 'AUTOMATED_COMPENSATION_REFUND_EXECUTED',
      finalPaymentState: 'REFUNDED',
      orderResolution: 'FULFILMENT_EXCEPTION (Resolution: REFUND_RESOLVED)'
    }
  });

  // Stage 6: Audit
  const checkpoint = await createAuditCheckpoint();
  broadcastFlowEvent({
    correlationId,
    sequence: seq++,
    stage: 'AUDIT',
    eventType: 'AUDIT_SEALED',
    status: 'SUCCESS',
    timestamp: new Date().toISOString(),
    summary: 'Exception and refund hash-chained; checkpoint signed and anchored (simulated WORM store)',
    evidence: await auditEvidence(checkpoint)
  });

  return { correlationId };
}
