import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { pool } from '../../src/db/pool.js';
import { seedDatabase } from '../../src/db/seed.js';
import {
  verifyWebhookSignature,
  processRazorpayWebhook,
  verifyWebhookSignatureWithRotation,
  rotateWebhookSecret,
  registerKmsSecret
} from '../../src/webhooks/razorpay.js';
import { createCart, addToCart } from '../../src/cart/service.js';
import { startCheckout } from '../../src/checkout/service.js';
import {
  runFullReconciliationCycle,
  reconcileCapturedPaymentsWithoutOrder,
  reconcileUncertainRefunds
} from '../../src/payments/reconciliation.js';

describe('Razorpay Webhook Verification, Uncertainty & Reconciliation Suite', () => {
  const webhookSecret = 'test_webhook_secret_key_12345';
  let orderId: string;
  let razorpayOrderId: string;

  beforeAll(async () => {
    await seedDatabase();

    const cart = await createCart('22222222-2222-2222-2222-222222222222', 'corr_wh_setup');
    const vRes = await pool.query(`SELECT id FROM product_variants WHERE sku = 'BREW-42-BLK' LIMIT 1`);
    await addToCart(cart.cartId, vRes.rows[0].id, 1, 'corr_wh_setup');

    const chk = await startCheckout(
      cart.cartId,
      { line1: 'Test St', city: 'Bengaluru', postal_code: '560001', country: 'IN' },
      'corr_wh_setup'
    );

    orderId = chk.orderId!;
    razorpayOrderId = chk.razorpayOrderId!;
  });

  it('Validates authentic HMAC-SHA256 signatures correctly', () => {
    const rawBody = JSON.stringify({ event: 'payment.captured', id: 'evt_123' });
    const signature = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    expect(verifyWebhookSignature(rawBody, signature, webhookSecret)).toBe(true);
  });

  it('Rejects tampered or forged webhook signatures', () => {
    const rawBody = JSON.stringify({ event: 'payment.captured', id: 'evt_123' });
    const forgedSignature = '0000000000000000000000000000000000000000000000000000000000000000';

    expect(verifyWebhookSignature(rawBody, forgedSignature, webhookSecret)).toBe(false);
  });

  it('Rejects empty or missing signature with 400 rejection', async () => {
    const payload = { event: 'payment.captured', id: 'evt_missing_sig' };
    const res = await processRazorpayWebhook(payload as any, false, webhookSecret);
    expect(res.ok).toBe(false);
    expect(res.status).toBe('UNAUTHORIZED');
  });

  it('Handles out-of-order webhooks where payment.captured arrives before payment.authorized with authentic source attribution (P0.1)', async () => {
    const eventId = `evt_out_of_order_${Date.now()}`;
    const payload = {
      event: 'payment.captured',
      id: eventId,
      payload: {
        payment: {
          entity: {
            id: `pay_ooo_${Date.now()}`,
            order_id: razorpayOrderId,
            amount: 479900,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    };

    const res = await processRazorpayWebhook(payload, true, webhookSecret, 'RAZORPAY_NETWORK');
    expect(res.ok).toBe(true);
    expect(res.webhookSource).toBe('RAZORPAY_NETWORK');

    const oRes = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    expect(oRes.rows[0].status).toBe('CONFIRMED');
  });

  it('Processes payment.captured idempotently without duplicate side effects', async () => {
    const eventId = `evt_test_idem_${Date.now()}`;
    const payload = {
      event: 'payment.captured',
      id: eventId,
      payload: {
        payment: {
          entity: {
            id: `pay_idem_${Date.now()}`,
            order_id: razorpayOrderId,
            amount: 479900,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    };

    const res1 = await processRazorpayWebhook(payload, true, webhookSecret);
    expect(res1.ok).toBe(true);

    // Replay of duplicate event
    const res2 = await processRazorpayWebhook(payload, true, webhookSecret);
    expect(res2.ok).toBe(true);
    expect(res2.status).toBe('ALREADY_PROCESSED');
  });

  it('Enforces monotonic state precedence: Stale payment.failed cannot downgrade a CONFIRMED order', async () => {
    const staleFailPayload = {
      event: 'payment.failed',
      id: `evt_stale_fail_${Date.now()}`,
      payload: {
        payment: {
          entity: {
            id: `pay_stale_${Date.now()}`,
            order_id: razorpayOrderId,
            amount: 479900,
            currency: 'INR',
            status: 'failed',
            method: 'upi'
          }
        }
      }
    };

    const res = await processRazorpayWebhook(staleFailPayload, true, webhookSecret);
    expect(res.ok).toBe(true);
    expect(res.status).toBe('IGNORED_STALE_EVENT');

    // Order status remains strictly CONFIRMED
    const oRes = await pool.query('SELECT status FROM orders WHERE id = $1', [orderId]);
    expect(oRes.rows[0].status).toBe('CONFIRMED');
  });

  it('Preserves cart and reservation on payment.failed retryable attempt', async () => {
    const cart = await createCart('22222222-2222-2222-2222-222222222222', 'corr_fail_retry_test');
    const vRes = await pool.query(`SELECT id FROM product_variants WHERE sku = 'SONIC-H7-BLU' LIMIT 1`);
    await addToCart(cart.cartId, vRes.rows[0].id, 1, 'corr_fail_retry_test');

    const chk = await startCheckout(
      cart.cartId,
      { line1: 'Test St', city: 'Bengaluru', postal_code: '560001', country: 'IN' },
      'corr_fail_retry_test'
    );

    const failPayload = {
      event: 'payment.failed',
      id: `evt_fail_test_${Date.now()}`,
      payload: {
        payment: {
          entity: {
            id: `pay_failed_${Date.now()}`,
            order_id: chk.razorpayOrderId!,
            amount: 349900,
            currency: 'INR',
            status: 'failed',
            method: 'card',
            error_code: 'BAD_REQUEST_ERROR',
            error_description: 'Card declined due to insufficient funds'
          }
        }
      }
    };

    const res = await processRazorpayWebhook(failPayload, true, webhookSecret, 'TEST_INJECTION');
    expect(res.ok).toBe(true);
    expect(res.status).toBe('PAYMENT_ATTEMPT_FAILED');
    expect(res.problemDetail?.inventory_state).toBe('HELD_UNTIL_TTL');

    const oRes = await pool.query('SELECT status FROM orders WHERE id = $1', [chk.orderId]);
    expect(oRes.rows[0].status).toBe('PAYMENT_ATTEMPT_FAILED');
  });

  it('Handles late AUTHORIZED webhook when stock is unavailable: Declines capture and cancels order (P0.6)', async () => {
    const cart = await createCart('22222222-2222-2222-2222-222222222222', 'corr_late_auth');
    const vRes = await pool.query(`SELECT id FROM product_variants WHERE sku = 'OIL-OLV-1L-BTL' LIMIT 1`);
    await addToCart(cart.cartId, vRes.rows[0].id, 1, 'corr_late_auth');

    const chk = await startCheckout(
      cart.cartId,
      { line1: 'Late Auth St', city: 'Bengaluru', country: 'IN' },
      'corr_late_auth'
    );

    // Force reservation expiry & drain available stock
    await pool.query(`UPDATE inventory_reservations SET status = 'EXPIRED' WHERE cart_id = $1`, [cart.cartId]);
    await pool.query(`UPDATE product_variants SET stock_qty = 0, reserved_qty = 0 WHERE id = $1`, [vRes.rows[0].id]);

    const authPayload = {
      event: 'payment.authorized',
      id: `evt_auth_drain_${Date.now()}`,
      payload: {
        payment: {
          entity: {
            id: `pay_auth_late_${Date.now()}`,
            order_id: chk.razorpayOrderId!,
            amount: 129900,
            currency: 'INR',
            status: 'authorized',
            method: 'upi'
          }
        }
      }
    };

    const res = await processRazorpayWebhook(authPayload, true, webhookSecret);
    expect(res.ok).toBe(true);
    expect(res.status).toBe('DO_NOT_CAPTURE_AWAITING_PROVIDER_AUTO_REFUND');

    const oCheck = await pool.query('SELECT status FROM orders WHERE id = $1', [chk.orderId]);
    expect(oCheck.rows[0].status).toBe('CANCELLED');
  });

  it('Automated Compensation Refund: Captured payment with expired reservation and no stock triggers refund (P0.5 & P0.6)', async () => {
    const cart = await createCart('22222222-2222-2222-2222-222222222222', 'corr_refund_test');
    const vRes = await pool.query(`SELECT id FROM product_variants WHERE sku = 'CHG-GAN-65W-WHT' LIMIT 1`);
    await addToCart(cart.cartId, vRes.rows[0].id, 1, 'corr_refund_test');

    const chk = await startCheckout(
      cart.cartId,
      { line1: 'Refund St', city: 'Bengaluru', country: 'IN' },
      'corr_refund_test'
    );

    // Force reservation expiry & stock drain
    await pool.query(`UPDATE inventory_reservations SET status = 'EXPIRED' WHERE cart_id = $1`, [cart.cartId]);
    await pool.query(`UPDATE product_variants SET stock_qty = 0, reserved_qty = 0 WHERE id = $1`, [vRes.rows[0].id]);

    const capturePayload = {
      event: 'payment.captured',
      id: `evt_cap_drain_${Date.now()}`,
      payload: {
        payment: {
          entity: {
            id: `pay_cap_drain_${Date.now()}`,
            order_id: chk.razorpayOrderId!,
            amount: 189900,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          }
        }
      }
    };

    const res = await processRazorpayWebhook(capturePayload, true, webhookSecret);
    expect(res.ok).toBe(true);
    expect(res.status).toBe('AUTOMATED_REFUND_EXECUTED');

    const oCheck = await pool.query('SELECT status FROM orders WHERE id = $1', [chk.orderId]);
    expect(oCheck.rows[0].status).toBe('REFUNDED');

    const pCheck = await pool.query('SELECT status FROM payments WHERE order_id = $1', [chk.orderId]);
    expect(pCheck.rows[0].status).toBe('REFUNDED');
  });

  it('Handles provider network timeout via PAYMENT_UNCERTAIN and resolves state via ReconciliationWorker', async () => {
    const cart = await createCart('22222222-2222-2222-2222-222222222222', 'corr_uncertain_test');
    const vRes = await pool.query(`SELECT id FROM product_variants WHERE sku = 'TEA-DARJ-250-CAN' LIMIT 1`);
    await addToCart(cart.cartId, vRes.rows[0].id, 1, 'corr_uncertain_test');

    const chk = await startCheckout(
      cart.cartId,
      { line1: 'Test St', city: 'Bengaluru', postal_code: '560001', country: 'IN' },
      'corr_uncertain_test'
    );

    const uncertainPayload = {
      event: 'payment.uncertain',
      id: `evt_unc_${Date.now()}`,
      payload: {
        payment: {
          entity: {
            id: `pay_unc_${Date.now()}`,
            order_id: chk.razorpayOrderId!,
            amount: 49900,
            currency: 'INR',
            status: 'pending',
            method: 'upi'
          }
        }
      }
    };

    const whRes = await processRazorpayWebhook(uncertainPayload, true, webhookSecret);
    expect(whRes.ok).toBe(true);

    const checkState = await pool.query('SELECT status FROM orders WHERE id = $1', [chk.orderId]);
    expect(checkState.rows[0].status).toBe('PAYMENT_UNCERTAIN');

    const report = await runFullReconciliationCycle();
    expect(report.success).toBe(true);
    expect(report.uncertainProcessed).toBeGreaterThanOrEqual(1);
  });

  it('Disaster Recovery: Captured payment with injected DB crash automatically reconstructs order from immutable checkout snapshot', async () => {
    const cart = await createCart('22222222-2222-2222-2222-222222222222', 'corr_crash_test');
    const vRes = await pool.query(`SELECT id, price_minor, sku, title FROM product_variants WHERE sku = 'HONEY-WILD-500-JAR' LIMIT 1`);
    await addToCart(cart.cartId, vRes.rows[0].id, 1, 'corr_crash_test');

    const frozenLines = [{
      variant_id: vRes.rows[0].id,
      quantity: 1,
      unit_price_minor: Number(vRes.rows[0].price_minor),
      sku: vRes.rows[0].sku,
      title: vRes.rows[0].title
    }];

    const frozenSnapshot = {
      schema_version: '2.0',
      cart_id: cart.cartId,
      merchant_id: '11111111-1111-1111-1111-111111111111',
      buyer_agent_id: '22222222-2222-2222-2222-222222222222',
      lines: frozenLines,
      shipping_address: { line1: 'Snapshot Address', city: 'Bengaluru', country: 'IN' }
    };

    const chkRes = await pool.query(`
      INSERT INTO checkouts (
        cart_id, merchant_id, quote_hash, cart_hash, gross_amount_minor,
        discount_amount_minor, net_amount_minor, currency, execution_mode, status, checkout_snapshot, correlation_id, expires_at
      ) VALUES (
        $1, '11111111-1111-1111-1111-111111111111', 'quote_crashed', 'cart_crashed', 39900, 0, 39900, 'INR', 'AUTO_EXECUTABLE', 'PENDING', $2, 'corr_crash_test', NOW() + INTERVAL '15 minutes'
      ) RETURNING id;
    `, [cart.cartId, JSON.stringify(frozenSnapshot)]);
    const checkoutId = chkRes.rows[0].id;

    // Simulate captured payment record created without order (simulating crash before order creation)
    const paymentRes = await pool.query(`
      INSERT INTO payments (
        checkout_id, razorpay_payment_id, provider, amount_minor, currency, status, method
      ) VALUES (
        $1, $2, 'RAZORPAY_CHECKOUT', 39900, 'INR', 'CAPTURED', 'upi'
      ) RETURNING id;
    `, [checkoutId, `pay_orphaned_${Date.now()}`]);
    const orphanedPaymentId = paymentRes.rows[0].id;

    // Run reconciliation worker to discover orphaned payment and recover order from snapshot
    const incidents = await reconcileCapturedPaymentsWithoutOrder();
    expect(incidents.length).toBeGreaterThanOrEqual(1);

    const match = incidents.find(inc => inc.paymentId === orphanedPaymentId);
    expect(match).toBeDefined();
    expect(match?.resolvedStatus).toBe('CONFIRMED');

    // Verify order was created in DB and linked to payment
    const recoveredPayment = await pool.query('SELECT order_id, status FROM payments WHERE id = $1', [orphanedPaymentId]);
    expect(recoveredPayment.rows[0].order_id).toBeDefined();
    expect(recoveredPayment.rows[0].status).toBe('CAPTURED');

    const orderCheck = await pool.query('SELECT status, total_minor FROM orders WHERE id = $1', [recoveredPayment.rows[0].order_id]);
    expect(orderCheck.rows[0].status).toBe('CONFIRMED');
    expect(Number(orderCheck.rows[0].total_minor)).toBe(39900);
  });

  it('Refund Lifecycle: Asynchronous refund.processed webhook confirms refund entity in PROCESSED state', async () => {
    const cart = await createCart('22222222-2222-2222-2222-222222222222', 'corr_async_refund');
    const vRes = await pool.query(`SELECT id FROM product_variants WHERE sku = 'HONEY-WILD-500-JAR' LIMIT 1`);
    await addToCart(cart.cartId, vRes.rows[0].id, 1, 'corr_async_refund');

    const chk = await startCheckout(
      cart.cartId,
      { line1: 'Refund St', city: 'Bengaluru', country: 'IN' },
      'corr_async_refund'
    );

    const rzpPaymentId = `pay_refund_target_${Date.now()}`;
    const rzpRefundId = `rfnd_external_${Date.now()}`;

    // Create payment in CAPTURED state
    const pRes = await pool.query(`
      INSERT INTO payments (order_id, checkout_id, razorpay_payment_id, provider, amount_minor, currency, status, method)
      VALUES ($1, $2, $3, 'RAZORPAY_CHECKOUT', 39900, 'INR', 'CAPTURED', 'upi')
      RETURNING id;
    `, [chk.orderId, chk.checkoutId, rzpPaymentId]);
    const paymentId = pRes.rows[0].id;

    // Create refund entity in SUBMITTED state
    const refRes = await pool.query(`
      INSERT INTO refunds (order_id, payment_id, razorpay_refund_id, amount_minor, currency, reason, status, correlation_id)
      VALUES ($1, $2, $3, 39900, 'INR', 'Customer cancellation', 'SUBMITTED', 'corr_async_refund')
      RETURNING id;
    `, [chk.orderId, paymentId, rzpRefundId]);
    const refundId = refRes.rows[0].id;

    // Ingest authentic refund.processed webhook
    const refundPayload = {
      event: 'refund.processed',
      id: `evt_rfnd_proc_${Date.now()}`,
      payload: {
        refund: {
          entity: {
            id: rzpRefundId,
            payment_id: rzpPaymentId,
            amount: 39900,
            currency: 'INR',
            status: 'processed'
          }
        }
      }
    };

    const whRes = await processRazorpayWebhook(refundPayload, true, webhookSecret);
    expect(whRes.ok).toBe(true);
    expect(whRes.status).toBe('REFUND_PROCESSED');

    // Verify independent refund entity is PROCESSED
    const refCheck = await pool.query('SELECT status FROM refunds WHERE id = $1', [refundId]);
    expect(refCheck.rows[0].status).toBe('PROCESSED');

    // Verify payment and order are updated to REFUNDED
    const pCheck = await pool.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
    expect(pCheck.rows[0].status).toBe('REFUNDED');

    const oCheck = await pool.query('SELECT status FROM orders WHERE id = $1', [chk.orderId]);
    expect(oCheck.rows[0].status).toBe('REFUNDED');
  });

  it('Refund Lifecycle: Asynchronous refund.failed webhook moves refund to FAILED and escalates order to MANUAL_RESOLUTION_REQUIRED', async () => {
    const cart = await createCart('22222222-2222-2222-2222-222222222222', 'corr_async_refund_fail');
    const vRes = await pool.query(`SELECT id FROM product_variants WHERE sku = 'HONEY-WILD-500-JAR' LIMIT 1`);
    await addToCart(cart.cartId, vRes.rows[0].id, 1, 'corr_async_refund_fail');

    const chk = await startCheckout(
      cart.cartId,
      { line1: 'Refund St', city: 'Bengaluru', country: 'IN' },
      'corr_async_refund_fail'
    );

    const rzpPaymentId = `pay_refund_fail_target_${Date.now()}`;
    const rzpRefundId = `rfnd_failed_external_${Date.now()}`;

    // Create payment in CAPTURED state
    const pRes = await pool.query(`
      INSERT INTO payments (order_id, checkout_id, razorpay_payment_id, provider, amount_minor, currency, status, method)
      VALUES ($1, $2, $3, 'RAZORPAY_CHECKOUT', 39900, 'INR', 'CAPTURED', 'upi')
      RETURNING id;
    `, [chk.orderId, chk.checkoutId, rzpPaymentId]);
    const paymentId = pRes.rows[0].id;

    // Create refund entity in SUBMITTED state
    const refRes = await pool.query(`
      INSERT INTO refunds (order_id, payment_id, razorpay_refund_id, amount_minor, currency, reason, status, correlation_id)
      VALUES ($1, $2, $3, 39900, 'INR', 'Customer return', 'SUBMITTED', 'corr_async_refund_fail')
      RETURNING id;
    `, [chk.orderId, paymentId, rzpRefundId]);
    const refundId = refRes.rows[0].id;

    // Ingest authentic refund.failed webhook
    const refundPayload = {
      event: 'refund.failed',
      id: `evt_rfnd_fail_${Date.now()}`,
      payload: {
        refund: {
          entity: {
            id: rzpRefundId,
            payment_id: rzpPaymentId,
            amount: 39900,
            currency: 'INR',
            status: 'failed',
            error_code: 'BAD_REQUEST_ERROR',
            error_description: 'Beneficiary bank account closed'
          }
        }
      }
    };

    const whRes = await processRazorpayWebhook(refundPayload, true, webhookSecret);
    expect(whRes.ok).toBe(true);
    expect(whRes.status).toBe('REFUND_FAILED');

    // Verify independent refund entity is FAILED
    const refCheck = await pool.query('SELECT status, error_code, error_description FROM refunds WHERE id = $1', [refundId]);
    expect(refCheck.rows[0].status).toBe('FAILED');
    expect(refCheck.rows[0].error_code).toBe('BAD_REQUEST_ERROR');

    // Verify order is escalated to MANUAL_RESOLUTION_REQUIRED
    const oCheck = await pool.query('SELECT status FROM orders WHERE id = $1', [chk.orderId]);
    expect(oCheck.rows[0].status).toBe('MANUAL_RESOLUTION_REQUIRED');
  });

  it('Refund Uncertainty & Reconciliation: Resolves REFUND_UNCERTAIN via background worker with provider confirmation', async () => {
    const cart = await createCart('22222222-2222-2222-2222-222222222222', 'corr_reconcile_refund');
    const vRes = await pool.query(`SELECT id FROM product_variants WHERE sku = 'HONEY-WILD-500-JAR' LIMIT 1`);
    await addToCart(cart.cartId, vRes.rows[0].id, 1, 'corr_reconcile_refund');

    const chk = await startCheckout(
      cart.cartId,
      { line1: 'Refund St', city: 'Bengaluru', country: 'IN' },
      'corr_reconcile_refund'
    );

    expect(chk.ok).toBe(true);

    const rzpPaymentId = `pay_unc_target_${Date.now()}`;
    const rzpRefundId = `rfnd_unc_${Date.now()}`;

    // Create captured payment
    const pRes = await pool.query(`
      INSERT INTO payments (order_id, checkout_id, razorpay_payment_id, provider, amount_minor, currency, status, method)
      VALUES ($1, $2, $3, 'RAZORPAY_CHECKOUT', 39900, 'INR', 'CAPTURED', 'upi')
      RETURNING id;
    `, [chk.orderId, chk.checkoutId || chk.checkoutSessionId, rzpPaymentId]);
    const paymentId = pRes.rows[0].id;

    // Create refund record in REFUND_UNCERTAIN state (simulating network timeout during refund initiation)
    const refRes = await pool.query(`
      INSERT INTO refunds (
        order_id, payment_id, razorpay_refund_id, amount_minor, currency, reason,
        status, reconciliation_attempts, next_reconciliation_attempt_at, correlation_id
      ) VALUES (
        $1, $2, $3, 39900, 'INR', 'Simulated timeout compensation',
        'REFUND_UNCERTAIN', 0, NOW() - INTERVAL '1 minute', 'corr_reconcile_refund'
      ) RETURNING id;
    `, [chk.orderId, paymentId, rzpRefundId]);
    const refundId = refRes.rows[0].id;

    // Run reconciliation worker
    const incidents = await reconcileUncertainRefunds();
    expect(incidents.length).toBeGreaterThanOrEqual(1);

    const matchedIncident = incidents.find(i => i.orderId === chk.orderId);
    expect(matchedIncident).toBeDefined();
    expect(matchedIncident?.type).toBe('REFUND_UNCERTAIN_RESOLVED');
    expect(matchedIncident?.resolvedStatus).toBe('REFUNDED');

    // Verify refund entity is now PROCESSED
    const refCheck = await pool.query('SELECT status FROM refunds WHERE id = $1', [refundId]);
    expect(refCheck.rows[0].status).toBe('PROCESSED');

    // Verify payment and order are REFUNDED
    const pCheck = await pool.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
    expect(pCheck.rows[0].status).toBe('REFUNDED');

    const oCheck = await pool.query('SELECT status FROM orders WHERE id = $1', [chk.orderId]);
    expect(oCheck.rows[0].status).toBe('REFUNDED');
  });

  it('Webhook Secret Rotation & Grace Period: Verifies retries of older webhooks with previous active secret without plaintext DB storage', async () => {
    const merchantId = '11111111-1111-1111-1111-111111111111';

    // 1. Register Mock KMS Secret Handles
    const v1SecretValue = 'kms_secret_raw_v1_abc12345';
    const v2SecretValue = 'kms_secret_raw_v2_xyz67890';
    const v1Handle = 'kms://projects/manifest/secrets/rzp_wh_v1';
    const v2Handle = 'kms://projects/manifest/secrets/rzp_wh_v2';

    registerKmsSecret(v1Handle, v1SecretValue);
    registerKmsSecret(v2Handle, v2SecretValue);

    // 2. Set Version 1 as initial PRIMARY secret
    await pool.query(`DELETE FROM webhook_secrets WHERE merchant_id = $1`, [merchantId]);
    await pool.query(`
      INSERT INTO webhook_secrets (merchant_id, version, secret_handle, status, valid_from)
      VALUES ($1, 1, $2, 'PRIMARY', NOW());
    `, [merchantId, v1Handle]);

    const testPayload = JSON.stringify({ event: 'payment.captured', id: 'evt_rot_test_1', amount: 39900 });

    // 3. Verify event signed with v1 passes as PRIMARY
    const sigV1 = crypto.createHmac('sha256', v1SecretValue).update(testPayload).digest('hex');
    const resPreRotation = await verifyWebhookSignatureWithRotation(testPayload, sigV1, merchantId);
    expect(resPreRotation.valid).toBe(true);
    expect(resPreRotation.secretVersion).toBe(1);
    expect(resPreRotation.isRotationGracePeriod).toBe(false);

    // 4. Perform Secret Rotation to Version 2 with 24-hour retry grace period
    const rotRes = await rotateWebhookSecret({
      merchantId,
      newSecretHandle: v2Handle,
      gracePeriodHours: 24,
      correlationId: 'corr_rot_test_1',
      actor: 'principal:security_officer'
    });
    expect(rotRes.ok).toBe(true);
    expect(rotRes.newVersion).toBe(2);
    expect(rotRes.previousVersion).toBe(1);

    // 5. Invariant A: New webhooks signed with Version 2 verify as PRIMARY
    const sigV2 = crypto.createHmac('sha256', v2SecretValue).update(testPayload).digest('hex');
    const resV2Primary = await verifyWebhookSignatureWithRotation(testPayload, sigV2, merchantId);
    expect(resV2Primary.valid).toBe(true);
    expect(resV2Primary.secretVersion).toBe(2);
    expect(resV2Primary.isRotationGracePeriod).toBe(false);

    // 6. Invariant B (The Edge Case): Retries of older webhook events signed with Version 1 STILL VERIFY under PREVIOUS_ACTIVE grace period
    const resV1Retry = await verifyWebhookSignatureWithRotation(testPayload, sigV1, merchantId);
    expect(resV1Retry.valid).toBe(true);
    expect(resV1Retry.secretVersion).toBe(1);
    expect(resV1Retry.isRotationGracePeriod).toBe(true);

    // 7. Invariant C: Invalid/tampered signature is rejected
    const badSig = 'bad_signature_000000000000000000000000000000000000000000000000000000000000';
    const resBad = await verifyWebhookSignatureWithRotation(testPayload, badSig, merchantId);
    expect(resBad.valid).toBe(false);
    expect(resBad.errorCode).toBe('HMAC_VERIFICATION_FAILED');

    // 8. Invariant D: Expired grace period secret is rejected
    await pool.query(`
      UPDATE webhook_secrets
      SET valid_until = NOW() - INTERVAL '1 hour'
      WHERE merchant_id = $1 AND version = 1;
    `, [merchantId]);

    const resExpiredRetry = await verifyWebhookSignatureWithRotation(testPayload, sigV1, merchantId);
    expect(resExpiredRetry.valid).toBe(false);
    expect(resExpiredRetry.errorCode).toBe('HMAC_VERIFICATION_FAILED');

    // 9. Invariant E: Verify PostgreSQL stores ONLY KMS/Secret Manager handles, NEVER plaintext secrets
    const dbSecrets = await pool.query('SELECT * FROM webhook_secrets WHERE merchant_id = $1', [merchantId]);
    for (const row of dbSecrets.rows) {
      expect(row.secret_handle.startsWith('kms://') || row.secret_handle.startsWith('env://')).toBe(true);
      expect(row.secret_handle).not.toContain(v1SecretValue);
      expect(row.secret_handle).not.toContain(v2SecretValue);
    }
  });
});
