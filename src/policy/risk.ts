import pg from 'pg';
import { pool } from '../db/pool.js';

export type RiskDecision = 'ALLOW' | 'REVIEW' | 'DENY';

export interface RiskEvaluationContext {
  merchantId: string;
  buyerAgentId: string;
  cartId?: string;
  proposedAmountMinor: number;
  categories: string[];
  txClient?: pg.PoolClient;
}

export interface RiskEvaluationResult {
  decision: RiskDecision;
  riskScore: number; // 0 (lowest) to 100 (highest)
  riskFactors: string[];
  reason: string;
}

/**
 * Question 3: Does real-time transaction risk permit execution?
 * 
 * - ALLOW: Low risk profile (normal velocity, acceptable transaction value, standard category).
 * - REVIEW: Elevated risk (unusually large ticket size or velocity spike requiring secondary review).
 * - DENY: Extreme risk (blacklisted principal, extreme velocity abuse, or prohibited risk threshold).
 */
export async function evaluateRisk(
  ctx: RiskEvaluationContext
): Promise<RiskEvaluationResult> {
  const runner = ctx.txClient || pool;
  let riskScore = 5; // Base low risk
  const riskFactors: string[] = [];

  // 1. High ticket value check (> ₹100,000)
  if (ctx.proposedAmountMinor > 10000000) {
    riskScore += 30;
    riskFactors.push('HIGH_TRANSACTION_VALUE');
  }

  // 2. Velocity check: recent orders count in last 5 minutes
  const recentOrdersRes = await runner.query(`
    SELECT COUNT(*) as count, COALESCE(SUM(total_minor), 0) as velocity_sum
    FROM orders
    WHERE buyer_agent_id = $1 AND created_at > NOW() - INTERVAL '5 minutes';
  `, [ctx.buyerAgentId]);

  const velocityCount = Number(recentOrdersRes.rows[0].count);
  if (velocityCount > 20) {
    riskScore += 60;
    riskFactors.push('EXCESSIVE_TRANSACTION_VELOCITY');
  } else if (velocityCount > 5) {
    riskScore += 20;
    riskFactors.push('ELEVATED_TRANSACTION_VELOCITY');
  }

  // 3. High-risk categories check
  const highRiskCategories = ['Cryptocurrency', 'Gambling', 'Untracked_Vouchers'];
  const hasHighRiskCat = ctx.categories.some(cat => highRiskCategories.includes(cat));
  if (hasHighRiskCat) {
    riskScore += 80;
    riskFactors.push('PROHIBITED_OR_RESTRICTED_CATEGORY');
  }

  if (riskScore >= 80) {
    return {
      decision: 'DENY',
      riskScore,
      riskFactors,
      reason: `Transaction rejected due to critical risk score (${riskScore}/100): ${riskFactors.join(', ')}.`
    };
  }

  if (riskScore >= 40) {
    return {
      decision: 'REVIEW',
      riskScore,
      riskFactors,
      reason: `Transaction flagged for risk review (${riskScore}/100): ${riskFactors.join(', ')}.`
    };
  }

  return {
    decision: 'ALLOW',
    riskScore,
    riskFactors,
    reason: `Transaction risk acceptable (${riskScore}/100).`
  };
}
