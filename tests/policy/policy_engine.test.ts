import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { seedDatabase, getCanonicalMandateString } from '../../src/db/seed.js';
import { evaluatePolicy } from '../../src/policy/engine.js';
import { evaluatePurchaseAuthorization } from '../../src/policy/authorization.js';
import { resolvePaymentRailCapability } from '../../src/payments/resolver.js';
import { evaluateRisk } from '../../src/policy/risk.js';
import { pool } from '../../src/db/pool.js';
import {
  consumeMandateBudget,
  reserveMandateBudget,
  commitMandateBudget,
  releaseMandateBudget,
  signMandate,
  verifyPurchaseMandate
} from '../../src/policy/mandates.js';
import { computeCanonicalCartHash, createQuoteSnapshot } from '../../src/pricing/quotes.js';
import {
  validateOrderTransition,
  validatePaymentTransition,
  canTransitionOrder,
  canTransitionPayment,
  validateCheckoutTransition,
  canTransitionCheckout,
  validateRefundTransition,
  canTransitionRefund
} from '../../src/policy/state-machines.js';
import {
  createAgentDelegation,
  createPurchaseMandateFromDelegation,
  getMandateDetails,
  revokeMandate,
  updateDelegationBudget,
  revokeAgentDelegation,
  validateDelegationSubset
} from '../../src/policy/delegation.js';

describe('Deterministic Policy Engine, Authorization & Risk Suite', () => {
  const merchantId = '11111111-1111-1111-1111-111111111111';
  const buyerAgentId = '22222222-2222-2222-2222-222222222222';
  const activeMandateToken = 'mandate_tok_demo_2026';

  beforeEach(async () => {
    await seedDatabase();
  });

  it('Decomposes decisions into distinct Authorization, Capability, and Risk engines', async () => {
    // 1. Authorization Engine
    const auth = await evaluatePurchaseAuthorization({
      merchantId,
      buyerAgentId,
      mandateTokenId: activeMandateToken,
      proposedAmountMinor: 479900,
      categories: ['Appliances', 'Coffee Machines']
    });
    expect(auth.decision).toBe('AUTHORIZED');

    // 2. Payment Capability Resolver
    const cap = resolvePaymentRailCapability(undefined, false);
    expect(cap.capabilityType).toBe('INTERACTIVE');
    expect(cap.provider).toBe('RAZORPAY_CHECKOUT');

    // 3. Risk Engine
    const risk = await evaluateRisk({
      merchantId,
      buyerAgentId,
      proposedAmountMinor: 479900,
      categories: ['Appliances']
    });
    expect(risk.decision).toBe('ALLOW');

    // Combined synthesized policy evaluation
    const res = await evaluatePolicy({
      action: 'CHECKOUT_START',
      merchantId,
      buyerAgentId,
      mandateTokenId: activeMandateToken,
      grossAmountMinor: 479900,
      totalCogsMinor: 320000,
      categories: ['Appliances', 'Coffee Machines'],
      correlationId: 'corr_split_test'
    });

    expect(res.decision).toBe('REQUIRES_USER_ACTION');
    expect(res.authorizationDecision).toBe('AUTHORIZED');
    expect(res.paymentRail.capabilityType).toBe('INTERACTIVE');
  });

  it('Denies checkout when proposed total exceeds mandate ceiling limit', async () => {
    const result = await evaluatePolicy({
      action: 'CHECKOUT_START',
      merchantId,
      buyerAgentId,
      cartId: 'cart_test_overbudget',
      mandateTokenId: activeMandateToken,
      grossAmountMinor: 1500000, // ₹15,000 > ₹10,000 ceiling
      totalCogsMinor: 800000,
      categories: ['Electronics'],
      correlationId: 'corr_policy_test_1'
    });

    expect(result.decision).toBe('DENIED');
    expect(result.reasonCode).toBe('MANDATE_EXHAUSTED');
    expect(result.humanReadable).toContain('exceeds');
  });

  it('Denies checkout when purchasing disallowed category outside mandate whitelist', async () => {
    const result = await evaluatePolicy({
      action: 'CHECKOUT_START',
      merchantId,
      buyerAgentId,
      cartId: 'cart_test_disallowed_cat',
      mandateTokenId: activeMandateToken,
      grossAmountMinor: 300000,
      totalCogsMinor: 150000,
      categories: ['Automotive', 'Firearms'], // Not in allowed categories
      correlationId: 'corr_policy_test_2'
    });

    expect(result.decision).toBe('DENIED');
    expect(result.reasonCode).toBe('CATEGORY_DISALLOWED');
  });

  it('Denies checkout when buyer agent ID does not match mandate bound agent', async () => {
    const unauthorizedAgentId = '99999999-9999-9999-9999-999999999999';
    const result = await evaluatePolicy({
      action: 'CHECKOUT_START',
      merchantId,
      buyerAgentId: unauthorizedAgentId,
      cartId: 'cart_test_agent_mismatch',
      mandateTokenId: activeMandateToken,
      grossAmountMinor: 479900,
      totalCogsMinor: 320000,
      categories: ['Appliances'],
      correlationId: 'corr_policy_test_3'
    });

    expect(result.decision).toBe('DENIED');
    expect(result.reasonCode).toBe('AGENT_MISMATCH');
  });

  it('Enforces cryptographic Intent Binding: Denies checkout if cart_hash has been modified (P0.2)', async () => {
    const boundAgentId = '22222222-2222-2222-2222-222222222222';
    const originalItems = [{ variantId: '44444444-4444-4444-4444-444444444444', quantity: 1 }];
    const originalCartHash = computeCanonicalCartHash(merchantId, 'cart_canonical_1', originalItems);

    const modifiedItems = [{ variantId: '44444444-4444-4444-4444-444444444444', quantity: 2 }];
    const modifiedCartHash = computeCanonicalCartHash(merchantId, 'cart_canonical_1', modifiedItems);

    const keyPair = crypto.generateKeyPairSync('ed25519');
    const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

    await pool.query(`UPDATE mandate_key_bindings SET public_key = $1 WHERE buyer_agent_id = $2`, [publicKey, boundAgentId]);

    const mandatePayload = {
      mandate_token_id: 'mandate_tok_cart_bound',
      buyer_agent_id: boundAgentId,
      merchant_id: merchantId,
      max_total_amount_minor: 1000000,
      nonce: 'nonce_cart_bound_01'
    };

    const sig = signMandate(privateKey, mandatePayload);

    await pool.query(`
      INSERT INTO purchase_mandates (
        mandate_token_id, buyer_agent_id, merchant_id, max_total_amount_minor,
        currency, nonce, signature, signature_algorithm, status, not_before, expires_at, cart_hash
      ) VALUES ($1, $2, $3, $4, 'INR', $5, $6, 'Ed25519', 'ACTIVE', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 day', $7)
      ON CONFLICT (mandate_token_id) DO UPDATE SET cart_hash = $7, signature = $6;
    `, [
      mandatePayload.mandate_token_id,
      mandatePayload.buyer_agent_id,
      mandatePayload.merchant_id,
      mandatePayload.max_total_amount_minor,
      mandatePayload.nonce,
      sig,
      originalCartHash
    ]);

    const result = await evaluatePurchaseAuthorization({
      merchantId,
      buyerAgentId: boundAgentId,
      mandateTokenId: 'mandate_tok_cart_bound',
      proposedAmountMinor: 479900,
      categories: ['Appliances'],
      cartHash: modifiedCartHash
    });

    expect(result.decision).toBe('DENIED');
    expect(result.reasonCode).toBe('CART_HASH_MISMATCH');
  });

  it('Enforces cryptographic Intent Binding: Rejects when quote_hash has been altered (P0.3)', async () => {
    const boundAgentId = '22222222-2222-2222-2222-222222222222';
    const originalQuote = createQuoteSnapshot({
      quoteId: 'q_test_1',
      merchantId,
      lines: [{ variantId: 'v1', quantity: 1, unitPriceMinor: 100000, priceVersion: 1 }],
      finalTotalMinor: 100000,
      currency: 'INR'
    });
    const originalQuoteHash = originalQuote.quoteHash;
    const alteredQuoteHash = crypto.createHash('sha256').update('altered_quote').digest('hex');

    const keyPair = crypto.generateKeyPairSync('ed25519');
    const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

    await pool.query(`UPDATE mandate_key_bindings SET public_key = $1 WHERE buyer_agent_id = $2`, [publicKey, boundAgentId]);

    const mandatePayload = {
      mandate_token_id: 'mandate_tok_quote_bound',
      buyer_agent_id: boundAgentId,
      merchant_id: merchantId,
      max_total_amount_minor: 1000000,
      nonce: 'nonce_quote_bound_01'
    };

    const sig = signMandate(privateKey, mandatePayload);

    await pool.query(`
      INSERT INTO purchase_mandates (
        mandate_token_id, buyer_agent_id, merchant_id, max_total_amount_minor,
        currency, nonce, signature, signature_algorithm, status, not_before, expires_at, quote_hash
      ) VALUES ($1, $2, $3, $4, 'INR', $5, $6, 'Ed25519', 'ACTIVE', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 day', $7)
      ON CONFLICT (mandate_token_id) DO UPDATE SET quote_hash = $7, signature = $6;
    `, [
      mandatePayload.mandate_token_id,
      mandatePayload.buyer_agent_id,
      mandatePayload.merchant_id,
      mandatePayload.max_total_amount_minor,
      mandatePayload.nonce,
      sig,
      originalQuoteHash
    ]);

    const result = await evaluatePurchaseAuthorization({
      merchantId,
      buyerAgentId: boundAgentId,
      mandateTokenId: 'mandate_tok_quote_bound',
      proposedAmountMinor: 100000,
      categories: ['Electronics'],
      quoteHash: alteredQuoteHash
    });

    expect(result.decision).toBe('DENIED');
    expect(result.reasonCode).toBe('QUOTE_HASH_MISMATCH');
  });

  it('Denies pricing when combinatorial discounts breach merchant COGS or minimum margin floor', async () => {
    const result = await evaluatePolicy({
      action: 'CHECKOUT_START',
      merchantId,
      buyerAgentId,
      cartId: 'cart_test_margin_breach',
      grossAmountMinor: 500000, // ₹5,000
      totalCogsMinor: 400000,   // ₹4,000 COGS (requires at least 12% margin = ₹4,480)
      categories: ['Electronics'],
      adjustments: [
        {
          sourceType: 'NEGOTIATED_DISCOUNT',
          fundingParty: 'MERCHANT',
          amountMinor: 80000, // ₹800 discount -> Net ₹4,200 < ₹4,480 floor
          stackGroup: 'DISCOUNT',
          ruleId: 'TEST_HEAVY_DISCOUNT'
        }
      ],
      correlationId: 'corr_policy_test_4'
    });

    expect(result.decision).toBe('DENIED');
    expect(result.reasonCode).toBe('ECONOMIC_MARGIN_VIOLATION');
    expect(result.humanReadable).toContain('violates merchant floor');
  });

  it('Resolves to REQUIRES_USER_ACTION on standard checkout without autonomous mandate', async () => {
    const result = await evaluatePolicy({
      action: 'CHECKOUT_START',
      merchantId,
      buyerAgentId,
      cartId: 'cart_test_interactive',
      grossAmountMinor: 349900,
      totalCogsMinor: 210000,
      categories: ['Electronics'],
      correlationId: 'corr_policy_test_5'
    });

    expect(result.decision).toBe('REQUIRES_USER_ACTION');
    expect(result.paymentRail.provider).toBe('RAZORPAY_CHECKOUT');
    expect(result.paymentRail.accessTier).toBe('DEFAULT_TEST_MODE');
  });

  it('Resolves to AUTO_EXECUTABLE with valid Ed25519 mandate and demo simulation mode', async () => {
    const result = await evaluatePolicy({
      action: 'CHECKOUT_START',
      merchantId,
      buyerAgentId,
      cartId: 'cart_test_auto',
      mandateTokenId: activeMandateToken,
      grossAmountMinor: 479900,
      totalCogsMinor: 320000,
      categories: ['Appliances', 'Coffee Machines'],
      correlationId: 'corr_policy_test_6',
      isDemoSimulated: true
    });

    expect(result.decision).toBe('AUTO_EXECUTABLE');
    expect(result.paymentRail.accessTier).toBe('SIMULATED');
    expect(result.paymentRail.provider).toBe('MOCK_SIMULATED_RAIL');
  });

  it('Enforces Mandate Budget Reserve / Commit / Release lifecycle (P1.5)', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const testMandateId = '66666666-6666-6666-6666-666666666666';
      await client.query(`
        INSERT INTO purchase_mandates (
          id, mandate_token_id, buyer_agent_id, merchant_id, max_total_amount_minor, spent_amount_minor, reserved_amount_minor,
          per_txn_limit_minor, allowed_categories, currency, nonce, signature, signature_algorithm, status, not_before, expires_at
        ) VALUES (
          $1, 'mandate_reserve_test', $2, $3, 1000000, 0, 0, 800000, ARRAY['Electronics'], 'INR', 'nonce_b_res', 'sig_fake', 'Ed25519', 'ACTIVE', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '1 day'
        ) ON CONFLICT (id) DO UPDATE SET spent_amount_minor = 0, reserved_amount_minor = 0, status = 'ACTIVE';
      `, [testMandateId, buyerAgentId, merchantId]);

      // 1. Reserve ₹6,000
      const res1 = await reserveMandateBudget(testMandateId, 600000, client);
      expect(res1.ok).toBe(true);
      expect(res1.newReservedMinor).toBe(600000);

      // 2. Attempt to reserve another ₹5,000 (total ₹11,000 exceeds ₹10,000 limit -> rejected)
      const res2 = await reserveMandateBudget(testMandateId, 500000, client);
      expect(res2.ok).toBe(false);

      // 3. Commit ₹6,000 on successful payment
      const commitRes = await commitMandateBudget(testMandateId, 600000, client);
      expect(commitRes.ok).toBe(true);
      expect(commitRes.newSpentMinor).toBe(600000);

      // 4. Reserve remaining ₹3,000
      const res3 = await reserveMandateBudget(testMandateId, 300000, client);
      expect(res3.ok).toBe(true);

      // 5. Release reserved ₹3,000 on cancelled session
      const relRes = await releaseMandateBudget(testMandateId, 300000, client);
      expect(relRes.ok).toBe(true);

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('Enforces Non-Linear Legal State Machine Transitions across Checkout, Payment, Order & Refund Lifecycles (P0.4)', () => {
    // 1. Checkout Lifecycle
    expect(canTransitionCheckout('PENDING', 'AWAITING_AUTH')).toBe(true);
    expect(canTransitionCheckout('AWAITING_AUTH', 'PAID')).toBe(true);
    expect(canTransitionCheckout('PAID', 'AWAITING_AUTH')).toBe(false);
    expect(() => validateCheckoutTransition('PAID', 'AWAITING_AUTH')).toThrow('ILLEGAL_CHECKOUT_STATE_TRANSITION');

    // 2. Payment Lifecycle
    expect(canTransitionPayment('CREATED', 'PENDING')).toBe(true);
    expect(canTransitionPayment('PENDING', 'AUTHORIZED')).toBe(true);
    expect(canTransitionPayment('AUTHORIZED', 'CAPTURED')).toBe(true);
    expect(canTransitionPayment('CAPTURED', 'REFUNDED')).toBe(true);

    // Illegal Payment Transitions MUST FAIL
    expect(canTransitionPayment('CAPTURED', 'FAILED')).toBe(false);
    expect(() => validatePaymentTransition('CAPTURED', 'FAILED')).toThrow('ILLEGAL_PAYMENT_STATE_TRANSITION');
    expect(canTransitionPayment('REFUNDED', 'CAPTURED')).toBe(false);
    expect(() => validatePaymentTransition('REFUNDED', 'CAPTURED')).toThrow('ILLEGAL_PAYMENT_STATE_TRANSITION');

    // 3. Order Lifecycle
    expect(canTransitionOrder('PENDING_CONFIRMATION', 'CONFIRMED')).toBe(true);
    expect(canTransitionOrder('CONFIRMED', 'PROCESSING')).toBe(true);
    expect(canTransitionOrder('PROCESSING', 'SHIPPED')).toBe(true);
    expect(canTransitionOrder('SHIPPED', 'DELIVERED')).toBe(true);
    expect(canTransitionOrder('FULFILMENT_EXCEPTION', 'REFUNDED')).toBe(true);

    // Illegal Order Transitions MUST FAIL
    expect(canTransitionOrder('DELIVERED', 'CONFIRMED')).toBe(false);
    expect(() => validateOrderTransition('DELIVERED', 'CONFIRMED')).toThrow('ILLEGAL_ORDER_STATE_TRANSITION');
    expect(canTransitionOrder('CANCELLED', 'CONFIRMED')).toBe(false);
    expect(() => validateOrderTransition('CANCELLED', 'CONFIRMED')).toThrow('ILLEGAL_ORDER_STATE_TRANSITION');

    // 4. Refund Lifecycle (Independent Entity)
    expect(canTransitionRefund('CREATED', 'SUBMITTED')).toBe(true);
    expect(canTransitionRefund('SUBMITTED', 'PROCESSING')).toBe(true);
    expect(canTransitionRefund('PROCESSING', 'PROCESSED')).toBe(true);
    expect(canTransitionRefund('PROCESSING', 'FAILED')).toBe(true);

    // Illegal Refund Transitions MUST FAIL
    expect(canTransitionRefund('PROCESSED', 'SUBMITTED')).toBe(false);
    expect(() => validateRefundTransition('PROCESSED', 'SUBMITTED')).toThrow('ILLEGAL_REFUND_STATE_TRANSITION');
    expect(canTransitionRefund('PROCESSED', 'PROCESSING')).toBe(false);
    expect(() => validateRefundTransition('PROCESSED', 'PROCESSING')).toThrow('ILLEGAL_REFUND_STATE_TRANSITION');
  });

  it('Demonstrates Full Human-to-Agent Delegation & Mandate Revocation Lifecycle (P0.3)', async () => {
    // 1. Human creates delegation
    const delegation = await createAgentDelegation({
      principalName: 'Priya Patel',
      buyerAgentId,
      merchantId,
      allowedCategories: ['Appliances'],
      maxTotalAmountMinor: 800000,
      autonomousPurchaseAllowed: true
    }, 'corr_del_test');

    expect(delegation.status).toBe('ACTIVE');
    expect(delegation.maxTotalAmountMinor).toBe(800000);

    // 2. Issue mandate derived from active delegation
    const keyPair = crypto.generateKeyPairSync('ed25519');
    const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

    await pool.query(`UPDATE mandate_key_bindings SET public_key = $1 WHERE buyer_agent_id = $2`, [publicKey, buyerAgentId]);

    const mandateRes = await createPurchaseMandateFromDelegation({
      delegationId: delegation.id,
      buyerAgentId,
      merchantId,
      maxTotalAmountMinor: 500000 // ₹5,000 <= ₹8,000 delegation ceiling
    }, privateKey, 'corr_man_issue_test');

    expect(mandateRes.ok).toBe(true);
    expect(mandateRes.mandateTokenId).toBeDefined();

    // 3. Fetch Mandate Details & available budget
    const details = await getMandateDetails(mandateRes.mandateTokenId!);
    expect(details?.status).toBe('ACTIVE');
    expect(details?.availableBudgetMinor).toBe(500000);

    // 4. Revoke Mandate
    const revokeRes = await revokeMandate(mandateRes.mandateTokenId!, 'User security precaution', 'corr_rev_test');
    expect(revokeRes.ok).toBe(true);

    const revokedDetails = await getMandateDetails(mandateRes.mandateTokenId!);
    expect(revokedDetails?.status).toBe('REVOKED');
  });

  it('Delegation Revocation Cascade: Immediately invalidates all child mandates dynamically even if mandate status in storage is ACTIVE', async () => {
    // 1. Create parent delegation
    const delegation = await createAgentDelegation({
      principalName: 'Vikram Seth',
      buyerAgentId,
      merchantId,
      allowedCategories: ['Appliances', 'Coffee Machines'],
      maxTotalAmountMinor: 1000000, // ₹10,000 ceiling
      autonomousPurchaseAllowed: true
    }, 'corr_casc_del');

    // 2. Issue child mandate
    const keyPair = crypto.generateKeyPairSync('ed25519');
    const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await pool.query(`UPDATE mandate_key_bindings SET public_key = $1 WHERE buyer_agent_id = $2`, [publicKey, buyerAgentId]);

    const mandateRes = await createPurchaseMandateFromDelegation({
      delegationId: delegation.id,
      buyerAgentId,
      merchantId,
      maxTotalAmountMinor: 800000, // ₹8,000
      allowedCategories: ['Coffee Machines']
    }, privateKey, 'corr_casc_man');

    expect(mandateRes.ok).toBe(true);
    const tokenId = mandateRes.mandateTokenId!;

    // 3. Verify mandate is initially valid
    const preCheck = await verifyPurchaseMandate(tokenId, merchantId, buyerAgentId, 450000, ['Coffee Machines']);
    expect(preCheck.valid).toBe(true);

    // 4. Human REVOKES the parent delegation
    const revDelRes = await revokeAgentDelegation(delegation.id, 'Lost phone / compromised agent', 'corr_casc_rev');
    expect(revDelRes.ok).toBe(true);

    // 5. Dynamic Check: Even if mandate record in database was untouched, verification MUST FAIL IMMEDIATELY
    const postCheck = await verifyPurchaseMandate(tokenId, merchantId, buyerAgentId, 450000, ['Coffee Machines']);
    expect(postCheck.valid).toBe(false);
    expect(postCheck.errorCode).toBe('PARENT_DELEGATION_REVOKED');
    expect(postCheck.reason).toContain('parent delegation');

    // 6. getMandateDetails returns status: 'REVOKED'
    const details = await getMandateDetails(tokenId);
    expect(details?.status).toBe('REVOKED');
    expect(details?.delegationStatus).toBe('REVOKED');
  });

  it('Version Binding & Dynamic Budget Reduction: Reduced delegation ceiling dynamically constrains pre-existing child mandates', async () => {
    // 1. Human creates delegation with ₹10,000 budget (Version 1)
    const delegation = await createAgentDelegation({
      principalName: 'Ananya Deshmukh',
      buyerAgentId,
      merchantId,
      allowedCategories: ['Electronics', 'Appliances'],
      maxTotalAmountMinor: 1000000, // ₹10,000
      autonomousPurchaseAllowed: true
    }, 'corr_ver_del');

    expect(delegation.version).toBe(1);

    // 2. Child mandate is generated for ₹10,000
    const keyPair = crypto.generateKeyPairSync('ed25519');
    const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await pool.query(`UPDATE mandate_key_bindings SET public_key = $1 WHERE buyer_agent_id = $2`, [publicKey, buyerAgentId]);

    const mandateRes = await createPurchaseMandateFromDelegation({
      delegationId: delegation.id,
      buyerAgentId,
      merchantId,
      maxTotalAmountMinor: 1000000 // ₹10,000
    }, privateKey, 'corr_ver_man');

    const tokenId = mandateRes.mandateTokenId!;

    // 3. Verify order of ₹7,000 passes under initial ₹10,000 budget
    const check1 = await verifyPurchaseMandate(tokenId, merchantId, buyerAgentId, 700000, ['Electronics']);
    expect(check1.valid).toBe(true);

    // 4. Human steps up and REDUCES delegation budget to ₹5,000 (Version 2)
    const updateRes = await updateDelegationBudget(delegation.id, 500000, 'corr_ver_update');
    expect(updateRes.ok).toBe(true);
    expect(updateRes.delegation?.version).toBe(2);
    expect(updateRes.delegation?.maxTotalAmountMinor).toBe(500000);

    // 5. Invariant: Pre-existing child mandate (signed for ₹10,000) is now dynamically constrained to ₹5,000
    // Attempting ₹7,000 purchase MUST BE REJECTED with MANDATE_EXCEEDS_PARENT_DELEGATION_CEILING
    const checkOverBudget = await verifyPurchaseMandate(tokenId, merchantId, buyerAgentId, 700000, ['Electronics']);
    expect(checkOverBudget.valid).toBe(false);
    expect(checkOverBudget.errorCode).toBe('MANDATE_EXCEEDS_PARENT_DELEGATION_CEILING');
    expect(checkOverBudget.reason).toContain('parent delegation');

    // Attempting ₹4,500 purchase (within new ₹5,000 ceiling) MUST PASS
    const checkWithinBudget = await verifyPurchaseMandate(tokenId, merchantId, buyerAgentId, 450000, ['Electronics']);
    expect(checkWithinBudget.valid).toBe(true);
    expect(checkWithinBudget.maxTotalAmountMinor).toBe(500000); // dynamically constrained
  });

  it('Monotonic Narrowing Rule: validateDelegationSubset strictly rejects child mandate exceeding parent amount and category bounds', async () => {
    // 1. Parent Delegation: ₹10,000 ceiling, 'Electronics' only
    const parentDelegation = await createAgentDelegation({
      principalName: 'Meera Nambiar',
      buyerAgentId,
      merchantId,
      allowedCategories: ['Electronics'],
      maxTotalAmountMinor: 1000000, // ₹10,000
      validityHours: 72
    }, 'corr_mono_del');

    // 2. Direct unit evaluation of validateDelegationSubset
    const invalidChildProposal = {
      maxTotalAmountMinor: 2000000, // ₹20,000 > ₹10,000
      allowedCategories: ['Electronics', 'Jewellery'], // Jewellery ⊄ ['Electronics']
      validityHours: 24
    };

    const directSubsetResult = validateDelegationSubset(
      {
        maxTotalAmountMinor: parentDelegation.maxTotalAmountMinor,
        expiresAt: parentDelegation.expiresAt,
        allowedCategories: parentDelegation.allowedCategories
      },
      invalidChildProposal
    );

    expect(directSubsetResult.valid).toBe(false);
    expect(directSubsetResult.errors.length).toBe(2);
    expect(directSubsetResult.errors.some(e => e.includes('AMOUNT_EXCEEDS_PARENT'))).toBe(true);
    expect(directSubsetResult.errors.some(e => e.includes('CATEGORIES_NOT_SUBSET'))).toBe(true);

    // 3. Evaluation during mandate issuance API
    const keyPair = crypto.generateKeyPairSync('ed25519');
    const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    await pool.query(`UPDATE mandate_key_bindings SET public_key = $1 WHERE buyer_agent_id = $2`, [publicKey, buyerAgentId]);

    const mandateIssuance = await createPurchaseMandateFromDelegation({
      delegationId: parentDelegation.id,
      buyerAgentId,
      merchantId,
      maxTotalAmountMinor: 2000000, // ₹20,000
      allowedCategories: ['Electronics', 'Jewellery']
    }, privateKey, 'corr_mono_man_fail');

    expect(mandateIssuance.ok).toBe(false);
    expect(mandateIssuance.error).toContain('MONOTONIC_NARROWING_VIOLATION');
    expect(mandateIssuance.error).toContain('AMOUNT_EXCEEDS_PARENT');
    expect(mandateIssuance.error).toContain('CATEGORIES_NOT_SUBSET');
  });

  it('Seller Agent Façade: Handles A2A dialogue, negotiation explanation, and delegates pricing/stock/payment to deterministic engines', async () => {
    const { SellerAgent } = await import('../../src/agent/seller-agent.js');
    const seller = new SellerAgent('seller_agent_apex_v1', merchantId, 'Apex Global Retail');

    const principal = {
      principalType: 'BUYER_AGENT' as const,
      agentId: buyerAgentId,
      principalName: 'Test Buyer Agent',
      scopes: ['catalog:read', 'cart:write', 'negotiate:write', 'checkout:write'],
      sessionId: 'corr_seller_test',
      authenticatedVia: 'CRYPTOGRAPHIC_JWT' as const
    };

    // 1. Search Inquiry
    const searchResp = await seller.handleBuyerMessage({
      intent: 'SEARCH_PRODUCTS',
      parameters: { query: 'coffee' },
      correlationId: 'corr_seller_search',
      principalContext: principal
    });
    expect(searchResp.intentProcessed).toBe('SEARCH_PRODUCTS');
    expect(searchResp.dialogue).toContain('catalog search for "coffee"');
    expect(searchResp.result.results.length).toBeGreaterThan(0);

    const variantId = searchResp.result.results[0].variantId;

    // 2. Negotiation Dialogue with Policy Grounding
    const negResp = await seller.handleBuyerMessage({
      intent: 'NEGOTIATE_PRICE',
      parameters: { variant_id: variantId, proposed_price_minor: 455905 },
      correlationId: 'corr_seller_neg',
      principalContext: principal
    });
    expect(negResp.intentProcessed).toBe('NEGOTIATE_PRICE');
    expect(negResp.dialogue).toContain('Negotiation Accepted');
    expect(negResp.policyExplanation).toContain('private pricing and promotion policies');
    expect(negResp.policyExplanation).toContain('confidential');

    // 3. Autonomous Checkout Delegation
    const cart = await seller.handleBuyerMessage({
      intent: 'INITIALIZE_CART',
      parameters: {},
      correlationId: 'corr_seller_cart',
      principalContext: principal
    });

    await seller.handleBuyerMessage({
      intent: 'RESERVE_ITEM',
      parameters: { cart_id: cart.result.cartId, variant_id: variantId, quantity: 1 },
      correlationId: 'corr_seller_res',
      principalContext: principal
    });

    const checkoutResp = await seller.handleBuyerMessage({
      intent: 'SUBMIT_CHECKOUT',
      parameters: {
        cart_id: cart.result.cartId,
        mandate_token_id: 'mandate_tok_demo_2026',
        shipping_address: { line1: 'Test St', city: 'Bengaluru', country: 'IN' }
      },
      correlationId: 'corr_seller_chk',
      principalContext: principal
    });

    // The seeded demo mandate is not bound to a purchase task, so autonomous checkout must refuse it:
    // a mandate proves a budget, not that the items are what the human asked for. (The successful
    // task-bound path is covered in tests/security/intent_authorization.test.ts.)
    expect(checkoutResp.intentProcessed).toBe('SUBMIT_CHECKOUT');
    expect(checkoutResp.dialogue).toContain('Checkout Rejected');
    expect(checkoutResp.result.errorCode).toBe('AUTONOMOUS_CHECKOUT_REQUIRES_TASK');
  });
});
