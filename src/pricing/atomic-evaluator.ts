export interface PriceAdjustment {
  sourceType: 'NEGOTIATED_DISCOUNT' | 'COUPON' | 'LOYALTY' | 'SHIPPING_WAIVER' | 'BANK_OFFER' | 'PSP_OFFER';
  fundingParty: 'MERCHANT' | 'BANK' | 'PSP_PARTNER' | 'ISSUER';
  amountMinor: number;
  stackGroup?: string;
  ruleId: string;
}

export interface EconomicEvaluationInput {
  grossAmountMinor: number;
  totalCogsMinor: number;
  minGrossMarginBps: number;
  adjustments: PriceAdjustment[];
  estimatedPspBps?: number; // Estimated payment gateway processing fee (e.g. 200 bps = 2%)
}

export interface NormalizedDiscountLedgerItem {
  sourceType: string;
  fundingParty: string;
  amountMinor: number;
  ruleId: string;
}

export interface EconomicEvaluationResult {
  valid: boolean;
  grossAmountMinor: number;
  netPayableMinor: number;
  totalMerchantDiscountMinor: number;
  totalThirdPartySubsidiesMinor: number;
  merchantNetRevenueMinor: number;
  effectiveMerchantMarginBps: number;
  discountLedger: NormalizedDiscountLedgerItem[];
  rejectionReason?: string;
}

/**
 * P1.8: Deterministic integer rounding division (ROUND_HALF_UP) to eliminate float drift.
 */
export function roundDivision(numerator: number, denominator: number, mode: 'ROUND_HALF_UP' | 'FLOOR' = 'ROUND_HALF_UP'): number {
  if (denominator === 0) return 0;
  if (mode === 'ROUND_HALF_UP') {
    return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
  }
  return Math.floor(numerator / denominator);
}

/**
 * Calculates basis-point discount in integer paise using ROUND_HALF_UP.
 */
export function computeBpsDiscount(amountMinor: number, discountBps: number): number {
  return roundDivision(amountMinor * discountBps, 10000, 'ROUND_HALF_UP');
}

/**
 * Evaluates atomic merchant unit economics across multi-stakeholder discount contributions.
 * 
 * INVARIANT:
 * Merchant Net Revenue = Net Payable by Customer + External Subsidies (Bank Cashback / Issuer funding)
 * Effective Merchant Margin = (Merchant Net Revenue - COGS - Estimated PSP costs) / Merchant Net Revenue
 * Must satisfy: Effective Margin >= minGrossMarginBps
 */
export function evaluateAtomicEconomics(input: EconomicEvaluationInput): EconomicEvaluationResult {
  let totalMerchantDiscount = 0;
  let totalThirdPartySubsidies = 0;
  const discountLedger: NormalizedDiscountLedgerItem[] = [];

  for (const adj of input.adjustments) {
    discountLedger.push({
      sourceType: adj.sourceType,
      fundingParty: adj.fundingParty,
      amountMinor: adj.amountMinor,
      ruleId: adj.ruleId
    });

    if (adj.fundingParty === 'MERCHANT') {
      totalMerchantDiscount += adj.amountMinor;
    } else {
      totalThirdPartySubsidies += adj.amountMinor;
    }
  }

  // Net payable by buyer (customer checkout price)
  const netPayableMinor = Math.max(0, input.grossAmountMinor - totalMerchantDiscount - totalThirdPartySubsidies);

  // Total gross revenue received by merchant (customer payment + bank/issuer settlement reimbursement)
  const merchantRevenueMinor = netPayableMinor + totalThirdPartySubsidies;

  // Estimated payment processing fee (default 0 or specified bps using controlled integer division)
  const pspCostMinor = input.estimatedPspBps
    ? roundDivision(netPayableMinor * input.estimatedPspBps, 10000, 'ROUND_HALF_UP')
    : 0;

  // Net merchant margin
  const netMerchantMarginMinor = merchantRevenueMinor - input.totalCogsMinor - pspCostMinor;

  if (merchantRevenueMinor <= (input.totalCogsMinor + pspCostMinor) || netMerchantMarginMinor <= 0) {
    return {
      valid: false,
      grossAmountMinor: input.grossAmountMinor,
      netPayableMinor,
      totalMerchantDiscountMinor: totalMerchantDiscount,
      totalThirdPartySubsidiesMinor: totalThirdPartySubsidies,
      merchantNetRevenueMinor: merchantRevenueMinor,
      effectiveMerchantMarginBps: 0,
      discountLedger,
      rejectionReason: `Combinatorial discounts breach unit economics: Merchant net revenue (₹${(merchantRevenueMinor / 100).toFixed(2)}) is below COGS + PSP cost (₹${((input.totalCogsMinor + pspCostMinor) / 100).toFixed(2)}).`
    };
  }

  const effectiveMarginBps = roundDivision(netMerchantMarginMinor * 10000, merchantRevenueMinor, 'ROUND_HALF_UP');

  if (effectiveMarginBps < input.minGrossMarginBps) {
    return {
      valid: false,
      grossAmountMinor: input.grossAmountMinor,
      netPayableMinor,
      totalMerchantDiscountMinor: totalMerchantDiscount,
      totalThirdPartySubsidiesMinor: totalThirdPartySubsidies,
      merchantNetRevenueMinor: merchantRevenueMinor,
      effectiveMerchantMarginBps: effectiveMarginBps,
      discountLedger,
      rejectionReason: `Effective gross margin (${(effectiveMarginBps / 100).toFixed(2)}%) violates merchant floor requirement of ${(input.minGrossMarginBps / 100).toFixed(2)}%.`
    };
  }

  return {
    valid: true,
    grossAmountMinor: input.grossAmountMinor,
    netPayableMinor,
    totalMerchantDiscountMinor: totalMerchantDiscount,
    totalThirdPartySubsidiesMinor: totalThirdPartySubsidies,
    merchantNetRevenueMinor: merchantRevenueMinor,
    effectiveMerchantMarginBps: effectiveMarginBps,
    discountLedger
  };
}
