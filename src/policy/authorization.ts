import pg from 'pg';
import { pool } from '../db/pool.js';
import { verifyPurchaseMandate, MandateVerificationResult } from './mandates.js';

export type PurchaseAuthorizationDecision = 'AUTHORIZED' | 'APPROVAL_REQUIRED' | 'DENIED';

export interface PurchaseAuthorizationContext {
  merchantId: string;
  buyerAgentId: string;
  mandateTokenId?: string;
  proposedAmountMinor: number;
  categories: string[];
  skuPrefixes?: string[];
  cartHash?: string;
  quoteHash?: string;
  txClient?: pg.PoolClient;
}

export interface PurchaseAuthorizationResult {
  decision: PurchaseAuthorizationDecision;
  reasonCode: string;
  reason: string;
  mandateId?: string;
  remainingBudgetMinor?: number;
  mandateDetails?: MandateVerificationResult;
}

/**
 * Question 1: Is this purchase authorized by a human principal or corporate spending mandate?
 * 
 * - AUTHORIZED: Cryptographically signed mandate exists, binding matches, budget sufficient, intent hashes match.
 * - APPROVAL_REQUIRED: No mandate provided or interactive human authorization required before payment.
 * - DENIED: Mandate explicitly invalid, expired, revoked, over-budget, category-disallowed, or tampered.
 */
export async function evaluatePurchaseAuthorization(
  ctx: PurchaseAuthorizationContext
): Promise<PurchaseAuthorizationResult> {
  // If no mandate token is provided, purchase requires interactive human approval
  if (!ctx.mandateTokenId) {
    return {
      decision: 'APPROVAL_REQUIRED',
      reasonCode: 'MANDATE_NOT_PROVIDED',
      reason: 'No AP2 cryptographic spending mandate provided. Purchase requires human approval.'
    };
  }

  const mandateRes = await verifyPurchaseMandate(
    ctx.mandateTokenId,
    ctx.merchantId,
    ctx.buyerAgentId,
    ctx.proposedAmountMinor,
    ctx.categories,
    ctx.skuPrefixes || [],
    ctx.txClient,
    ctx.cartHash,
    ctx.quoteHash
  );

  if (!mandateRes.valid) {
    return {
      decision: 'DENIED',
      reasonCode: mandateRes.errorCode || 'MANDATE_INVALID',
      reason: mandateRes.reason || 'Cryptographic mandate authorization check failed.',
      mandateDetails: mandateRes
    };
  }

  return {
    decision: 'AUTHORIZED',
    reasonCode: 'MANDATE_AUTHORIZED',
    reason: `Purchase cryptographically authorized under mandate ${ctx.mandateTokenId}. Remaining budget: ₹${((mandateRes.remainingBudgetMinor || 0) / 100).toFixed(2)}.`,
    mandateId: mandateRes.mandateId,
    remainingBudgetMinor: mandateRes.remainingBudgetMinor,
    mandateDetails: mandateRes
  };
}
