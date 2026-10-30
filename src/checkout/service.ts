import crypto from 'crypto';
import pg from 'pg';
import { pool } from '../db/pool.js';
import { getCart } from '../cart/service.js';
import { evaluatePolicy } from '../policy/engine.js';
import { createRazorpayOrder } from '../payments/adapters/razorpay.js';
import { createSimulatedPayment } from '../payments/adapters/mock.js';
import { logAuditEvent } from '../audit/ledger.js';
import { generateMerkleProvenanceReceipt } from '../audit/provenance.js';
import { commitReservationForCart } from '../inventory/reservation.js';
import { reserveMandateBudget, commitMandateBudget, releaseMandateBudget } from '../policy/mandates.js';
import { computeCanonicalCartHash, createQuoteSnapshot, QuoteLine, QuoteAdjustment } from '../pricing/quotes.js';

export interface CheckoutResult {
  ok: boolean;
  checkoutId?: string;
  orderId?: string;
  razorpayOrderId?: string;
  executionMode?: 'AUTO_EXECUTABLE' | 'REQUIRES_USER_ACTION' | 'DENIED';
  policyDecision?: any;
  paymentCapability?: string;
  riskDecision?: string;
  status?: string;
  orderStatus?: string;
  totalMinor?: number;
  currency?: string;
  checkoutSessionUrl?: string;
  provenanceReceipt?: any;
  quoteSnapshot?: any;
  message?: string;
  errorCode?: string;
}

export async function startCheckout(
  cartId: string,
  shippingAddress: Record<string, any>,
  correlationId: string,
  mandateTokenId?: string
): Promise<CheckoutResult> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Fetch Cart
    const cart = await getCart(cartId);
    if (!cart || cart.items.length === 0) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        errorCode: 'CART_EMPTY_OR_NOT_FOUND',
        message: 'Cart is empty or not found.'
      };
    }

    if (cart.status !== 'OPEN') {
      await client.query('ROLLBACK');
      return {
        ok: false,
        errorCode: 'CART_NOT_OPEN',
        message: `Cart is in status '${cart.status}'.`
      };
    }

    // 2. Fetch Item COGS, Categories, and construct frozen QuoteLines
    let totalCogsMinor = 0;
    const categories: string[] = [];
    const skuPrefixes: string[] = [];
    const quoteLines: QuoteLine[] = [];
    const itemDetails: Array<{ variantId: string; title: string; priceMinor: number; quantity: number }> = [];

    for (const item of cart.items) {
      const vRes = await client.query(`
        SELECT p.cogs_minor, p.category_path, p.sku_prefix, pv.price_minor, pv.sku, pv.title
        FROM product_variants pv
        JOIN products p ON p.id = pv.product_id
        WHERE pv.id = $1;
      `, [item.variantId]);

      if (vRes.rows.length > 0) {
        const vInfo = vRes.rows[0];
        const cogs = Number(vInfo.cogs_minor) * item.quantity;
        totalCogsMinor += cogs;
        categories.push(...(vInfo.category_path || []));
        if (vInfo.sku_prefix) skuPrefixes.push(vInfo.sku_prefix);

        quoteLines.push({
          variant_id: item.variantId,
          quantity: item.quantity,
          unit_price_minor: item.unitPriceMinor,
          cogs_minor: Number(vInfo.cogs_minor),
          sku: vInfo.sku,
          title: vInfo.title
        });
      }

      itemDetails.push({
        variantId: item.variantId,
        title: item.title,
        priceMinor: item.unitPriceMinor,
        quantity: item.quantity
      });
    }

    // 3. Compute Cryptographically Canonical RFC 8785 Cart & Quote Hashes (P0.2 & P0.3)
    const cartHash = computeCanonicalCartHash(cart.merchantId, cartId, cart.items);

    const { quote: quoteSnapshot, quoteHash } = createQuoteSnapshot({
      merchantId: cart.merchantId,
      cartId,
      lines: quoteLines,
      adjustments: []
    });

    // 4. Server-Controlled Payment Rail Resolution (P0.1: Never accept mock rail from buyer parameter)
    const isMockRailPermitted = process.env.ENABLE_SIMULATED_PAYMENT_RAIL === 'true' || process.env.NODE_ENV !== 'production';

    // 5. Central Policy Evaluation Gatekeeper & Execution Planner
    const policyResult = await evaluatePolicy({
      action: 'CHECKOUT_START',
      merchantId: cart.merchantId,
      buyerAgentId: cart.buyerAgentId,
      cartId,
      mandateTokenId,
      grossAmountMinor: cart.grossAmountMinor,
      totalCogsMinor,
      categories: [...new Set(categories)],
      skuPrefixes: [...new Set(skuPrefixes)],
      correlationId,
      cartHash,
      quoteHash,
      isDemoSimulated: isMockRailPermitted && !!mandateTokenId
    }, client);

    if (policyResult.decision === 'DENIED') {
      await client.query('ROLLBACK');
      // The policy engine's own audit event was inside the rolled-back transaction; record the denial durably.
      await logAuditEvent({
        correlationId,
        actor: `buyer_agent:${cart.buyerAgentId}`,
        action: 'checkout.denied',
        merchantId: cart.merchantId,
        decision: 'DENIED',
        humanReadable: `Checkout denied: ${policyResult.humanReadable}`,
        policyRuleId: policyResult.policyRuleId,
        metadata: { cartId, mandateTokenId, reasonCode: policyResult.reasonCode, grossAmountMinor: cart.grossAmountMinor }
      });
      return {
        ok: false,
        executionMode: 'DENIED',
        errorCode: policyResult.reasonCode,
        message: policyResult.humanReadable
      };
    }

    const netAmountMinor = policyResult.netPayableMinor;

    // 6. Mandate Budget Reservation (P1.5 Lifecycle: Reserve)
    if (policyResult.mandateId) {
      const reserveRes = await reserveMandateBudget(policyResult.mandateId, netAmountMinor, client);
      if (!reserveRes.ok) {
        await client.query('ROLLBACK');
        return {
          ok: false,
          errorCode: 'MANDATE_RESERVATION_FAILED',
          message: reserveRes.error || 'Failed to reserve mandate budget.'
        };
      }
    }

    // 7. Create Frozen Checkout Snapshot (P0.5: Never reconstruct from mutable cart)
    const frozenCheckoutSnapshot = {
      schema_version: '2.0',
      cart_id: cartId,
      merchant_id: cart.merchantId,
      buyer_agent_id: cart.buyerAgentId,
      mandate_id: policyResult.mandateId || null,
      lines: quoteLines,
      cart_hash: cartHash,
      quote_hash: quoteHash,
      gross_amount_minor: cart.grossAmountMinor,
      discount_amount_minor: cart.grossAmountMinor - netAmountMinor,
      net_amount_minor: netAmountMinor,
      currency: 'INR',
      shipping_address: shippingAddress,
      created_at: new Date().toISOString()
    };

    // 8. Create Checkout Record
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const checkoutRes = await client.query(`
      INSERT INTO checkouts (
        cart_id, merchant_id, mandate_id, quote_hash, cart_hash,
        gross_amount_minor, discount_amount_minor, net_amount_minor, currency,
        execution_mode, status, checkout_snapshot, quote_snapshot, correlation_id, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'INR', $9, 'PENDING', $10, $11, $12, $13)
      RETURNING id;
    `, [
      cartId,
      cart.merchantId,
      policyResult.mandateId || null,
      quoteHash,
      cartHash,
      cart.grossAmountMinor,
      cart.grossAmountMinor - netAmountMinor,
      netAmountMinor,
      policyResult.decision,
      JSON.stringify(frozenCheckoutSnapshot),
      JSON.stringify(quoteSnapshot),
      correlationId,
      expiresAt
    ]);

    const checkoutId = checkoutRes.rows[0].id;

    // 9. Handle AUTO_EXECUTABLE Autonomous Flow (P0.4: Order Status = CONFIRMED, Payment = CAPTURED)
    if (policyResult.decision === 'AUTO_EXECUTABLE') {
      // Commit reserved mandate budget
      if (policyResult.mandateId) {
        await commitMandateBudget(policyResult.mandateId, netAmountMinor, client);
      }

      const mockPayment = await createSimulatedPayment({
        orderId: `ord_auto_${Date.now()}`,
        amountMinor: netAmountMinor,
        currency: 'INR',
        correlationId
      });

      // Insert Order with CONFIRMED status and TEST environment flag (P0.1 & P0.4)
      const orderRes = await client.query(`
        INSERT INTO orders (
          checkout_id, merchant_id, buyer_agent_id, mandate_id,
          razorpay_order_id, total_minor, currency, status,
          environment, funds_moved, fulfilment_allowed,
          shipping_address, correlation_id
        ) VALUES ($1, $2, $3, $4, $5, $6, 'INR', 'CONFIRMED', 'TEST', false, false, $7, $8)
        RETURNING id;
      `, [
        checkoutId,
        cart.merchantId,
        cart.buyerAgentId,
        policyResult.mandateId || null,
        `rzp_auto_${Date.now()}`,
        netAmountMinor,
        JSON.stringify(shippingAddress),
        correlationId
      ]);
      const orderId = orderRes.rows[0].id;

      // Insert Order Items from frozen snapshot
      for (const line of quoteLines) {
        await client.query(`
          INSERT INTO order_items (order_id, variant_id, quantity, unit_price_minor, cogs_minor)
          VALUES ($1, $2, $3, $4, $5);
        `, [orderId, line.variant_id, line.quantity, line.unit_price_minor, line.cogs_minor || 0]);
      }

      // Insert Payment Record with CAPTURED status
      await client.query(`
        INSERT INTO payments (
          order_id, checkout_id, razorpay_payment_id, provider, amount_minor, currency, status, method
        ) VALUES ($1, $2, $3, 'MOCK_SIMULATED_RAIL', $4, 'INR', 'CAPTURED', 'SIMULATED_AUTONOMOUS_RAIL');
      `, [orderId, checkoutId, mockPayment.paymentId, netAmountMinor]);

      // Commit reserved inventory
      await commitReservationForCart(cartId, correlationId, client);

      // Convert cart status & checkout status
      await client.query(`UPDATE carts SET status = 'CONVERTED_TO_CHECKOUT' WHERE id = $1;`, [cartId]);
      await client.query(`UPDATE checkouts SET status = 'PAID' WHERE id = $1;`, [checkoutId]);

      // Generate Merkle Provenance Receipt
      const provenanceReceipt = generateMerkleProvenanceReceipt({
        orderId,
        buyerAgentId: cart.buyerAgentId,
        merchantId: cart.merchantId,
        items: itemDetails,
        pricing: {
          grossAmountMinor: cart.grossAmountMinor,
          discountAmountMinor: cart.grossAmountMinor - netAmountMinor,
          netAmountMinor
        },
        policyDecision: {
          decision: 'AUTO_EXECUTABLE',
          policyRuleId: policyResult.policyRuleId,
          reasonCode: policyResult.reasonCode
        },
        mandateBinding: policyResult.mandateId ? {
          mandateTokenId: mandateTokenId || '',
          nonce: correlationId,
          maxTotalAmountMinor: netAmountMinor
        } : undefined,
        payment: {
          provider: 'MOCK_SIMULATED_RAIL',
          paymentId: mockPayment.paymentId,
          status: 'CAPTURED'
        }
      });

      await client.query(`
        INSERT INTO provenance_receipts (
          order_id, audit_root_hash, merkle_tree, mandate_token_id, quote_hash, catalog_version, policy_version, seller_model_id, full_receipt
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
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

      // Final Audit Log
      await logAuditEvent({
        correlationId,
        actor: 'system:checkout_engine',
        action: 'checkout.complete_autonomous',
        merchantId: cart.merchantId,
        decision: 'AUTO_EXECUTABLE',
        humanReadable: `Executed autonomous order ${orderId} for ₹${(netAmountMinor / 100).toFixed(2)} via ${mockPayment.provider}. Status: CONFIRMED. Merkle root: ${provenanceReceipt.auditRootHash}.`,
        policyRuleId: 'RULE_AUTONOMOUS_EXECUTION_COMPLETED',
        metadata: { orderId, paymentId: mockPayment.paymentId, provReceipt: provenanceReceipt }
      }, client);

      await client.query('COMMIT');

      return {
        ok: true,
        checkoutId,
        orderId,
        executionMode: 'AUTO_EXECUTABLE',
        policyDecision: { decision: 'AUTHORIZED', policyRuleId: policyResult.policyRuleId },
        paymentCapability: 'AUTO_EXECUTABLE',
        riskDecision: 'ALLOW',
        status: 'CONFIRMED',
        orderStatus: 'CONFIRMED',
        totalMinor: netAmountMinor,
        currency: 'INR',
        provenanceReceipt,
        quoteSnapshot,
        message: 'Payment captured and order confirmed autonomously.'
      };
    }

    // 10. Handle REQUIRES_USER_ACTION Standard Razorpay Checkout Flow
    const rzpOrder = await createRazorpayOrder({
      amountMinor: netAmountMinor,
      currency: 'INR',
      receipt: `rcpt_${checkoutId.substring(0, 10)}`,
      notes: { cart_id: cartId, checkout_id: checkoutId, correlation_id: correlationId }
    });

    const razorpayOrderId = rzpOrder.id;

    // Insert Order in PENDING_CONFIRMATION status
    const orderRes = await client.query(`
      INSERT INTO orders (
        checkout_id, merchant_id, buyer_agent_id, mandate_id,
        razorpay_order_id, total_minor, currency, status,
        environment, funds_moved, fulfilment_allowed,
        shipping_address, correlation_id
      ) VALUES ($1, $2, $3, $4, $5, $6, 'INR', 'PENDING_CONFIRMATION', 'PRODUCTION', true, true, $7, $8)
      RETURNING id;
    `, [
      checkoutId,
      cart.merchantId,
      cart.buyerAgentId,
      policyResult.mandateId || null,
      razorpayOrderId,
      netAmountMinor,
      JSON.stringify(shippingAddress),
      correlationId
    ]);
    const orderId = orderRes.rows[0].id;

    // Insert Order Items from frozen snapshot
    for (const line of quoteLines) {
      await client.query(`
        INSERT INTO order_items (order_id, variant_id, quantity, unit_price_minor, cogs_minor)
        VALUES ($1, $2, $3, $4, $5);
      `, [orderId, line.variant_id, line.quantity, line.unit_price_minor, line.cogs_minor || 0]);
    }

    await client.query(`
      UPDATE checkouts SET razorpay_order_id = $1, status = 'AWAITING_AUTH' WHERE id = $2;
    `, [razorpayOrderId, checkoutId]);

    const checkoutUrl = `/checkout/hosted/${orderId}`;

    await logAuditEvent({
      correlationId,
      actor: 'system:checkout_engine',
      action: 'checkout.create_razorpay_order',
      merchantId: cart.merchantId,
      decision: 'REQUIRES_USER_ACTION',
      humanReadable: `Created Razorpay Order ${razorpayOrderId} for ₹${(netAmountMinor / 100).toFixed(2)}. Interactive human authentication required at ${checkoutUrl}.`,
      policyRuleId: 'RULE_STANDARD_RAZORPAY_AWAITING_AUTH',
      metadata: { orderId, razorpayOrderId, checkoutUrl }
    }, client);

    await client.query('COMMIT');

    return {
      ok: true,
      checkoutId,
      orderId,
      razorpayOrderId,
      executionMode: 'REQUIRES_USER_ACTION',
      policyDecision: { decision: 'AUTHORIZED', policyRuleId: policyResult.policyRuleId },
      paymentCapability: 'INTERACTIVE',
      riskDecision: 'ALLOW',
      status: 'AWAITING_AUTH',
      orderStatus: 'PENDING_CONFIRMATION',
      totalMinor: netAmountMinor,
      currency: 'INR',
      checkoutSessionUrl: checkoutUrl,
      quoteSnapshot,
      message: 'Razorpay Order created. Human user must complete OTP/UPI authentication.'
    };
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('Checkout error:', err);
    return {
      ok: false,
      errorCode: 'CHECKOUT_FAILED',
      message: err.message || 'Internal checkout processing failure.'
    };
  } finally {
    client.release();
  }
}

export async function getOrderStatus(orderId: string) {
  const oRes = await pool.query(`
    SELECT o.*, c.execution_mode, c.quote_hash, c.checkout_snapshot, c.quote_snapshot
    FROM orders o
    JOIN checkouts c ON c.id = o.checkout_id
    WHERE o.id::text = $1 OR o.razorpay_order_id = $1;
  `, [orderId]);

  if (oRes.rows.length === 0) return null;
  const order = oRes.rows[0];

  const itemsRes = await pool.query(`
    SELECT oi.*, pv.sku, pv.title
    FROM order_items oi
    JOIN product_variants pv ON pv.id = oi.variant_id
    WHERE oi.order_id = $1;
  `, [order.id]);

  const pRes = await pool.query(`
    SELECT * FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1;
  `, [order.id]);

  const receiptRes = await pool.query(`
    SELECT * FROM provenance_receipts WHERE order_id = $1;
  `, [order.id]);

  return {
    id: order.id,
    checkoutId: order.checkout_id,
    merchantId: order.merchant_id,
    buyerAgentId: order.buyer_agent_id,
    razorpayOrderId: order.razorpay_order_id,
    status: order.status,
    orderStatus: order.status,
    environment: order.environment,
    fundsMoved: order.funds_moved,
    fulfilmentAllowed: order.fulfilment_allowed,
    totalMinor: Number(order.total_minor),
    currency: order.currency,
    executionMode: order.execution_mode,
    shippingAddress: order.shipping_address,
    checkoutSnapshot: order.checkout_snapshot,
    quoteSnapshot: order.quote_snapshot,
    items: itemsRes.rows.map(r => ({
      variantId: r.variant_id,
      sku: r.sku,
      title: r.title,
      quantity: Number(r.quantity),
      unitPriceMinor: Number(r.unit_price_minor)
    })),
    payment: pRes.rows.length > 0 ? {
      paymentId: pRes.rows[0].razorpay_payment_id,
      provider: pRes.rows[0].provider,
      status: pRes.rows[0].status,
      method: pRes.rows[0].method
    } : { provider: 'NONE', status: 'UNPAID', paymentId: null },
    provenanceReceipt: receiptRes.rows.length > 0 ? receiptRes.rows[0].full_receipt : null,
    createdAt: order.created_at
  };
}
