import { pool } from './pool.js';
import { ARENA_AGENT_ID, ARENA_PRINCIPAL_NAME, arenaProducts } from '../arena/catalog.js';
import crypto from 'crypto';

export function getCanonicalMandateString(data: {
  mandate_token_id: string;
  buyer_agent_id: string;
  merchant_id: string;
  max_total_amount_minor: number;
  nonce: string;
}): string {
  return `${data.mandate_token_id}:${data.buyer_agent_id}:${data.merchant_id}:${data.max_total_amount_minor}:${data.nonce}`;
}

export async function seedDatabase() {
  console.log('🌱 Seeding Bound merchant database: catalog, policy gates, and signed demo mandates...');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Merchant
    const merchantRes = await client.query(`
      INSERT INTO merchants (id, name, slug, razorpay_key_id, currency)
      VALUES (
        '11111111-1111-1111-1111-111111111111',
        'Apex Global Retail (Test Merchant)',
        'apex-retail',
        'rzp_test_manifest2026',
        'INR'
      )
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
      RETURNING id;
    `);
    const merchantId = merchantRes.rows[0].id;

    // 2. Buyer Agent
    await client.query(`
      INSERT INTO buyer_agents (id, label, principal_name, key_custody_tier)
      VALUES (
        '22222222-2222-2222-2222-222222222222',
        'Reference Buyer Agent (local Gemma 4 tool loop)',
        'Principal Shopper Account',
        'DEV_KEY_STORAGE'
      )
      ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label;
    `);
    // Separate agent for the Arena so its per-run signing keys never touch the reference agent's mandates
    await client.query(`
      INSERT INTO buyer_agents (id, label, principal_name, key_custody_tier)
      VALUES ($1, 'Arena Buyer Agent (local Gemma 4)', $2, 'DEV_KEY_STORAGE')
      ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, principal_name = EXCLUDED.principal_name;
    `, [ARENA_AGENT_ID, ARENA_PRINCIPAL_NAME]);
    const buyerAgentId = '22222222-2222-2222-2222-222222222222';

    // Reset audit tables for clean genesis hash chain
    await client.query(`
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

      TRUNCATE TABLE audit_ledger_heads, audit_events, audit_checkpoints, provenance_receipts, refunds, payments, order_items, orders, checkouts, cart_items, carts, inventory_reservations, inventory_events, negotiation_sessions, purchase_mandates, agent_delegations, webhook_secrets, webhook_events, audit_outbox CASCADE;
    `);

    // Seed initial Primary Webhook Secret using KMS/Secret Manager reference (Version 1)
    await client.query(`
      INSERT INTO webhook_secrets (merchant_id, version, secret_handle, status, valid_from)
      VALUES ($1, 1, 'env://RAZORPAY_WEBHOOK_SECRET', 'PRIMARY', NOW());
    `, [merchantId]);
    await client.query('DELETE FROM purchase_policies WHERE merchant_id = $1', [merchantId]);
    await client.query(`
      INSERT INTO purchase_policies (
        id, merchant_id, version, max_discount_bps, min_gross_margin_bps, max_negotiation_rounds, allow_coupon_stacking, eligible_categories, active
      ) VALUES (
        '33333333-3333-3333-3333-333333333333',
        $1,
        1,
        1000, -- 10% max discount
        1200, -- 12% minimum margin floor
        2,
        false,
        ARRAY['Electronics', 'Appliances', 'Groceries', 'Beverages', 'Home', 'Accessories', 'Audio', 'Coffee Machines'],
        true
      );
    `, [merchantId]);

    // 4. Ed25519 Key Pair & Mandate Binding
    const keyPair = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

    await client.query(`
      INSERT INTO mandate_key_bindings (id, buyer_agent_id, key_id, public_key, algorithm, status)
      VALUES (
        '44444444-4444-4444-4444-444444444444',
        $1,
        'key_agent_ed25519_demo',
        $2,
        'Ed25519',
        'ACTIVE'
      )
      ON CONFLICT (key_id) DO UPDATE SET public_key = EXCLUDED.public_key, status = 'ACTIVE';
    `, [buyerAgentId, publicKeyPem]);

    // 5. Active Purchase Mandate for Demo
    const mandateData = {
      mandate_token_id: 'mandate_tok_demo_2026',
      buyer_agent_id: buyerAgentId,
      merchant_id: merchantId,
      max_total_amount_minor: 1000000, // ₹10,000 max total ceiling
      per_txn_limit_minor: 600000,     // ₹6,000 per txn
      allowed_categories: [
        'Electronics', 'Appliances', 'Groceries', 'Beverages', 'Home', 'Accessories', 
        'Audio', 'Coffee Machines', 'Coffee', 'Wearables', 'Grains', 'Rice', 'Tea', 
        'Chargers', 'Cooking Essentials', 'Oils', 'Kitchen', 'Smart Home', 'Keyboards', 
        'Spreads', 'Honey', 'Headphones'
      ],
      currency: 'INR',
      nonce: 'nonce_demo_init_89123',
      not_before: new Date(Date.now() - 3600000).toISOString(),
      expires_at: new Date(Date.now() + 86400000 * 30).toISOString() // 30 days valid
    };

    const canonicalMsg = getCanonicalMandateString(mandateData);
    const signature = crypto.sign(null, Buffer.from(canonicalMsg), keyPair.privateKey).toString('hex');

    await client.query(`
      INSERT INTO purchase_mandates (
        id, mandate_token_id, buyer_agent_id, merchant_id, max_total_amount_minor, spent_amount_minor,
        per_txn_limit_minor, allowed_categories, currency, nonce, signature, signature_algorithm,
        status, not_before, expires_at
      ) VALUES (
        '55555555-5555-5555-5555-555555555555',
        $1, $2, $3, $4, 0, $5, $6, $7, $8, $9, 'Ed25519', 'ACTIVE', $10, $11
      )
      ON CONFLICT (mandate_token_id) DO UPDATE SET
        max_total_amount_minor = EXCLUDED.max_total_amount_minor,
        spent_amount_minor = 0,
        signature = EXCLUDED.signature,
        status = 'ACTIVE';
    `, [
      mandateData.mandate_token_id,
      mandateData.buyer_agent_id,
      mandateData.merchant_id,
      mandateData.max_total_amount_minor,
      mandateData.per_txn_limit_minor,
      mandateData.allowed_categories,
      mandateData.currency,
      mandateData.nonce,
      signature,
      mandateData.not_before,
      mandateData.expires_at
    ]);

    // 6. Comprehensive 30+ SKUs Catalog
    const sampleProducts = [
      {
        sku_prefix: 'BREW-42',
        title: 'BrewMaster Compact Espresso & Coffee Machine',
        brand: 'BrewMaster',
        category_path: ['Appliances', 'Coffee Machines'],
        description: 'Compact 900W 15-bar espresso machine with milk frother steam wand.',
        agent_summary: 'Brand: BrewMaster | Power: 900W | Pressure: 15-bar | Capacity: 1.2L | Color: Matte Black | Category: Appliances',
        specifications: { power_w: 900, capacity_l: 1.2, pressure_bar: 15, color: 'Matte Black' },
        safety_facts: { food_grade_certified: 'TRUE', bpa_free: 'TRUE', high_voltage: 'TRUE' },
        cogs_minor: 320000,
        variants: [
          { sku: 'BREW-42-BLK', title: 'Matte Black / 220V', price_minor: 479900, stock_qty: 25, compare_at_price_minor: 549900 }
        ]
      },
      {
        sku_prefix: 'SONIC-H7',
        title: 'SonicWave Wireless Noise-Cancelling Headphones',
        brand: 'SonicWave',
        category_path: ['Electronics', 'Audio', 'Headphones'],
        description: 'Over-ear active noise cancelling bluetooth 5.3 headphones with 40h battery life.',
        agent_summary: 'Brand: SonicWave | Type: Over-ear ANC | Battery: 40h | Connectivity: Bluetooth 5.3 | Color: Midnight Blue',
        specifications: { battery_hours: 40, anc: true, bluetooth: '5.3', weight_g: 240 },
        safety_facts: { battery_certified: 'TRUE', water_resistant: 'TRUE' },
        cogs_minor: 210000,
        variants: [
          { sku: 'SONIC-H7-BLU', title: 'Midnight Blue', price_minor: 349900, stock_qty: 40, compare_at_price_minor: 429900 },
          { sku: 'SONIC-H7-BLK', title: 'Stealth Black', price_minor: 349900, stock_qty: 30, compare_at_price_minor: 429900 }
        ]
      },
      {
        sku_prefix: 'CONC-HOT-01',
        title: 'Limited Edition Smart Fitness Band (Concurrency Test SKU 1)',
        brand: 'PulseTech',
        category_path: ['Electronics', 'Wearables'],
        description: 'Ultra-rare limited batch fitness tracker with AMOLED display. Exactly 1 unit available.',
        agent_summary: 'Brand: PulseTech | AMOLED | 1 Unit In Stock for Concurrency Race Testing | Limited Edition',
        specifications: { display: 'AMOLED', water_resistance: '5ATM', stock_scarcity: 'CRITICAL_1_UNIT' },
        safety_facts: { skin_safe_silicone: 'TRUE' },
        cogs_minor: 90000,
        variants: [
          { sku: 'CONC-HOT-01-LTD', title: 'Limited Gunmetal / Single Unit', price_minor: 149900, stock_qty: 1, compare_at_price_minor: 199900 }
        ]
      },
      {
        sku_prefix: 'CONC-HOT-02',
        title: 'Exclusive Handcrafted Coffee Roast 250g (Concurrency Test SKU 2)',
        brand: 'Monsoon Roasters',
        category_path: ['Groceries', 'Beverages', 'Coffee'],
        description: 'Micro-lot single estate artisanal coffee beans. Exactly 1 unit available.',
        agent_summary: 'Single Origin Arabica | 250g | 1 Unit in Stock for Concurrency Race Testing',
        specifications: { origin: 'Coorg Estate', roast: 'Medium-Dark', weight_g: 250 },
        safety_facts: { organic: 'TRUE', allergen_free: 'TRUE' },
        cogs_minor: 25000,
        variants: [
          { sku: 'CONC-HOT-02-LTD', title: 'Whole Bean 250g / Single Unit', price_minor: 45000, stock_qty: 1, compare_at_price_minor: 55000 }
        ]
      },
      {
        sku_prefix: 'RICE-ROYAL-5K',
        title: 'Royal Heritage Aged Basmati Rice 5kg',
        brand: 'Royal Heritage',
        category_path: ['Groceries', 'Grains', 'Rice'],
        description: 'Long grain aromatic 2-year aged premium basmati rice.',
        agent_summary: 'Type: Aged Basmati Rice | Weight: 5kg | Grain: Extra Long | Category: Groceries',
        specifications: { weight_kg: 5, aging_years: 2, grain_length_mm: 8.4 },
        safety_facts: { non_gmo: 'TRUE', pesticide_tested: 'TRUE' },
        cogs_minor: 52000,
        variants: [
          { sku: 'RICE-ROYAL-5K-PK', title: '5kg Family Pack', price_minor: 79900, stock_qty: 80, compare_at_price_minor: 95000 }
        ]
      },
      {
        sku_prefix: 'TEA-DARJ-250',
        title: 'First Flush Imperial Darjeeling Green Tea 250g',
        brand: 'Himalayan Leaf',
        category_path: ['Groceries', 'Beverages', 'Tea'],
        description: 'Handpicked spring crop whole leaf organic green tea.',
        agent_summary: 'Organic First Flush Darjeeling Green Tea | 250g | Antioxidant Rich',
        specifications: { weight_g: 250, flush: 'First Flush', organic: true },
        safety_facts: { organic: 'TRUE', zero_preservatives: 'TRUE' },
        cogs_minor: 28000,
        variants: [
          { sku: 'TEA-DARJ-250-CAN', title: '250g Airtight Canister', price_minor: 49900, stock_qty: 60, compare_at_price_minor: 59900 }
        ]
      },
      {
        sku_prefix: 'CHG-GAN-65W',
        title: 'HyperFast 65W GaN Fast Charger 3-Port',
        brand: 'VoltCraft',
        category_path: ['Electronics', 'Accessories', 'Chargers'],
        description: 'Dual USB-C and USB-A power delivery fast charger compatible with laptops and smartphones.',
        agent_summary: 'GaN Technology | 65W Power Delivery | 2x USB-C + 1x USB-A | Compact Travel Charger',
        specifications: { power_w: 65, ports: 3, tech: 'GaN III', fast_charge: 'PD 3.0 / PPS' },
        safety_facts: { surge_protection: 'TRUE', overvoltage_protection: 'TRUE' },
        cogs_minor: 95000,
        variants: [
          { sku: 'CHG-GAN-65W-WHT', title: 'Gloss White', price_minor: 189900, stock_qty: 50, compare_at_price_minor: 249900 },
          { sku: 'CHG-GAN-65W-BLK', title: 'Matte Black', price_minor: 189900, stock_qty: 45, compare_at_price_minor: 249900 }
        ]
      },
      {
        sku_prefix: 'OIL-OLV-1L',
        title: 'Mediterranean Extra Virgin Cold Pressed Olive Oil 1L',
        brand: 'Sol Del Sur',
        category_path: ['Groceries', 'Cooking Essentials', 'Oils'],
        description: 'First cold pressed unfiltered extra virgin olive oil.',
        agent_summary: 'Extra Virgin Olive Oil | 1 Litre Glass Bottle | Cold Pressed | Acidity < 0.3%',
        specifications: { volume_l: 1, acidity_pct: 0.28, extraction: 'Cold Pressed' },
        safety_facts: { cold_pressed: 'TRUE', unrefined: 'TRUE' },
        cogs_minor: 85000,
        variants: [
          { sku: 'OIL-OLV-1L-BTL', title: '1L Dark Glass Bottle', price_minor: 129900, stock_qty: 35, compare_at_price_minor: 159900 }
        ]
      },
      {
        sku_prefix: 'AIR-FRY-4L',
        title: 'CrispAir Digital 4.2L Air Fryer Oven',
        brand: 'CrispAir',
        category_path: ['Appliances', 'Kitchen'],
        description: 'Rapid air circulation 1400W digital air fryer with 8 preset cooking modes.',
        agent_summary: 'Digital Air Fryer | 4.2L Capacity | 1400W | Touch Screen | Dishwasher Safe Basket',
        specifications: { power_w: 1400, capacity_l: 4.2, nonstick: true },
        safety_facts: { pfoa_free: 'TRUE', auto_shutoff: 'TRUE' },
        cogs_minor: 240000,
        variants: [
          { sku: 'AIR-FRY-4L-BLK', title: 'Piano Black 4.2L', price_minor: 389900, stock_qty: 20, compare_at_price_minor: 499900 }
        ]
      },
      {
        sku_prefix: 'VAC-ROBOT-X',
        title: 'RoboClean Smart LiDAR Robot Vacuum & Mop',
        brand: 'RoboClean',
        category_path: ['Appliances', 'Smart Home'],
        description: '4000Pa suction robotic vacuum cleaner with laser LiDAR navigation and auto-mop lift.',
        agent_summary: 'LiDAR Navigation | 4000Pa Suction | 2-in-1 Vacuum & Mop | App & Voice Control',
        specifications: { suction_pa: 4000, battery_mah: 5200, lidar: true },
        safety_facts: { cliff_sensor: 'TRUE', battery_certified: 'TRUE' },
        cogs_minor: 1450000,
        variants: [
          { sku: 'VAC-ROBOT-X-WHT', title: 'Pearl White / Auto-Empty Ready', price_minor: 2299900, stock_qty: 15, compare_at_price_minor: 2999900 }
        ]
      },
      {
        sku_prefix: 'KB-MECH-RGB',
        title: 'TactilePro 75% Wireless Mechanical Keyboard',
        brand: 'TactilePro',
        category_path: ['Electronics', 'Accessories', 'Keyboards'],
        description: 'Hot-swappable tactile mechanical keyboard with RGB backlighting and tri-mode connectivity.',
        agent_summary: '75% Layout | Hot-Swappable Switches | Tri-Mode (BT/2.4G/USB-C) | PBT Keycaps',
        specifications: { keys: 84, battery_mah: 4000, hot_swap: true },
        safety_facts: { rohs_compliant: 'TRUE' },
        cogs_minor: 320000,
        variants: [
          { sku: 'KB-MECH-BRN', title: 'Brown Tactile Switch / Space Grey', price_minor: 499900, stock_qty: 25, compare_at_price_minor: 599900 },
          { sku: 'KB-MECH-RED', title: 'Red Linear Switch / Space Grey', price_minor: 499900, stock_qty: 20, compare_at_price_minor: 599900 }
        ]
      },
      {
        sku_prefix: 'HONEY-WILD-500',
        title: 'Organic Raw Forest Wildflower Honey 500g',
        brand: 'Nectar Botanicals',
        category_path: ['Groceries', 'Spreads', 'Honey'],
        description: 'Unprocessed unheated 100% pure raw forest honey rich in natural pollen and enzymes.',
        agent_summary: 'Raw Organic Wildflower Honey | 500g Glass Jar | NMR Tested 100% Pure',
        specifications: { weight_g: 500, raw: true, nmr_tested: true },
        safety_facts: { zero_added_sugar: 'TRUE', pure_raw: 'TRUE' },
        cogs_minor: 22000,
        variants: [
          { sku: 'HONEY-WILD-500-JAR', title: '500g Hexagon Jar', price_minor: 39900, stock_qty: 50, compare_at_price_minor: 49900 }
        ]
      },
      ...arenaProducts
    ];

    for (const prod of sampleProducts) {
      const existing = await client.query('SELECT id FROM products WHERE merchant_id = $1 AND sku_prefix = $2', [merchantId, prod.sku_prefix]);
      let productId: string;
      if (existing.rows.length > 0) {
        productId = existing.rows[0].id;
        await client.query(`
          UPDATE products SET
            title = $1, brand = $2, category_path = $3, description = $4,
            agent_summary = $5, specifications = $6, safety_facts = $7, cogs_minor = $8, updated_at = NOW()
          WHERE id = $9;
        `, [
          prod.title,
          prod.brand,
          prod.category_path,
          prod.description,
          prod.agent_summary,
          JSON.stringify(prod.specifications),
          JSON.stringify(prod.safety_facts),
          prod.cogs_minor,
          productId
        ]);
      } else {
        const prodRes = await client.query(`
          INSERT INTO products (
            merchant_id, sku_prefix, title, brand, category_path, description, agent_summary, specifications, safety_facts, cogs_minor
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          RETURNING id;
        `, [
          merchantId,
          prod.sku_prefix,
          prod.title,
          prod.brand,
          prod.category_path,
          prod.description,
          prod.agent_summary,
          JSON.stringify(prod.specifications),
          JSON.stringify(prod.safety_facts),
          prod.cogs_minor
        ]);
        productId = prodRes.rows[0].id;
      }

      for (const v of prod.variants as Array<(typeof prod.variants)[number] & { id?: string }>) {
        await client.query(`
          INSERT INTO product_variants (
            id, product_id, sku, title, price_minor, compare_at_price_minor, stock_qty, reserved_qty
          ) VALUES (COALESCE($7::uuid, gen_random_uuid()), $1, $2, $3, $4, $5, $6, 0)
          ON CONFLICT (sku) DO UPDATE SET
            price_minor = EXCLUDED.price_minor,
            stock_qty = EXCLUDED.stock_qty,
            reserved_qty = 0;
        `, [
          productId,
          v.sku,
          v.title,
          v.price_minor,
          v.compare_at_price_minor,
          v.stock_qty,
          v.id ?? null
        ]);
      }

      const searchContent = `${prod.title} ${prod.brand} ${prod.category_path.join(' ')} ${prod.description} ${prod.agent_summary}`;
      await client.query(`
        INSERT INTO product_search (product_id, search_vector, embedding_version)
        VALUES ($1, to_tsvector('english', $2), 'v1')
        ON CONFLICT (product_id) DO UPDATE SET search_vector = to_tsvector('english', $2);
      `, [productId, searchContent]);
    }

    await client.query('COMMIT');
    console.log(`✅ Catalog seeded: ${sampleProducts.length} products, signed demo mandates, and concurrency targets.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seeding failed:', err);
    throw err;
  } finally {
    client.release();
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  seedDatabase()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
