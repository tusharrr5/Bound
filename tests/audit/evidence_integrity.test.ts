import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { seedDatabase } from '../../src/db/seed.js';
import { pool } from '../../src/db/pool.js';
import {
  buildMerkleTree, hashLeafData, hashPair, verifyMerkleInclusionProof, verifyLeafInclusion,
  generateMerkleProvenanceReceipt
} from '../../src/audit/provenance.js';
import { logAuditEvent, verifyAuditLedger, createAuditCheckpoint } from '../../src/audit/ledger.js';
import { verifyExternalWormAnchors } from '../../src/audit/anchoring.js';

const order = (over: Partial<{ title: string; variantId: string; quantity: number; priceMinor: number; merchantId: string }> = {}) => ({
  orderId: 'ord_1',
  merchantId: over.merchantId ?? 'm_1',
  items: [
    { variantId: over.variantId ?? 'v_flask', title: over.title ?? 'SteelBrew Flask', priceMinor: over.priceMinor ?? 129900, quantity: over.quantity ?? 1 },
    { variantId: 'v_mug', title: 'ThermoMug', priceMinor: 69900, quantity: 1, meta: { tags: ['steel', null], nested: { deep: true } } }
  ]
});

describe('Merkle provenance commits to nested transaction data', () => {
  it.each([
    ['nested product title', { title: 'Espresso Station' }],
    ['nested variant id', { variantId: 'v_x9' }],
    ['quantity', { quantity: 60 }],
    ['price', { priceMinor: 100 }],
    ['merchant id', { merchantId: 'm_2' }]
  ])('a changed %s changes the leaf and fails the proof', (_label, change) => {
    const tree = buildMerkleTree([{ key: 'product_snapshot', data: order() }, { key: 'price', data: { gross: 1 } }]);
    const proof = tree.inclusionProofs['product_snapshot'];
    expect(verifyLeafInclusion('product_snapshot', order(), proof, tree.rootHash)).toBe(true);
    expect(hashLeafData(order(change), 'product_snapshot')).not.toBe(hashLeafData(order(), 'product_snapshot'));
    expect(verifyLeafInclusion('product_snapshot', order(change), proof, tree.rootHash)).toBe(false);
  });

  it('binds the leaf key, so a leaf cannot be moved to another position', () => {
    const tree = buildMerkleTree([{ key: 'a', data: { x: 1 } }, { key: 'b', data: { x: 1 } }]);
    expect(tree.leaves[0].hash).not.toBe(tree.leaves[1].hash);
    expect(verifyLeafInclusion('b', { x: 1 }, tree.inclusionProofs['a'], tree.rootHash)).toBe(false);
  });

  it('separates leaves from internal nodes', () => {
    const l = hashLeafData({ a: 1 }, 'k');
    expect(hashPair(l, l)).not.toBe(l);
  });

  it.each([1, 2, 3, 4, 5, 7, 8, 9])('every proof verifies for %i leaves', n => {
    const tree = buildMerkleTree(Array.from({ length: n }, (_, i) => ({ key: `k${i}`, data: { i, nested: { arr: [i, null] } } })));
    for (const leaf of tree.leaves) {
      expect(verifyMerkleInclusionProof(leaf.hash, tree.inclusionProofs[leaf.key], tree.rootHash)).toBe(true);
    }
  });

  it('single leaf: the root is the leaf; empty: a fixed empty root', () => {
    const one = buildMerkleTree([{ key: 'only', data: { a: 1 } }]);
    expect(one.rootHash).toBe(one.leaves[0].hash);
    const empty1 = buildMerkleTree([]);
    const empty2 = buildMerkleTree([]);
    expect(empty1.rootHash).toBe(empty2.rootHash);
    expect(empty1.rootHash).not.toBe(one.rootHash);
  });

  it('promotes an odd node instead of pairing it with itself', () => {
    const tree = buildMerkleTree(['a', 'b', 'c'].map(k => ({ key: k, data: { k } })));
    const [a, b, c] = tree.leaves.map(l => l.hash);
    expect(tree.rootHash).toBe(hashPair(hashPair(a, b), c));
    expect(tree.rootHash).not.toBe(hashPair(hashPair(a, b), hashPair(c, c)));
  });

  it('changes the root when leaves are reordered, and refuses duplicate keys', () => {
    const ab = buildMerkleTree([{ key: 'a', data: { v: 1 } }, { key: 'b', data: { v: 2 } }]);
    const ba = buildMerkleTree([{ key: 'b', data: { v: 2 } }, { key: 'a', data: { v: 1 } }]);
    expect(ab.rootHash).not.toBe(ba.rootHash);
    expect(() => buildMerkleTree([{ key: 'a', data: {} }, { key: 'a', data: {} }])).toThrow('Duplicate');
  });

  it('a provenance receipt commits to each product line', () => {
    const base = {
      orderId: 'ord_r', buyerAgentId: 'agent_r', merchantId: 'm_r',
      items: [{ variantId: 'v1', title: 'Flask', priceMinor: 99900, quantity: 1 }],
      pricing: { grossAmountMinor: 99900, discountAmountMinor: 0, netAmountMinor: 99900 },
      policyDecision: { decision: 'AUTO_EXECUTABLE', reasonCode: 'OK' },
      payment: { provider: 'SIMULATED', paymentId: 'p1', status: 'CAPTURED' }
    };
    const r1 = generateMerkleProvenanceReceipt(base);
    const r2 = generateMerkleProvenanceReceipt({ ...base, items: [{ ...base.items[0], variantId: 'v_x9' }] });
    expect(r1.auditRootHash).not.toBe(r2.auditRootHash);
  });
});

describe('Audit ledger is verified per merchant', () => {
  let merchantB: string;

  beforeAll(async () => {
    await seedDatabase();
    merchantB = crypto.randomUUID();
    await pool.query(`INSERT INTO merchants (id, name, slug, razorpay_key_id, currency) VALUES ($1, 'Ledger B', $2, 'rzp_test_lb', 'INR')`,
      [merchantB, `lb-${merchantB.slice(0, 8)}`]);
  });

  it('keeps two merchants\' interleaved chains valid (sequence numbers overlap)', async () => {
    for (let i = 0; i < 4; i++) {
      await logAuditEvent({ correlationId: `c_a_${i}`, actor: 'test', action: 'test.a', humanReadable: `A ${i}` });
      await logAuditEvent({ correlationId: `c_b_${i}`, actor: 'test', action: 'test.b', merchantId: merchantB, humanReadable: `B ${i}` });
    }
    const seqB = await pool.query('SELECT sequence_number FROM audit_events WHERE merchant_id = $1 ORDER BY 1', [merchantB]);
    expect(seqB.rows.map(r => Number(r.sequence_number))).toEqual([1, 2, 3, 4]);
    expect((await verifyAuditLedger()).valid).toBe(true);
  });

  it('serializes concurrent appends to one merchant without gaps or forks', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      logAuditEvent({ correlationId: `c_conc_${i}`, actor: 'test', action: 'test.conc', merchantId: merchantB, humanReadable: `conc ${i}` })));
    const seqs = (await pool.query('SELECT sequence_number FROM audit_events WHERE merchant_id = $1 ORDER BY 1', [merchantB])).rows.map(r => Number(r.sequence_number));
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    expect((await verifyAuditLedger()).valid).toBe(true);
  });

  it('checkpoints and anchors one merchant\'s chain', async () => {
    const chk = await createAuditCheckpoint({ merchantId: merchantB });
    expect((chk as any).ok).toBe(true);
    const anchors = await verifyExternalWormAnchors();
    expect(anchors.dbMatchesExternalWorm).toBe(true);
    expect((await verifyAuditLedger()).checkpointsValid).toBe(true);
  });

  it('detects a tampered event in one merchant\'s chain', async () => {
    await pool.query('ALTER TABLE audit_events DISABLE TRIGGER trg_audit_events_immutable');
    try {
      await pool.query(`UPDATE audit_events SET human_readable = 'rewritten' WHERE merchant_id = $1 AND sequence_number = 2`, [merchantB]);
      const res = await verifyAuditLedger();
      expect(res.valid).toBe(false);
      expect(res.message).toContain(merchantB);
    } finally {
      await pool.query('ALTER TABLE audit_events ENABLE TRIGGER trg_audit_events_immutable');
    }
  });

  it('detects events removed from the end of a chain via the ledger head', async () => {
    await seedDatabase();
    for (let i = 0; i < 3; i++) await logAuditEvent({ correlationId: `c_t_${i}`, actor: 'test', action: 'test.t', merchantId: merchantB, humanReadable: `t ${i}` });
    expect((await verifyAuditLedger()).valid).toBe(true);
    await pool.query('ALTER TABLE audit_events DISABLE TRIGGER trg_audit_events_immutable');
    try {
      await pool.query(`DELETE FROM audit_events WHERE merchant_id = $1 AND sequence_number = 3`, [merchantB]);
      const res = await verifyAuditLedger();
      expect(res.valid).toBe(false);
      expect(res.message).toContain('removed');
    } finally {
      await pool.query('ALTER TABLE audit_events ENABLE TRIGGER trg_audit_events_immutable');
    }
  });
});
