import crypto from 'crypto';
import pg from 'pg';
import { pool } from '../db/pool.js';
import { broadcastAuditEvent } from './stream.js';

export type PolicyDecisionType = 'AUTO_EXECUTABLE' | 'REQUIRES_USER_ACTION' | 'DENIED';

export interface AuditEventInput {
  correlationId: string;
  actor: string;
  action: string;
  merchantId?: string;
  decision?: PolicyDecisionType | null;
  humanReadable: string;
  policyRuleId?: string;
  metadata?: Record<string, any>;
}

export interface AuditEventRecord {
  id: string;
  sequenceNumber: number;
  correlationId: string;
  merchantId?: string;
  actor: string;
  action: string;
  decision: PolicyDecisionType | null;
  humanReadable: string;
  policyRuleId: string | null;
  prevEventHash: string;
  currentHash: string;
  metadata: Record<string, any>;
  schemaVersion: string;
  canonicalizationVersion: string;
  hashAlgorithm: string;
  createdAt: Date;
}

export const AUDIT_SCHEMA_VERSION = '2.0';
export const AUDIT_CANONICALIZATION = 'RFC8785';
export const AUDIT_HASH_ALGORITHM = 'SHA-256';
export const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

let merchantCheckpointKeyPair: crypto.KeyPairSyncResult<string, string> | null = null;

export function getMerchantCheckpointKeyPair() {
  if (!merchantCheckpointKeyPair) {
    merchantCheckpointKeyPair = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
  }
  return merchantCheckpointKeyPair;
}

/**
 * Standard RFC 8785 / JCS JSON Canonicalization.
 * Produces deterministic byte representations regardless of key insertion order.
 */
export function canonicalJson(obj: any): string {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  const sortedKeys = Object.keys(obj)
    .filter(k => obj[k] !== undefined)
    .sort();
  const pairs = sortedKeys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return '{' + pairs.join(',') + '}';
}

/**
 * Computes cryptographically bound SHA-256 hash across previous hash and event fields.
 */
export function computeEventHash(
  prevHash: string,
  seq: number | string,
  corrId: string,
  actor: string,
  action: string,
  decision: string,
  humanReadable: string,
  ruleId: string,
  metaObj: any
): string {
  const metaStr = canonicalJson(metaObj || {});
  return crypto
    .createHash('sha256')
    .update(`${prevHash}:${seq}:${corrId}:${actor}:${action}:${decision}:${humanReadable}:${ruleId}:${metaStr}`)
    .digest('hex');
}

/**
 * Appends a tamper-evident audit record to the immutable hash-chained ledger.
 * Uses per-merchant ledger-head row serialization (P1.1) to avoid global table locks while preventing forks.
 */
export async function logAuditEvent(
  input: AuditEventInput,
  txClient?: pg.PoolClient
): Promise<AuditEventRecord> {
  const isDedicatedClient = !!txClient;
  const client = txClient || (await pool.connect());

  try {
    if (!isDedicatedClient) {
      await client.query('BEGIN');
    }

    // Resolve merchant ID or primary default merchant for ledger head scoping
    let merchantId = input.merchantId;
    if (!merchantId) {
      const mRes = await client.query(`SELECT id FROM merchants WHERE slug = 'apex-retail' LIMIT 1;`);
      if (mRes.rows.length > 0) {
        merchantId = mRes.rows[0].id;
      }
    }

    let prevSeq = 0;
    let prevHash = GENESIS_HASH;

    if (merchantId) {
      // Ensure ledger head exists for merchant
      await client.query(`
        INSERT INTO audit_ledger_heads (merchant_id, latest_sequence, latest_hash)
        VALUES ($1, 0, $2)
        ON CONFLICT (merchant_id) DO NOTHING;
      `, [merchantId, GENESIS_HASH]);

      // Acquire per-merchant row lock (no global table lock bottleneck)
      const headRes = await client.query(`
        SELECT latest_sequence, latest_hash
        FROM audit_ledger_heads
        WHERE merchant_id = $1
        FOR UPDATE;
      `, [merchantId]);

      if (headRes.rows.length > 0) {
        prevSeq = Number(headRes.rows[0].latest_sequence);
        prevHash = headRes.rows[0].latest_hash;
      }
    } else {
      // Fallback global serialization for system-level events without merchant scope
      const latestRes = await client.query(`
        SELECT sequence_number, current_hash 
        FROM audit_events 
        ORDER BY sequence_number DESC 
        LIMIT 1
        FOR UPDATE;
      `);
      if (latestRes.rows.length > 0) {
        prevSeq = Number(latestRes.rows[0].sequence_number);
        prevHash = latestRes.rows[0].current_hash;
      }
    }

    const nextSeq = prevSeq + 1;
    const decisionVal = input.decision || null;
    const policyRuleIdVal = input.policyRuleId || null;
    const metadataVal = {
      ...(input.metadata || {}),
      schema_version: AUDIT_SCHEMA_VERSION,
      canonicalization: AUDIT_CANONICALIZATION,
      hash_algorithm: AUDIT_HASH_ALGORITHM
    };

    const currentHash = computeEventHash(
      prevHash,
      nextSeq,
      input.correlationId,
      input.actor,
      input.action,
      decisionVal || '',
      input.humanReadable,
      policyRuleIdVal || '',
      metadataVal
    );

    const insertRes = await client.query(`
      INSERT INTO audit_events (
        merchant_id, sequence_number, correlation_id, actor, action, decision, human_readable, policy_rule_id,
        prev_event_hash, current_hash, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *;
    `, [
      merchantId || null,
      nextSeq,
      input.correlationId,
      input.actor,
      input.action,
      decisionVal,
      input.humanReadable,
      policyRuleIdVal,
      prevHash,
      currentHash,
      JSON.stringify(metadataVal)
    ]);

    if (merchantId) {
      await client.query(`
        UPDATE audit_ledger_heads
        SET latest_sequence = $1, latest_hash = $2, updated_at = NOW()
        WHERE merchant_id = $3;
      `, [nextSeq, currentHash, merchantId]);
    }

    const row = insertRes.rows[0];

    // Atomically link with audit_outbox in the same transaction
    await client.query(`
      INSERT INTO audit_outbox (
        transaction_id, correlation_id, actor, action, merchant_id, decision,
        human_readable, policy_rule_id, metadata, status, processed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PROCESSED', NOW());
    `, [
      `tx_direct_${row.id}`,
      input.correlationId,
      input.actor,
      input.action,
      merchantId || null,
      decisionVal,
      input.humanReadable,
      policyRuleIdVal,
      JSON.stringify(metadataVal)
    ]);

    if (!isDedicatedClient) {
      await client.query('COMMIT');
    }
    const eventRecord: AuditEventRecord = {
      id: row.id,
      sequenceNumber: Number(row.sequence_number),
      correlationId: row.correlation_id,
      merchantId: row.merchant_id,
      actor: row.actor,
      action: row.action,
      decision: row.decision,
      humanReadable: row.human_readable,
      policyRuleId: row.policy_rule_id,
      prevEventHash: row.prev_event_hash,
      currentHash: row.current_hash,
      metadata: row.metadata,
      schemaVersion: AUDIT_SCHEMA_VERSION,
      canonicalizationVersion: AUDIT_CANONICALIZATION,
      hashAlgorithm: AUDIT_HASH_ALGORITHM,
      createdAt: row.created_at
    };

    try {
      broadcastAuditEvent(eventRecord);
    } catch (err) {}

    return eventRecord;
  } catch (err) {
    if (!isDedicatedClient) {
      await client.query('ROLLBACK');
    }
    throw err;
  } finally {
    if (!isDedicatedClient) {
      client.release();
    }
  }
}

export async function getAuditTrail(correlationId?: string, limit: number = 50): Promise<AuditEventRecord[]> {
  let query = 'SELECT * FROM audit_events';
  const params: any[] = [];

  if (correlationId) {
    query += ' WHERE correlation_id = $1';
    params.push(correlationId);
  }

  query += ' ORDER BY sequence_number DESC LIMIT $' + (params.length + 1);
  params.push(limit);

  const res = await pool.query(query, params);
  return res.rows.map(row => ({
    id: row.id,
    sequenceNumber: Number(row.sequence_number),
    correlationId: row.correlation_id,
    merchantId: row.merchant_id,
    actor: row.actor,
    action: row.action,
    decision: row.decision,
    humanReadable: row.human_readable,
    policyRuleId: row.policy_rule_id,
    prevEventHash: row.prev_event_hash,
    currentHash: row.current_hash,
    metadata: row.metadata,
    schemaVersion: AUDIT_SCHEMA_VERSION,
    canonicalizationVersion: AUDIT_CANONICALIZATION,
    hashAlgorithm: AUDIT_HASH_ALGORITHM,
    createdAt: row.created_at
  }));
}

import { anchorAuditRootToExternalWormStorage, DEFAULT_KMS_KEY_ARN, DEFAULT_WORM_BUCKET_URI, externalWormVault } from './anchoring.js';

export async function createAuditCheckpoint(params?: {
  keyId?: string;
  kmsKeyArn?: string;
  wormBucketUri?: string;
  retentionPolicy?: 'COMPLIANCE_MODE_7_YEARS' | 'GOVERNANCE_MODE_1_YEAR';
}) {
  const keyId = params?.keyId || 'local-audit-key-v2';
  const kmsKeyArn = params?.kmsKeyArn || DEFAULT_KMS_KEY_ARN;
  const wormBucketUri = params?.wormBucketUri || DEFAULT_WORM_BUCKET_URI;
  const retentionPolicy = params?.retentionPolicy || 'COMPLIANCE_MODE_7_YEARS';

  const latestRes = await pool.query(`
    SELECT sequence_number, current_hash 
    FROM audit_events 
    ORDER BY sequence_number DESC 
    LIMIT 1;
  `);

  if (latestRes.rows.length === 0) {
    return { error: 'No audit events to checkpoint' };
  }

  const latestSeq = Number(latestRes.rows[0].sequence_number);
  const rootHash = latestRes.rows[0].current_hash;

  const lastChkRes = await pool.query(`
    SELECT sequence_end FROM audit_checkpoints ORDER BY sequence_end DESC LIMIT 1;
  `);
  const seqStart = lastChkRes.rows.length > 0 ? Number(lastChkRes.rows[0].sequence_end) + 1 : 1;
  const eventCount = latestSeq - seqStart + 1;

  // 1. Sign root hash with the local dev key and anchor it in the simulated WORM vault
  const wormRecord = await anchorAuditRootToExternalWormStorage({
    sequenceStart: seqStart,
    sequenceEnd: latestSeq,
    eventCount,
    rootHash,
    kmsKeyArn,
    wormBucketUri,
    retentionPolicy
  });

  // 2. Persist local database pointer with full external anchoring metadata
  const insertRes = await pool.query(`
    INSERT INTO audit_checkpoints (
      sequence_start, sequence_end, event_count, root_hash, key_id, key_version,
      kms_key_arn, external_storage_uri, worm_retention_policy, object_lock_legal_hold,
      external_object_sha256, signature, algorithm
    ) VALUES ($1, $2, $3, $4, $5, 'v2', $6, $7, $8, $9, $10, $11, 'Ed25519')
    RETURNING *;
  `, [
    seqStart,
    latestSeq,
    eventCount,
    rootHash,
    keyId,
    kmsKeyArn,
    wormRecord.storageUri,
    retentionPolicy,
    true,
    wormRecord.objectSha256,
    wormRecord.signature
  ]);

  return {
    ok: true,
    checkpointId: insertRes.rows[0].id,
    externalWormCheckpointId: wormRecord.checkpointId,
    sequenceStart: seqStart,
    sequenceEnd: latestSeq,
    eventCount,
    rootHash,
    kmsKeyArn,
    externalStorageUri: wormRecord.storageUri,
    wormRetentionPolicy: retentionPolicy,
    objectLockLegalHold: true,
    externalObjectSha256: wormRecord.objectSha256,
    keyId,
    keyVersion: 'v2',
    signature: wormRecord.signature,
    algorithm: 'Ed25519',
    canonicalization: 'RFC8785',
    hashAlgorithm: 'SHA-256',
    signedAt: insertRes.rows[0].signed_at
  };
}

export async function verifyAuditLedger(): Promise<{
  valid: boolean;
  totalEventsChecked: number;
  tamperedSequence?: number;
  latestRootHash?: string;
  checkpointsValid: boolean;
  checkpointCount: number;
  schemaVersion: string;
  canonicalization: string;
  message: string;
}> {
  const res = await pool.query(`
    SELECT * FROM audit_events ORDER BY sequence_number ASC;
  `);

  let prevHash = GENESIS_HASH;

  for (let i = 0; i < res.rows.length; i++) {
    const row = res.rows[i];
    const seq = Number(row.sequence_number);

    if (row.prev_event_hash !== prevHash) {
      return {
        valid: false,
        totalEventsChecked: i,
        tamperedSequence: seq,
        checkpointsValid: false,
        checkpointCount: 0,
        schemaVersion: AUDIT_SCHEMA_VERSION,
        canonicalization: AUDIT_CANONICALIZATION,
        message: `Hash-chain broken at event #${seq}. Stored prev_hash does not match preceding event hash.`
      };
    }

    const expectedHash = computeEventHash(
      prevHash,
      seq,
      row.correlation_id,
      row.actor,
      row.action,
      row.decision || '',
      row.human_readable,
      row.policy_rule_id || '',
      row.metadata
    );

    if (row.current_hash !== expectedHash) {
      return {
        valid: false,
        totalEventsChecked: i,
        tamperedSequence: seq,
        checkpointsValid: false,
        checkpointCount: 0,
        schemaVersion: AUDIT_SCHEMA_VERSION,
        canonicalization: AUDIT_CANONICALIZATION,
        message: `Tampered payload detected at event #${seq}. Recomputed hash does not match stored hash.`
      };
    }

    prevHash = row.current_hash;
  }

  const chkRes = await pool.query(`SELECT * FROM audit_checkpoints ORDER BY sequence_end ASC;`);
  const kmsKeyPair = externalWormVault.getKmsKeyPair();
  const merchantKeyPair = getMerchantCheckpointKeyPair();
  let allCheckpointsValid = true;

  for (const chk of chkRes.rows) {
    const keyToUse = chk.kms_key_arn || chk.key_id;
    const payloadToSign = chk.key_version === 'v2'
      ? `CHECKPOINT:v2:${chk.sequence_start}:${chk.sequence_end}:${chk.root_hash}:${keyToUse}:RFC8785:SHA-256`
      : `CHECKPOINT:v1:${chk.sequence_start}:${chk.sequence_end}:${chk.root_hash}:${chk.key_id}`;

    const verified = crypto.verify(
      null,
      Buffer.from(payloadToSign),
      kmsKeyPair.publicKey,
      Buffer.from(chk.signature, 'hex')
    ) || crypto.verify(
      null,
      Buffer.from(payloadToSign),
      merchantKeyPair.publicKey,
      Buffer.from(chk.signature, 'hex')
    );

    if (!verified) {
      allCheckpointsValid = false;
    }
  }

  return {
    valid: true,
    totalEventsChecked: res.rows.length,
    latestRootHash: prevHash,
    checkpointsValid: allCheckpointsValid,
    checkpointCount: chkRes.rows.length,
    schemaVersion: AUDIT_SCHEMA_VERSION,
    canonicalization: AUDIT_CANONICALIZATION,
    message: `All ${res.rows.length} audit events cryptographically verified under ${AUDIT_CANONICALIZATION}/${AUDIT_HASH_ALGORITHM}. Hash chain is unbroken and tamper-evident.`
  };
}
