import pg from 'pg';
import crypto from 'crypto';
import { pool } from '../db/pool.js';
import { logAuditEvent } from '../audit/ledger.js';
import { validateReservationTransition, type ReservationStatus } from '../policy/state-machines.js';

export interface BuyerIdentityCluster {
  agentId?: string;
  humanPrincipalId?: string;
  deviceFingerprint?: string;
  ipAddress?: string;
  shippingAddress?: {
    line1?: string;
    city?: string;
    postal_code?: string;
    country?: string;
    phone?: string;
  };
  shippingAddressHash?: string;
  accountHash?: string;
}

export function normalizeAddressHash(addr?: { line1?: string; city?: string; postal_code?: string; country?: string; phone?: string }): string | null {
  if (!addr || (!addr.line1 && !addr.postal_code)) return null;
  const str = `${(addr.line1 || '').toLowerCase().replace(/[^a-z0-9]/g, '')}:${(addr.postal_code || '').toLowerCase().trim()}:${(addr.city || '').toLowerCase().trim()}`;
  return crypto.createHash('sha256').update(str).digest('hex');
}

export function extractSubnet(ip?: string): string | null {
  if (!ip) return null;
  const match = ip.match(/^(\d+\.\d+\.\d+)\.\d+$/);
  return match ? match[1] : ip;
}

export interface ReservationResult {
  success: boolean;
  reservationId?: string;
  variantId: string;
  quantityReserved: number;
  availableRemaining: number;
  expiresAt?: Date;
  errorCode?: 'INSUFFICIENT_STOCK' | 'VARIANT_NOT_FOUND' | 'RESERVATION_FAILED' | 'RESERVATION_HOARDING_BLOCKED' | 'SYBIL_RESERVATION_HOARDING_BLOCKED';
  errorMessage?: string;
  lockDurationMs?: number;
}

export interface MultiReservationItem {
  variantId: string;
  quantity: number;
}

export interface MultiReservationResult {
  success: boolean;
  reservations: ReservationResult[];
  errorCode?: string;
  errorMessage?: string;
  lockDurationMs?: number;
}

export const RESERVATION_TTL_MS = 10 * 60 * 1000; // 10 minutes business hold
export const SCARCE_ITEM_TTL_MS = 60 * 1000; // 60 seconds hold for scarce inventory
export const MAX_ACTIVE_RESERVATIONS_PER_AGENT = 10;

/**
 * Lazy cleanup of expired reservations.
 * Releases held stock back to product_variants.
 */
export async function cleanupExpiredReservations(txClient?: pg.PoolClient) {
  const runner = txClient || pool;
  const expiredRes = await runner.query(`
    SELECT id, variant_id, cart_id, quantity 
    FROM inventory_reservations 
    WHERE status = 'ACTIVE' AND expires_at <= NOW()
    FOR UPDATE SKIP LOCKED;
  `);

  for (const row of expiredRes.rows) {
    await runner.query(`
      UPDATE product_variants 
      SET reserved_qty = GREATEST(0, reserved_qty - $1), updated_at = NOW() 
      WHERE id = $2;
    `, [row.quantity, row.variant_id]);

    await runner.query(`
      UPDATE inventory_reservations 
      SET status = 'EXPIRED' 
      WHERE id = $1;
    `, [row.id]);

    await runner.query(`
      INSERT INTO inventory_events (variant_id, delta, resulting_stock, resulting_reserved, reason, correlation_id)
      SELECT id, $1, stock_qty, reserved_qty, 'RELEASED_EXPIRY', $2
      FROM product_variants WHERE id = $3;
    `, [row.quantity, `lazy_cleanup_${row.cart_id}`, row.variant_id]);
  }
}

/**
 * Atomically reserves stock for a single variant with multi-entity Sybil anti-hoarding protection.
 * 
 * ARCHITECTURE INVARIANT:
 * - PostgreSQL row lock (`SELECT ... FOR UPDATE`) lasts ONLY MILLISECONDS during the transaction.
 * - The reservation record in `inventory_reservations` has a 10-MINUTE TTL.
 * - Lock is released immediately upon COMMIT.
 * - Hot/scarce items enforce 1 active reservation per linked buyer identity cluster across all Sybil agents.
 */
export async function reserveStock(
  variantId: string,
  cartId: string,
  quantity: number,
  correlationId: string,
  txClient?: pg.PoolClient,
  identityInput?: string | BuyerIdentityCluster
): Promise<ReservationResult> {
  const client = txClient || (await pool.connect());
  const isInternalTx = !txClient;
  const startTime = Date.now();

  const cluster: BuyerIdentityCluster = typeof identityInput === 'string'
    ? { agentId: identityInput }
    : (identityInput || {});

  try {
    if (isInternalTx) await client.query('BEGIN');

    // 1. Cleanup expired reservations
    await cleanupExpiredReservations(client);

    // 2. Fetch cart identity metadata if not fully provided
    const cartRes = await client.query(`
      SELECT c.buyer_agent_id, ad.principal_name as delegation_principal
      FROM carts c
      LEFT JOIN agent_delegations ad ON ad.buyer_agent_id = c.buyer_agent_id AND ad.status = 'ACTIVE'
      WHERE c.id::text = $1;
    `, [cartId]);

    const cartAgentId = cartRes.rows.length > 0 ? cartRes.rows[0].buyer_agent_id : undefined;
    const delegationPrincipal = cartRes.rows.length > 0 ? cartRes.rows[0].delegation_principal : undefined;

    const resolvedAgentId = cluster.agentId || cartAgentId;
    const resolvedHumanPrincipal = cluster.humanPrincipalId || delegationPrincipal;
    const resolvedDevice = cluster.deviceFingerprint;
    const resolvedIp = cluster.ipAddress;
    const resolvedAddressHash = cluster.shippingAddressHash || normalizeAddressHash(cluster.shippingAddress);
    const resolvedAccountHash = cluster.accountHash;

    // 3. Short-Lived Pessimistic Row Lock (Microseconds / Milliseconds duration)
    const variantRes = await client.query(`
      SELECT id, sku, stock_qty, reserved_qty
      FROM product_variants
      WHERE id = $1
      FOR UPDATE;
    `, [variantId]);

    if (variantRes.rows.length === 0) {
      if (isInternalTx) await client.query('ROLLBACK');
      return {
        success: false,
        variantId,
        quantityReserved: 0,
        availableRemaining: 0,
        errorCode: 'VARIANT_NOT_FOUND',
        errorMessage: `Variant ${variantId} does not exist.`
      };
    }

    const { sku, stock_qty, reserved_qty } = variantRes.rows[0];
    const availableStock = stock_qty - reserved_qty;

    if (availableStock < quantity) {
      if (isInternalTx) await client.query('ROLLBACK');

      await logAuditEvent({
        correlationId,
        actor: 'system:inventory_engine',
        action: 'inventory.reserve',
        decision: 'DENIED',
        humanReadable: `Reservation rejected for SKU ${sku}: requested ${quantity}, available ${availableStock}.`,
        policyRuleId: 'RULE_INVENTORY_OVERSALE_DEFENSE',
        metadata: { variantId, sku, requested: quantity, available: availableStock }
      });

      return {
        success: false,
        variantId,
        quantityReserved: 0,
        availableRemaining: availableStock,
        errorCode: 'INSUFFICIENT_STOCK',
        errorMessage: `Insufficient available stock for SKU ${sku}. Requested: ${quantity}, Available: ${availableStock}.`
      };
    }

    // 4. Sybil Multi-Entity Anti-Hoarding Defense on Hot/Scarce Items
    const isHotItem = availableStock <= 5;

    if (isHotItem) {
      const activeRes = await client.query(`
        SELECT ir.id, ir.cart_id, ir.buyer_agent_id, ir.human_principal_id, ir.device_fingerprint,
               ir.ip_address, ir.shipping_address_hash, ir.account_hash,
               c.buyer_agent_id as cart_agent_id,
               ad.principal_name as delegation_principal
        FROM inventory_reservations ir
        LEFT JOIN carts c ON c.id::text = ir.cart_id
        LEFT JOIN agent_delegations ad ON ad.buyer_agent_id = c.buyer_agent_id AND ad.status = 'ACTIVE'
        WHERE ir.variant_id = $1 AND ir.status = 'ACTIVE' AND ir.expires_at > NOW() AND ir.cart_id != $2;
      `, [variantId, cartId]);

      for (const existing of activeRes.rows) {
        const humanMatch = resolvedHumanPrincipal && (
          existing.human_principal_id === resolvedHumanPrincipal ||
          existing.delegation_principal === resolvedHumanPrincipal
        );
        const agentMatch = resolvedAgentId && (
          existing.buyer_agent_id === resolvedAgentId ||
          existing.cart_agent_id === resolvedAgentId
        );
        const deviceMatch = resolvedDevice && existing.device_fingerprint && (
          existing.device_fingerprint === resolvedDevice
        );
        const ipMatch = resolvedIp && existing.ip_address && (
          existing.ip_address === resolvedIp ||
          extractSubnet(existing.ip_address) === extractSubnet(resolvedIp)
        );
        const addressMatch = resolvedAddressHash && existing.shipping_address_hash && (
          existing.shipping_address_hash === resolvedAddressHash
        );
        const accountMatch = resolvedAccountHash && existing.account_hash && (
          existing.account_hash === resolvedAccountHash
        );

        const isDefiniteLink = !!(humanMatch || agentMatch || accountMatch);
        const isProbabilisticCluster = !!((deviceMatch && ipMatch) || addressMatch || (deviceMatch && addressMatch));

        if (isDefiniteLink || isProbabilisticCluster) {
          if (isInternalTx) await client.query('ROLLBACK');

          const linkConfidence = isDefiniteLink ? 'DEFINITE_LINK' : 'PROBABILISTIC_LINK';
          const identityDimension = humanMatch ? `Human Delegation Owner '${resolvedHumanPrincipal}'`
            : accountMatch ? `Payment Account Identity`
            : agentMatch ? `Buyer Agent '${resolvedAgentId}'`
            : addressMatch ? `Shipping Address Destination`
            : `Device & Network Cluster (${resolvedDevice} @ ${resolvedIp})`;

          await logAuditEvent({
            correlationId,
            actor: 'system:inventory_engine',
            action: 'inventory.sybil_hoarding_blocked',
            decision: 'DENIED',
            humanReadable: `Sybil reservation hoarding blocked on hot SKU ${sku}. Active reservation held by linked identity (${identityDimension}, Confidence: ${linkConfidence}).`,
            policyRuleId: 'RULE_SYBIL_ANTI_HOARDING_DEFENSE',
            metadata: { variantId, sku, cartId, resolvedAgentId, resolvedHumanPrincipal, identityDimension, linkConfidence }
          });

          return {
            success: false,
            variantId,
            quantityReserved: 0,
            availableRemaining: availableStock,
            errorCode: 'SYBIL_RESERVATION_HOARDING_BLOCKED',
            errorMessage: `Sybil Reservation Hoarding Blocked: Hot/scarce SKU ${sku} is already reserved by a linked buyer identity (${identityDimension}, Confidence: ${linkConfidence}). Limit is strictly 1 active reservation per linked buyer identity cluster per SKU.`
          };
        }
      }
    }

    // 5. Global Multi-Agent Cluster Hoarding Limit (Max active reservations across all SKUs)
    if (resolvedHumanPrincipal || resolvedAgentId) {
      const clusterResCount = await client.query(`
        SELECT COUNT(*) as count 
        FROM inventory_reservations ir
        LEFT JOIN carts c ON c.id::text = ir.cart_id
        LEFT JOIN agent_delegations ad ON ad.buyer_agent_id = c.buyer_agent_id AND ad.status = 'ACTIVE'
        WHERE ir.status = 'ACTIVE' AND ir.expires_at > NOW()
          AND (
            (ir.human_principal_id = $1 OR ad.principal_name = $1)
            OR (ir.buyer_agent_id::text = $2 OR c.buyer_agent_id::text = $2)
          );
      `, [resolvedHumanPrincipal || null, resolvedAgentId || null]);

      if (Number(clusterResCount.rows[0].count) >= MAX_ACTIVE_RESERVATIONS_PER_AGENT) {
        if (isInternalTx) await client.query('ROLLBACK');
        return {
          success: false,
          variantId,
          quantityReserved: 0,
          availableRemaining: availableStock,
          errorCode: 'RESERVATION_HOARDING_BLOCKED',
          errorMessage: `Buyer identity cluster (${resolvedHumanPrincipal || resolvedAgentId}) exceeded maximum active reservation limit (${MAX_ACTIVE_RESERVATIONS_PER_AGENT}).`
        };
      }
    }

    // 6. Atomically increment reserved_qty
    const updatedReserved = reserved_qty + quantity;
    await client.query(`
      UPDATE product_variants
      SET reserved_qty = $1, updated_at = NOW()
      WHERE id = $2;
    `, [updatedReserved, variantId]);

    // 7. Insert active reservation record with linked identity cluster (10m TTL or 60s for scarce items)
    const isScarce = (stock_qty - updatedReserved) <= 1;
    const ttlMs = isScarce ? SCARCE_ITEM_TTL_MS : RESERVATION_TTL_MS;
    const expiresAt = new Date(Date.now() + ttlMs);

    const isUuid = (id?: string) => !!id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    const validAgentUuid = isUuid(resolvedAgentId) ? resolvedAgentId : null;

    const reservationRes = await client.query(`
      INSERT INTO inventory_reservations (
        variant_id, cart_id, buyer_agent_id, human_principal_id, device_fingerprint,
        ip_address, shipping_address_hash, account_hash, quantity, status, expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ACTIVE', $10)
      RETURNING id;
    `, [
      variantId, cartId, validAgentUuid, resolvedHumanPrincipal || null,
      resolvedDevice || null, resolvedIp || null, resolvedAddressHash || null,
      resolvedAccountHash || null, quantity, expiresAt
    ]);

    const reservationId = reservationRes.rows[0].id;

    // 8. Emit Inventory Audit Event
    await client.query(`
      INSERT INTO inventory_events (variant_id, reservation_id, delta, resulting_stock, resulting_reserved, reason, correlation_id)
      VALUES ($1, $2, $3, $4, $5, 'RESERVED', $6);
    `, [variantId, reservationId, quantity, stock_qty, updatedReserved, correlationId]);

    // 9. Log to Hash-Chained Audit Ledger
    await logAuditEvent({
      correlationId,
      actor: 'system:inventory_engine',
      action: 'inventory.reserve',
      decision: 'AUTO_EXECUTABLE',
      humanReadable: `Atomically reserved ${quantity} units of SKU ${sku} for Cart ${cartId}. DB lock released; reservation TTL: ${isScarce ? '60s' : '10m'}.`,
      policyRuleId: 'RULE_INVENTORY_RESERVATION_ACQUIRED',
      metadata: { variantId, sku, cartId, quantity, reservationId, expiresAt: expiresAt.toISOString(), resolvedHumanPrincipal }
    }, client);

    if (isInternalTx) await client.query('COMMIT');
    const lockDurationMs = Date.now() - startTime;

    return {
      success: true,
      reservationId,
      variantId,
      quantityReserved: quantity,
      availableRemaining: stock_qty - updatedReserved,
      expiresAt,
      lockDurationMs
    };
  } catch (err) {
    if (isInternalTx) await client.query('ROLLBACK');
    console.error('Inventory reservation error:', err);
    return {
      success: false,
      variantId,
      quantityReserved: 0,
      availableRemaining: 0,
      errorCode: 'RESERVATION_FAILED',
      errorMessage: (err as any)?.message || 'Reservation failed due to internal error'
    };
  } finally {
    if (isInternalTx) client.release();
  }
}

/**
 * Atomically reserves multiple items with CANONICAL SKU/VARIANT ID SORTING to prevent deadlocks.
 * 
 * INVARIANT: Locks are always acquired in deterministic sorted order: A -> B -> C.
 */
export async function reserveMultiStock(
  items: MultiReservationItem[],
  cartId: string,
  correlationId: string,
  txClient?: pg.PoolClient,
  agentId?: string
): Promise<MultiReservationResult> {
  // Sort canonically by variantId to eliminate lock ordering deadlocks
  const sortedItems = [...items].sort((a, b) => a.variantId.localeCompare(b.variantId));
  const client = txClient || (await pool.connect());
  const isInternalTx = !txClient;
  const startTime = Date.now();
  const reservations: ReservationResult[] = [];

  try {
    if (isInternalTx) await client.query('BEGIN');

    for (const item of sortedItems) {
      const res = await reserveStock(
        item.variantId,
        cartId,
        item.quantity,
        correlationId,
        client,
        agentId
      );

      if (!res.success) {
        if (isInternalTx) await client.query('ROLLBACK');
        return {
          success: false,
          reservations,
          errorCode: res.errorCode,
          errorMessage: res.errorMessage,
          lockDurationMs: Date.now() - startTime
        };
      }
      reservations.push(res);
    }

    if (isInternalTx) await client.query('COMMIT');
    return {
      success: true,
      reservations,
      lockDurationMs: Date.now() - startTime
    };
  } catch (err: any) {
    if (isInternalTx) await client.query('ROLLBACK');
    return {
      success: false,
      reservations: [],
      errorCode: 'MULTI_RESERVATION_FAILED',
      errorMessage: err.message || 'Multi-item reservation failed'
    };
  } finally {
    if (isInternalTx) client.release();
  }
}

/**
 * Releases reserved stock back to the catalog on cart item removal or cancellation.
 * Idempotent: Subsequent calls on already RELEASED reservations succeed without double-decrementing.
 * State machine: Strictly prevents releasing COMMITTED/CONSUMED inventory.
 */
export async function releaseReservation(
  variantId: string,
  cartId: string,
  quantity: number,
  correlationId: string,
  txClient?: pg.PoolClient
): Promise<boolean> {
  const runner = txClient || pool;

  const res = await runner.query(`
    SELECT id, quantity, status 
    FROM inventory_reservations 
    WHERE variant_id = $1 AND cart_id = $2
    ORDER BY created_at DESC
    LIMIT 1
    FOR UPDATE;
  `, [variantId, cartId]);

  if (res.rows.length === 0) return false;

  const currentStatus = res.rows[0].status as ReservationStatus;

  // Idempotency: If already RELEASED, return true without double-decrementing
  if (currentStatus === 'RELEASED') {
    return true;
  }

  // State Machine Guard: Cannot release COMMITTED / CONSUMED inventory
  if (currentStatus === 'COMMITTED') {
    throw new Error(`ILLEGAL_RESERVATION_STATE_TRANSITION: Cannot release already COMMITTED reservation ${res.rows[0].id}.`);
  }

  if (currentStatus !== 'ACTIVE') {
    return false;
  }

  // Validate state machine transition ACTIVE -> RELEASED
  validateReservationTransition(currentStatus, 'RELEASED');

  await runner.query(`
    UPDATE product_variants
    SET reserved_qty = GREATEST(0, reserved_qty - $1), updated_at = NOW()
    WHERE id = $2;
  `, [quantity, variantId]);

  await runner.query(`
    UPDATE inventory_reservations
    SET status = 'RELEASED', updated_at = NOW()
    WHERE id = $1;
  `, [res.rows[0].id]);

  await runner.query(`
    INSERT INTO inventory_events (variant_id, reservation_id, delta, resulting_stock, resulting_reserved, reason, correlation_id)
    SELECT id, $1, $2, stock_qty, reserved_qty, 'RELEASED_CANCEL', $3
    FROM product_variants WHERE id = $4;
  `, [res.rows[0].id, -quantity, correlationId, variantId]);

  await logAuditEvent({
    correlationId,
    actor: 'system:inventory_engine',
    action: 'inventory.release',
    decision: 'AUTO_EXECUTABLE',
    humanReadable: `Released ${quantity} units of reserved stock for Cart ${cartId}.`,
    metadata: { variantId, cartId, quantity, reservationId: res.rows[0].id }
  }, txClient);

  return true;
}

/**
 * Commits active reservations upon successful order payment.
 * Idempotent: Subsequent calls on already COMMITTED reservations succeed without double-decrementing stock.
 * State machine: Strictly prevents committing RELEASED or EXPIRED reservations.
 */
export async function commitReservationForCart(cartId: string, correlationId: string, txClient?: pg.PoolClient): Promise<boolean> {
  const runner = txClient || pool;

  const reservations = await runner.query(`
    SELECT id, variant_id, quantity, status
    FROM inventory_reservations
    WHERE cart_id = $1
    FOR UPDATE;
  `, [cartId]);

  if (reservations.rows.length === 0) return true;

  const activeReservations = reservations.rows.filter(r => r.status === 'ACTIVE');

  // Idempotent: If all reservations for this cart are already COMMITTED or no active reservations, return true
  if (activeReservations.length === 0) {
    return true;
  }

  // State Machine Guard: Cannot commit RELEASED or EXPIRED reservations
  const invalidReservations = reservations.rows.filter(r => r.status === 'RELEASED' || r.status === 'EXPIRED');
  if (invalidReservations.length > 0 && activeReservations.length === 0) {
    throw new Error(`ILLEGAL_RESERVATION_STATE_TRANSITION: Cannot commit reservation in terminal status ${invalidReservations[0].status}.`);
  }

  for (const row of activeReservations) {
    validateReservationTransition(row.status as ReservationStatus, 'COMMITTED');

    const vRes = await runner.query(`
      SELECT stock_qty, reserved_qty FROM product_variants WHERE id = $1 FOR UPDATE;
    `, [row.variant_id]);

    if (vRes.rows.length === 0) {
      throw new Error(`Variant ${row.variant_id} not found during commit`);
    }

    const { stock_qty, reserved_qty } = vRes.rows[0];
    if (stock_qty < row.quantity || reserved_qty < row.quantity) {
      throw new Error(`Inventory integrity violation: cannot commit ${row.quantity} units from stock=${stock_qty}, reserved=${reserved_qty}`);
    }

    await runner.query(`
      UPDATE product_variants
      SET stock_qty = stock_qty - $1,
          reserved_qty = reserved_qty - $1,
          updated_at = NOW()
      WHERE id = $2;
    `, [row.quantity, row.variant_id]);

    await runner.query(`
      UPDATE inventory_reservations
      SET status = 'COMMITTED', updated_at = NOW()
      WHERE id = $1;
    `, [row.id]);

    await runner.query(`
      INSERT INTO inventory_events (variant_id, reservation_id, delta, resulting_stock, resulting_reserved, reason, correlation_id)
      SELECT id, $1, $2, stock_qty, reserved_qty, 'COMMITTED_PAID', $3
      FROM product_variants WHERE id = $4;
    `, [row.id, -row.quantity, correlationId, row.variant_id]);
  }

  return true;
}
