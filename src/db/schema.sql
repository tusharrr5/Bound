-- ════════════════════════════════════════════════════════════════════════════
-- MANIFEST: AGENTIC COMMERCE ENGINE (DATABASE SCHEMA v2.0)
-- ════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── MERCHANTS & BUYER AGENTS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS merchants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    razorpay_key_id TEXT,
    currency TEXT NOT NULL DEFAULT 'INR',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS buyer_agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    label TEXT NOT NULL,
    principal_name TEXT NOT NULL,
    key_custody_tier TEXT NOT NULL DEFAULT 'DEV_KEY_STORAGE' CHECK (key_custody_tier IN ('DEV_KEY_STORAGE', 'SECURE_ENCLAVE', 'KMS_HSM')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mandate_key_bindings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_agent_id UUID NOT NULL REFERENCES buyer_agents(id) ON DELETE CASCADE,
    key_id TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    algorithm TEXT NOT NULL DEFAULT 'Ed25519',
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'ROTATED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
);

-- ─── AGENT DELEGATIONS (HUMAN PRINCIPAL TO BUYER AGENT) ─────────────────────
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

-- ─── CATALOG, INVENTORY & RESERVATIONS ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    sku_prefix TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    category_path TEXT[] NOT NULL,
    base_price_minor BIGINT NOT NULL CHECK (base_price_minor >= 0),
    cogs_minor BIGINT NOT NULL CHECK (cogs_minor >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    sku TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    price_minor BIGINT NOT NULL CHECK (price_minor >= 0),
    stock_qty INTEGER NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
    reserved_qty INTEGER NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT reserved_le_stock CHECK (reserved_qty <= stock_qty)
);

CREATE TABLE IF NOT EXISTS inventory_reservations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    cart_id TEXT NOT NULL,
    buyer_agent_id UUID REFERENCES buyer_agents(id),
    human_principal_id TEXT,
    device_fingerprint TEXT,
    ip_address TEXT,
    shipping_address_hash TEXT,
    account_hash TEXT,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED')),
    correlation_id TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    reservation_id UUID REFERENCES inventory_reservations(id),
    event_type TEXT NOT NULL CHECK (event_type IN ('RESERVE', 'COMMIT', 'RELEASE', 'EXPIRE_SWEEP', 'RESTOCK', 'ADJUSTMENT')),
    quantity_change INTEGER NOT NULL,
    resulting_stock INTEGER NOT NULL,
    resulting_reserved INTEGER NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── PRICING POLICIES, NEGOTIATIONS & ADJUSTMENTS ───────────────────────────
CREATE TABLE IF NOT EXISTS purchase_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    max_discount_bps INTEGER NOT NULL DEFAULT 1000 CHECK (max_discount_bps <= 5000),
    min_gross_margin_bps INTEGER NOT NULL DEFAULT 1200,
    max_negotiation_rounds INTEGER NOT NULL DEFAULT 2,
    allow_coupon_stacking BOOLEAN NOT NULL DEFAULT FALSE,
    eligible_categories TEXT[],
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS negotiation_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_agent_id UUID NOT NULL REFERENCES buyer_agents(id),
    variant_id UUID NOT NULL REFERENCES product_variants(id),
    rounds_used INTEGER NOT NULL DEFAULT 0,
    last_offered_price_minor BIGINT,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACCEPTED', 'REJECTED', 'EXPIRED')),
    expires_at TIMESTAMPTZ NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS price_adjustments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    checkout_id TEXT NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('NEGOTIATED_DISCOUNT', 'COUPON', 'LOYALTY', 'SHIPPING_WAIVER', 'BANK_OFFER')),
    funding_party TEXT NOT NULL CHECK (funding_party IN ('MERCHANT', 'BANK', 'PSP_PARTNER')),
    amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
    stack_group TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── PURCHASE MANDATES (AP2-INSPIRED CRYPTOGRAPHIC TOKENS) ───────────────────
CREATE TABLE IF NOT EXISTS purchase_mandates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mandate_token_id TEXT NOT NULL UNIQUE,
    delegation_id UUID REFERENCES agent_delegations(id),
    delegation_version INTEGER DEFAULT 1,
    buyer_agent_id UUID NOT NULL REFERENCES buyer_agents(id),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    key_id TEXT,
    max_total_amount_minor BIGINT NOT NULL CHECK (max_total_amount_minor > 0),
    reserved_amount_minor BIGINT NOT NULL DEFAULT 0 CHECK (reserved_amount_minor >= 0),
    spent_amount_minor BIGINT NOT NULL DEFAULT 0 CHECK (spent_amount_minor >= 0),
    per_txn_limit_minor BIGINT,
    allowed_categories TEXT[],
    allowed_sku_prefixes TEXT[],
    cart_hash TEXT,
    quote_hash TEXT,
    currency TEXT NOT NULL DEFAULT 'INR',
    nonce TEXT NOT NULL UNIQUE,
    signature TEXT NOT NULL,
    signature_algorithm TEXT NOT NULL DEFAULT 'Ed25519',
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXHAUSTED', 'EXPIRED', 'REVOKED')),
    not_before TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT spent_limit_check CHECK (spent_amount_minor + reserved_amount_minor <= max_total_amount_minor)
);

-- ─── CARTS & CHECKOUT SESSIONS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS carts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_agent_id UUID NOT NULL REFERENCES buyer_agents(id),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CONVERTED_TO_CHECKOUT', 'EXPIRED', 'ABANDONED')),
    correlation_id TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cart_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cart_id UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_minor BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (cart_id, variant_id)
);

CREATE TABLE IF NOT EXISTS checkouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cart_id UUID NOT NULL REFERENCES carts(id),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    mandate_id UUID REFERENCES purchase_mandates(id),
    razorpay_order_id TEXT UNIQUE,
    quote_hash TEXT NOT NULL,
    cart_hash TEXT NOT NULL,
    gross_amount_minor BIGINT NOT NULL,
    discount_amount_minor BIGINT NOT NULL DEFAULT 0,
    net_amount_minor BIGINT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    execution_mode TEXT NOT NULL CHECK (execution_mode IN ('AUTO_EXECUTABLE', 'REQUIRES_USER_ACTION', 'DENIED')),
    status TEXT NOT NULL DEFAULT 'PENDING' 
        CHECK (status IN ('PENDING', 'AWAITING_AUTH', 'PAYMENT_UNCERTAIN', 'PAYMENT_ATTEMPT_FAILED', 'PAID', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED')),
    checkout_snapshot JSONB NOT NULL DEFAULT '{}',
    quote_snapshot JSONB NOT NULL DEFAULT '{}',
    policy_evaluation_id UUID,
    reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
    last_reconciliation_attempt_at TIMESTAMPTZ,
    next_reconciliation_attempt_at TIMESTAMPTZ,
    reconciliation_error TEXT,
    correlation_id TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── ORDERS & FULFILMENT (LEGAL STATE MACHINE) ──────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    checkout_id UUID NOT NULL UNIQUE REFERENCES checkouts(id),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    buyer_agent_id UUID NOT NULL REFERENCES buyer_agents(id),
    mandate_id UUID REFERENCES purchase_mandates(id),
    razorpay_order_id TEXT NOT NULL UNIQUE,
    total_minor BIGINT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    status TEXT NOT NULL DEFAULT 'PENDING_CONFIRMATION' 
        CHECK (status IN (
            'PENDING_CONFIRMATION', 'CONFIRMED', 'PAID', 'PROCESSING', 'SHIPPED', 'DELIVERED',
            'PAYMENT_UNCERTAIN', 'PAYMENT_ATTEMPT_FAILED', 'PAYMENT_FAILED', 'FULFILMENT_EXCEPTION',
            'REFUND_REQUIRED', 'REFUND_PENDING', 'REFUNDED', 'MANUAL_RESOLUTION_REQUIRED',
            'RETURN_REQUESTED', 'RETURNED', 'CANCELLED'
        )),
    environment TEXT NOT NULL DEFAULT 'PRODUCTION' CHECK (environment IN ('PRODUCTION', 'TEST')),
    funds_moved BOOLEAN NOT NULL DEFAULT TRUE,
    fulfilment_allowed BOOLEAN NOT NULL DEFAULT TRUE,
    shipping_address JSONB NOT NULL,
    correlation_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price_minor BIGINT NOT NULL,
    cogs_minor BIGINT NOT NULL
);

-- ─── PAYMENTS & WEBHOOK EVENTS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES orders(id),
    checkout_id UUID NOT NULL REFERENCES checkouts(id),
    razorpay_payment_id TEXT UNIQUE,
    provider TEXT NOT NULL CHECK (provider IN ('RAZORPAY_CHECKOUT', 'RAZORPAY_UPI_RESERVE_PAY', 'MOCK_SIMULATED_RAIL')),
    amount_minor BIGINT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    status TEXT NOT NULL CHECK (status IN ('CREATED', 'PENDING', 'AUTHORIZED', 'PAYMENT_UNCERTAIN', 'CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'FAILED', 'CANCELLED')),
    method TEXT,
    error_code TEXT,
    error_description TEXT,
    reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
    last_reconciliation_attempt_at TIMESTAMPTZ,
    next_reconciliation_attempt_at TIMESTAMPTZ,
    reconciliation_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL DEFAULT 'RAZORPAY',
    provider_event_id TEXT NOT NULL,
    webhook_source TEXT NOT NULL DEFAULT 'RAZORPAY_NETWORK' CHECK (webhook_source IN ('RAZORPAY_NETWORK', 'TEST_INJECTION')),
    event_type TEXT NOT NULL,
    signature_valid BOOLEAN NOT NULL,
    raw_payload JSONB NOT NULL,
    processed BOOLEAN NOT NULL DEFAULT FALSE,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, provider_event_id)
);

-- ─── PROVENANCE RECEIPTS (REAL MERKLE TREE CONSTRUCTION) ───────────────────
CREATE TABLE IF NOT EXISTS provenance_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL UNIQUE REFERENCES orders(id),
    receipt_version TEXT NOT NULL DEFAULT '2.0',
    audit_root_hash TEXT NOT NULL,
    merkle_tree JSONB NOT NULL,
    mandate_token_id TEXT,
    quote_hash TEXT NOT NULL,
    catalog_version TEXT NOT NULL,
    policy_version INTEGER NOT NULL,
    seller_model_id TEXT NOT NULL,
    full_receipt JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── AUDIT TRAIL & PER-MERCHANT LEDGER HEADS ────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_ledger_heads (
    merchant_id UUID PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
    latest_sequence BIGINT NOT NULL DEFAULT 0,
    latest_hash TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID REFERENCES merchants(id),
    sequence_number BIGSERIAL UNIQUE,
    correlation_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    decision TEXT CHECK (decision IN ('AUTO_EXECUTABLE', 'REQUIRES_USER_ACTION', 'DENIED', NULL)),
    human_readable TEXT NOT NULL,
    policy_rule_id TEXT,
    prev_event_hash TEXT NOT NULL,
    current_hash TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sequence_start BIGINT NOT NULL,
    sequence_end BIGINT NOT NULL,
    event_count BIGINT NOT NULL,
    root_hash TEXT NOT NULL,
    key_id TEXT NOT NULL,
    key_version TEXT NOT NULL DEFAULT 'v2',
    kms_key_arn TEXT NOT NULL DEFAULT 'local:ed25519:audit-checkpoint-dev-key',
    external_storage_uri TEXT NOT NULL DEFAULT 'memory://simulated-worm/checkpoints/',
    worm_retention_policy TEXT NOT NULL DEFAULT 'COMPLIANCE_MODE_7_YEARS',
    object_lock_legal_hold BOOLEAN NOT NULL DEFAULT TRUE,
    external_object_sha256 TEXT,
    signature TEXT NOT NULL,
    algorithm TEXT NOT NULL DEFAULT 'Ed25519',
    signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── TRANSACTIONAL AUDIT OUTBOX (ATOMICITY GUARANTEE) ────────────────────────
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

-- ─── OUTBOX & IDEMPOTENCY ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outbox_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'FAILED')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS idempotency_records (
    idempotency_key TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
    response_code INTEGER,
    response_body JSONB,
    lease_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 seconds'),
    owner_instance TEXT NOT NULL DEFAULT 'node_primary',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS demo_sessions (
    correlation_id TEXT PRIMARY KEY,
    inject_failure BOOLEAN NOT NULL DEFAULT FALSE,
    demo_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── DATABASE-LEVEL LOUD IMMUTABILITY TRIGGER ────────────────────────────────
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

-- ─── INVENTORY RESERVATION STATE MACHINE TRIGGER ─────────────────────────────
CREATE OR REPLACE FUNCTION enforce_inventory_reservation_transition()
RETURNS TRIGGER AS $$
BEGIN
    -- No-op if status does not change
    IF OLD.status = NEW.status THEN
        RETURN NEW;
    END IF;

    -- Valid Transitions:
    -- ACTIVE -> COMMITTED (Terminal)
    -- ACTIVE -> RELEASED (Terminal)
    -- ACTIVE -> EXPIRED (Terminal)
    IF OLD.status = 'ACTIVE' AND NEW.status IN ('COMMITTED', 'RELEASED', 'EXPIRED') THEN
        RETURN NEW;
    END IF;

    -- Any transition from terminal states (COMMITTED, RELEASED, EXPIRED) to anything else is strictly prohibited
    RAISE EXCEPTION 'ILLEGAL_RESERVATION_STATE_TRANSITION: Cannot transition reservation from terminal status % to %', OLD.status, NEW.status;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inventory_reservation_transition ON inventory_reservations;
CREATE TRIGGER trg_inventory_reservation_transition
BEFORE UPDATE ON inventory_reservations
FOR EACH ROW EXECUTE FUNCTION enforce_inventory_reservation_transition();

-- ─── ARENA (LIVE PROMPT-INJECTION DEMO) ──────────────────────────────────────
-- One row per Arena run. Kept across re-seeds so the "times fooled" counter survives.
CREATE TABLE IF NOT EXISTS arena_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    correlation_id TEXT NOT NULL,
    goal TEXT NOT NULL,
    listing_description TEXT NOT NULL,
    model TEXT NOT NULL,
    outcome TEXT NOT NULL,
    fooled BOOLEAN NOT NULL,
    attempted_amount_minor BIGINT,
    money_moved_minor BIGINT NOT NULL DEFAULT 0,
    reason_code TEXT,
    order_id TEXT,
    audit_event_hash TEXT,
    duration_ms INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── PURCHASE TASKS (INTENT-BOUND AUTHORIZATION) ─────────────────────────────
-- What the human actually asked for. Cart lines and autonomous checkouts must satisfy the task,
-- not just the budget. Written only by the server; the model can never create or widen one.
CREATE TABLE IF NOT EXISTS purchase_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_id TEXT NOT NULL,
    buyer_agent_id UUID NOT NULL REFERENCES buyer_agents(id),
    merchant_id UUID NOT NULL REFERENCES merchants(id),
    original_request TEXT NOT NULL CHECK (length(original_request) BETWEEN 1 AND 1000),
    normalized_intent TEXT,
    allowed_product_types TEXT[] NOT NULL DEFAULT '{}',
    excluded_product_types TEXT[] NOT NULL DEFAULT '{}',
    required_attributes JSONB NOT NULL DEFAULT '{}',
    allowed_variant_ids UUID[] NOT NULL DEFAULT '{}',
    max_budget_minor BIGINT NOT NULL CHECK (max_budget_minor > 0),
    max_total_quantity INTEGER NOT NULL CHECK (max_total_quantity BETWEEN 1 AND 1000),
    max_quantity_per_item INTEGER NOT NULL CHECK (max_quantity_per_item BETWEEN 1 AND 1000),
    currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
    status TEXT NOT NULL CHECK (status IN ('PENDING_CONFIRMATION', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'EXPIRED')),
    confirmation_source TEXT CHECK (confirmation_source IN ('HUMAN_CONFIRMED', 'RESOLVER_UNAMBIGUOUS')),
    intent_hash TEXT NOT NULL,
    authorization_version INTEGER NOT NULL DEFAULT 1 CHECK (authorization_version >= 1),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK (expires_at > created_at),
    CHECK (max_quantity_per_item <= max_total_quantity),
    -- An ACTIVE task must name at least one product type and say how it was confirmed
    CHECK (status <> 'ACTIVE' OR (cardinality(allowed_product_types) > 0 AND confirmation_source IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_purchase_tasks_agent ON purchase_tasks (buyer_agent_id, status);
