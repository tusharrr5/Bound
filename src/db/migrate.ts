import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');

  console.log('⚡ Running PostgreSQL database migrations for Bound...');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // On a fresh database there is nothing to pre-alter; schema.sql creates everything.
    const existing = await client.query(`SELECT to_regclass('public.audit_events') AS t;`);
    const isExistingDb = existing.rows[0].t !== null;

    if (isExistingDb) {
    // Pre-alter existing tables so subsequent index creation succeeds
    await client.query(`
      ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS merchant_id UUID REFERENCES merchants(id);
      ALTER TABLE audit_checkpoints ADD COLUMN IF NOT EXISTS key_version TEXT NOT NULL DEFAULT 'v1';
      ALTER TABLE purchase_mandates ADD COLUMN IF NOT EXISTS delegation_id UUID;
      ALTER TABLE purchase_mandates ADD COLUMN IF NOT EXISTS key_id TEXT;
      ALTER TABLE purchase_mandates ADD COLUMN IF NOT EXISTS cart_hash TEXT;
      ALTER TABLE purchase_mandates ADD COLUMN IF NOT EXISTS quote_hash TEXT;
      ALTER TABLE purchase_mandates ADD COLUMN IF NOT EXISTS reserved_amount_minor BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE idempotency_records ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 seconds');
      ALTER TABLE idempotency_records ADD COLUMN IF NOT EXISTS owner_instance TEXT NOT NULL DEFAULT 'node_primary';
      ALTER TABLE payments ALTER COLUMN order_id DROP NOT NULL;
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS reconciliation_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS last_reconciliation_attempt_at TIMESTAMPTZ;
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS next_reconciliation_attempt_at TIMESTAMPTZ;
      ALTER TABLE payments ADD COLUMN IF NOT EXISTS reconciliation_error TEXT;
      ALTER TABLE checkouts ADD COLUMN IF NOT EXISTS checkout_snapshot JSONB NOT NULL DEFAULT '{}';
      ALTER TABLE checkouts ADD COLUMN IF NOT EXISTS quote_snapshot JSONB NOT NULL DEFAULT '{}';
      ALTER TABLE checkouts ADD COLUMN IF NOT EXISTS reconciliation_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE checkouts ADD COLUMN IF NOT EXISTS last_reconciliation_attempt_at TIMESTAMPTZ;
      ALTER TABLE checkouts ADD COLUMN IF NOT EXISTS next_reconciliation_attempt_at TIMESTAMPTZ;
      ALTER TABLE checkouts ADD COLUMN IF NOT EXISTS reconciliation_error TEXT;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'PRODUCTION';
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS funds_moved BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfilment_allowed BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'RAZORPAY';
      ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS webhook_source TEXT NOT NULL DEFAULT 'RAZORPAY_NETWORK';
      ALTER TABLE inventory_events ADD COLUMN IF NOT EXISTS reservation_id UUID;
      ALTER TABLE inventory_reservations ALTER COLUMN cart_id TYPE TEXT;
      ALTER TABLE inventory_reservations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
      ALTER TABLE inventory_reservations ADD COLUMN IF NOT EXISTS buyer_agent_id UUID REFERENCES buyer_agents(id);
      ALTER TABLE inventory_reservations ADD COLUMN IF NOT EXISTS human_principal_id TEXT;
      ALTER TABLE inventory_reservations ADD COLUMN IF NOT EXISTS device_fingerprint TEXT;
      ALTER TABLE inventory_reservations ADD COLUMN IF NOT EXISTS ip_address TEXT;
      ALTER TABLE inventory_reservations ADD COLUMN IF NOT EXISTS shipping_address_hash TEXT;
      ALTER TABLE inventory_reservations ADD COLUMN IF NOT EXISTS account_hash TEXT;
      ALTER TABLE audit_checkpoints ADD COLUMN IF NOT EXISTS kms_key_arn TEXT NOT NULL DEFAULT 'local:ed25519:audit-checkpoint-dev-key';
      ALTER TABLE audit_checkpoints ADD COLUMN IF NOT EXISTS external_storage_uri TEXT NOT NULL DEFAULT 'memory://simulated-worm/checkpoints/';
      ALTER TABLE audit_checkpoints ADD COLUMN IF NOT EXISTS worm_retention_policy TEXT NOT NULL DEFAULT 'COMPLIANCE_MODE_7_YEARS';
      ALTER TABLE audit_checkpoints ADD COLUMN IF NOT EXISTS object_lock_legal_hold BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE audit_checkpoints ADD COLUMN IF NOT EXISTS external_object_sha256 TEXT;
    `);

    // Ensure unique constraint on webhook_events (provider, provider_event_id)
    await client.query(`
      DO $$
      BEGIN
          IF NOT EXISTS (
              SELECT 1 FROM pg_constraint WHERE conname = 'webhook_events_provider_provider_event_id_key'
          ) THEN
              BEGIN
                  ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_provider_provider_event_id_key UNIQUE (provider, provider_event_id);
              EXCEPTION WHEN duplicate_table THEN
                  -- ignore
              END;
          END IF;
      END $$;
    `);
    }

    await client.query(sql);

    // Catalog columns and search table used by seed.ts and catalog/service.ts but missing
    // from schema.sql, which made fresh-clone setup fail.
    await client.query(`
      ALTER TABLE products ADD COLUMN IF NOT EXISTS brand TEXT;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS agent_summary TEXT;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS specifications JSONB NOT NULL DEFAULT '{}';
      ALTER TABLE products ADD COLUMN IF NOT EXISTS safety_facts JSONB NOT NULL DEFAULT '{}';
      ALTER TABLE products ADD COLUMN IF NOT EXISTS returnable BOOLEAN;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS return_window_days INTEGER;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS warranty_months INTEGER;
      ALTER TABLE products ALTER COLUMN base_price_minor SET DEFAULT 0;
      ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS compare_at_price_minor BIGINT;
      ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR';

      CREATE TABLE IF NOT EXISTS product_search (
          product_id UUID PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
          search_vector TSVECTOR NOT NULL,
          embedding_version TEXT NOT NULL DEFAULT 'v1',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_product_search_vector ON product_search USING GIN (search_vector);

      -- Columns the code never sets on insert
      ALTER TABLE inventory_reservations ALTER COLUMN correlation_id DROP NOT NULL;
      ALTER TABLE payments ALTER COLUMN checkout_id DROP NOT NULL;
      ALTER TABLE refunds ALTER COLUMN order_id DROP NOT NULL;

      -- inventory_events: the code writes (delta, reason); schema.sql defined (quantity_change, event_type)
      ALTER TABLE inventory_events ADD COLUMN IF NOT EXISTS delta INTEGER;
      ALTER TABLE inventory_events ADD COLUMN IF NOT EXISTS reason TEXT;
      ALTER TABLE inventory_events ALTER COLUMN event_type DROP NOT NULL;
      ALTER TABLE inventory_events ALTER COLUMN quantity_change DROP NOT NULL;
      -- Merchant-verified product metadata used for intent authorization (never seller-written)
      ALTER TABLE products ADD COLUMN IF NOT EXISTS product_type TEXT;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS verified_attributes JSONB NOT NULL DEFAULT '{}';
      CREATE INDEX IF NOT EXISTS idx_products_merchant_type ON products (merchant_id, product_type);

      -- Carts and mandates bound to the purchase task they serve
      ALTER TABLE carts ADD COLUMN IF NOT EXISTS purchase_task_id UUID REFERENCES purchase_tasks(id);
      CREATE INDEX IF NOT EXISTS idx_carts_task ON carts (purchase_task_id);
      ALTER TABLE purchase_mandates ADD COLUMN IF NOT EXISTS purchase_task_id UUID REFERENCES purchase_tasks(id);
      -- Mandate signature scheme version (2 = full canonical payload) and the signed task intent hash
      ALTER TABLE purchase_mandates ADD COLUMN IF NOT EXISTS signature_version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE purchase_mandates ADD COLUMN IF NOT EXISTS intent_hash TEXT;

      -- Arena outcomes now separate "the model resisted" from "the backend blocked it" (old values kept for history)
      ALTER TABLE arena_runs DROP CONSTRAINT IF EXISTS arena_runs_outcome_check;
      ALTER TABLE arena_runs ADD CONSTRAINT arena_runs_outcome_check CHECK (outcome IN (
        'RESISTED', 'BLOCKED_AT_CART', 'BLOCKED_AT_CHECKOUT', 'REACHED_PAYMENT_LAYER', 'BREACH',
        'BLOCKED', 'FOOLED_NO_CHECKOUT', 'PURCHASED', 'NO_PURCHASE'
      ));

      -- Audit chains are per merchant: sequence numbers are unique within a merchant, not globally
      -- (a global UNIQUE made the first event of any second merchant fail to insert)
      ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_sequence_number_key;
      CREATE UNIQUE INDEX IF NOT EXISTS ux_audit_events_merchant_seq ON audit_events (merchant_id, sequence_number) NULLS NOT DISTINCT;
      ALTER TABLE audit_checkpoints ADD COLUMN IF NOT EXISTS merchant_id UUID REFERENCES merchants(id);

      -- Keep inventory history when a reservation row is removed
      ALTER TABLE inventory_events DROP CONSTRAINT IF EXISTS inventory_events_reservation_id_fkey;
      ALTER TABLE inventory_events ADD CONSTRAINT inventory_events_reservation_id_fkey
          FOREIGN KEY (reservation_id) REFERENCES inventory_reservations(id) ON DELETE SET NULL;
    `);

    // Apply incremental schema alterations for existing DB tables
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_delegations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          principal_name TEXT NOT NULL,
          buyer_agent_id UUID NOT NULL REFERENCES buyer_agents(id),
          merchant_id UUID REFERENCES merchants(id),
          allowed_categories TEXT[],
          max_total_amount_minor BIGINT NOT NULL,
          autonomous_purchase_allowed BOOLEAN NOT NULL DEFAULT TRUE,
          version INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE agent_delegations ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE purchase_mandates ADD COLUMN IF NOT EXISTS delegation_version INTEGER DEFAULT 1;

      CREATE TABLE IF NOT EXISTS audit_ledger_heads (
          merchant_id UUID PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
          latest_sequence BIGINT NOT NULL DEFAULT 0,
          latest_hash TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
      ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (
          'PENDING_CONFIRMATION', 'CONFIRMED', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED',
          'PAYMENT_UNCERTAIN', 'PAYMENT_ATTEMPT_FAILED', 'PAYMENT_FAILED', 'FULFILMENT_EXCEPTION',
          'REFUND_REQUIRED', 'REFUND_PENDING', 'REFUNDED', 'MANUAL_RESOLUTION_REQUIRED',
          'RETURN_REQUESTED', 'RETURNED', 'CANCELLED'
      ));

      ALTER TABLE checkouts DROP CONSTRAINT IF EXISTS checkouts_status_check;
      ALTER TABLE checkouts ADD CONSTRAINT checkouts_status_check CHECK (status IN ('PENDING', 'AWAITING_AUTH', 'PAYMENT_UNCERTAIN', 'PAYMENT_ATTEMPT_FAILED', 'PAID', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED'));

      ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
      ALTER TABLE payments ADD CONSTRAINT payments_status_check CHECK (status IN ('CREATED', 'PENDING', 'AUTHORIZED', 'PAYMENT_UNCERTAIN', 'CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'FAILED', 'CANCELLED'));

      CREATE TABLE IF NOT EXISTS refunds (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          order_id UUID NOT NULL REFERENCES orders(id),
          payment_id UUID REFERENCES payments(id),
          razorpay_refund_id TEXT UNIQUE,
          amount_minor BIGINT NOT NULL,
          currency TEXT NOT NULL DEFAULT 'INR',
          reason TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'CREATED' 
              CHECK (status IN ('CREATED', 'SUBMITTED', 'REFUND_UNCERTAIN', 'PROCESSING', 'PROCESSED', 'FAILED', 'MANUAL_RESOLUTION_REQUIRED')),
          provider TEXT NOT NULL DEFAULT 'RAZORPAY_CHECKOUT',
          error_code TEXT,
          error_description TEXT,
          reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
          last_reconciliation_attempt_at TIMESTAMPTZ,
          next_reconciliation_attempt_at TIMESTAMPTZ,
          correlation_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_status_check;
      ALTER TABLE refunds ADD CONSTRAINT refunds_status_check CHECK (status IN ('CREATED', 'SUBMITTED', 'REFUND_UNCERTAIN', 'PROCESSING', 'PROCESSED', 'FAILED', 'MANUAL_RESOLUTION_REQUIRED'));

      CREATE TABLE IF NOT EXISTS webhook_secrets (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          merchant_id UUID REFERENCES merchants(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,
          secret_handle TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('PRIMARY', 'PREVIOUS_ACTIVE', 'REVOKED')),
          valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          valid_until TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS audit_outbox (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          transaction_id TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          merchant_id UUID REFERENCES merchants(id),
          decision TEXT,
          human_readable TEXT NOT NULL,
          policy_rule_id TEXT,
          metadata JSONB NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSED', 'FAILED')),
          error_message TEXT,
          processed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      DROP RULE IF EXISTS audit_events_no_update ON audit_events;
      DROP RULE IF EXISTS audit_events_no_delete ON audit_events;

      CREATE OR REPLACE FUNCTION enforce_audit_events_immutable()
      RETURNS TRIGGER AS $$
      BEGIN
          RAISE EXCEPTION 'ERROR: AUDIT_EVENT_IMMUTABLE: Mutation or deletion of cryptographic audit log is prohibited.';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_audit_events_immutable ON audit_events;
      CREATE TRIGGER trg_audit_events_immutable
      BEFORE UPDATE OR DELETE ON audit_events
      FOR EACH ROW EXECUTE FUNCTION enforce_audit_events_immutable();

      -- Inventory Invariants & State Machine Trigger
      ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS reserved_le_stock;
      ALTER TABLE product_variants ADD CONSTRAINT reserved_le_stock CHECK (reserved_qty <= stock_qty);

      CREATE OR REPLACE FUNCTION enforce_inventory_reservation_transition()
      RETURNS TRIGGER AS $$
      BEGIN
          IF OLD.status = NEW.status THEN
              RETURN NEW;
          END IF;

          IF OLD.status = 'ACTIVE' AND NEW.status IN ('COMMITTED', 'RELEASED', 'EXPIRED') THEN
              RETURN NEW;
          END IF;

          RAISE EXCEPTION 'ILLEGAL_RESERVATION_STATE_TRANSITION: Cannot transition reservation from terminal status % to %', OLD.status, NEW.status;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_inventory_reservation_transition ON inventory_reservations;
      CREATE TRIGGER trg_inventory_reservation_transition
      BEFORE UPDATE ON inventory_reservations
      FOR EACH ROW EXECUTE FUNCTION enforce_inventory_reservation_transition();
    `);

    await client.query('COMMIT');
    console.log('✅ Migrations applied successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
