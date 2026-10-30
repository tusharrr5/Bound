import { pool } from '../db/pool.js';
import { logAuditEvent, PolicyDecisionType } from '../audit/ledger.js';
import { evaluatePolicy } from '../policy/engine.js';
import { PriceAdjustment } from '../pricing/atomic-evaluator.js';

export interface NegotiationResult {
  buyerAgentId: string;
  variantId: string;
  listPriceMinor: number;
  offeredPriceMinor: number;
  roundsUsed: number;
  maxRounds: number;
  status: 'ACCEPTED' | 'COUNTER_OFFER' | 'REJECTED';
  decision: PolicyDecisionType;
  message: string;
}

export async function negotiatePrice(
  buyerAgentId: string,
  variantId: string,
  proposedPriceMinor: number,
  correlationId: string
): Promise<NegotiationResult> {
  const runner = pool;

  // 1. Fetch variant and product pricing + COGS details
  const vRes = await runner.query(`
    SELECT pv.id AS variant_id, pv.sku, pv.price_minor, p.cogs_minor, p.merchant_id, p.category_path
    FROM product_variants pv
    JOIN products p ON p.id = pv.product_id
    WHERE pv.id = $1;
  `, [variantId]);

  if (vRes.rows.length === 0) {
    throw new Error(`Variant ${variantId} not found`);
  }

  const variant = vRes.rows[0];
  const listPriceMinor = Number(variant.price_minor);
  const cogsMinor = Number(variant.cogs_minor);
  const merchantId = variant.merchant_id;
  const categories = variant.category_path || [];

  // 2. Fetch Merchant Policy
  const pRes = await runner.query(`
    SELECT * FROM purchase_policies
    WHERE merchant_id = $1 AND active = true
    ORDER BY version DESC
    LIMIT 1;
  `, [merchantId]);

  const policy = pRes.rows[0] || {
    max_discount_bps: 1000,
    min_gross_margin_bps: 1200,
    max_negotiation_rounds: 2,
    allow_coupon_stacking: false
  };

  // 3. Track Negotiation Session & Max Rounds
  const sRes = await runner.query(`
    SELECT * FROM negotiation_sessions
    WHERE buyer_agent_id = $1 AND variant_id = $2 AND status = 'OPEN' AND expires_at > NOW()
    ORDER BY created_at DESC LIMIT 1;
  `, [buyerAgentId, variantId]);

  let roundsUsed = 1;
  if (sRes.rows.length > 0) {
    roundsUsed = sRes.rows[0].rounds_used + 1;
    if (roundsUsed > policy.max_negotiation_rounds) {
      await logAuditEvent({
        correlationId,
        actor: `merchant:pricing_engine`,
        action: 'negotiation.max_rounds_exceeded',
        decision: 'DENIED',
        humanReadable: `Negotiation rejected for variant ${variant.sku}: Exceeded maximum ${policy.max_negotiation_rounds} negotiation rounds.`,
        policyRuleId: 'RULE_MAX_NEGOTIATION_ROUNDS',
        metadata: { buyerAgentId, variantId, roundsUsed }
      });

      return {
        buyerAgentId,
        variantId,
        listPriceMinor,
        offeredPriceMinor: Number(sRes.rows[0].last_offered_price_minor || listPriceMinor),
        roundsUsed,
        maxRounds: policy.max_negotiation_rounds,
        status: 'REJECTED',
        decision: 'DENIED',
        message: `Maximum negotiation rounds (${policy.max_negotiation_rounds}) reached. Offering final counter-offer.`
      };
    }
  }

  // 4. Calculate Absolute Floor Price based on COGS + Minimum Margin requirement
  const minMarginMultiplier = 1 + (policy.min_gross_margin_bps / 10000);
  const cogsMarginFloorMinor = Math.ceil(cogsMinor * minMarginMultiplier);

  // Maximum allowed policy discount from list price
  const maxPolicyDiscountMinor = Math.floor(listPriceMinor * (policy.max_discount_bps / 10000));
  const maxDiscountFloorMinor = listPriceMinor - maxPolicyDiscountMinor;

  // The true floor is the higher of the two (never breaches margin or max discount)
  const absoluteFloorMinor = Math.max(cogsMarginFloorMinor, maxDiscountFloorMinor);

  // 5. Evaluate proposed price through the central Policy Engine
  const proposedDiscountMinor = Math.max(0, listPriceMinor - proposedPriceMinor);
  const proposedAdjustments: PriceAdjustment[] = [
    {
      sourceType: 'NEGOTIATED_DISCOUNT',
      fundingParty: 'MERCHANT',
      amountMinor: proposedDiscountMinor,
      stackGroup: 'DISCOUNT',
      ruleId: 'NEGOTIATED_AGENT_DISCOUNT'
    }
  ];

  const policyEval = await evaluatePolicy({
    action: 'DISCOUNT_REQUEST',
    merchantId,
    buyerAgentId,
    grossAmountMinor: listPriceMinor,
    totalCogsMinor: cogsMinor,
    categories,
    adjustments: proposedAdjustments,
    correlationId
  });

  let status: 'ACCEPTED' | 'COUNTER_OFFER' | 'REJECTED';
  let agreedPriceMinor: number;
  let decision: PolicyDecisionType;
  let message: string;

  if (proposedPriceMinor >= listPriceMinor) {
    status = 'ACCEPTED';
    agreedPriceMinor = listPriceMinor;
    decision = 'AUTO_EXECUTABLE';
    message = 'List price accepted.';
  } else if (proposedPriceMinor >= absoluteFloorMinor && policyEval.decision !== 'DENIED') {
    status = 'ACCEPTED';
    agreedPriceMinor = proposedPriceMinor;
    decision = 'AUTO_EXECUTABLE';
    message = `Discount approved! Item offered at ₹${(agreedPriceMinor / 100).toFixed(2)}.`;
  } else {
    // Dynamic counter-offer at floor
    agreedPriceMinor = absoluteFloorMinor;
    status = 'COUNTER_OFFER';
    decision = 'REQUIRES_USER_ACTION';
    message = `Proposed price ₹${(proposedPriceMinor / 100).toFixed(2)} is below acceptable merchant policy. Counter-offer: ₹${(agreedPriceMinor / 100).toFixed(2)}.`;
  }

  // Update or insert negotiation session
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  const sessionStatus = (status as string) === 'REJECTED' ? 'REJECTED' : 'OPEN';
  await runner.query(`
    INSERT INTO negotiation_sessions (
      buyer_agent_id, variant_id, rounds_used, last_offered_price_minor, status, expires_at, correlation_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7);
  `, [buyerAgentId, variantId, roundsUsed, agreedPriceMinor, sessionStatus, expiresAt, correlationId]);

  const effectiveDiscountBps = Math.round(((listPriceMinor - agreedPriceMinor) / listPriceMinor) * 10000);

  await logAuditEvent({
    correlationId,
    actor: `merchant:pricing_engine`,
    action: 'negotiation.response',
    decision,
    humanReadable: `Negotiation ${status}: List ₹${(listPriceMinor / 100).toFixed(2)} → Offered ₹${(agreedPriceMinor / 100).toFixed(2)} (${(effectiveDiscountBps / 100).toFixed(1)}% off). ${message}`,
    policyRuleId: 'RULE_SAFE_BOUNDED_NEGOTIATION',
    metadata: {
      buyerAgentId,
      variantId,
      listPriceMinor,
      offeredPriceMinor: agreedPriceMinor,
      effectiveDiscountBps,
      roundsUsed,
      status
    }
  });

  return {
    buyerAgentId,
    variantId,
    listPriceMinor,
    offeredPriceMinor: agreedPriceMinor,
    roundsUsed,
    maxRounds: policy.max_negotiation_rounds,
    status,
    decision,
    message
  };
}
