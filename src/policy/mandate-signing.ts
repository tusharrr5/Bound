import crypto from 'crypto';
import pg from 'pg';
import { pool } from '../db/pool.js';
import { canonicalJson } from '../crypto/canonical.js';

/**
 * Mandate signature scheme v2.
 *
 * v1 signed only `token:agent:merchant:ceiling:nonce`, so categories, the per-transaction limit,
 * expiry, currency and task binding could be widened in the database without detection. v2 signs
 * every field the policy engine enforces, as canonical JSON behind a domain tag, and verification
 * recomputes the payload from the stored row. Change any enforced field and the signature fails.
 */
export const MANDATE_SIGNATURE_VERSION = 2;
const DOMAIN = 'bound.mandate.v2';

export interface MandateFields {
  mandate_token_id: string;
  buyer_agent_id: string;
  merchant_id: string;
  key_id: string;
  purchase_task_id: string | null;
  intent_hash: string | null;
  max_total_amount_minor: number;
  per_txn_limit_minor: number | null;
  currency: string;
  allowed_categories: string[];
  allowed_sku_prefixes: string[];
  not_before: string | Date;
  expires_at: string | Date;
  delegation_id: string | null;
  delegation_version: number | null;
  cart_hash: string | null;
  quote_hash: string | null;
  nonce: string;
}

const iso = (d: string | Date) => new Date(d).toISOString();
const sorted = (a: string[] | null | undefined) => [...(a ?? [])].sort();

/** The exact structure that is signed. Built from inputs at issue time and from the row at verify time. */
export function mandatePayloadV2(f: MandateFields) {
  return {
    alg: 'Ed25519',
    schema: DOMAIN,
    mandate_token_id: f.mandate_token_id,
    buyer_agent_id: f.buyer_agent_id,
    merchant_id: f.merchant_id,
    key_id: f.key_id,
    purchase_task_id: f.purchase_task_id ?? null,
    intent_hash: f.intent_hash ?? null,
    max_total_amount_minor: String(f.max_total_amount_minor),
    per_txn_limit_minor: f.per_txn_limit_minor == null ? null : String(f.per_txn_limit_minor),
    currency: f.currency,
    allowed_categories: sorted(f.allowed_categories),
    allowed_sku_prefixes: sorted(f.allowed_sku_prefixes),
    not_before: iso(f.not_before),
    expires_at: iso(f.expires_at),
    delegation_id: f.delegation_id ?? null,
    delegation_version: f.delegation_version ?? null,
    cart_hash: f.cart_hash ?? null,
    quote_hash: f.quote_hash ?? null,
    nonce: f.nonce
  };
}

function message(f: MandateFields): Buffer {
  return Buffer.from(`${DOMAIN}\u0000${canonicalJson(mandatePayloadV2(f))}`, 'utf8');
}

export function signMandateV2(privateKeyPem: string, f: MandateFields): string {
  return crypto.sign(null, message(f), privateKeyPem).toString('hex');
}

/** Rebuilds the signed fields from a purchase_mandates row (plus its key id) and verifies them. */
export function verifyMandateRowV2(row: any, keyId: string, publicKeyPem: string): boolean {
  if (!/^[0-9a-f]+$/i.test(row.signature || '')) return false;
  const fields: MandateFields = {
    mandate_token_id: row.mandate_token_id,
    buyer_agent_id: row.buyer_agent_id,
    merchant_id: row.merchant_id,
    key_id: keyId,
    purchase_task_id: row.purchase_task_id ?? null,
    intent_hash: row.intent_hash ?? null,
    max_total_amount_minor: Number(row.max_total_amount_minor),
    per_txn_limit_minor: row.per_txn_limit_minor == null ? null : Number(row.per_txn_limit_minor),
    currency: row.currency,
    allowed_categories: row.allowed_categories ?? [],
    allowed_sku_prefixes: row.allowed_sku_prefixes ?? [],
    not_before: row.not_before,
    expires_at: row.expires_at,
    delegation_id: row.delegation_id ?? null,
    delegation_version: row.delegation_version == null ? null : Number(row.delegation_version),
    cart_hash: row.cart_hash ?? null,
    quote_hash: row.quote_hash ?? null,
    nonce: row.nonce
  };
  try {
    return crypto.verify(null, message(fields), publicKeyPem, Buffer.from(row.signature, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Signs and stores a v2 mandate. The caller holds the private key (the human's device in a real
 * deployment; a key generated on this machine in the demo) and must already have bound the
 * matching public key under `keyId`. The private key is never stored.
 */
export async function issueMandate(
  params: Omit<MandateFields, 'nonce' | 'not_before' | 'expires_at'> & {
    privateKeyPem: string;
    notBefore?: Date;
    expiresAt: Date;
    nonce?: string;
  },
  client?: pg.PoolClient
): Promise<{ mandateTokenId: string; signature: string; nonce: string }> {
  const nonce = params.nonce ?? crypto.randomBytes(16).toString('hex');
  const fields: MandateFields = {
    ...params,
    nonce,
    not_before: params.notBefore ?? new Date(Date.now() - 60_000),
    expires_at: params.expiresAt
  };
  const signature = signMandateV2(params.privateKeyPem, fields);
  await (client || pool).query(`
    INSERT INTO purchase_mandates (
      mandate_token_id, buyer_agent_id, merchant_id, key_id, purchase_task_id, intent_hash, max_total_amount_minor,
      reserved_amount_minor, spent_amount_minor, per_txn_limit_minor, allowed_categories, allowed_sku_prefixes, currency,
      nonce, signature, signature_algorithm, signature_version, status, not_before, expires_at, delegation_id,
      delegation_version, cart_hash, quote_hash
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,$8,$9,$10,$11,$12,$13,'Ed25519',$14,'ACTIVE',$15,$16,$17,$18,$19,$20);
  `, [
    fields.mandate_token_id, fields.buyer_agent_id, fields.merchant_id, fields.key_id, fields.purchase_task_id,
    fields.intent_hash, fields.max_total_amount_minor, fields.per_txn_limit_minor, fields.allowed_categories,
    fields.allowed_sku_prefixes, fields.currency, nonce, signature, MANDATE_SIGNATURE_VERSION,
    new Date(fields.not_before), new Date(fields.expires_at), fields.delegation_id, fields.delegation_version,
    fields.cart_hash, fields.quote_hash
  ]);
  return { mandateTokenId: fields.mandate_token_id, signature, nonce };
}
