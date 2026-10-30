import crypto from 'crypto';
import pg from 'pg';
import { pool } from '../db/pool.js';
import { getCanonicalMandateString } from '../db/seed.js';

export interface PurchaseMandateData {
  mandate_token_id: string;
  buyer_agent_id: string;
  merchant_id: string;
  key_id?: string;
  max_total_amount_minor: number;
  per_txn_limit_minor?: number;
  allowed_categories?: string[];
  allowed_sku_prefixes?: string[];
  cart_hash?: string;
  quote_hash?: string;
  currency: string;
  nonce: string;
  not_before: string;
  expires_at: string;
}

export interface MandateVerificationResult {
  valid: boolean;
  mandateId?: string;
  buyerAgentId?: string;
  keyId?: string;
  maxTotalAmountMinor?: number;
  reservedAmountMinor?: number;
  spentAmountMinor?: number;
  remainingBudgetMinor?: number;
  perTxnLimitMinor?: number;
  allowedCategories?: string[];
  allowedSkuPrefixes?: string[];
  boundCartHash?: string;
  boundQuoteHash?: string;
  errorCode?: 
    | 'MANDATE_NOT_FOUND' 
    | 'SIGNATURE_INVALID' 
    | 'MANDATE_EXPIRED' 
    | 'MANDATE_NOT_YET_VALID' 
    | 'MANDATE_STATUS_INVALID'
    | 'REVOKED_SIGNING_KEY'
    | 'AGENT_MISMATCH' 
    | 'MERCHANT_MISMATCH' 
    | 'MANDATE_EXHAUSTED' 
    | 'CATEGORY_DISALLOWED'
    | 'SKU_PREFIX_DISALLOWED'
    | 'CART_HASH_MISMATCH'
    | 'QUOTE_HASH_MISMATCH'
    | 'PARENT_DELEGATION_REVOKED'
    | 'PARENT_DELEGATION_EXPIRED'
    | 'PARENT_DELEGATION_INVALID'
    | 'MANDATE_EXCEEDS_PARENT_DELEGATION_CEILING'
    | 'DELEGATION_CATEGORY_DISALLOWED';
  reason?: string;
}

/**
 * Safe signing interface: signs mandate payload with private key custody without exposing private key bytes.
 */
export function signMandate(privateKeyPem: string, data: {
  mandate_token_id: string;
  buyer_agent_id: string;
  merchant_id: string;
  max_total_amount_minor: number;
  nonce: string;
}): string {
  const canonicalMsg = getCanonicalMandateString(data);
  return crypto.sign(null, Buffer.from(canonicalMsg), privateKeyPem).toString('hex');
}

/**
 * Cryptographically verifies purchase mandate, checking:
 * 1. Existence and active status
 * 2. Key validity (not revoked or rotated)
 * 3. Temporal validity (not_before, expires_at)
 * 4. Parent Delegation Active & Non-Revoked Status (Cascading Invariant)
 * 5. Parent Delegation Budget Constraint (Version-bound Dynamic Ceiling)
 * 6. Ed25519 signature authenticity
 * 7. Spending limit and remaining budget (accounting for active reservations)
 * 8. Whitelists (category & SKU prefix)
 * 9. Intent binding (cart_hash and quote_hash match)
 */
export async function verifyPurchaseMandate(
  mandateTokenId: string,
  merchantId: string,
  buyerAgentId: string,
  proposedAmountMinor: number,
  orderCategories: string[],
  orderSkuPrefixes: string[] = [],
  txClient?: pg.PoolClient,
  cartHash?: string,
  quoteHash?: string
): Promise<MandateVerificationResult> {
  const runner = txClient || pool;

  // 1. Fetch mandate, parent delegation, and signing key from DB
  const mRes = await runner.query(`
    SELECT 
      pm.*,
      ad.status AS delegation_status,
      ad.version AS delegation_version,
      ad.max_total_amount_minor AS delegation_max_total_minor,
      ad.expires_at AS delegation_expires_at,
      ad.allowed_categories AS delegation_allowed_categories,
      mkb.key_id AS bound_key_id,
      mkb.public_key,
      mkb.algorithm,
      mkb.status AS key_status
    FROM purchase_mandates pm
    JOIN mandate_key_bindings mkb ON mkb.buyer_agent_id = pm.buyer_agent_id
    LEFT JOIN agent_delegations ad ON ad.id = pm.delegation_id
    WHERE pm.mandate_token_id = $1;
  `, [mandateTokenId]);

  if (mRes.rows.length === 0) {
    return {
      valid: false,
      errorCode: 'MANDATE_NOT_FOUND',
      reason: `Mandate token '${mandateTokenId}' does not exist.`
    };
  }

  const row = mRes.rows[0];

  // 2. Validate Key Status
  if (row.key_status === 'REVOKED') {
    return {
      valid: false,
      errorCode: 'REVOKED_SIGNING_KEY',
      reason: `Signing key '${row.bound_key_id}' for agent ${row.buyer_agent_id} has been revoked.`
    };
  }

  if (row.key_status !== 'ACTIVE') {
    return {
      valid: false,
      errorCode: 'MANDATE_STATUS_INVALID',
      reason: `Signing key status is '${row.key_status}'. Only ACTIVE keys are authorized.`
    };
  }

  // 3. Dynamic Cascade Check on Parent Delegation (Even if mandate in storage says ACTIVE)
  if (row.delegation_id) {
    if (row.delegation_status === 'REVOKED') {
      return {
        valid: false,
        errorCode: 'PARENT_DELEGATION_REVOKED',
        reason: `Mandate '${mandateTokenId}' cannot be used because its parent delegation '${row.delegation_id}' has been REVOKED by the human principal.`
      };
    }

    if (row.delegation_status === 'EXPIRED' || (row.delegation_expires_at && new Date() > new Date(row.delegation_expires_at))) {
      return {
        valid: false,
        errorCode: 'PARENT_DELEGATION_EXPIRED',
        reason: `Mandate '${mandateTokenId}' cannot be used because its parent delegation '${row.delegation_id}' has EXPIRED.`
      };
    }

    if (row.delegation_status !== 'ACTIVE') {
      return {
        valid: false,
        errorCode: 'PARENT_DELEGATION_INVALID',
        reason: `Mandate parent delegation status is '${row.delegation_status}'. Only ACTIVE delegations are authorized.`
      };
    }
  }

  // 4. Validate Merchant & Agent Binding
  if (row.merchant_id !== merchantId) {
    return {
      valid: false,
      errorCode: 'MERCHANT_MISMATCH',
      reason: `Mandate is bound to merchant ${row.merchant_id}, cannot be used at merchant ${merchantId}.`
    };
  }

  if (row.buyer_agent_id !== buyerAgentId) {
    return {
      valid: false,
      errorCode: 'AGENT_MISMATCH',
      reason: `Mandate is bound to agent ${row.buyer_agent_id}, cannot be invoked by agent ${buyerAgentId}.`
    };
  }

  // 5. Status Check
  if (row.status !== 'ACTIVE') {
    return {
      valid: false,
      errorCode: 'MANDATE_STATUS_INVALID',
      reason: `Mandate status is '${row.status}'. Only ACTIVE mandates are authorized.`
    };
  }

  const now = new Date();
  const notBefore = new Date(row.not_before);
  const expiresAt = new Date(row.expires_at);

  if (now < notBefore) {
    return {
      valid: false,
      errorCode: 'MANDATE_NOT_YET_VALID',
      reason: `Mandate is not active until ${notBefore.toISOString()}.`
    };
  }

  if (now > expiresAt) {
    return {
      valid: false,
      errorCode: 'MANDATE_EXPIRED',
      reason: `Mandate expired at ${expiresAt.toISOString()}.`
    };
  }

  // 6. Intent Binding: Check cart_hash and quote_hash if specified in mandate
  if (row.cart_hash && cartHash && row.cart_hash !== cartHash) {
    return {
      valid: false,
      errorCode: 'CART_HASH_MISMATCH',
      reason: `Mandate intent bound to cart hash ${row.cart_hash}, but checkout has cart hash ${cartHash}. Cart has been modified.`
    };
  }

  if (row.quote_hash && quoteHash && row.quote_hash !== quoteHash) {
    return {
      valid: false,
      errorCode: 'QUOTE_HASH_MISMATCH',
      reason: `Mandate intent bound to quote hash ${row.quote_hash}, but checkout has quote hash ${quoteHash}. Quote has been modified.`
    };
  }

  // 7. Verify Cryptographic Ed25519 Signature
  const canonicalMsg = getCanonicalMandateString({
    mandate_token_id: row.mandate_token_id,
    buyer_agent_id: row.buyer_agent_id,
    merchant_id: row.merchant_id,
    max_total_amount_minor: Number(row.max_total_amount_minor),
    nonce: row.nonce
  });

  const payloadBuffer = Buffer.from(canonicalMsg);
  const signatureBuffer = Buffer.from(row.signature, 'hex');

  const isVerified = crypto.verify(
    null,
    payloadBuffer,
    row.public_key,
    signatureBuffer
  );

  if (!isVerified) {
    return {
      valid: false,
      errorCode: 'SIGNATURE_INVALID',
      reason: 'Cryptographic Ed25519 signature verification failed for purchase mandate.'
    };
  }

  // 8. Dynamic Budget & Ceiling Invariant with Version Binding:
  // If parent delegation budget was decreased (e.g. from ₹10,000 to ₹5,000),
  // the effective maximum spend ceiling is constrained to Math.min(mandate_max, delegation_current_max).
  const mandateMax = Number(row.max_total_amount_minor);
  const delegationMax = row.delegation_max_total_minor ? Number(row.delegation_max_total_minor) : mandateMax;
  const effectiveMaxTotal = Math.min(mandateMax, delegationMax);

  const spent = Number(row.spent_amount_minor);
  const reserved = Number(row.reserved_amount_minor || 0);
  const remaining = effectiveMaxTotal - spent - reserved;
  const perTxnLimit = row.per_txn_limit_minor ? Math.min(Number(row.per_txn_limit_minor), effectiveMaxTotal) : effectiveMaxTotal;

  if (proposedAmountMinor > remaining) {
    const isDelegationConstrained = delegationMax < mandateMax;
    return {
      valid: false,
      errorCode: isDelegationConstrained ? 'MANDATE_EXCEEDS_PARENT_DELEGATION_CEILING' : 'MANDATE_EXHAUSTED',
      reason: isDelegationConstrained
        ? `Proposed order amount ₹${(proposedAmountMinor / 100).toFixed(2)} exceeds parent delegation's current active budget ceiling ₹${(effectiveMaxTotal / 100).toFixed(2)} (Parent Delegation Version: ${row.delegation_version || 1}).`
        : `Proposed order amount ₹${(proposedAmountMinor / 100).toFixed(2)} exceeds available mandate budget ₹${(remaining / 100).toFixed(2)} (Spent: ₹${(spent / 100).toFixed(2)}, Reserved: ₹${(reserved / 100).toFixed(2)}).`
    };
  }

  if (proposedAmountMinor > perTxnLimit) {
    return {
      valid: false,
      errorCode: 'MANDATE_EXHAUSTED',
      reason: `Proposed order amount ₹${(proposedAmountMinor / 100).toFixed(2)} exceeds per-transaction limit ₹${(perTxnLimit / 100).toFixed(2)}.`
    };
  }

  // 9. Check Category Whitelist
  if (row.allowed_categories && row.allowed_categories.length > 0) {
    const allowed = row.allowed_categories as string[];
    const disallowed = orderCategories.filter(cat => !allowed.includes(cat));
    if (disallowed.length > 0) {
      return {
        valid: false,
        errorCode: 'CATEGORY_DISALLOWED',
        reason: `Mandate does not permit purchase of categories: ${disallowed.join(', ')}.`
      };
    }
  }

  if (row.delegation_allowed_categories && row.delegation_allowed_categories.length > 0) {
    const delegationAllowed = row.delegation_allowed_categories as string[];
    const disallowed = orderCategories.filter(cat => !delegationAllowed.includes(cat));
    if (disallowed.length > 0) {
      return {
        valid: false,
        errorCode: 'DELEGATION_CATEGORY_DISALLOWED',
        reason: `Parent delegation does not permit purchase of categories: ${disallowed.join(', ')}.`
      };
    }
  }

  // 10. Check SKU Prefix Whitelist
  if (row.allowed_sku_prefixes && row.allowed_sku_prefixes.length > 0) {
    const allowedPrefixes = row.allowed_sku_prefixes as string[];
    const disallowedPrefixes = orderSkuPrefixes.filter(pfx => !allowedPrefixes.includes(pfx));
    if (disallowedPrefixes.length > 0) {
      return {
        valid: false,
        errorCode: 'SKU_PREFIX_DISALLOWED',
        reason: `Mandate does not permit SKU prefixes: ${disallowedPrefixes.join(', ')}.`
      };
    }
  }

  return {
    valid: true,
    mandateId: row.id,
    buyerAgentId: row.buyer_agent_id,
    keyId: row.bound_key_id,
    maxTotalAmountMinor: effectiveMaxTotal,
    reservedAmountMinor: reserved,
    spentAmountMinor: spent,
    remainingBudgetMinor: remaining,
    perTxnLimitMinor: perTxnLimit,
    allowedCategories: row.allowed_categories,
    allowedSkuPrefixes: row.allowed_sku_prefixes,
    boundCartHash: row.cart_hash,
    boundQuoteHash: row.quote_hash
  };
}

/**
 * Reserves mandate budget during checkout creation (P1.5 Lifecycle: Reserve).
 */
export async function reserveMandateBudget(
  mandateId: string,
  amountMinor: number,
  txClient: pg.PoolClient
): Promise<{ ok: boolean; newReservedMinor?: number; error?: string }> {
  // Check parent delegation status and effective ceiling under row lock
  const mCheck = await txClient.query(`
    SELECT pm.*, ad.status as delegation_status, ad.max_total_amount_minor as delegation_max_total_minor
    FROM purchase_mandates pm
    LEFT JOIN agent_delegations ad ON ad.id = pm.delegation_id
    WHERE pm.id = $1
    FOR UPDATE OF pm;
  `, [mandateId]);

  if (mCheck.rows.length === 0) {
    return { ok: false, error: 'Mandate not found.' };
  }

  const row = mCheck.rows[0];

  if (row.delegation_id) {
    if (row.delegation_status === 'REVOKED') {
      return { ok: false, error: 'Parent delegation is REVOKED.' };
    }
  }

  const effectiveMax = row.delegation_max_total_minor
    ? Math.min(Number(row.max_total_amount_minor), Number(row.delegation_max_total_minor))
    : Number(row.max_total_amount_minor);

  const spent = Number(row.spent_amount_minor);
  const reserved = Number(row.reserved_amount_minor || 0);

  if (spent + reserved + amountMinor > effectiveMax) {
    return { ok: false, error: 'Mandate budget exceeded parent delegation ceiling or unavailable to reserve.' };
  }

  const updateRes = await txClient.query(`
    UPDATE purchase_mandates
    SET reserved_amount_minor = reserved_amount_minor + $1
    WHERE id = $2
    RETURNING reserved_amount_minor, spent_amount_minor, max_total_amount_minor;
  `, [amountMinor, mandateId]);

  return { ok: true, newReservedMinor: Number(updateRes.rows[0].reserved_amount_minor) };
}

/**
 * Commits reserved mandate budget when payment succeeds (P1.5 Lifecycle: Commit).
 */
export async function commitMandateBudget(
  mandateId: string,
  amountMinor: number,
  txClient: pg.PoolClient
): Promise<{ ok: boolean; newSpentMinor?: number; error?: string }> {
  const updateRes = await txClient.query(`
    UPDATE purchase_mandates
    SET reserved_amount_minor = GREATEST(0, reserved_amount_minor - $1),
        spent_amount_minor = spent_amount_minor + $1,
        status = CASE WHEN spent_amount_minor + $1 >= max_total_amount_minor THEN 'EXHAUSTED' ELSE status END
    WHERE id = $2
    RETURNING spent_amount_minor, reserved_amount_minor, max_total_amount_minor;
  `, [amountMinor, mandateId]);

  if (updateRes.rows.length === 0) {
    return { ok: false, error: 'Failed to commit mandate budget.' };
  }

  return { ok: true, newSpentMinor: Number(updateRes.rows[0].spent_amount_minor) };
}

/**
 * Releases reserved mandate budget when checkout expires or payment fails (P1.5 Lifecycle: Release).
 */
export async function releaseMandateBudget(
  mandateId: string,
  amountMinor: number,
  txClient: pg.PoolClient
): Promise<{ ok: boolean; error?: string }> {
  await txClient.query(`
    UPDATE purchase_mandates
    SET reserved_amount_minor = GREATEST(0, reserved_amount_minor - $1)
    WHERE id = $2;
  `, [amountMinor, mandateId]);

  return { ok: true };
}

/**
 * Direct atomic budget consumption shortcut.
 */
export async function consumeMandateBudget(
  mandateId: string,
  amountMinor: number,
  txClient: pg.PoolClient
): Promise<{ ok: boolean; newSpentMinor?: number; error?: string }> {
  const updateRes = await txClient.query(`
    UPDATE purchase_mandates
    SET spent_amount_minor = spent_amount_minor + $1,
        status = CASE WHEN spent_amount_minor + $1 >= max_total_amount_minor THEN 'EXHAUSTED' ELSE status END
    WHERE id = $2 AND (spent_amount_minor + reserved_amount_minor + $1 <= max_total_amount_minor)
    RETURNING spent_amount_minor, max_total_amount_minor;
  `, [amountMinor, mandateId]);

  if (updateRes.rows.length === 0) {
    return { ok: false, error: 'Mandate spending budget exceeded or mandate locked.' };
  }

  return { ok: true, newSpentMinor: Number(updateRes.rows[0].spent_amount_minor) };
}
