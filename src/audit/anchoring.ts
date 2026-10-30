import crypto from 'crypto';
import { pool } from '../db/pool.js';
import { canonicalJson } from './ledger.js';

export interface ExternalWormObject {
  checkpointId: string;
  storageUri: string;
  kmsKeyArn: string;
  sequenceStart: number;
  sequenceEnd: number;
  eventCount: number;
  rootHash: string;
  signature: string;
  algorithm: 'Ed25519';
  canonicalization: 'RFC8785';
  hashAlgorithm: 'SHA-256';
  wormRetentionPolicy: 'COMPLIANCE_MODE_7_YEARS' | 'GOVERNANCE_MODE_1_YEAR' | 'STANDARD_AUDIT_1_YEAR' | 'PAYMENT_PCI_3_YEARS' | 'LEGAL_HOLD_INDEFINITE';
  retentionTier?: 'STANDARD_AUDIT_1_YEAR' | 'PAYMENT_PCI_3_YEARS' | 'REGULATED_COMPLIANCE_7_YEARS' | 'LEGAL_HOLD_INDEFINITE';
  objectLockLegalHold: boolean;
  signedAt: string;
  objectSha256: string;
  metadata: Record<string, any>;
}

// SIMULATED: there is no AWS KMS key and no S3 bucket. Checkpoints are signed with an
// Ed25519 key generated in-process and stored in an in-memory write-once map that resets
// on restart. Field names (kmsKeyArn, wormRetentionPolicy) are kept so a real KMS / S3
// Object Lock adapter can slot in behind the same interface later.
export const DEFAULT_KMS_KEY_ARN = 'local:ed25519:audit-checkpoint-dev-key';
export const DEFAULT_WORM_BUCKET_URI = 'memory://simulated-worm/checkpoints/';

// In-Memory Simulated WORM Vault (enforces write-once within the process lifetime only)
class ExternalWormStorageVault {
  private objects: Map<string, ExternalWormObject> = new Map();
  private kmsKeyPair: crypto.KeyPairSyncResult<string, string> | null = null;

  public getKmsKeyPair() {
    if (!this.kmsKeyPair) {
      this.kmsKeyPair = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
      });
    }
    return this.kmsKeyPair;
  }

  /**
   * Puts object into WORM compliant storage.
   * If the key already exists, throws WORM_IMMUTABILITY_VIOLATION (Write-Once-Read-Many).
   */
  public putObject(uri: string, object: ExternalWormObject): void {
    if (this.objects.has(uri)) {
      throw new Error(`WORM_IMMUTABILITY_VIOLATION: Object ${uri} is locked under COMPLIANCE_MODE and cannot be overwritten.`);
    }
    this.objects.set(uri, Object.freeze({ ...object }));
  }

  public getObject(uri: string): ExternalWormObject | undefined {
    return this.objects.get(uri);
  }

  public listObjects(): ExternalWormObject[] {
    return Array.from(this.objects.values()).sort((a, b) => a.sequenceStart - b.sequenceStart);
  }

  public clear(): void {
    this.objects.clear();
  }
}

export const externalWormVault = new ExternalWormStorageVault();

/**
 * Signs the audit root hash with the local dev key and writes it to the in-memory simulated WORM vault.
 */
export async function anchorAuditRootToExternalWormStorage(params: {
  sequenceStart: number;
  sequenceEnd: number;
  eventCount: number;
  rootHash: string;
  kmsKeyArn?: string;
  wormBucketUri?: string;
  retentionPolicy?: 'COMPLIANCE_MODE_7_YEARS' | 'GOVERNANCE_MODE_1_YEAR';
}): Promise<ExternalWormObject> {
  const kmsKeyArn = params.kmsKeyArn || DEFAULT_KMS_KEY_ARN;
  const wormBucketUri = params.wormBucketUri || DEFAULT_WORM_BUCKET_URI;
  const retentionPolicy = params.retentionPolicy || 'COMPLIANCE_MODE_7_YEARS';

  const checkpointId = `chk_${Date.now()}_seq_${params.sequenceStart}_${params.sequenceEnd}`;
  const storageUri = `${wormBucketUri}${checkpointId}.json`;

  const keyPair = externalWormVault.getKmsKeyPair();
  const payloadToSign = `CHECKPOINT:v2:${params.sequenceStart}:${params.sequenceEnd}:${params.rootHash}:${kmsKeyArn}:RFC8785:SHA-256`;
  const signature = crypto.sign(null, Buffer.from(payloadToSign), keyPair.privateKey).toString('hex');
  const signedAt = new Date().toISOString();

  const rawRecord = {
    checkpointId,
    storageUri,
    kmsKeyArn,
    sequenceStart: params.sequenceStart,
    sequenceEnd: params.sequenceEnd,
    eventCount: params.eventCount,
    rootHash: params.rootHash,
    signature,
    algorithm: 'Ed25519' as const,
    canonicalization: 'RFC8785' as const,
    hashAlgorithm: 'SHA-256' as const,
    wormRetentionPolicy: retentionPolicy,
    objectLockLegalHold: true,
    signedAt,
    metadata: {
      provider: 'SIMULATED_IN_MEMORY',
      simulated: true,
      kms_hsm_secured: false
    }
  };

  const canonicalContent = canonicalJson(rawRecord);
  const objectSha256 = crypto.createHash('sha256').update(canonicalContent).digest('hex');

  const wormObject: ExternalWormObject = {
    ...rawRecord,
    objectSha256
  };

  // Write to External WORM Vault
  externalWormVault.putObject(storageUri, wormObject);

  return wormObject;
}

export interface ExternalWormVerificationResult {
  valid: boolean;
  totalExternalAnchorsChecked: number;
  dbEventsChecked: number;
  latestWormRootHash?: string;
  dbMatchesExternalWorm: boolean;
  dbCompromiseDetected: boolean;
  details: Array<{
    checkpointId: string;
    storageUri: string;
    kmsKeyArn: string;
    sequenceRange: string;
    signatureVerified: boolean;
    dbRootHashMatches: boolean;
  }>;
  summary: string;
}

/**
 * Cross-verifies PostgreSQL audit records against the simulated WORM anchors.
 * Detects DB rows rewritten after a checkpoint was taken. Because the vault is in-memory,
 * this only holds within one process lifetime; a real deployment needs external storage.
 */
export async function verifyExternalWormAnchors(): Promise<ExternalWormVerificationResult> {
  const externalObjects = externalWormVault.listObjects();
  const details: ExternalWormVerificationResult['details'] = [];
  const keyPair = externalWormVault.getKmsKeyPair();

  let allSignaturesValid = true;
  let dbMatchesExternal = true;
  let dbCompromiseDetected = false;

  // Query latest DB state
  const dbEventsRes = await pool.query('SELECT sequence_number, current_hash FROM audit_events ORDER BY sequence_number ASC;');
  const dbEventsBySeq = new Map<number, string>();
  for (const row of dbEventsRes.rows) {
    dbEventsBySeq.set(Number(row.sequence_number), row.current_hash);
  }

  for (const obj of externalObjects) {
    // 1. Verify the Ed25519 signature of the anchored checkpoint
    const payloadToSign = `CHECKPOINT:v2:${obj.sequenceStart}:${obj.sequenceEnd}:${obj.rootHash}:${obj.kmsKeyArn}:RFC8785:SHA-256`;
    const sigValid = crypto.verify(
      null,
      Buffer.from(payloadToSign),
      keyPair.publicKey,
      Buffer.from(obj.signature, 'hex')
    );

    if (!sigValid) {
      allSignaturesValid = false;
    }

    // 2. Compare with PostgreSQL DB state at sequenceEnd
    const dbHashAtSeq = dbEventsBySeq.get(obj.sequenceEnd);
    const hashesMatch = dbHashAtSeq === obj.rootHash;

    if (!hashesMatch) {
      dbMatchesExternal = false;
      dbCompromiseDetected = true;
    }

    details.push({
      checkpointId: obj.checkpointId,
      storageUri: obj.storageUri,
      kmsKeyArn: obj.kmsKeyArn,
      sequenceRange: `#${obj.sequenceStart} - #${obj.sequenceEnd}`,
      signatureVerified: sigValid,
      dbRootHashMatches: hashesMatch
    });
  }

  const valid = externalObjects.length > 0 && allSignaturesValid && dbMatchesExternal;

  return {
    valid,
    totalExternalAnchorsChecked: externalObjects.length,
    dbEventsChecked: dbEventsRes.rows.length,
    latestWormRootHash: externalObjects.length > 0 ? externalObjects[externalObjects.length - 1].rootHash : undefined,
    dbMatchesExternalWorm: dbMatchesExternal,
    dbCompromiseDetected,
    details,
    summary: dbCompromiseDetected
      ? 'CRITICAL SECURITY ALERT: PostgreSQL database tampering detected! Local DB state diverged from the signed checkpoint anchor (simulated WORM store).'
      : valid
        ? `Anchor verification successful: ${externalObjects.length} checkpoints verified against the local Ed25519 dev key (simulated in-memory WORM store).`
        : 'No checkpoints anchored in this process yet, or signature verification failed.'
  };
}
