import { describe, it, expect, beforeAll } from 'vitest';
import { seedDatabase } from '../../src/db/seed.js';
import { pool } from '../../src/db/pool.js';
import { logAuditEvent, verifyAuditLedger, createAuditCheckpoint } from '../../src/audit/ledger.js';
import { generateMerkleProvenanceReceipt, verifyMerkleInclusionProof } from '../../src/audit/provenance.js';
import {
  stageOutboxAuditEvent,
  processAuditOutboxBatch,
  verifyCommerceAuditAtomicity
} from '../../src/audit/outbox.js';
import {
  verifyExternalWormAnchors,
  externalWormVault
} from '../../src/audit/anchoring.js';

describe('Cryptographic Audit Ledger & Merkle Provenance Suite', () => {
  beforeAll(async () => {
    await seedDatabase();
  });

  it('Verifies unbroken hash chain and signed checkpoints on clean ledger under RFC 8785', async () => {
    await logAuditEvent({
      correlationId: 'corr_audit_test_1',
      actor: 'test:auditor',
      action: 'test.init',
      decision: 'AUTO_EXECUTABLE',
      humanReadable: 'Audit integrity baseline test event 1.'
    });

    await logAuditEvent({
      correlationId: 'corr_audit_test_1',
      actor: 'test:auditor',
      action: 'test.step_2',
      decision: 'AUTO_EXECUTABLE',
      humanReadable: 'Audit integrity baseline test event 2.'
    });

    // Create external KMS/merchant signed checkpoint
    const chk = await createAuditCheckpoint('merchant-key-01');
    expect(chk.ok).toBe(true);
    expect(chk.algorithm).toBe('Ed25519');

    // Verify ledger
    const verifyResult = await verifyAuditLedger();
    expect(verifyResult.valid).toBe(true);
    expect(verifyResult.checkpointsValid).toBe(true);
    expect(verifyResult.checkpointCount).toBeGreaterThanOrEqual(1);
    expect(verifyResult.canonicalization).toBe('RFC8785');
    expect(verifyResult.schemaVersion).toBe('2.0');
    expect(verifyResult.totalEventsChecked).toBeGreaterThan(0);
  });

  it('Generates authentic Merkle Provenance Receipts with valid pairwise inclusion proofs', () => {
    const receipt = generateMerkleProvenanceReceipt({
      orderId: 'ord_merkle_test_123',
      buyerAgentId: '22222222-2222-2222-2222-222222222222',
      merchantId: '11111111-1111-1111-1111-111111111111',
      items: [{ variantId: 'v1', title: 'Espresso Machine', priceMinor: 479900, quantity: 1 }],
      pricing: { grossAmountMinor: 479900, discountAmountMinor: 0, netAmountMinor: 479900 },
      policyDecision: { decision: 'AUTO_EXECUTABLE', reasonCode: 'AUTONOMOUS_RAIL_AUTHORIZED' },
      payment: { provider: 'MOCK_SIMULATED_RAIL', paymentId: 'pay_mock_1', status: 'CAPTURED' }
    });

    expect(receipt.auditRootHash).toBeDefined();
    expect(receipt.merkleTree.leaves.length).toBe(5);

    const priceLeaf = receipt.merkleTree.leaves.find(l => l.key === 'price_snapshot')!;
    const priceProof = receipt.merkleTree.inclusionProofs['price_snapshot'];

    const isValidProof = verifyMerkleInclusionProof(
      priceLeaf.hash,
      priceProof,
      receipt.auditRootHash
    );

    expect(isValidProof).toBe(true);
  });

  it('Per-merchant ledger-head serialization (P1.1): 100 concurrent parallel audit writes serialize without hash forks', async () => {
    const count = 100;
    const writePromises = Array.from({ length: count }, (_, i) =>
      logAuditEvent({
        correlationId: `corr_parallel_audit_${i}`,
        actor: `worker:${i}`,
        action: 'audit.concurrent_append',
        merchantId: '11111111-1111-1111-1111-111111111111',
        decision: 'AUTO_EXECUTABLE',
        humanReadable: `Parallel audit write test event #${i}.`,
        metadata: { index: i }
      })
    );

    const results = await Promise.all(writePromises);
    expect(results.length).toBe(count);

    // Verify cryptographic integrity of full ledger after 100 concurrent appends
    const verifyResult = await verifyAuditLedger();
    expect(verifyResult.valid).toBe(true);
    expect(verifyResult.message).toContain('cryptographically verified');

    // Check sequence numbers are strictly linear with no duplicates
    const allSeq = await pool.query('SELECT sequence_number FROM audit_events ORDER BY sequence_number ASC');
    const seqNumbers = allSeq.rows.map(r => Number(r.sequence_number));
    
    for (let i = 1; i < seqNumbers.length; i++) {
      expect(seqNumbers[i]).toBe(seqNumbers[i - 1] + 1);
    }
  });

  it('Database trigger strictly prevents UPDATE or DELETE on audit_events and raises explicit error', async () => {
    const latestEvent = await pool.query('SELECT id FROM audit_events LIMIT 1');
    const eventId = latestEvent.rows[0].id;

    // Attempting to UPDATE must throw AUDIT_EVENT_IMMUTABLE
    let updateThrew = false;
    try {
      await pool.query("UPDATE audit_events SET human_readable = 'Tampered log content' WHERE id = $1", [eventId]);
    } catch (err: any) {
      updateThrew = true;
      expect(err.message).toContain('AUDIT_EVENT_IMMUTABLE');
    }
    expect(updateThrew).toBe(true);

    // Attempting to DELETE must throw AUDIT_EVENT_IMMUTABLE
    let deleteThrew = false;
    try {
      await pool.query('DELETE FROM audit_events WHERE id = $1', [eventId]);
    } catch (err: any) {
      deleteThrew = true;
      expect(err.message).toContain('AUDIT_EVENT_IMMUTABLE');
    }
    expect(deleteThrew).toBe(true);
  });

  it('Transactional Outbox: Guarantees audit atomicity with commerce state mutations and drains to hash chain', async () => {
    const correlationId = `corr_outbox_test_${Date.now()}`;
    const merchantId = '11111111-1111-1111-1111-111111111111';

    // 1. Transactional Commerce Mutation + Staged Outbox Event in the SAME transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const vRes = await client.query('SELECT id FROM product_variants LIMIT 1');
      const variantId = vRes.rows[0].id;

      // Commerce state mutation: Inventory Reservation
      const resRes = await client.query(`
        INSERT INTO inventory_reservations (variant_id, cart_id, quantity, status, expires_at)
        VALUES ($1, $2, 1, 'ACTIVE', NOW() + INTERVAL '10 minutes')
        RETURNING id;
      `, [variantId, correlationId]);

      // Atomic Audit Event in Outbox
      const outboxRes = await stageOutboxAuditEvent({
        correlationId,
        actor: 'buyer_agent:22222222-2222-2222-2222-222222222222',
        action: 'inventory.reserve',
        merchantId,
        decision: 'AUTO_EXECUTABLE',
        humanReadable: `Atomically reserved 1 unit of variant ${variantId}.`,
        policyRuleId: 'RULE_INVENTORY_RESERVATION',
        metadata: { reservationId: resRes.rows[0].id, quantity: 1 }
      }, client);

      expect(outboxRes.ok).toBe(true);
      expect(outboxRes.outboxId).toBeDefined();

      await client.query('COMMIT');
    } finally {
      client.release();
    }

    // 2. Verify outbox event is in PENDING state
    const pendingCheck = await pool.query('SELECT * FROM audit_outbox WHERE correlation_id = $1', [correlationId]);
    expect(pendingCheck.rows.length).toBe(1);
    expect(pendingCheck.rows[0].status).toBe('PENDING');

    // 3. Run Outbox Worker Batch Drain
    const outboxBatch = await processAuditOutboxBatch(10);
    expect(outboxBatch.processedCount).toBeGreaterThanOrEqual(1);

    // 4. Verify outbox status transitioned to PROCESSED
    const processedCheck = await pool.query('SELECT * FROM audit_outbox WHERE correlation_id = $1', [correlationId]);
    expect(processedCheck.rows[0].status).toBe('PROCESSED');
    expect(processedCheck.rows[0].processed_at).toBeDefined();

    // 5. Verify appended audit record exists in cryptographic ledger with valid hash chain
    const ledgerCheck = await pool.query('SELECT * FROM audit_events WHERE correlation_id = $1', [correlationId]);
    expect(ledgerCheck.rows.length).toBe(1);
    expect(ledgerCheck.rows[0].action).toBe('inventory.reserve');

    const verifyLedger = await verifyAuditLedger();
    expect(verifyLedger.valid).toBe(true);
  });

  it('Audit Atomicity Invariant Monitor: Asserts every commerce mutation has an audit trace and flags unaudited ghost mutations', async () => {
    // 1. Clean audit verification
    const cleanAudit = await verifyCommerceAuditAtomicity();
    expect(cleanAudit.compliant).toBe(true);
    expect(cleanAudit.unauditedEntitiesCount).toBe(0);

    // 2. Inject an unaudited rogue commerce mutation (Ghost Order without audit event or outbox entry)
    const ghostCartId = '88888888-8888-8888-8888-888888888888';
    const ghostOrderId = '99999999-9999-9999-9999-999999999999';
    const ghostCheckoutId = '77777777-7777-7777-7777-777777777777';
    const merchantId = '11111111-1111-1111-1111-111111111111';
    const buyerAgentId = '22222222-2222-2222-2222-222222222222';

    await pool.query(`
      INSERT INTO carts (id, merchant_id, buyer_agent_id, status, correlation_id, expires_at)
      VALUES ($1, $2, $3, 'OPEN', 'ghost_corr_123', NOW() + INTERVAL '10 min') ON CONFLICT (id) DO NOTHING;
    `, [ghostCartId, merchantId, buyerAgentId]);

    await pool.query(`
      INSERT INTO checkouts (id, cart_id, merchant_id, quote_hash, cart_hash, gross_amount_minor, net_amount_minor, execution_mode, status, correlation_id, expires_at)
      VALUES ($1, $2, $3, 'q_hash_ghost', 'c_hash_ghost', 500000, 500000, 'AUTO_EXECUTABLE', 'PENDING', 'ghost_corr_123', NOW() + INTERVAL '10 min')
      ON CONFLICT (id) DO NOTHING;
    `, [ghostCheckoutId, ghostCartId, merchantId]);

    await pool.query(`
      INSERT INTO orders (id, checkout_id, merchant_id, buyer_agent_id, razorpay_order_id, total_minor, status, shipping_address, correlation_id)
      VALUES ($1, $2, $3, $4, 'order_ghost_123', 500000, 'CONFIRMED', '{}', 'ghost_corr_123')
      ON CONFLICT (id) DO NOTHING;
    `, [ghostOrderId, ghostCheckoutId, merchantId, buyerAgentId]);

    // 3. Invariant Monitor MUST CATCH the unaudited ghost mutation
    const detectedViolation = await verifyCommerceAuditAtomicity();
    expect(detectedViolation.compliant).toBe(false);
    expect(detectedViolation.unauditedEntitiesCount).toBeGreaterThanOrEqual(1);
    
    const matchedViolation = detectedViolation.violations.find(v => v.entityId === ghostOrderId);
    expect(matchedViolation).toBeDefined();
    expect(matchedViolation?.entityType).toBe('ORDER');
    expect(matchedViolation?.reason).toContain('committed without any corresponding audit or outbox event');

    // 4. Cleanup ghost mutation
    await pool.query('DELETE FROM orders WHERE id = $1', [ghostOrderId]);
    await pool.query('DELETE FROM checkouts WHERE id = $1', [ghostCheckoutId]);
    await pool.query('DELETE FROM carts WHERE id = $1', [ghostCartId]);
  });

  it('Simulated WORM Anchoring: verifies Ed25519-signed root hash in the in-memory write-once store', async () => {
    // 1. Log fresh audit event
    await logAuditEvent({
      correlationId: `corr_worm_test_${Date.now()}`,
      actor: 'system:compliance_officer',
      action: 'compliance.quarterly_freeze',
      decision: 'AUTO_EXECUTABLE',
      humanReadable: 'Quarterly compliance audit freeze.'
    });

    // 2. Anchor root hash to the simulated WORM store with the local Ed25519 key
    const checkpoint = await createAuditCheckpoint({
      keyId: 'local-compliance-key-01',
      kmsKeyArn: 'local:ed25519:audit-checkpoint-dev-key',
      wormBucketUri: 'memory://simulated-worm/checkpoints/',
      retentionPolicy: 'COMPLIANCE_MODE_7_YEARS'
    });

    expect(checkpoint.ok).toBe(true);
    expect(checkpoint.externalStorageUri).toContain('memory://simulated-worm/checkpoints/');
    expect(checkpoint.kmsKeyArn).toBe('local:ed25519:audit-checkpoint-dev-key');
    expect(checkpoint.wormRetentionPolicy).toBe('COMPLIANCE_MODE_7_YEARS');
    expect(checkpoint.objectLockLegalHold).toBe(true);
    expect(checkpoint.externalObjectSha256).toBeDefined();

    // 3. Verify anchored checkpoints
    const wormVerification = await verifyExternalWormAnchors();
    expect(wormVerification.valid).toBe(true);
    expect(wormVerification.dbCompromiseDetected).toBe(false);
    expect(wormVerification.totalExternalAnchorsChecked).toBeGreaterThanOrEqual(1);
    expect(wormVerification.dbMatchesExternalWorm).toBe(true);
  });

  it('PostgreSQL Database Compromise Detection: anchor cross-verification detects local DB record rewriting', async () => {
    // 1. Create baseline external WORM anchor
    const chk = await createAuditCheckpoint();
    expect(chk.ok).toBe(true);

    const latestSeq = chk.sequenceEnd;

    // 2. Temporarily disable trigger and simulate an attacker with PostgreSQL superuser access rewriting local DB hash
    await pool.query('ALTER TABLE audit_events DISABLE TRIGGER trg_audit_events_immutable;');
    await pool.query(`
      UPDATE audit_events
      SET current_hash = 'tampered_hash_attacker_controlled_0000000000000000000000000000'
      WHERE sequence_number = $1;
    `, [latestSeq]);
    await pool.query('ALTER TABLE audit_events ENABLE TRIGGER trg_audit_events_immutable;');

    // 3. Run External WORM verification: MUST DETECT DB COMPROMISE because external WORM store cannot be rewritten
    const wormDetection = await verifyExternalWormAnchors();
    expect(wormDetection.valid).toBe(false);
    expect(wormDetection.dbCompromiseDetected).toBe(true);
    expect(wormDetection.dbMatchesExternalWorm).toBe(false);
    expect(wormDetection.summary).toContain('CRITICAL SECURITY ALERT: PostgreSQL database tampering detected');

    // 4. Restore original hash
    await pool.query('ALTER TABLE audit_events DISABLE TRIGGER trg_audit_events_immutable;');
    await pool.query(`
      UPDATE audit_events
      SET current_hash = $1
      WHERE sequence_number = $2;
    `, [chk.rootHash, latestSeq]);
    await pool.query('ALTER TABLE audit_events ENABLE TRIGGER trg_audit_events_immutable;');

    // 5. Verify restored state is clean again
    const postRestore = await verifyExternalWormAnchors();
    expect(postRestore.valid).toBe(true);
    expect(postRestore.dbCompromiseDetected).toBe(false);
  });
});
