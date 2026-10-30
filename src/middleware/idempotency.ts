import crypto from 'crypto';
import { pool } from '../db/pool.js';

export interface IdempotencyCheckResult {
  isCached: boolean;
  isConflict?: boolean;
  isLocked?: boolean;
  statusCode?: number;
  responseBody?: any;
  errorMessage?: string;
}

export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
export const IDEMPOTENCY_LEASE_MS = 30 * 1000; // 30 seconds crash recovery lease

export async function checkIdempotency(
  key: string | undefined,
  principalId: string,
  endpoint: string,
  body: any
): Promise<IdempotencyCheckResult> {
  if (!key) return { isCached: false };

  // Key length validation (DoS prevention)
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return {
      isCached: false,
      isConflict: true,
      errorMessage: `Idempotency key exceeds maximum length (${MAX_IDEMPOTENCY_KEY_LENGTH} characters).`
    };
  }

  const requestHash = crypto
    .createHash('sha256')
    .update(`${principalId}:${endpoint}:${JSON.stringify(body || {})}`)
    .digest('hex');

  const res = await pool.query(`
    SELECT status, response_code, response_body, request_hash, lease_expires_at
    FROM idempotency_records
    WHERE idempotency_key = $1;
  `, [key]);

  if (res.rows.length > 0) {
    const record = res.rows[0];

    // 1. Completed request checking
    if (record.status === 'COMPLETED') {
      if (record.request_hash === requestHash) {
        return {
          isCached: true,
          statusCode: record.response_code,
          responseBody: record.response_body
        };
      } else {
        // Different payload with identical idempotency key -> Conflict
        return {
          isCached: false,
          isConflict: true,
          errorMessage: 'IDEMPOTENCY_CONFLICT: Idempotency key reused with a different request payload or parameters.'
        };
      }
    }

    // 2. In-flight request lease checking (Orphan Recovery)
    if (record.status === 'IN_PROGRESS') {
      const now = new Date();
      const leaseExpiresAt = new Date(record.lease_expires_at);

      if (now <= leaseExpiresAt) {
        // Active lease on another concurrent thread
        return {
          isCached: false,
          isLocked: true,
          errorMessage: 'Concurrent request in progress under active idempotency lease.'
        };
      } else {
        // Orphan process crashed -> Safely recover lease and proceed
        const newLease = new Date(Date.now() + IDEMPOTENCY_LEASE_MS);
        await pool.query(`
          UPDATE idempotency_records
          SET request_hash = $1, lease_expires_at = $2, updated_at = NOW()
          WHERE idempotency_key = $3;
        `, [requestHash, newLease, key]);

        return { isCached: false };
      }
    }
  }

  // 3. New in-flight idempotency record
  const leaseExpiresAt = new Date(Date.now() + IDEMPOTENCY_LEASE_MS);
  await pool.query(`
    INSERT INTO idempotency_records (idempotency_key, principal_id, endpoint, request_hash, status, lease_expires_at)
    VALUES ($1, $2, $3, $4, 'IN_PROGRESS', $5)
    ON CONFLICT (idempotency_key) DO UPDATE SET
      request_hash = EXCLUDED.request_hash,
      lease_expires_at = EXCLUDED.lease_expires_at,
      updated_at = NOW();
  `, [key, principalId, endpoint, requestHash, leaseExpiresAt]);

  return { isCached: false };
}

export async function saveIdempotencyResponse(
  key: string | undefined,
  statusCode: number,
  responseBody: any
) {
  if (!key) return;

  await pool.query(`
    UPDATE idempotency_records
    SET status = 'COMPLETED',
        response_code = $1,
        response_body = $2,
        updated_at = NOW()
    WHERE idempotency_key = $3;
  `, [statusCode, JSON.stringify(responseBody), key]);
}
