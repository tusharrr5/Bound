import crypto from 'crypto';
import pg from 'pg';
import { pool } from '../db/pool.js';
import { logAuditEvent } from '../audit/ledger.js';
import { issueMandate } from './mandate-signing.js';
import { getPurchaseTask } from '../intent/tasks.js';

export interface AgentDelegationInput {
  principalName: string;
  buyerAgentId: string;
  merchantId?: string;
  allowedCategories?: string[];
  maxTotalAmountMinor: number;
  autonomousPurchaseAllowed?: boolean;
  validityHours?: number;
}

export interface AgentDelegationRecord {
  id: string;
  principalName: string;
  buyerAgentId: string;
  merchantId?: string;
  allowedCategories: string[];
  maxTotalAmountMinor: number;
  autonomousPurchaseAllowed: boolean;
  version: number;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  expiresAt: string;
  createdAt: string;
}

export interface CreateMandateInput {
  delegationId: string;
  buyerAgentId: string;
  merchantId: string;
  maxTotalAmountMinor: number;
  perTxnLimitMinor?: number;
  allowedCategories?: string[];
  cartHash?: string;
  quoteHash?: string;
  nonce?: string;
  validityHours?: number;
  /** Bind the mandate to a purchase task; required for autonomous checkout. */
  purchaseTaskId?: string;
  /** Signing key to use; defaults to the agent's most recent active key. */
  keyId?: string;
}

/**
 * Creates a formal human-to-agent delegation grant (P0.3 Enrollment Lifecycle).
 */
export async function createAgentDelegation(
  input: AgentDelegationInput,
  correlationId: string,
  txClient?: pg.PoolClient
): Promise<AgentDelegationRecord> {
  const runner = txClient || pool;
  const validityHours = input.validityHours || 24 * 30; // 30 days default
  const expiresAt = new Date(Date.now() + validityHours * 3600 * 1000).toISOString();

  const res = await runner.query(`
    INSERT INTO agent_delegations (
      principal_name, buyer_agent_id, merchant_id, allowed_categories,
      max_total_amount_minor, autonomous_purchase_allowed, version, status, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, 1, 'ACTIVE', $7)
    RETURNING *;
  `, [
    input.principalName,
    input.buyerAgentId,
    input.merchantId || null,
    input.allowedCategories || [],
    input.maxTotalAmountMinor,
    input.autonomousPurchaseAllowed !== false,
    expiresAt
  ]);

  const row = res.rows[0];

  await logAuditEvent({
    correlationId,
    actor: `principal:${input.principalName}`,
    action: 'delegation.create',
    merchantId: input.merchantId,
    decision: 'AUTO_EXECUTABLE',
    humanReadable: `Human principal '${input.principalName}' authorized Buyer Agent ${input.buyerAgentId} with budget ceiling ₹${(input.maxTotalAmountMinor / 100).toFixed(2)} (Version: 1).`,
    policyRuleId: 'RULE_AGENT_DELEGATION_ENROLLMENT',
    metadata: { delegationId: row.id, buyerAgentId: input.buyerAgentId, maxTotal: input.maxTotalAmountMinor, version: 1 }
  }, txClient);

  return {
    id: row.id,
    principalName: row.principal_name,
    buyerAgentId: row.buyer_agent_id,
    merchantId: row.merchant_id,
    allowedCategories: row.allowed_categories || [],
    maxTotalAmountMinor: Number(row.max_total_amount_minor),
    autonomousPurchaseAllowed: row.autonomous_purchase_allowed,
    version: Number(row.version || 1),
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at
  };
}

export interface DelegationSubsetValidationResult {
  valid: boolean;
  errors: string[];
  errorCode?: 
    | 'AMOUNT_EXCEEDS_PARENT'
    | 'EXPIRY_EXCEEDS_PARENT'
    | 'CATEGORIES_NOT_SUBSET'
    | 'MERCHANT_MISMATCH'
    | 'PAYMENT_SCOPE_NOT_SUBSET'
    | 'ADDRESS_SCOPE_NOT_SUBSET';
}

/**
 * Deterministically enforces the Monotonic Narrowing Rule.
 * A child mandate should NEVER have more authority than its parent across any dimension:
 * - child.amount <= parent.amount
 * - child.expiry <= parent.expiry
 * - child.categories ⊆ parent.categories
 * - child.merchant_id == parent.merchant_id (if parent is merchant-bound)
 * - child.payment_scope ⊆ parent.payment_scope
 * - child.addresses ⊆ parent.addresses
 */
export function validateDelegationSubset(
  parent: {
    maxTotalAmountMinor: number;
    expiresAt: string | Date;
    allowedCategories?: string[];
    merchantId?: string;
    allowedSkuPrefixes?: string[];
    allowedPostalCodes?: string[];
    paymentScope?: string[];
  },
  child: {
    maxTotalAmountMinor: number;
    expiresAt?: string | Date;
    validityHours?: number;
    allowedCategories?: string[];
    merchantId?: string;
    allowedSkuPrefixes?: string[];
    allowedPostalCodes?: string[];
    paymentScope?: string[];
  }
): DelegationSubsetValidationResult {
  const errors: string[] = [];
  let primaryErrorCode: DelegationSubsetValidationResult['errorCode'];

  // 1. Monotonic Amount Narrowing: child.amount <= parent.amount
  if (child.maxTotalAmountMinor > parent.maxTotalAmountMinor) {
    errors.push(
      `AMOUNT_EXCEEDS_PARENT: Child mandate budget ₹${(child.maxTotalAmountMinor / 100).toFixed(2)} exceeds parent delegation ceiling ₹${(parent.maxTotalAmountMinor / 100).toFixed(2)}.`
    );
    if (!primaryErrorCode) primaryErrorCode = 'AMOUNT_EXCEEDS_PARENT';
  }

  // 2. Monotonic Temporal Narrowing: child.expiry <= parent.expiry
  const parentExpiry = new Date(parent.expiresAt).getTime();
  let childExpiry: number | undefined;
  if (child.expiresAt) {
    childExpiry = new Date(child.expiresAt).getTime();
  } else if (child.validityHours) {
    childExpiry = Date.now() + child.validityHours * 3600 * 1000;
  }

  if (childExpiry && childExpiry > parentExpiry + 1000) {
    errors.push(
      `EXPIRY_EXCEEDS_PARENT: Child mandate expiration (${new Date(childExpiry).toISOString()}) exceeds parent delegation expiration (${new Date(parentExpiry).toISOString()}).`
    );
    if (!primaryErrorCode) primaryErrorCode = 'EXPIRY_EXCEEDS_PARENT';
  }

  // 3. Monotonic Category Narrowing: child.categories ⊆ parent.categories
  if (parent.allowedCategories && parent.allowedCategories.length > 0) {
    if (!child.allowedCategories || child.allowedCategories.length === 0) {
      errors.push(
        `CATEGORIES_NOT_SUBSET: CATEGORY_NOT_DELEGATED: Parent restricts categories to [${parent.allowedCategories.join(', ')}], but child requested unrestricted/empty category list.`
      );
      if (!primaryErrorCode) primaryErrorCode = 'CATEGORIES_NOT_SUBSET';
    } else {
      const disallowed = child.allowedCategories.filter(c => !parent.allowedCategories!.includes(c));
      if (disallowed.length > 0) {
        errors.push(
          `CATEGORIES_NOT_SUBSET: CATEGORY_NOT_DELEGATED: Child requested categories [${disallowed.join(', ')}] outside parent delegation whitelist [${parent.allowedCategories.join(', ')}].`
        );
        if (!primaryErrorCode) primaryErrorCode = 'CATEGORIES_NOT_SUBSET';
      }
    }
  }

  // 4. Monotonic Merchant Scoping: child.merchantId == parent.merchantId
  if (parent.merchantId && child.merchantId && parent.merchantId !== child.merchantId) {
    errors.push(
      `MERCHANT_MISMATCH: Child mandate merchant '${child.merchantId}' does not match parent delegation merchant '${parent.merchantId}'.`
    );
    if (!primaryErrorCode) primaryErrorCode = 'MERCHANT_MISMATCH';
  }

  // 5. Monotonic Payment Scope Narrowing: child.payment_scope ⊆ parent.payment_scope
  if (parent.paymentScope && parent.paymentScope.length > 0 && child.paymentScope && child.paymentScope.length > 0) {
    const disallowedPayment = child.paymentScope.filter(p => !parent.paymentScope!.includes(p));
    if (disallowedPayment.length > 0) {
      errors.push(
        `PAYMENT_SCOPE_NOT_SUBSET: Child payment scope [${disallowedPayment.join(', ')}] exceeds parent delegation scope [${parent.paymentScope.join(', ')}].`
      );
      if (!primaryErrorCode) primaryErrorCode = 'PAYMENT_SCOPE_NOT_SUBSET';
    }
  }

  // 6. Monotonic Postal Code / Address Scope Narrowing: child.addresses ⊆ parent.addresses
  if (parent.allowedPostalCodes && parent.allowedPostalCodes.length > 0 && child.allowedPostalCodes && child.allowedPostalCodes.length > 0) {
    const disallowedPostal = child.allowedPostalCodes.filter(pc => !parent.allowedPostalCodes!.includes(pc));
    if (disallowedPostal.length > 0) {
      errors.push(
        `ADDRESS_SCOPE_NOT_SUBSET: Child postal codes [${disallowedPostal.join(', ')}] exceed parent delegation scope [${parent.allowedPostalCodes.join(', ')}].`
      );
      if (!primaryErrorCode) primaryErrorCode = 'ADDRESS_SCOPE_NOT_SUBSET';
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    errorCode: primaryErrorCode
  };
}

/**
 * Creates and cryptographically signs a purchase mandate derived from an active human delegation.
 */
export async function createPurchaseMandateFromDelegation(
  input: CreateMandateInput,
  privateKeyPem: string,
  correlationId: string,
  txClient?: pg.PoolClient
): Promise<{ ok: boolean; mandateTokenId?: string; signature?: string; error?: string; errorCode?: string }> {
  const runner = txClient || pool;

  // 1. Verify Delegation Exists and is ACTIVE
  const delRes = await runner.query(`
    SELECT * FROM agent_delegations WHERE id = $1;
  `, [input.delegationId]);

  if (delRes.rows.length === 0) {
    return { ok: false, error: `Delegation '${input.delegationId}' not found.` };
  }

  const delegation = delRes.rows[0];
  if (delegation.status !== 'ACTIVE' || new Date(delegation.expires_at) < new Date()) {
    return { ok: false, error: `Delegation '${input.delegationId}' is ${delegation.status}.` };
  }

  // Inherit delegation categories if not explicitly narrowed in child input
  const childCategories = input.allowedCategories || delegation.allowed_categories || [];

  // 2. Deterministic Monotonic Narrowing Enforcement
  const subsetCheck = validateDelegationSubset(
    {
      maxTotalAmountMinor: Number(delegation.max_total_amount_minor),
      expiresAt: delegation.expires_at,
      allowedCategories: delegation.allowed_categories || [],
      merchantId: delegation.merchant_id || undefined
    },
    {
      maxTotalAmountMinor: input.maxTotalAmountMinor,
      validityHours: input.validityHours,
      allowedCategories: childCategories,
      merchantId: input.merchantId
    }
  );

  if (!subsetCheck.valid) {
    return {
      ok: false,
      error: `MONOTONIC_NARROWING_VIOLATION: ${subsetCheck.errors.join('; ')}`,
      errorCode: subsetCheck.errorCode
    };
  }

  if (!privateKeyPem) {
    return { ok: false, error: 'A signing key held by the human principal is required to issue a mandate.', errorCode: 'SIGNING_KEY_REQUIRED' };
  }

  // Optional task binding: the mandate signs the task's intent hash and may not exceed its budget
  let intentHash: string | null = null;
  if (input.purchaseTaskId) {
    const task = await getPurchaseTask(input.purchaseTaskId, txClient);
    if (!task || task.buyerAgentId !== input.buyerAgentId || task.merchantId !== input.merchantId || task.status !== 'ACTIVE') {
      return { ok: false, error: 'Purchase task is missing, inactive, or belongs to another agent or merchant.', errorCode: 'TASK_BINDING_INVALID' };
    }
    if (input.maxTotalAmountMinor > task.maxBudgetMinor) {
      return { ok: false, error: 'Mandate ceiling exceeds the purchase task budget.', errorCode: 'TASK_BUDGET_EXCEEDED' };
    }
    intentHash = task.intentHash;
  }

  const keyRes = await runner.query(`
    SELECT key_id FROM mandate_key_bindings
    WHERE buyer_agent_id = $1 AND status = 'ACTIVE' AND ($2::text IS NULL OR key_id = $2)
    ORDER BY created_at DESC LIMIT 1;
  `, [input.buyerAgentId, input.keyId ?? null]);
  if (keyRes.rows.length === 0) {
    return { ok: false, error: 'No active signing key is bound to this agent.', errorCode: 'SIGNING_KEY_NOT_BOUND' };
  }

  const mandateTokenId = `mandate_tok_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const validityHours = input.validityHours || 24 * 7;

  // 3–4. Sign every enforced field (v2) and persist
  const { signature, nonce } = await issueMandate({
    privateKeyPem,
    mandate_token_id: mandateTokenId,
    buyer_agent_id: input.buyerAgentId,
    merchant_id: input.merchantId,
    key_id: keyRes.rows[0].key_id,
    purchase_task_id: input.purchaseTaskId ?? null,
    intent_hash: intentHash,
    max_total_amount_minor: input.maxTotalAmountMinor,
    per_txn_limit_minor: input.perTxnLimitMinor || input.maxTotalAmountMinor,
    currency: 'INR',
    allowed_categories: childCategories,
    allowed_sku_prefixes: [],
    delegation_id: input.delegationId,
    delegation_version: delegation.version || 1,
    cart_hash: input.cartHash || null,
    quote_hash: input.quoteHash || null,
    nonce: input.nonce,
    expiresAt: new Date(Date.now() + validityHours * 3600 * 1000)
  }, txClient);

  await logAuditEvent({
    correlationId,
    actor: `agent:${input.buyerAgentId}`,
    action: 'mandate.issue',
    merchantId: input.merchantId,
    decision: 'AUTO_EXECUTABLE',
    humanReadable: `Issued active purchase mandate ${mandateTokenId} bound to delegation ${input.delegationId} (Limit: ₹${(input.maxTotalAmountMinor / 100).toFixed(2)}, Delegation Version: ${delegation.version || 1}).`,
    policyRuleId: 'RULE_PURCHASE_MANDATE_ISSUANCE',
    metadata: { mandateTokenId, delegationId: input.delegationId, maxTotal: input.maxTotalAmountMinor, delegationVersion: delegation.version || 1 }
  }, txClient);

  return {
    ok: true,
    mandateTokenId,
    signature
  };
}

/**
 * Retrieves the real-time status and spending consumption of a purchase mandate.
 * Dynamic Invariant:
 * - If parent delegation is REVOKED or EXPIRED, computed status is immediately REVOKED/EXPIRED
 * - Effective budget ceiling is dynamically constrained by parent delegation's current active budget
 */
export async function getMandateDetails(mandateTokenId: string) {
  const res = await pool.query(`
    SELECT pm.*, ad.principal_name, ad.status as delegation_status,
           ad.max_total_amount_minor as delegation_max_total_minor,
           ad.version as delegation_version,
           m.name as merchant_name
    FROM purchase_mandates pm
    LEFT JOIN agent_delegations ad ON ad.id = pm.delegation_id
    LEFT JOIN merchants m ON m.id = pm.merchant_id
    WHERE pm.mandate_token_id = $1;
  `, [mandateTokenId]);

  if (res.rows.length === 0) return null;
  const row = res.rows[0];

  const now = new Date();
  let computedStatus = row.status;

  // Real-time Dynamic Cascade Check
  if (row.delegation_id && row.delegation_status === 'REVOKED') {
    computedStatus = 'REVOKED';
  } else if (row.delegation_id && row.delegation_status === 'EXPIRED') {
    computedStatus = 'EXPIRED';
  } else if (computedStatus === 'ACTIVE' && now > new Date(row.expires_at)) {
    computedStatus = 'EXPIRED';
  } else if (computedStatus === 'ACTIVE' && Number(row.spent_amount_minor) >= Number(row.max_total_amount_minor)) {
    computedStatus = 'EXHAUSTED';
  }

  const effectiveMaxTotal = row.delegation_max_total_minor
    ? Math.min(Number(row.max_total_amount_minor), Number(row.delegation_max_total_minor))
    : Number(row.max_total_amount_minor);

  return {
    id: row.id,
    mandateTokenId: row.mandate_token_id,
    delegationId: row.delegation_id,
    delegationVersion: row.delegation_version,
    delegationStatus: row.delegation_status,
    principalName: row.principal_name,
    buyerAgentId: row.buyer_agent_id,
    merchantId: row.merchant_id,
    merchantName: row.merchant_name,
    maxTotalAmountMinor: effectiveMaxTotal,
    originalMaxTotalAmountMinor: Number(row.max_total_amount_minor),
    reservedAmountMinor: Number(row.reserved_amount_minor),
    spentAmountMinor: Number(row.spent_amount_minor),
    availableBudgetMinor: Math.max(0, effectiveMaxTotal - Number(row.spent_amount_minor) - Number(row.reserved_amount_minor)),
    status: computedStatus,
    allowedCategories: row.allowed_categories,
    cartHash: row.cart_hash,
    quoteHash: row.quote_hash,
    signature: row.signature,
    notBefore: row.not_before,
    expiresAt: row.expires_at,
    createdAt: row.created_at
  };
}

/**
 * Revokes an active purchase mandate, immediately preventing any further authorization or spend.
 */
export async function revokeMandate(
  mandateTokenId: string,
  reason: string,
  correlationId: string,
  actor: string = 'principal'
): Promise<{ ok: boolean; error?: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const updateRes = await client.query(`
      UPDATE purchase_mandates
      SET status = 'REVOKED'
      WHERE mandate_token_id = $1 AND status = 'ACTIVE'
      RETURNING id, buyer_agent_id, merchant_id;
    `, [mandateTokenId]);

    if (updateRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: `Mandate '${mandateTokenId}' is not active or not found.` };
    }

    const row = updateRes.rows[0];

    await logAuditEvent({
      correlationId,
      actor,
      action: 'mandate.revoke',
      merchantId: row.merchant_id,
      decision: 'AUTO_EXECUTABLE',
      humanReadable: `Revoked purchase mandate ${mandateTokenId}. Reason: ${reason}.`,
      policyRuleId: 'RULE_MANDATE_REVOCATION',
      metadata: { mandateTokenId, reason }
    }, client);

    await client.query('COMMIT');
    return { ok: true };
  } catch (err: any) {
    await client.query('ROLLBACK');
    return { ok: false, error: err.message || 'Failed to revoke mandate.' };
  } finally {
    client.release();
  }
}

/**
 * Updates the budget limit on an active delegation with monotonic version increment.
 * Must be authorized by human principal with step-up authentication.
 */
export async function updateDelegationBudget(
  delegationId: string,
  newBudgetMinor: number,
  correlationId: string,
  actor: string = 'principal:human'
): Promise<{ ok: boolean; delegation?: AgentDelegationRecord; error?: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const updateRes = await client.query(`
      UPDATE agent_delegations
      SET max_total_amount_minor = $1,
          version = version + 1
      WHERE id = $2 AND status = 'ACTIVE'
      RETURNING *;
    `, [newBudgetMinor, delegationId]);

    if (updateRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: `Delegation '${delegationId}' is not active or not found.` };
    }

    const row = updateRes.rows[0];

    await logAuditEvent({
      correlationId,
      actor,
      action: 'delegation.budget_update',
      merchantId: row.merchant_id,
      decision: 'AUTO_EXECUTABLE',
      humanReadable: `Human principal updated delegation ${delegationId} budget ceiling to ₹${(newBudgetMinor / 100).toFixed(2)} (Version: ${row.version}).`,
      policyRuleId: 'RULE_DELEGATION_BUDGET_UPDATE',
      metadata: { delegationId, newBudgetMinor, version: row.version }
    }, client);

    await client.query('COMMIT');

    return {
      ok: true,
      delegation: {
        id: row.id,
        principalName: row.principal_name,
        buyerAgentId: row.buyer_agent_id,
        merchantId: row.merchant_id,
        allowedCategories: row.allowed_categories || [],
        maxTotalAmountMinor: Number(row.max_total_amount_minor),
        autonomousPurchaseAllowed: row.autonomous_purchase_allowed,
        version: Number(row.version),
        status: row.status,
        expiresAt: row.expires_at,
        createdAt: row.created_at
      }
    };
  } catch (err: any) {
    await client.query('ROLLBACK');
    return { ok: false, error: err.message || 'Failed to update delegation budget.' };
  } finally {
    client.release();
  }
}

/**
 * Revokes a human-to-agent delegation grant and all derived active mandates.
 */
export async function revokeAgentDelegation(
  delegationId: string,
  reason: string,
  correlationId: string,
  actor: string = 'principal:human'
): Promise<{ ok: boolean; error?: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const updateRes = await client.query(`
      UPDATE agent_delegations
      SET status = 'REVOKED'
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING *;
    `, [delegationId]);

    if (updateRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, error: `Delegation '${delegationId}' is not active or not found.` };
    }

    const row = updateRes.rows[0];

    // Cascade revoke any active mandates under this delegation
    await client.query(`
      UPDATE purchase_mandates
      SET status = 'REVOKED'
      WHERE delegation_id = $1 AND status = 'ACTIVE';
    `, [delegationId]);

    await logAuditEvent({
      correlationId,
      actor,
      action: 'delegation.revoke',
      merchantId: row.merchant_id,
      decision: 'AUTO_EXECUTABLE',
      humanReadable: `Human principal revoked delegation ${delegationId}. All derived mandates invalidated. Reason: ${reason}.`,
      policyRuleId: 'RULE_DELEGATION_REVOCATION',
      metadata: { delegationId, reason }
    }, client);

    await client.query('COMMIT');
    return { ok: true };
  } catch (err: any) {
    await client.query('ROLLBACK');
    return { ok: false, error: err.message || 'Failed to revoke delegation.' };
  } finally {
    client.release();
  }
}
