import crypto from 'crypto';
import { canonicalJson } from '../audit/ledger.js';

export interface QuoteLine {
  variant_id: string;
  quantity: number;
  unit_price_minor: number;
  cogs_minor?: number;
  title?: string;
  sku?: string;
}

export interface QuoteAdjustment {
  source_type: 'NEGOTIATED_DISCOUNT' | 'COUPON' | 'LOYALTY' | 'SHIPPING_WAIVER' | 'BANK_OFFER';
  funding_party: 'MERCHANT' | 'BANK' | 'PSP_PARTNER';
  amount_minor: number;
  stack_group?: string;
  rule_id: string;
}

export interface QuoteSnapshot {
  schema_version: '2.0';
  canonicalization: 'RFC8785';
  hash_algorithm: 'SHA-256';
  quote_id: string;
  merchant_id: string;
  cart_id: string;
  lines: QuoteLine[];
  adjustments: QuoteAdjustment[];
  shipping: {
    method: string;
    amount_minor: number;
  };
  tax_minor: number;
  gross_amount_minor: number;
  discount_amount_minor: number;
  final_total_minor: number;
  currency: string;
  pricing_policy_version: number;
  created_at: string;
  expires_at: string;
}

/**
 * Computes cryptographically bound, canonical SHA-256 hash for cart contents (RFC 8785).
 */
export function computeCanonicalCartHash(
  merchantId: string,
  cartId: string,
  items: Array<{ variantId: string; quantity: number }>
): string {
  const sortedItems = [...items]
    .sort((a, b) => a.variantId.localeCompare(b.variantId))
    .map(i => ({
      quantity: i.quantity,
      variant_id: i.variantId
    }));

  const canonicalPayload = {
    canonicalization: 'RFC8785',
    cart_id: cartId,
    hash_algorithm: 'SHA-256',
    items: sortedItems,
    merchant_id: merchantId,
    schema_version: '2.0'
  };

  return crypto
    .createHash('sha256')
    .update(canonicalJson(canonicalPayload))
    .digest('hex');
}

/**
 * Generates an immutable QuoteSnapshot and its canonical RFC 8785 SHA-256 hash.
 */
export function createQuoteSnapshot(params: {
  quoteId?: string;
  merchantId: string;
  cartId: string;
  lines: QuoteLine[];
  adjustments?: QuoteAdjustment[];
  shippingMethod?: string;
  shippingAmountMinor?: number;
  taxMinor?: number;
  pricingPolicyVersion?: number;
  validityMs?: number;
}): { quote: QuoteSnapshot; quoteHash: string } {
  const quoteId = params.quoteId || `quote_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (params.validityMs || 15 * 60 * 1000));

  const sortedLines = [...params.lines].sort((a, b) => a.variant_id.localeCompare(b.variant_id));
  const sortedAdjustments = [...(params.adjustments || [])].sort((a, b) => a.rule_id.localeCompare(b.rule_id));

  const grossAmountMinor = sortedLines.reduce((acc, l) => acc + l.unit_price_minor * l.quantity, 0);
  const discountAmountMinor = sortedAdjustments.reduce((acc, a) => acc + a.amount_minor, 0);
  const shippingAmountMinor = params.shippingAmountMinor || 0;
  const taxMinor = params.taxMinor || 0;
  const finalTotalMinor = Math.max(0, grossAmountMinor - discountAmountMinor + shippingAmountMinor + taxMinor);

  const quote: QuoteSnapshot = {
    schema_version: '2.0',
    canonicalization: 'RFC8785',
    hash_algorithm: 'SHA-256',
    quote_id: quoteId,
    merchant_id: params.merchantId,
    cart_id: params.cartId,
    lines: sortedLines,
    adjustments: sortedAdjustments,
    shipping: {
      method: params.shippingMethod || 'STANDARD_DELIVERY',
      amount_minor: shippingAmountMinor
    },
    tax_minor: taxMinor,
    gross_amount_minor: grossAmountMinor,
    discount_amount_minor: discountAmountMinor,
    final_total_minor: finalTotalMinor,
    currency: 'INR',
    pricing_policy_version: params.pricingPolicyVersion || 1,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString()
  };

  const quoteHash = crypto
    .createHash('sha256')
    .update(canonicalJson(quote))
    .digest('hex');

  return { quote, quoteHash };
}
