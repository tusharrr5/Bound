import { describe, it, expect, beforeAll } from 'vitest';
import { pool } from '../../src/db/pool.js';
import { seedDatabase } from '../../src/db/seed.js';
import { reserveStock, reserveMultiStock, releaseReservation, commitReservationForCart } from '../../src/inventory/reservation.js';
import { addToCart, createCart } from '../../src/cart/service.js';

describe('Atomic Inventory Reservation & Concurrency Invariant Suite', () => {
  beforeAll(async () => {
    await seedDatabase();
  });

  it('20 concurrent requests competing for 1 unit of stock yields exactly 1 winner and 19 rejections across repeated trials', async () => {
    for (let trial = 1; trial <= 5; trial++) {
      // Reset SKU stock to exactly 1 and clean prior reservations
      const vRes = await pool.query(`
        UPDATE product_variants 
        SET stock_qty = 1, reserved_qty = 0 
        WHERE sku = 'CONC-HOT-01-LTD'
        RETURNING id, stock_qty, reserved_qty;
      `);
      const hotVariantId = vRes.rows[0].id;
      await pool.query(`DELETE FROM inventory_reservations WHERE variant_id = $1`, [hotVariantId]);

      const numConcurrentRequests = 20;
      const correlationBase = `trial_${trial}_corr_${Date.now()}`;

      // Launch 20 concurrent promises simultaneously
      const reservationPromises = Array.from({ length: numConcurrentRequests }, (_, idx) =>
        reserveStock(hotVariantId, `cart_race_${trial}_${idx}`, 1, `${correlationBase}_${idx}`)
      );

      const results = await Promise.all(reservationPromises);

      const successful = results.filter(r => r.success);
      const rejected = results.filter(r => !r.success && r.errorCode === 'INSUFFICIENT_STOCK');

      expect(successful.length).toBe(1);
      expect(rejected.length).toBe(numConcurrentRequests - 1);

      // Verify DB invariant: reserved_qty must be exactly 1, stock_qty exactly 1
      const finalDbCheck = await pool.query(`
        SELECT stock_qty, reserved_qty 
        FROM product_variants 
        WHERE id = $1;
      `, [hotVariantId]);

      expect(finalDbCheck.rows[0].stock_qty).toBe(1);
      expect(finalDbCheck.rows[0].reserved_qty).toBe(1);
    }
  });

  it('Database row lock lasts only milliseconds during reservation and releases immediately', async () => {
    const vRes = await pool.query(`
      UPDATE product_variants 
      SET stock_qty = 50, reserved_qty = 0 
      WHERE sku = 'BREW-42-BLK'
      RETURNING id;
    `);
    const variantId = vRes.rows[0].id;
    await pool.query(`DELETE FROM inventory_reservations WHERE variant_id = $1`, [variantId]);

    const start = Date.now();
    const res = await reserveStock(variantId, 'cart_speed_test_1', 1, 'corr_speed_1');
    const elapsed = Date.now() - start;

    expect(res.success).toBe(true);
    expect(res.lockDurationMs).toBeDefined();
    // Database lock duration is under 50 milliseconds
    expect(res.lockDurationMs).toBeLessThan(50);
    expect(elapsed).toBeLessThan(100);

    // Verify reservation row has a 10-minute TTL
    expect(res.expiresAt).toBeDefined();
    const ttlMs = res.expiresAt!.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(9 * 60 * 1000); // ~10 minutes
  });

  it('Concurrent addToCart API requests safely serialize row-locks without deadlock', async () => {
    const vRes = await pool.query(`
      UPDATE product_variants 
      SET stock_qty = 1, reserved_qty = 0 
      WHERE sku = 'CONC-HOT-02-LTD'
      RETURNING id;
    `);
    const variantId = vRes.rows[0].id;
    await pool.query(`DELETE FROM inventory_reservations WHERE variant_id = $1`, [variantId]);

    // Create 10 distinct shopping carts
    const carts = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createCart('22222222-2222-2222-2222-222222222222', `corr_cart_init_${i}`)
      )
    );

    // Concurrently invoke addToCart on the scarce item across 10 carts
    const outcomes = await Promise.all(
      carts.map(c => addToCart(c.cartId, variantId, 1, `corr_race_add_${c.cartId}`))
    );

    const successCount = outcomes.filter(o => o.ok).length;
    const failCount = outcomes.filter(o => !o.ok).length;

    expect(successCount).toBe(1);
    expect(failCount).toBe(9);
  });

  it('Multi-item reservation in reverse orders (A then B vs B then A) completes without deadlock via canonical sorting', async () => {
    const vResA = await pool.query(`SELECT id FROM product_variants WHERE sku = 'BREW-42-BLK'`);
    const vResB = await pool.query(`SELECT id FROM product_variants WHERE sku = 'SONIC-H7-BLK'`);
    const variantA = vResA.rows[0].id;
    const variantB = vResB.rows[0].id;

    await pool.query(`UPDATE product_variants SET stock_qty = 10, reserved_qty = 0 WHERE id IN ($1, $2)`, [variantA, variantB]);
    await pool.query(`DELETE FROM inventory_reservations WHERE variant_id IN ($1, $2)`, [variantA, variantB]);

    // Cart 1 requests [B, A]
    const p1 = reserveMultiStock([
      { variantId: variantB, quantity: 1 },
      { variantId: variantA, quantity: 1 }
    ], 'cart_multi_1', 'corr_multi_1');

    // Cart 2 requests [A, B]
    const p2 = reserveMultiStock([
      { variantId: variantA, quantity: 1 },
      { variantId: variantB, quantity: 1 }
    ], 'cart_multi_2', 'corr_multi_2');

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r1.reservations.length).toBe(2);
    expect(r2.reservations.length).toBe(2);
  });

  it('Blocks reservation hoarding when a single agent exceeds active reservation limit', async () => {
    const hoardingAgentId = '88888888-8888-8888-8888-888888888888';
    await pool.query(`
      INSERT INTO buyer_agents (id, label, principal_name, key_custody_tier)
      VALUES ($1, 'Hoarding Test Agent', 'Hoarding Test Principal', 'DEV_KEY_STORAGE')
      ON CONFLICT (id) DO NOTHING;
    `, [hoardingAgentId]);

    const vRes = await pool.query(`SELECT id FROM product_variants WHERE sku = 'RICE-ROYAL-5K-PK'`);
    const variantId = vRes.rows[0].id;

    // Reset stock to 100
    await pool.query(`UPDATE product_variants SET stock_qty = 100, reserved_qty = 0 WHERE id = $1`, [variantId]);
    await pool.query(`DELETE FROM inventory_reservations WHERE buyer_agent_id = $1`, [hoardingAgentId]);

    // Create 10 active reservations (limit is 10)
    for (let i = 0; i < 10; i++) {
      const cart = await createCart(hoardingAgentId, `corr_hoard_${i}`);
      const r = await reserveStock(variantId, cart.cartId, 1, `corr_hoard_${i}`, undefined, hoardingAgentId);
      expect(r.success).toBe(true);
    }

    // 11th reservation attempt must be throttled/blocked
    const extraCart = await createCart(hoardingAgentId, 'corr_hoard_extra');
    const extraRes = await reserveStock(variantId, extraCart.cartId, 1, 'corr_hoard_extra', undefined, hoardingAgentId);

    expect(extraRes.success).toBe(false);
    expect(extraRes.errorCode).toBe('RESERVATION_HOARDING_BLOCKED');

    // Clean up
    await pool.query(`DELETE FROM inventory_reservations WHERE buyer_agent_id = $1`, [hoardingAgentId]);
  });

  it('Enforces DB-level inventory invariants: reserved_qty <= stock_qty, on_hand >= 0, reserved >= 0', async () => {
    const vRes = await pool.query(`SELECT id, stock_qty, reserved_qty FROM product_variants WHERE sku = 'SONIC-H7-BLK'`);
    const variantId = vRes.rows[0].id;
    const currentStock = vRes.rows[0].stock_qty;

    // 1. Attempting reserved_qty > stock_qty must violate DB constraint 'reserved_le_stock' or 'stock_check'
    await expect(
      pool.query(`UPDATE product_variants SET reserved_qty = $1 WHERE id = $2::uuid`, [currentStock + 10, variantId])
    ).rejects.toThrow(/(reserved_le_stock|stock_check|check|violat)/i);

    // 2. Attempting negative stock_qty must violate check constraint
    await expect(
      pool.query(`UPDATE product_variants SET stock_qty = -1 WHERE id = $1::uuid`, [variantId])
    ).rejects.toThrow(/check|violat/i);

    // 3. Attempting negative reserved_qty must violate check constraint
    await expect(
      pool.query(`UPDATE product_variants SET reserved_qty = -1 WHERE id = $1::uuid`, [variantId])
    ).rejects.toThrow(/check|violat/i);
  });

  it('Enforces Idempotent Reservation Release: ACTIVE -> RELEASED cannot double-decrement reserved_qty on repeat calls', async () => {
    const vRes = await pool.query(`SELECT id FROM product_variants WHERE sku = 'BREW-42-BLK'`);
    const variantId = vRes.rows[0].id;

    // Set baseline: 10 stock, 0 reserved
    await pool.query(`UPDATE product_variants SET stock_qty = 10, reserved_qty = 0 WHERE id = $1::uuid`, [variantId]);

    const cart = await createCart('22222222-2222-2222-2222-222222222222', 'corr_release_idempotent');
    const res = await reserveStock(variantId, cart.cartId, 2, 'corr_release_idempotent');
    expect(res.success).toBe(true);

    const postReserve = await pool.query(`SELECT reserved_qty FROM product_variants WHERE id = $1::uuid`, [variantId]);
    expect(postReserve.rows[0].reserved_qty).toBe(2);

    // First release call: ACTIVE -> RELEASED (decrements 2 units -> 0)
    const rel1 = await releaseReservation(variantId, cart.cartId, 2, 'corr_release_1');
    expect(rel1).toBe(true);

    const postRelease1 = await pool.query(`SELECT reserved_qty FROM product_variants WHERE id = $1::uuid`, [variantId]);
    expect(postRelease1.rows[0].reserved_qty).toBe(0);

    // Second release call: Idempotent (must NOT double-decrement or throw)
    const rel2 = await releaseReservation(variantId, cart.cartId, 2, 'corr_release_2');
    expect(rel2).toBe(true);

    const postRelease2 = await pool.query(`SELECT reserved_qty FROM product_variants WHERE id = $1::uuid`, [variantId]);
    expect(postRelease2.rows[0].reserved_qty).toBe(0);
  });

  it('Enforces Reservation State Transition Rules and Rejects Illegal Transitions (COMMITTED -> RELEASED)', async () => {
    const vRes = await pool.query(`SELECT id FROM product_variants WHERE sku = 'BREW-42-BLK'`);
    const variantId = vRes.rows[0].id;

    await pool.query(`UPDATE product_variants SET stock_qty = 10, reserved_qty = 0 WHERE id = $1::uuid`, [variantId]);

    const cart = await createCart('22222222-2222-2222-2222-222222222222', 'corr_res_transition_test');
    const res = await reserveStock(variantId, cart.cartId, 1, 'corr_res_transition_test');
    expect(res.success).toBe(true);

    // 1. ACTIVE -> COMMITTED (Successful Payment Commit)
    const committed = await commitReservationForCart(cart.cartId, 'corr_commit_1');
    expect(committed).toBe(true);

    const postCommit = await pool.query(`SELECT status FROM inventory_reservations WHERE id = $1`, [res.reservationId]);
    expect(postCommit.rows[0].status).toBe('COMMITTED');

    // 2. COMMITTED -> RELEASED must be rejected by application state machine
    await expect(
      releaseReservation(variantId, cart.cartId, 1, 'corr_illegal_release')
    ).rejects.toThrow(/ILLEGAL_RESERVATION_STATE_TRANSITION/);

    // 3. Direct DB update attempting illegal transition from COMMITTED to ACTIVE must be blocked by DB trigger
    await expect(
      pool.query(`UPDATE inventory_reservations SET status = 'ACTIVE' WHERE id = $1`, [res.reservationId])
    ).rejects.toThrow(/ILLEGAL_RESERVATION_STATE_TRANSITION/);
  });

  it('Sybil Hoarding Defense: Multi-Agent Sybil attack under same Human Principal on hot SKU is strictly blocked', async () => {
    // Limited stock SKU (e.g. 5 units total)
    const vRes = await pool.query(`SELECT id FROM product_variants WHERE sku = 'CONC-HOT-01-LTD'`);
    const variantId = vRes.rows[0].id;
    await pool.query(`UPDATE product_variants SET stock_qty = 5, reserved_qty = 0 WHERE id = $1::uuid`, [variantId]);

    // Attacker registers 2 distinct buyer agents
    const agentAId = 'a1111111-1111-1111-1111-111111111111';
    const agentBId = 'b2222222-2222-2222-2222-222222222222';

    await pool.query(`
      INSERT INTO buyer_agents (id, label, principal_name) 
      VALUES ($1, 'Sybil Agent Alpha', 'Malicious Hoarder Principal'),
             ($2, 'Sybil Agent Beta', 'Malicious Hoarder Principal')
      ON CONFLICT (id) DO NOTHING;
    `, [agentAId, agentBId]);

    const cartA = await createCart(agentAId, 'corr_sybil_cart_a');
    const cartB = await createCart(agentBId, 'corr_sybil_cart_b');

    // 1. Agent A successfully acquires 1 reservation on hot SKU
    const resA = await reserveStock(variantId, cartA.cartId, 1, 'corr_sybil_1', undefined, {
      agentId: agentAId,
      humanPrincipalId: 'Malicious Hoarder Principal',
      ipAddress: '198.51.100.25'
    });
    expect(resA.success).toBe(true);

    // 2. Agent B (different agent ID, but same Human Principal) attempts to hoard another unit of the same hot SKU
    const resB = await reserveStock(variantId, cartB.cartId, 1, 'corr_sybil_2', undefined, {
      agentId: agentBId,
      humanPrincipalId: 'Malicious Hoarder Principal',
      ipAddress: '198.51.100.99'
    });

    expect(resB.success).toBe(false);
    expect(resB.errorCode).toBe('SYBIL_RESERVATION_HOARDING_BLOCKED');
    expect(resB.errorMessage).toContain('Sybil Reservation Hoarding Blocked');
    expect(resB.errorMessage).toContain('Human Delegation Owner');
  });

  it('Sybil Hoarding Defense: Multi-Agent Sybil attack from same Network IP Subnet / Device is blocked on hot items', async () => {
    const vRes = await pool.query(`SELECT id FROM product_variants WHERE sku = 'CONC-HOT-02-LTD'`);
    const variantId = vRes.rows[0].id;
    await pool.query(`UPDATE product_variants SET stock_qty = 3, reserved_qty = 0 WHERE id = $1::uuid`, [variantId]);

    const agentXId = 'c3333333-3333-3333-3333-333333333333';
    const agentYId = 'd4444444-4444-4444-4444-444444444444';

    await pool.query(`
      INSERT INTO buyer_agents (id, label, principal_name) 
      VALUES ($1, 'Bot Cluster Node 1', 'Anon Principal 1'),
             ($2, 'Bot Cluster Node 2', 'Anon Principal 2')
      ON CONFLICT (id) DO NOTHING;
    `, [agentXId, agentYId]);

    const cartX = await createCart(agentXId, 'corr_sybil_net_x');
    const cartY = await createCart(agentYId, 'corr_sybil_net_y');

    // Agent X reserves with IP 203.0.113.10
    const resX = await reserveStock(variantId, cartX.cartId, 1, 'corr_net_1', undefined, {
      agentId: agentXId,
      humanPrincipalId: 'Anon Principal 1',
      ipAddress: '203.0.113.10',
      deviceFingerprint: 'dev_fp_iphone_safari_abc123'
    });
    expect(resX.success).toBe(true);

    // Agent Y attempts to reserve from same /24 subnet (203.0.113.88) and same device fingerprint
    const resY = await reserveStock(variantId, cartY.cartId, 1, 'corr_net_2', undefined, {
      agentId: agentYId,
      humanPrincipalId: 'Anon Principal 2',
      ipAddress: '203.0.113.88',
      deviceFingerprint: 'dev_fp_iphone_safari_abc123'
    });

    expect(resY.success).toBe(false);
    expect(resY.errorCode).toBe('SYBIL_RESERVATION_HOARDING_BLOCKED');
  });

  it('Sybil Hoarding Defense: Multi-Agent Sybil attack with matching Shipping Address Destination is blocked', async () => {
    const vRes = await pool.query(`SELECT id FROM product_variants WHERE sku = 'CONC-HOT-01-LTD'`);
    const variantId = vRes.rows[0].id;
    await pool.query(`UPDATE product_variants SET stock_qty = 5, reserved_qty = 0 WHERE id = $1::uuid`, [variantId]);

    const agentMId = 'e5555555-5555-5555-5555-555555555555';
    const agentNId = 'f6666666-6666-6666-6666-666666666666';

    await pool.query(`
      INSERT INTO buyer_agents (id, label, principal_name) 
      VALUES ($1, 'Sybil Address Bot 1', 'Owner 1'),
             ($2, 'Sybil Address Bot 2', 'Owner 2')
      ON CONFLICT (id) DO NOTHING;
    `, [agentMId, agentNId]);

    const cartM = await createCart(agentMId, 'corr_addr_m');
    const cartN = await createCart(agentNId, 'corr_addr_n');

    const address = {
      line1: 'Flat 402, 12th Main Road, Indiranagar',
      city: 'Bengaluru',
      postal_code: '560038',
      country: 'IN'
    };

    // Agent M reserves with delivery address
    const resM = await reserveStock(variantId, cartM.cartId, 1, 'corr_addr_1', undefined, {
      agentId: agentMId,
      shippingAddress: address
    });
    expect(resM.success).toBe(true);

    // Agent N attempts to reserve with slightly formatted variation of the same physical address
    const resN = await reserveStock(variantId, cartN.cartId, 1, 'corr_addr_2', undefined, {
      agentId: agentNId,
      shippingAddress: {
        line1: 'flat 402, 12th main road indiranagar',
        city: 'bengaluru',
        postal_code: '560038',
        country: 'IN'
      }
    });

    expect(resN.success).toBe(false);
    expect(resN.errorCode).toBe('SYBIL_RESERVATION_HOARDING_BLOCKED');
    expect(resN.errorMessage).toContain('Shipping Address Destination');
  });
});
