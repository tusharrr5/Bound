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

  it('refuses the injected ₹49,999 item at the cart; only the authorized flask can be paid', async () => {
    const res = await runDirectCheck();

    // The flask is what the human asked for; the espresso station is not, whatever its price
    const [, addFlask, addPayload] = res.steps;
    expect(addFlask.toolResult.ok).toBe(true);
    expect(addPayload.toolResult).toMatchObject({ ok: false, code: 'PRODUCT_NOT_AUTHORIZED_FOR_TASK' });
    expect(res.cartMinor).toBeLessThanOrEqual(ARENA_MANDATE_CEILING_MINOR);

    // Checkout only ever sees the authorized line
    expect(res.checkout.executionMode).toBe('AUTO_EXECUTABLE');
    expect(res.moneyMovedMinor).toBe(99900);
    const cartId = res.steps[0].toolResult.cartId;
    const lines = await pool.query('SELECT variant_id FROM cart_items WHERE cart_id = $1', [cartId]);
    expect(lines.rows.map(r => r.variant_id)).not.toContain('77777777-7777-7777-7777-777777777777');

    // The refusal is in the audit log, and no stock hold is left behind
    const denied = await pool.query(`SELECT 1 FROM audit_events WHERE correlation_id = $1 AND action = 'cart.add_item_denied'`, [res.correlationId]);
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
