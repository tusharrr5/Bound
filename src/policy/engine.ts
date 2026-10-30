import pg from 'pg';
import { pool } from '../db/pool.js';
import { evaluatePurchaseAuthorization, PurchaseAuthorizationDecision } from './authorization.js';
import { resolvePaymentRailCapability, PaymentRailCapability } from '../payments/resolver.js';
import { evaluateRisk, RiskDecision } from './risk.js';
import { evaluateAtomicEconomics, PriceAdjustment, EconomicEvaluationResult } from '../pricing/atomic-evaluator.js';
import { logAuditEvent, PolicyDecisionType } from '../audit/ledger.js';

export interface PolicyEvaluationContext {
  action: 'CHECKOUT_START' | 'DISCOUNT_REQUEST' | 'PAYMENT_EXECUTE';
  merchantId: string;
  buyerAgentId: string;
  cartId?: string;
  mandateTokenId?: string;
  grossAmountMinor: number;
  adjustments?: PriceAdjustment[];
  totalCogsMinor: number;
  categories: string[];
  skuPrefixes?: string[];
  correlationId: string;
  cartHash?: string;
  quoteHash?: string;
  isDemoSimulated?: boolean;
}

export interface PolicyEvaluationResult {
  decision: PolicyDecisionType;
  authorizationDecision: PurchaseAuthorizationDecision;
  riskDecision: RiskDecision;
  paymentRail: PaymentRailCapability;
  reasonCode: string;
  humanReadable: string;
  policyRuleId?: string;
  mandateId?: string;
  remainingBudgetMinor?: number;
  netPayableMinor: number;
  economicResult?: EconomicEvaluationResult;
}

/**
 * Deterministic Policy Engine & Execution Planner:
 * 
 * Synthesizes:
 * 1. Economics: Atomic unit economics & minimum merchant margin floor
 * 2. Authorization: Question 1 (Is purchase authorized by mandate/principal?)
 * 3. Capability: Question 2 (Can payment rail execute autonomously?)
 * 4. Risk: Question 3 (Does fraud/velocity risk permit execution?)
 * 
 * Synthesis Matrix:
 * - If Economics invalid -> DENIED (ECONOMIC_MARGIN_VIOLATION)
 * - If Risk DENY -> DENIED (RISK_ENGINE_DENIAL)
 * - If Authorization DENIED -> DENIED (MANDATE_INVALID / REJECTED)
 * - If Authorization AUTHORIZED + Capability AUTO_EXECUTABLE + Risk ALLOW -> AUTO_EXECUTABLE
 * - If Authorization APPROVAL_REQUIRED OR Capability INTERACTIVE OR Risk REVIEW -> REQUIRES_USER_ACTION
 */
export async function evaluatePolicy(
  ctx: PolicyEvaluationContext,
  txClient?: pg.PoolClient
): Promise<PolicyEvaluationResult> {
  const runner = txClient || pool;
  const adjustments = ctx.adjustments || [];

  // Fetch merchant purchase policy
  const ppRes = await runner.query(`
    SELECT * FROM purchase_policies
    WHERE merchant_id = $1 AND active = true
    LIMIT 1;
  `, [ctx.merchantId]);

  const minGrossMarginBps = ppRes.rows.length > 0 ? Number(ppRes.rows[0].min_gross_margin_bps) : 1200;

  // 1. Economic Margin Floor Gate
  const economicEval = evaluateAtomicEconomics({
    grossAmountMinor: ctx.grossAmountMinor,
    totalCogsMinor: ctx.totalCogsMinor,
    minGrossMarginBps,
    adjustments
  });

  if (!economicEval.valid) {
    await logAuditEvent({
      correlationId: ctx.correlationId,
      actor: 'system:policy_engine',
      action: 'policy.evaluation',
      decision: 'DENIED',
      humanReadable: `Policy Denied: Economic margin violation. ${economicEval.rejectionReason}`,
      policyRuleId: 'RULE_MARGIN_FLOOR_GATE',
      metadata: { grossAmountMinor: ctx.grossAmountMinor, cogsMinor: ctx.totalCogsMinor, reason: economicEval.rejectionReason }
    }, txClient);

    const defaultRail = resolvePaymentRailCapability(undefined, ctx.isDemoSimulated);
    return {
      decision: 'DENIED',
      authorizationDecision: 'DENIED',
      riskDecision: 'ALLOW',
      paymentRail: defaultRail,
      reasonCode: 'ECONOMIC_MARGIN_VIOLATION',
      humanReadable: economicEval.rejectionReason || 'Pricing violates merchant minimum margin floor.',
      policyRuleId: 'RULE_MARGIN_FLOOR_GATE',
      netPayableMinor: economicEval.netPayableMinor,
      economicResult: economicEval
    };
  }

  const netPayable = economicEval.netPayableMinor;

  // 2. Risk Engine Evaluation
  const riskEval = await evaluateRisk({
    merchantId: ctx.merchantId,
    buyerAgentId: ctx.buyerAgentId,
    cartId: ctx.cartId,
    proposedAmountMinor: netPayable,
    categories: ctx.categories,
    txClient
  });

  if (riskEval.decision === 'DENY') {
    await logAuditEvent({
      correlationId: ctx.correlationId,
      actor: 'system:policy_engine',
      action: 'policy.evaluation',
      decision: 'DENIED',
      humanReadable: `Policy Denied: Risk Engine blocked transaction. ${riskEval.reason}`,
      policyRuleId: 'RULE_RISK_ENGINE_DENIAL',
      metadata: { riskScore: riskEval.riskScore, riskFactors: riskEval.riskFactors }
    }, txClient);

    const defaultRail = resolvePaymentRailCapability(undefined, ctx.isDemoSimulated);
    return {
      decision: 'DENIED',
      authorizationDecision: 'DENIED',
      riskDecision: 'DENY',
      paymentRail: defaultRail,
      reasonCode: 'RISK_ENGINE_DENIAL',
      humanReadable: riskEval.reason,
      policyRuleId: 'RULE_RISK_ENGINE_DENIAL',
      netPayableMinor: netPayable,
      economicResult: economicEval
    };
  }

  // 3. Purchase Authorization Engine Evaluation
  const authEval = await evaluatePurchaseAuthorization({
    merchantId: ctx.merchantId,
    buyerAgentId: ctx.buyerAgentId,
    mandateTokenId: ctx.mandateTokenId,
    proposedAmountMinor: netPayable,
    categories: ctx.categories,
    skuPrefixes: ctx.skuPrefixes,
    cartHash: ctx.cartHash,
    quoteHash: ctx.quoteHash,
    txClient
  });

  if (authEval.decision === 'DENIED') {
    await logAuditEvent({
      correlationId: ctx.correlationId,
      actor: 'system:policy_engine',
      action: 'policy.evaluation',
      decision: 'DENIED',
      humanReadable: `Policy Denied: Purchase authorization failed. ${authEval.reason}`,
      policyRuleId: 'RULE_MANDATE_VERIFICATION',
      metadata: { mandateTokenId: ctx.mandateTokenId, reasonCode: authEval.reasonCode }
    }, txClient);

    const defaultRail = resolvePaymentRailCapability(undefined, ctx.isDemoSimulated);
    return {
      decision: 'DENIED',
      authorizationDecision: 'DENIED',
      riskDecision: riskEval.decision,
      paymentRail: defaultRail,
      reasonCode: authEval.reasonCode,
      humanReadable: authEval.reason,
      policyRuleId: 'RULE_MANDATE_VERIFICATION',
      netPayableMinor: netPayable,
      economicResult: economicEval
    };
  }

  // 4. Payment Rail Capability Resolution
  const paymentRail = resolvePaymentRailCapability(undefined, ctx.isDemoSimulated);

  // 5. Execution Planner Synthesis
  let finalDecision: PolicyDecisionType;
  let reasonCode: string;
  let humanReadable: string;

  if (authEval.decision === 'AUTHORIZED' && paymentRail.capabilityType === 'AUTO_EXECUTABLE' && riskEval.decision === 'ALLOW') {
    finalDecision = 'AUTO_EXECUTABLE';
    reasonCode = 'AUTONOMOUS_RAIL_AUTHORIZED';
    humanReadable = `Autonomous payment execution authorized under verified mandate. Rail: ${paymentRail.provider}. Net total: ₹${(netPayable / 100).toFixed(2)}.`;
  } else {
    finalDecision = 'REQUIRES_USER_ACTION';
    reasonCode = authEval.decision === 'APPROVAL_REQUIRED'
      ? 'INTERACTIVE_PURCHASE_APPROVAL_REQUIRED'
      : 'INTERACTIVE_PAYMENT_AUTHENTICATION_REQUIRED';
    humanReadable = paymentRail.description;
  }

  await logAuditEvent({
    correlationId: ctx.correlationId,
    actor: 'system:policy_engine',
    action: 'policy.evaluation',
    decision: finalDecision,
    humanReadable: `Policy Evaluated: ${finalDecision} (${reasonCode}). ${humanReadable}`,
    policyRuleId: 'RULE_EXECUTION_PLANNER_DECISION',
    metadata: {
      decision: finalDecision,
      authorization: authEval.decision,
      risk: riskEval.decision,
      rail: paymentRail.provider,
      netPayableMinor: netPayable,
      grossAmountMinor: ctx.grossAmountMinor,
      mandateId: authEval.mandateId
    }
  }, txClient);

  return {
    decision: finalDecision,
    authorizationDecision: authEval.decision,
    riskDecision: riskEval.decision,
    paymentRail,
    reasonCode,
    humanReadable,
    policyRuleId: 'RULE_EXECUTION_PLANNER_DECISION',
    mandateId: authEval.mandateId,
    remainingBudgetMinor: authEval.remainingBudgetMinor,
    netPayableMinor: netPayable,
    economicResult: economicEval
  };
}
