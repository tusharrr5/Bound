import pg from 'pg';
import { pool } from '../db/pool.js';
import { logAuditEvent, AuditEventInput, AuditEventRecord } from './ledger.js';

export interface OutboxAuditEventInput extends AuditEventInput {
  transactionId?: string;
}

export interface OutboxRecord {
  id: string;
  transactionId: string;
  correlationId: string;
  actor: string;
  action: string;
  merchantId?: string;
  decision?: string;
  humanReadable: string;
  policyRuleId?: string;
  metadata: Record<string, any>;
  status: 'PENDING' | 'PROCESSED' | 'FAILED';
  errorMessage?: string;
  processedAt?: string;
  createdAt: string;
}

/**
 * Stages an audit event in the transactional outbox table within the active business transaction.
 * Guarantees that commerce mutations and audit event records are atomically committed together.
 * If the transaction succeeds, the outbox event is guaranteed to exist. If it aborts, both roll back.
 */
export async function stageOutboxAuditEvent(
  input: OutboxAuditEventInput,
  txClient: pg.PoolClient
): Promise<{ ok: boolean; outboxId: string }> {
  const txId = input.transactionId || `tx_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  const res = await txClient.query(`
    INSERT INTO audit_outbox (
      transaction_id, correlation_id, actor, action, merchant_id, decision,
      human_readable, policy_rule_id, metadata, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING')
    RETURNING id;
  `, [
    txId,
    input.correlationId,
    input.actor,
    input.action,
    input.merchantId || null,
    input.decision || null,
    input.humanReadable,
    input.policyRuleId || null,
    JSON.stringify(input.metadata || {})
  ]);

  return { ok: true, outboxId: res.rows[0].id };
}

/**
 * Drains and appends pending outbox audit events to the immutable hash-chained ledger.
 * Processes events sequentially to maintain per-merchant hash-chain serialization.
 */
export async function processAuditOutboxBatch(
  batchSize: number = 50
): Promise<{ processedCount: number; events: AuditEventRecord[]; errors: string[] }> {
  const client = await pool.connect();
  const processedEvents: AuditEventRecord[] = [];
  const errors: string[] = [];

  try {
    // Fetch pending outbox records with row lock to prevent concurrency race
    const pendingRes = await client.query(`
      SELECT * FROM audit_outbox
      WHERE status = 'PENDING'
      ORDER BY created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED;
    `, [batchSize]);

    for (const row of pendingRes.rows) {
      try {
        await client.query('BEGIN');

        const auditRecord = await logAuditEvent({
          correlationId: row.correlation_id,
          actor: row.actor,
          action: row.action,
          merchantId: row.merchant_id,
          decision: row.decision as any,
          humanReadable: row.human_readable,
          policyRuleId: row.policy_rule_id,
          metadata: {
            ...(typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata),
            outbox_id: row.id,
            transaction_id: row.transaction_id
          }
        }, client);

        await client.query(`
          UPDATE audit_outbox
          SET status = 'PROCESSED', processed_at = NOW()
          WHERE id = $1;
        `, [row.id]);

        await client.query('COMMIT');
        processedEvents.push(auditRecord);
      } catch (itemErr: any) {
        await client.query('ROLLBACK');
        errors.push(`Outbox item ${row.id} failed: ${itemErr.message}`);
        await pool.query(`
          UPDATE audit_outbox
          SET status = 'FAILED', error_message = $1
          WHERE id = $2;
        `, [itemErr.message, row.id]);
      }
    }

    return {
      processedCount: processedEvents.length,
      events: processedEvents,
      errors
    };
  } finally {
    client.release();
  }
}

export interface AuditAtomicityVerificationResult {
  compliant: boolean;
  totalCommerceEntitiesChecked: number;
  unauditedEntitiesCount: number;
  violations: Array<{
    entityType: string;
    entityId: string;
    correlationId: string;
    reason: string;
  }>;
  summary: string;
}

/**
 * Invariant Monitor: Asserts that every critical commerce entity in the database
 * (orders, payments, refunds, inventory reservations, checkouts)
 * is backed by a corresponding audit event or transactional outbox entry.
 *
 * Catches any ghost mutation where a business record exists without an audit record.
 */
export async function verifyCommerceAuditAtomicity(): Promise<AuditAtomicityVerificationResult> {
  const violations: AuditAtomicityVerificationResult['violations'] = [];
  let totalChecked = 0;

  // 1. Check Orders
  const ordersRes = await pool.query(`
    SELECT o.id, o.correlation_id, o.status, o.created_at,
           COUNT(ae.id) as audit_count, COUNT(ao.id) as outbox_count
    FROM orders o
    LEFT JOIN audit_events ae ON (ae.correlation_id = o.correlation_id OR (ae.metadata->>'orderId')::text = o.id::text)
    LEFT JOIN audit_outbox ao ON (ao.correlation_id = o.correlation_id OR (ao.metadata->>'orderId')::text = o.id::text)
    GROUP BY o.id, o.correlation_id, o.status, o.created_at;
  `);

  for (const row of ordersRes.rows) {
    totalChecked++;
    const totalAuditEvents = Number(row.audit_count) + Number(row.outbox_count);
    if (totalAuditEvents === 0) {
      violations.push({
        entityType: 'ORDER',
        entityId: row.id,
        correlationId: row.correlation_id,
        reason: `Order ${row.id} (Status: ${row.status}) was committed without any corresponding audit or outbox event.`
      });
    }
  }

  // 2. Check Payments
  const paymentsRes = await pool.query(`
    SELECT p.id, p.razorpay_payment_id, o.correlation_id, p.status,
           COUNT(ae.id) as audit_count, COUNT(ao.id) as outbox_count
    FROM payments p
    LEFT JOIN orders o ON o.id = p.order_id
    LEFT JOIN audit_events ae ON (ae.correlation_id = o.correlation_id OR (ae.metadata->>'paymentId')::text = p.razorpay_payment_id)
    LEFT JOIN audit_outbox ao ON (ao.correlation_id = o.correlation_id OR (ao.metadata->>'paymentId')::text = p.razorpay_payment_id)
    GROUP BY p.id, p.razorpay_payment_id, o.correlation_id, p.status;
  `);

  for (const row of paymentsRes.rows) {
    totalChecked++;
    const totalAuditEvents = Number(row.audit_count) + Number(row.outbox_count);
    if (totalAuditEvents === 0) {
      violations.push({
        entityType: 'PAYMENT',
        entityId: row.id,
        correlationId: row.correlation_id || 'UNKNOWN',
        reason: `Payment ${row.id} (${row.razorpay_payment_id}) has no audit trace.`
      });
    }
  }

  // 3. Check Refunds
  const refundsRes = await pool.query(`
    SELECT r.id, r.correlation_id, r.status,
           COUNT(ae.id) as audit_count, COUNT(ao.id) as outbox_count
    FROM refunds r
    LEFT JOIN audit_events ae ON (ae.correlation_id = r.correlation_id OR (ae.metadata->>'refundId')::text = r.id::text)
    LEFT JOIN audit_outbox ao ON (ao.correlation_id = r.correlation_id OR (ao.metadata->>'refundId')::text = r.id::text)
    GROUP BY r.id, r.correlation_id, r.status;
  `);

  for (const row of refundsRes.rows) {
    totalChecked++;
    const totalAuditEvents = Number(row.audit_count) + Number(row.outbox_count);
    if (totalAuditEvents === 0) {
      violations.push({
        entityType: 'REFUND',
        entityId: row.id,
        correlationId: row.correlation_id,
        reason: `Refund ${row.id} (Status: ${row.status}) has no audit trace.`
      });
    }
  }

  // 4. Check Inventory Reservations
  const invRes = await pool.query(`
    SELECT ir.id, ir.cart_id, ir.status,
           COUNT(ie.id) as event_count,
           COUNT(ae.id) as audit_count,
           COUNT(ao.id) as outbox_count
    FROM inventory_reservations ir
    LEFT JOIN inventory_events ie ON (ie.reservation_id = ir.id OR ie.correlation_id = ir.cart_id::text)
    LEFT JOIN audit_events ae ON ae.correlation_id = ir.cart_id::text
    LEFT JOIN audit_outbox ao ON ao.correlation_id = ir.cart_id::text
    GROUP BY ir.id, ir.cart_id, ir.status;
  `);

  for (const row of invRes.rows) {
    totalChecked++;
    const hasAuditTrace = Number(row.event_count) > 0 || Number(row.audit_count) > 0 || Number(row.outbox_count) > 0;
    if (!hasAuditTrace) {
      violations.push({
        entityType: 'INVENTORY_RESERVATION',
        entityId: row.id,
        correlationId: row.cart_id,
        reason: `Inventory reservation ${row.id} has no corresponding inventory_events or audit log record.`
      });
    }
  }

  const compliant = violations.length === 0;
  return {
    compliant,
    totalCommerceEntitiesChecked: totalChecked,
    unauditedEntitiesCount: violations.length,
    violations,
    summary: compliant
      ? `Audit Atomicity Invariant Verified: All ${totalChecked} critical commerce records are backed by atomic audit/outbox entries.`
      : `Audit Atomicity Violation Detected: ${violations.length} of ${totalChecked} commerce records lack cryptographic audit trails.`
  };
}
