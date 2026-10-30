import { describe, it, expect, beforeAll } from 'vitest';
import { seedDatabase } from '../../src/db/seed.js';
import { pool } from '../../src/db/pool.js';
import { runDirectCheck, listAttackPresets } from '../../src/arena/service.js';
import { verifyPurchaseMandate } from '../../src/policy/mandates.js';
import { ARENA_AGENT_ID, ARENA_MANDATE_CEILING_MINOR } from '../../src/arena/catalog.js';

// The Arena's guarantee without any model in the loop: whatever fills the cart,
// checkout refuses anything over the signed limit and no money moves.
describe('Arena wall (no model needed)', () => {
  beforeAll(async () => {
    await seedDatabase();
  });

  it('refuses the injected ₹49,999 cart under a ₹5,000 signed mandate and moves nothing', async () => {
    const res = await runDirectCheck();

    expect(res.cartMinor).toBeGreaterThan(ARENA_MANDATE_CEILING_MINOR);
    expect(res.checkout.ok).toBe(false);
    expect(res.checkout.executionMode).toBe('DENIED');
    expect(res.checkout.errorCode).toBe('MANDATE_EXHAUSTED');
    expect(res.moneyMovedMinor).toBe(0);

    // No order or payment exists for the refused cart
    const cartId = res.steps[0].toolResult.cartId;
    const orders = await pool.query('SELECT 1 FROM checkouts WHERE cart_id::text = $1', [cartId]);
    expect(orders.rowCount).toBe(0);

    // The refusal is in the audit log, and the stock hold was released
    const denied = await pool.query(`SELECT 1 FROM audit_events WHERE correlation_id = $1 AND action = 'checkout.denied'`, [res.correlationId]);
    expect(denied.rowCount).toBe(1);
    const holds = await pool.query(`SELECT 1 FROM inventory_reservations WHERE buyer_agent_id = $1 AND status = 'ACTIVE'`, [ARENA_AGENT_ID]);
    expect(holds.rowCount).toBe(0);
  });

  it('lets the same mandate pay for an honest in-limit cart', async () => {
    const res = await runDirectCheck({ includePayload: false });

    expect(res.checkout.ok).toBe(true);
    expect(res.checkout.executionMode).toBe('AUTO_EXECUTABLE');
    expect(res.moneyMovedMinor).toBe(99900);
  });

  it('keeps an earlier run\'s mandate valid after later runs bind newer keys', async () => {
    const first = await runDirectCheck({ includePayload: false });
    await runDirectCheck({ includePayload: false });

    const check = await verifyPurchaseMandate(
      first.mandate.mandateTokenId, '11111111-1111-1111-1111-111111111111', ARENA_AGENT_ID, 50000, ['Kitchen', 'Drinkware']
    );
    expect(check.errorCode).toBeUndefined();
    expect(check.valid).toBe(true);
  });

  it('ships attack presets that all reference the payload and have consistent counts', () => {
    const presets = listAttackPresets();
    expect(presets.length).toBeGreaterThan(0);
    for (const p of presets) {
      expect(p.text.length).toBeGreaterThan(20);
      expect(p.fooled).toBeLessThanOrEqual(p.runs);
      expect(p.blocked).toBeLessThanOrEqual(p.fooled);
    }
  });
});
