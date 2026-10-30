import pg from 'pg';
import { pool } from '../db/pool.js';
import { domainHash } from '../crypto/canonical.js';
import { logAuditEvent } from '../audit/ledger.js';
import { resolveIntent } from './resolver.js';
import { INTENTS, DEFAULT_MAX_QUANTITY_PER_ITEM, DEFAULT_MAX_TOTAL_QUANTITY } from './taxonomy.js';

export type TaskStatus = 'PENDING_CONFIRMATION' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';

export interface PurchaseTask {
  id: string;
  principalId: string;
  buyerAgentId: string;
  merchantId: string;
  originalRequest: string;
  normalizedIntent: string | null;
  allowedProductTypes: string[];
  excludedProductTypes: string[];
  requiredAttributes: Record<string, unknown>;
  allowedVariantIds: string[];
  maxBudgetMinor: number;
  maxTotalQuantity: number;
  maxQuantityPerItem: number;
  currency: string;
  status: TaskStatus;
  confirmationSource: 'HUMAN_CONFIRMED' | 'RESOLVER_UNAMBIGUOUS' | null;
  intentHash: string;
  authorizationVersion: number;
  createdAt: string;
  expiresAt: string;
  /** Intents a human can choose from when the request was ambiguous. */
  candidateIntents?: string[];
}

export class TaskValidationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const MAX_BUDGET_MINOR = 10_000_000_00; // ₹1 crore, a sanity cap on a single task
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;

/** The authorization-relevant fields of a task, in the exact shape that is hashed and signed. */
export function taskAuthorizationPayload(t: Omit<PurchaseTask, 'intentHash' | 'candidateIntents' | 'status' | 'confirmationSource' | 'createdAt'>) {
  return {
    v: 1,
    task_id: t.id,
    principal_id: t.principalId,
    buyer_agent_id: t.buyerAgentId,
    merchant_id: t.merchantId,
    original_request: t.originalRequest,
    normalized_intent: t.normalizedIntent,
    allowed_product_types: [...t.allowedProductTypes].sort(),
    excluded_product_types: [...t.excludedProductTypes].sort(),
    required_attributes: t.requiredAttributes,
    allowed_variant_ids: [...t.allowedVariantIds].sort(),
    max_budget_minor: t.maxBudgetMinor,
    max_total_quantity: t.maxTotalQuantity,
    max_quantity_per_item: t.maxQuantityPerItem,
    currency: t.currency,
    expires_at: new Date(t.expiresAt).toISOString(),
    authorization_version: t.authorizationVersion
  };
}

export function computeIntentHash(t: Parameters<typeof taskAuthorizationPayload>[0]): string {
  return domainHash('bound.purchase-task.v1', taskAuthorizationPayload(t));
}

function rowToTask(r: any): PurchaseTask {
  return {
    id: r.id,
    principalId: r.principal_id,
    buyerAgentId: r.buyer_agent_id,
    merchantId: r.merchant_id,
    originalRequest: r.original_request,
    normalizedIntent: r.normalized_intent,
    allowedProductTypes: r.allowed_product_types || [],
    excludedProductTypes: r.excluded_product_types || [],
    requiredAttributes: r.required_attributes || {},
    allowedVariantIds: r.allowed_variant_ids || [],
    maxBudgetMinor: Number(r.max_budget_minor),
    maxTotalQuantity: Number(r.max_total_quantity),
    maxQuantityPerItem: Number(r.max_quantity_per_item),
    currency: r.currency,
    status: r.status,
    confirmationSource: r.confirmation_source,
    intentHash: r.intent_hash,
    authorizationVersion: Number(r.authorization_version),
    createdAt: new Date(r.created_at).toISOString(),
    expiresAt: new Date(r.expires_at).toISOString()
  };
}

/** True when the stored row still matches the hash computed over its own fields. */
export function taskIntegrityHolds(task: PurchaseTask): boolean {
  return computeIntentHash(task) === task.intentHash;
}

export async function getPurchaseTask(taskId: string, client?: pg.PoolClient, forUpdate = false): Promise<PurchaseTask | null> {
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) return null;
  const res = await (client || pool).query(`SELECT * FROM purchase_tasks WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''};`, [taskId]);
  return res.rows.length ? rowToTask(res.rows[0]) : null;
}

/**
 * Creates a task from the human's own request. If the request maps to exactly one intent the
 * task is ACTIVE ("RESOLVER_UNAMBIGUOUS"); if the caller passes explicit product types the human
 * confirmed, it is ACTIVE ("HUMAN_CONFIRMED"); otherwise it waits for human confirmation.
 * The budget always comes from the caller (the human's mandate), never from the request text.
 */
export async function createPurchaseTask(params: {
  principalId: string;
  buyerAgentId: string;
  merchantId: string;
  request: string;
  maxBudgetMinor: number;
  humanConfirmed?: { productTypes: string[]; requiredAttributes?: Record<string, unknown>; intent?: string };
  maxTotalQuantity?: number;
  maxQuantityPerItem?: number;
  ttlMs?: number;
  correlationId?: string;
}): Promise<PurchaseTask> {
  const request = params.request?.trim() ?? '';
  if (request.length < 1 || request.length > 1000) throw new TaskValidationError('INVALID_REQUEST', 'Request must be 1 to 1000 characters.');
  if (!Number.isSafeInteger(params.maxBudgetMinor) || params.maxBudgetMinor <= 0 || params.maxBudgetMinor > MAX_BUDGET_MINOR) {
    throw new TaskValidationError('INVALID_BUDGET', 'Budget must be a positive integer amount in paise.');
  }
  const ttlMs = params.ttlMs ?? 60 * 60_000;
  if (ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) throw new TaskValidationError('INVALID_EXPIRY', 'Task lifetime must be between 1 minute and 24 hours.');
  const perItem = params.maxQuantityPerItem ?? DEFAULT_MAX_QUANTITY_PER_ITEM;
  const total = params.maxTotalQuantity ?? DEFAULT_MAX_TOTAL_QUANTITY;
  if (!Number.isInteger(perItem) || !Number.isInteger(total) || perItem < 1 || total < 1 || perItem > total) {
    throw new TaskValidationError('INVALID_QUANTITY_LIMITS', 'Quantity limits must be positive integers with per-item ≤ total.');
  }

  const resolution = resolveIntent(request);
  let status: TaskStatus = 'PENDING_CONFIRMATION';
  let confirmationSource: PurchaseTask['confirmationSource'] = null;
  let normalizedIntent: string | null = null;
  let productTypes: string[] = [];
  let requiredAttributes: Record<string, unknown> = resolution.requiredAttributes;

  if (params.humanConfirmed) {
    productTypes = [...new Set(params.humanConfirmed.productTypes)];
    if (productTypes.length === 0) throw new TaskValidationError('INVALID_PRODUCT_TYPES', 'A confirmed task needs at least one product type.');
    normalizedIntent = params.humanConfirmed.intent ?? resolution.intent ?? null;
    requiredAttributes = { ...requiredAttributes, ...(params.humanConfirmed.requiredAttributes || {}) };
    status = 'ACTIVE';
    confirmationSource = 'HUMAN_CONFIRMED';
  } else if (resolution.status === 'RESOLVED') {
    normalizedIntent = resolution.intent!;
    productTypes = INTENTS[normalizedIntent].productTypes;
    status = 'ACTIVE';
    confirmationSource = 'RESOLVER_UNAMBIGUOUS';
  }

  const idRes = await pool.query('SELECT gen_random_uuid() AS id, NOW() AS now;');
  const id: string = idRes.rows[0].id;
  const createdAt = new Date(idRes.rows[0].now);
  const draft = {
    id,
    principalId: params.principalId,
    buyerAgentId: params.buyerAgentId,
    merchantId: params.merchantId,
    originalRequest: request,
    normalizedIntent,
    allowedProductTypes: productTypes,
    excludedProductTypes: [] as string[],
    requiredAttributes,
    allowedVariantIds: [] as string[],
    maxBudgetMinor: params.maxBudgetMinor,
    maxTotalQuantity: total,
    maxQuantityPerItem: perItem,
    currency: 'INR',
    authorizationVersion: 1,
    expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString()
  };
  const intentHash = computeIntentHash(draft);

  const res = await pool.query(`
    INSERT INTO purchase_tasks (
      id, principal_id, buyer_agent_id, merchant_id, original_request, normalized_intent, allowed_product_types,
      excluded_product_types, required_attributes, allowed_variant_ids, max_budget_minor, max_total_quantity,
      max_quantity_per_item, currency, status, confirmation_source, intent_hash, authorization_version, created_at, expires_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    RETURNING *;
  `, [
    id, draft.principalId, draft.buyerAgentId, draft.merchantId, draft.originalRequest, normalizedIntent, productTypes,
    draft.excludedProductTypes, JSON.stringify(requiredAttributes), draft.allowedVariantIds, draft.maxBudgetMinor, total,
    perItem, 'INR', status, confirmationSource, intentHash, 1, createdAt, draft.expiresAt
  ]);

  await logAuditEvent({
    correlationId: params.correlationId || `task_${id}`,
    actor: `principal:${params.principalId}`,
    action: 'purchase_task.create',
    merchantId: params.merchantId,
    decision: status === 'ACTIVE' ? 'AUTO_EXECUTABLE' : 'REQUIRES_USER_ACTION',
    humanReadable: status === 'ACTIVE'
      ? `Purchase task ${id} created for "${request}": allowed product types [${productTypes.join(', ')}], budget ₹${(params.maxBudgetMinor / 100).toFixed(2)} (${confirmationSource}).`
      : `Purchase task ${id} for "${request}" needs human confirmation (${resolution.status}; candidates: ${resolution.candidates.join(', ') || 'none'}).`,
    metadata: { taskId: id, intentHash, status, candidates: resolution.candidates }
  });

  return { ...rowToTask(res.rows[0]), candidateIntents: resolution.candidates };
}
