import pg from 'pg';
import { pool } from '../db/pool.js';
import { reserveStock, releaseReservation, cleanupExpiredReservations } from '../inventory/reservation.js';
import { logAuditEvent } from '../audit/ledger.js';
import { computeCanonicalCartHash } from '../pricing/quotes.js';
import { getPurchaseTask } from '../intent/tasks.js';
import { authorizeLineForTask, loadAuthorizableProduct } from '../intent/authorize.js';

/** Largest quantity any single cart mutation may request. */
const MAX_QUANTITY_PER_MUTATION = 100;

export class CartTaskBindingError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export interface CartItem {
  id: string;
  variantId: string;
  sku: string;
  title: string;
  productTitle: string;
  quantity: number;
  unitPriceMinor: number;
  totalPriceMinor: number;
}

export interface CartSummary {
  cartId: string;
  buyerAgentId: string;
  merchantId: string;
  status: 'OPEN' | 'CONVERTED_TO_CHECKOUT' | 'EXPIRED' | 'ABANDONED';
  items: CartItem[];
  itemCount: number;
  grossAmountMinor: number;
  cartHash: string;
  currency: string;
  expiresAt: string;
  /** Purchase task this cart serves; null for carts a human fills directly. */
  purchaseTaskId: string | null;
}

export async function createCart(
  buyerAgentId: string,
  correlationId: string,
  customMerchantId?: string,
  options: { purchaseTaskId?: string } = {}
): Promise<CartSummary> {
  let merchantId = customMerchantId;
  if (!merchantId) {
    const mRes = await pool.query("SELECT id FROM merchants WHERE slug = 'apex-retail' OR id = '11111111-1111-1111-1111-111111111111' LIMIT 1;");
    if (mRes.rows.length === 0) {
      const fallback = await pool.query('SELECT id FROM merchants ORDER BY created_at ASC LIMIT 1;');
      if (fallback.rows.length === 0) throw new Error('No merchant configured');
      merchantId = fallback.rows[0].id;
    } else {
      merchantId = mRes.rows[0].id;
    }
  }

  // A task-bound cart may only be opened by the task's agent, at the task's merchant, while active
  if (options.purchaseTaskId) {
    const task = await getPurchaseTask(options.purchaseTaskId);
    if (!task) throw new CartTaskBindingError('TASK_NOT_FOUND', 'Purchase task does not exist.');
    if (task.buyerAgentId !== buyerAgentId) throw new CartTaskBindingError('TASK_AGENT_MISMATCH', 'Agent is not authorized for this purchase task.');
    if (task.merchantId !== merchantId) throw new CartTaskBindingError('MERCHANT_MISMATCH', 'Purchase task is for a different merchant.');
    if (task.status !== 'ACTIVE') throw new CartTaskBindingError('TASK_NOT_ACTIVE', `Purchase task is ${task.status}.`);
    if (new Date() > new Date(task.expiresAt)) throw new CartTaskBindingError('TASK_EXPIRED', 'Purchase task has expired.');
  }

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const res = await pool.query(`
    INSERT INTO carts (buyer_agent_id, merchant_id, status, correlation_id, expires_at, purchase_task_id)
    VALUES ($1, $2, 'OPEN', $3, $4, $5)
    RETURNING id, buyer_agent_id, merchant_id, status, expires_at, purchase_task_id;
  `, [buyerAgentId, merchantId, correlationId, expiresAt, options.purchaseTaskId ?? null]);

  const cart = res.rows[0];
  const cartHash = computeCanonicalCartHash(cart.merchant_id, cart.id, []);

  await logAuditEvent({
    correlationId,
    actor: `buyer_agent:${buyerAgentId}`,
    action: 'cart.create',
    merchantId,
    decision: 'AUTO_EXECUTABLE',
    humanReadable: `Created stateful Cart ${cart.id} for Buyer Agent ${buyerAgentId}.`,
    metadata: { cartId: cart.id, merchantId }
  });

  return {
    cartId: cart.id,
    buyerAgentId: cart.buyer_agent_id,
    merchantId: cart.merchant_id,
    status: cart.status,
    purchaseTaskId: cart.purchase_task_id ?? null,
    items: [],
    itemCount: 0,
    grossAmountMinor: 0,
    cartHash,
    currency: 'INR',
    expiresAt: cart.expires_at
  };
}

export async function addToCart(
  cartId: string,
  variantId: string,
  quantity: number,
  correlationId: string
): Promise<{ ok: boolean; cart?: CartSummary; code?: string; message?: string; product?: { variantId: string; title?: string; priceMinor: number } }> {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_MUTATION) {
    return { ok: false, code: 'INVALID_QUANTITY', message: `Quantity must be an integer from 1 to ${MAX_QUANTITY_PER_MUTATION}.` };
  }
  if (!/^[0-9a-f-]{36}$/i.test(cartId) || !/^[0-9a-f-]{36}$/i.test(variantId)) {
    return { ok: false, code: 'INVALID_ID', message: 'Cart and variant ids must be UUIDs.' };
  }
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Validate Cart Exists, is OPEN and not expired
    const cartRes = await client.query(`
      SELECT id, buyer_agent_id, merchant_id, status, expires_at, purchase_task_id
      FROM carts
      WHERE id = $1
      FOR UPDATE;
    `, [cartId]);

    if (cartRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'CART_NOT_FOUND', message: `Cart ${cartId} does not exist.` };
    }

    const cart = cartRes.rows[0];
    if (cart.status !== 'OPEN') {
      await client.query('ROLLBACK');
      return { ok: false, code: 'CART_NOT_OPEN', message: `Cart ${cartId} is in status '${cart.status}'.` };
    }

    if (new Date() > new Date(cart.expires_at)) {
      await client.query(`UPDATE carts SET status = 'EXPIRED' WHERE id = $1;`, [cartId]);
      await client.query('COMMIT');
      return { ok: false, code: 'CART_EXPIRED', message: `Cart ${cartId} has expired.` };
    }

    // 2. Fetch variant price; the variant must belong to the cart's merchant
    const vRes = await client.query(`
      SELECT pv.id, pv.sku, pv.title, pv.price_minor, p.merchant_id, ns.last_offered_price_minor
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
      LEFT JOIN negotiation_sessions ns ON ns.variant_id = pv.id 
        AND ns.buyer_agent_id = $1 AND ns.status = 'OPEN' AND ns.expires_at > NOW()
      WHERE pv.id = $2;
    `, [cart.buyer_agent_id, variantId]);

    if (vRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'VARIANT_NOT_FOUND', message: `Variant ${variantId} does not exist.` };
    }

    const variant = vRes.rows[0];
    if (variant.merchant_id !== cart.merchant_id) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'MERCHANT_MISMATCH', message: `Variant ${variantId} is not sold by this cart's merchant.` };
    }
    const unitPriceMinor = variant.last_offered_price_minor
      ? Number(variant.last_offered_price_minor)
      : Number(variant.price_minor);

    // 2b. Intent authorization: a task-bound cart only accepts products the human asked for
    if (cart.purchase_task_id) {
      const task = await getPurchaseTask(cart.purchase_task_id, client);
      const product = await loadAuthorizableProduct(variantId, client);
      const lines = await client.query(`SELECT variant_id, quantity, unit_price_minor FROM cart_items WHERE cart_id = $1;`, [cartId]);
      let quantityForVariant = quantity;
      let cartQuantityAfter = quantity;
      let cartGrossAfterMinor = quantity * unitPriceMinor;
      for (const l of lines.rows) {
        const lq = Number(l.quantity);
        cartQuantityAfter += lq;
        if (l.variant_id === variantId) {
          quantityForVariant += lq;
          cartGrossAfterMinor += lq * unitPriceMinor; // existing units are repriced at the current unit price
        } else {
          cartGrossAfterMinor += lq * Number(l.unit_price_minor);
        }
      }
      const verdict = task && product
        ? authorizeLineForTask(task, cart.buyer_agent_id, product, { quantityForVariant, cartQuantityAfter, cartGrossAfterMinor })
        : { allowed: false, code: 'TASK_NOT_ACTIVE', reason: 'Purchase task or product could not be loaded.' };
      if (!verdict.allowed) {
        await client.query('ROLLBACK');
        await logAuditEvent({
          correlationId,
          actor: `buyer_agent:${cart.buyer_agent_id}`,
          action: 'cart.add_item_denied',
          merchantId: cart.merchant_id,
          decision: 'DENIED',
          humanReadable: `Refused to add ${variant.sku} to cart ${cartId}: ${verdict.reason}`,
          policyRuleId: 'RULE_INTENT_BOUND_AUTHORIZATION',
          metadata: { cartId, variantId, sku: variant.sku, quantity, taskId: cart.purchase_task_id, code: verdict.code }
        });
        const titleRes = await pool.query('SELECT p.title FROM product_variants pv JOIN products p ON p.id = pv.product_id WHERE pv.id = $1', [variantId]);
        return {
          ok: false, code: verdict.code, message: verdict.reason,
          product: { variantId, title: titleRes.rows[0]?.title as string | undefined, priceMinor: unitPriceMinor }
        };
      }
    }

    // 3. Atomically Reserve Inventory inside the same transaction
    const reservation = await reserveStock(variantId, cartId, quantity, correlationId, client);
    if (!reservation.success) {
      await client.query('ROLLBACK');
      return {
        ok: false,
        code: reservation.errorCode,
        message: reservation.errorMessage
      };
    }

    // 4. Insert or update cart item
    await client.query(`
      INSERT INTO cart_items (cart_id, variant_id, quantity, unit_price_minor)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (cart_id, variant_id) DO UPDATE SET
        quantity = cart_items.quantity + EXCLUDED.quantity,
        unit_price_minor = EXCLUDED.unit_price_minor;
    `, [cartId, variantId, quantity, unitPriceMinor]);

    // Extend cart TTL by 10m on mutation
    const newExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await client.query(`UPDATE carts SET expires_at = $1, updated_at = NOW() WHERE id = $2;`, [newExpiresAt, cartId]);

    await client.query('COMMIT');

    const updatedCart = await getCart(cartId);

    await logAuditEvent({
      correlationId,
      actor: `buyer_agent:${cart.buyer_agent_id}`,
      action: 'cart.add_item',
      merchantId: cart.merchant_id,
      decision: 'AUTO_EXECUTABLE',
      humanReadable: `Added ${quantity} units of ${variant.title} (SKU: ${variant.sku}) to Cart ${cartId}. Cart total now ₹${((updatedCart?.grossAmountMinor || 0) / 100).toFixed(2)}.`,
      metadata: { cartId, variantId, sku: variant.sku, quantity, unitPriceMinor }
    });

    return { ok: true, cart: updatedCart || undefined };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error adding to cart:', err);
    return { ok: false, code: 'CART_MUTATION_FAILED', message: 'Database error while modifying cart.' };
  } finally {
    client.release();
  }
}

export async function removeFromCart(
  cartId: string,
  variantId: string,
  correlationId: string
): Promise<{ ok: boolean; cart?: CartSummary; code?: string; message?: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const itemRes = await client.query(`
      SELECT quantity FROM cart_items WHERE cart_id = $1 AND variant_id = $2 FOR UPDATE;
    `, [cartId, variantId]);

    if (itemRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'ITEM_NOT_IN_CART', message: 'Item not present in cart' };
    }

    const qty = Number(itemRes.rows[0].quantity);

    // Release reservation
    await releaseReservation(variantId, cartId, qty, correlationId, client);

    // Delete cart item
    await client.query('DELETE FROM cart_items WHERE cart_id = $1 AND variant_id = $2;', [cartId, variantId]);

    await client.query('COMMIT');

    const updatedCart = await getCart(cartId);
    return { ok: true, cart: updatedCart || undefined };
  } catch (err) {
    await client.query('ROLLBACK');
    return { ok: false, code: 'REMOVE_FAILED', message: 'Failed to remove item from cart' };
  } finally {
    client.release();
  }
}

/**
 * Reads a cart. Pass the transaction client (and lock: true) when the caller decides on the
 * result inside a transaction, e.g. checkout, so the lines cannot change underneath it.
 */
export async function getCart(cartId: string, options: { client?: pg.PoolClient; lock?: boolean } = {}): Promise<CartSummary | null> {
  if (!/^[0-9a-f-]{36}$/i.test(cartId)) return null;
  const runner = options.client || pool;
  if (!options.client) await cleanupExpiredReservations();

  const cRes = await runner.query(`
    SELECT c.*, m.currency
    FROM carts c
    JOIN merchants m ON m.id = c.merchant_id
    WHERE c.id = $1
    ${options.lock ? 'FOR UPDATE OF c' : ''};
  `, [cartId]);

  if (cRes.rows.length === 0) return null;
  const cart = cRes.rows[0];

  const itemsRes = await runner.query(`
    SELECT 
      ci.id, ci.variant_id, ci.quantity, ci.unit_price_minor,
      pv.sku, pv.title, p.title AS product_title
    FROM cart_items ci
    JOIN product_variants pv ON pv.id = ci.variant_id
    JOIN products p ON p.id = pv.product_id
    WHERE ci.cart_id = $1;
  `, [cartId]);

  let grossAmountMinor = 0;
  const items: CartItem[] = itemsRes.rows.map(row => {
    const itemTotal = Number(row.quantity) * Number(row.unit_price_minor);
    grossAmountMinor += itemTotal;
    return {
      id: row.id,
      variantId: row.variant_id,
      sku: row.sku,
      title: row.title,
      productTitle: row.product_title,
      quantity: Number(row.quantity),
      unitPriceMinor: Number(row.unit_price_minor),
      totalPriceMinor: itemTotal
    };
  });

  const cartHash = computeCanonicalCartHash(cart.merchant_id, cart.id, items);

  return {
    cartId: cart.id,
    buyerAgentId: cart.buyer_agent_id,
    merchantId: cart.merchant_id,
    status: cart.status,
    purchaseTaskId: cart.purchase_task_id ?? null,
    items,
    itemCount: items.reduce((acc, item) => acc + item.quantity, 0),
    grossAmountMinor,
    cartHash,
    currency: cart.currency || 'INR',
    expiresAt: cart.expires_at
  };
}
