import crypto from 'crypto';
import pg from 'pg';
import { pool } from '../db/pool.js';
import { logAuditEvent } from '../audit/ledger.js';

export type WebhookSecretStatus = 'PRIMARY' | 'PREVIOUS_ACTIVE' | 'REVOKED';

export interface WebhookSecretRecord {
  id: string;
  merchantId?: string;
  version: number;
  secretHandle: string;
  status: WebhookSecretStatus;
  validFrom: string;
  validUntil?: string;
  createdAt: string;
}

export interface WebhookVerificationResult {
  valid: boolean;
  secretVersion?: number;
  secretHandle?: string;
  isRotationGracePeriod?: boolean;
  /** The secret that verified the signature. Server-internal; never returned to clients. */
  secret?: string;
  /** Merchant whose secret was used (null = platform-level secret). */
  merchantId?: string | null;
  errorCode?: 'MISSING_SIGNATURE' | 'NO_ACTIVE_SECRETS' | 'HMAC_VERIFICATION_FAILED';
}

// ─── KMS / SECRET MANAGER RESOLVER ───────────────────────────────────────────
// Pluggable KMS / Secret Manager provider to prevent storing plaintext secrets in PostgreSQL
const inMemoryKmsVault = new Map<string, string>();

/**
 * Registers a secret in the mock KMS / Secret Manager provider (for testing & simulation).
 */
export function registerKmsSecret(handle: string, secretValue: string): void {
  inMemoryKmsVault.set(handle, secretValue);
}

/**
 * Resolves a secret handle from KMS, Secret Manager, or Environment variables.
 * Plaintext secrets are NEVER persisted in PostgreSQL.
 */
export async function resolveSecretHandle(handle: string): Promise<string | null> {
  if (!handle) return null;

  // 1. In-memory Mock KMS / Vault
  if (inMemoryKmsVault.has(handle)) {
    return inMemoryKmsVault.get(handle)!;
  }

  // 2. Environment Variable Reference (e.g. env://RAZORPAY_WEBHOOK_SECRET)
  if (handle.startsWith('env://')) {
    const envVar = handle.replace('env://', '');
    return process.env[envVar] || null;
  }

  // 3. Cloud KMS / Secret Manager ARN / URI formats (kms://, secretmanager://)
  if (handle.startsWith('kms://') || handle.startsWith('secretmanager://')) {
    // In production, invoke AWS KMS / GCP Secret Manager SDK client
    // For demo/simulated environment, check if mapped in vault or fallback
    return inMemoryKmsVault.get(handle) || process.env.RAZORPAY_WEBHOOK_SECRET || 'demo_webhook_secret_abcde';
  }

  // Fallback for direct identifier lookup
  return process.env[handle] || process.env.RAZORPAY_WEBHOOK_SECRET || 'demo_webhook_secret_abcde';
}

/**
 * Constant-time HMAC-SHA256 signature verification over raw request body.
 */
export function verifyHmacSha256(rawBody: string | Buffer, signature: string, secret: string): boolean {
  if (!signature || !secret || !rawBody) return false;
  try {
    const rawBuffer = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBuffer)
      .digest('hex');

    if (signature.length !== expectedSignature.length) return false;

    return crypto.timingSafeEqual(
      Buffer.from(signature, 'utf8'),
      Buffer.from(expectedSignature, 'utf8')
    );
  } catch (err) {
    return false;
  }
}

/**
 * Validates authentic Razorpay HMAC-SHA256 signature against raw request body bytes using constant-time comparison.
 * Backwards-compatible single-secret helper.
 */
export function verifyWebhookSignature(rawBody: string | Buffer, signature: string, secret: string): boolean {
  return verifyHmacSha256(rawBody, signature, secret);
}

/**
 * Multi-Secret Webhook Verification with Rotation & Grace Period.
 * Handles Razorpay's documented edge case:
 * "After changing a webhook secret, retries of older webhook events must still be verified
 * using the old secret; blindly switching to only the new secret causes valid retries to fail."
 *
 * Algorithm:
 * 1. Fetch active secrets: PRIMARY first, then PREVIOUS_ACTIVE within valid_until retry horizon.
 * 2. Try PRIMARY secret.
 * 3. If mismatch, try PREVIOUS_ACTIVE secret(s).
 * 4. Return verification status, secret version used, and whether rotation grace period was hit.
 */
export async function verifyWebhookSignatureWithRotation(
  rawBody: string | Buffer,
  signature: string,
  merchantId?: string,
  txClient?: pg.PoolClient
): Promise<WebhookVerificationResult> {
  if (!signature) {
    return { valid: false, errorCode: 'MISSING_SIGNATURE' };
  }

  const runner = txClient || pool;

  // 1. Fetch candidate secrets (PRIMARY first, then PREVIOUS_ACTIVE where NOW() <= valid_until)
  // A known merchant may use its own secrets or the platform-level ones. With no merchant, only
  // platform-level secrets apply: one merchant's secret must never authenticate another's event.
  const secretsRes = await runner.query(`
    SELECT * FROM webhook_secrets
    WHERE (($1::uuid IS NULL AND merchant_id IS NULL) OR ($1::uuid IS NOT NULL AND (merchant_id = $1 OR merchant_id IS NULL)))
      AND status IN ('PRIMARY', 'PREVIOUS_ACTIVE')
      AND (valid_until IS NULL OR valid_until >= NOW())
    ORDER BY CASE WHEN status = 'PRIMARY' THEN 0 ELSE 1 END, version DESC;
  `, [merchantId || null]);

  // Fallback to environment variable if no secrets configured in database yet
  if (secretsRes.rows.length === 0) {
    const fallbackSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'demo_webhook_secret_abcde';
    const isValid = verifyHmacSha256(rawBody, signature, fallbackSecret);
    return {
      valid: isValid,
      secretVersion: 1,
      secretHandle: 'env://RAZORPAY_WEBHOOK_SECRET',
      isRotationGracePeriod: false,
      secret: isValid ? fallbackSecret : undefined,
      merchantId: null,
      errorCode: isValid ? undefined : 'HMAC_VERIFICATION_FAILED'
    };
  }

  // 2. Iterate candidate secrets in prioritized order (PRIMARY -> PREVIOUS_ACTIVE)
  for (const row of secretsRes.rows) {
    const resolvedSecret = await resolveSecretHandle(row.secret_handle);
    if (!resolvedSecret) continue;

    const isValid = verifyHmacSha256(rawBody, signature, resolvedSecret);
    if (isValid) {
      return {
        valid: true,
        secretVersion: Number(row.version),
        secretHandle: row.secret_handle,
        isRotationGracePeriod: row.status === 'PREVIOUS_ACTIVE',
        secret: resolvedSecret,
        merchantId: row.merchant_id ?? null
      };
    }
  }

  return {
    valid: false,
    errorCode: 'HMAC_VERIFICATION_FAILED'
  };
}

/**
 * Rotates a webhook secret for a merchant or system.
 * - Demotes current PRIMARY to PREVIOUS_ACTIVE with a retry horizon (grace period).
 * - Enrolls new secret as PRIMARY (version N+1).
 * - Never stores plaintext secret in DB; only stores secretHandle.
 */
export async function rotateWebhookSecret(
  params: {
    merchantId?: string;
    newSecretHandle: string;
    gracePeriodHours?: number;
    correlationId: string;
    actor?: string;
  },
  txClient?: pg.PoolClient
): Promise<{ ok: boolean; newVersion?: number; previousVersion?: number; error?: string }> {
  const client = txClient || await pool.connect();
  const shouldManageTx = !txClient;

  try {
    if (shouldManageTx) await client.query('BEGIN');

    const graceHours = params.gracePeriodHours || 24; // 24-hour default retry horizon
    const validUntil = new Date(Date.now() + graceHours * 3600 * 1000).toISOString();

    // 1. Find existing PRIMARY secret
    const existingRes = await client.query(`
      SELECT * FROM webhook_secrets
      WHERE ($1::uuid IS NULL OR merchant_id = $1)
        AND status = 'PRIMARY'
      FOR UPDATE;
    `, [params.merchantId || null]);

    let previousVersion: number | undefined;
    let nextVersion = 1;

    if (existingRes.rows.length > 0) {
      const currentPrimary = existingRes.rows[0];
      previousVersion = Number(currentPrimary.version);
      nextVersion = previousVersion + 1;

      // Demote current PRIMARY to PREVIOUS_ACTIVE with valid_until grace period
      await client.query(`
        UPDATE webhook_secrets
        SET status = 'PREVIOUS_ACTIVE',
            valid_until = $1
        WHERE id = $2;
      `, [validUntil, currentPrimary.id]);
    }

    // 2. Insert new PRIMARY secret
    const insertRes = await client.query(`
      INSERT INTO webhook_secrets (
        merchant_id, version, secret_handle, status, valid_from, valid_until
      ) VALUES ($1, $2, $3, 'PRIMARY', NOW(), NULL)
      RETURNING *;
    `, [params.merchantId || null, nextVersion, params.newSecretHandle]);

    const row = insertRes.rows[0];

    // 3. Log Audit Trail
    await logAuditEvent({
      correlationId: params.correlationId,
      actor: params.actor || 'system:security_officer',
      action: 'webhook.secret_rotated',
      merchantId: params.merchantId,
      decision: 'AUTO_EXECUTABLE',
      humanReadable: `Rotated Webhook Secret to Version ${nextVersion} (Handle: ${params.newSecretHandle}). Previous Version ${previousVersion || 'none'} retained as PREVIOUS_ACTIVE until ${validUntil} (${graceHours}h retry horizon).`,
      policyRuleId: 'RULE_WEBHOOK_SECRET_ROTATION',
      metadata: {
        newVersion: nextVersion,
        previousVersion,
        newSecretHandle: params.newSecretHandle,
        gracePeriodHours: graceHours,
        validUntil
      }
    }, client);

    if (shouldManageTx) await client.query('COMMIT');

    return {
      ok: true,
      newVersion: Number(row.version),
      previousVersion
    };
  } catch (err: any) {
    if (shouldManageTx) await client.query('ROLLBACK');
    return { ok: false, error: err.message || 'Failed to rotate webhook secret.' };
  } finally {
    if (shouldManageTx) client.release();
  }
}

/**
 * Verifies an inbound Razorpay webhook. The merchant is derived from the order the event refers
 * to (stored razorpay_order_id), never from anything the sender claims, and only that merchant's
 * secrets (or platform-level ones) are tried.
 */
export async function verifyRazorpayWebhook(rawBody: Buffer, signature: string, payload: any): Promise<WebhookVerificationResult> {
  const orderId = payload?.payload?.payment?.entity?.order_id ?? payload?.payload?.order?.entity?.id ?? null;
  let merchantId: string | undefined;
  if (typeof orderId === 'string' && orderId.length <= 100) {
    const res = await pool.query('SELECT merchant_id FROM orders WHERE razorpay_order_id = $1', [orderId]);
    merchantId = res.rows[0]?.merchant_id;
  }
  return verifyWebhookSignatureWithRotation(rawBody, signature, merchantId);
}
