import { describe, it, expect } from 'vitest';
import { evaluateAtomicEconomics, PriceAdjustment, roundDivision, computeBpsDiscount } from '../../src/pricing/atomic-evaluator.js';

describe('Integer Paise Precision, Money Invariants & Promotion Permutation Suite', () => {
  it('Enforces exact integer basis-point division with ROUND_HALF_UP mode (P1.8)', () => {
    // 5% of 1005 paise = 50.25 -> 50 paise
    expect(computeBpsDiscount(1005, 500)).toBe(50);

    // 5% of 1010 paise = 50.50 -> 51 paise (ROUND_HALF_UP)
    expect(computeBpsDiscount(1010, 500)).toBe(51);

    // Controlled integer division
    expect(roundDivision(10, 3, 'ROUND_HALF_UP')).toBe(3); // 3.33 -> 3
    expect(roundDivision(11, 3, 'ROUND_HALF_UP')).toBe(4); // 3.66 -> 4
    expect(roundDivision(5, 2, 'ROUND_HALF_UP')).toBe(3);  // 2.50 -> 3
  });

  it('Enforces exact integer paise precision without floating-point drift', () => {
    const listPriceMinor = 479900; // ₹4,799.00
    const cogsMinor = 320000;      // ₹3,200.00
    const minMarginBps = 1200;     // 12%

    // 10% discount in basis points (1000 bps)
    const discountMinor = computeBpsDiscount(listPriceMinor, 1000);
    expect(Number.isInteger(discountMinor)).toBe(true);
    expect(discountMinor).toBe(47990);

    const adjustments: PriceAdjustment[] = [
      {
        sourceType: 'NEGOTIATED_DISCOUNT',
        fundingParty: 'MERCHANT',
        amountMinor: discountMinor,
        ruleId: 'NEG_10_PCT'
      }
    ];

    const result = evaluateAtomicEconomics({
      grossAmountMinor: listPriceMinor,
      totalCogsMinor: cogsMinor,
      minGrossMarginBps: minMarginBps,
      adjustments
    });

    expect(result.valid).toBe(true);
    expect(result.netPayableMinor).toBe(431910); // ₹4,319.10
    expect(Number.isInteger(result.netPayableMinor)).toBe(true);
    expect(result.effectiveMerchantMarginBps).toBe(2591); // 25.91%
  });

  it('Correctly separates Merchant vs Issuer/Bank subsidies in normalized discount ledger', () => {
    const grossMinor = 500000; // ₹5,000.00
    const cogsMinor = 380000;  // ₹3,800.00
    const minMarginBps = 1200; // 12% required (Minimum net revenue needed: ₹4,318.18)

    const adjustments: PriceAdjustment[] = [
      {
        sourceType: 'NEGOTIATED_DISCOUNT',
        fundingParty: 'MERCHANT',
        amountMinor: 25000, // ₹250
        ruleId: 'NEG_250'
      },
      {
        sourceType: 'COUPON',
        fundingParty: 'MERCHANT',
        amountMinor: 20000, // ₹200
        ruleId: 'COUPON_200'
      },
      {
        sourceType: 'BANK_OFFER',
        fundingParty: 'BANK', // Bank funded! Does NOT reduce merchant revenue
        amountMinor: 50000, // ₹500
        ruleId: 'HDFC_CASHBACK_500'
      }
    ];

    const result = evaluateAtomicEconomics({
      grossAmountMinor: grossMinor,
      totalCogsMinor: cogsMinor,
      minGrossMarginBps: minMarginBps,
      adjustments
    });

    expect(result.valid).toBe(true);
    // Customer pays: 500000 - 25000 - 20000 - 50000 = ₹4,050
    expect(result.netPayableMinor).toBe(405000);
    // Merchant receives customer pay + bank subsidy = ₹4,550
    expect(result.merchantNetRevenueMinor).toBe(455000);
    // Merchant margin on 455000 with 380000 COGS = (455000 - 380000) / 455000 = 16.48% (>= 12%)
    expect(result.effectiveMerchantMarginBps).toBe(1648);
    expect(result.discountLedger.length).toBe(3);
  });

  it('Promotion permutation fuzzing: Margin invariant is never breached regardless of discount stacking sequence', () => {
    const grossMinor = 1000000; // ₹10,000
    const cogsMinor = 750000;   // ₹7,500 COGS
    const minMarginBps = 1500;  // 15% margin floor

    // Available promotions
    const promoPool: PriceAdjustment[] = [
      { sourceType: 'NEGOTIATED_DISCOUNT', fundingParty: 'MERCHANT', amountMinor: 50000, ruleId: 'NEG_500' },
      { sourceType: 'COUPON', fundingParty: 'MERCHANT', amountMinor: 70000, ruleId: 'COUPON_700' },
      { sourceType: 'SHIPPING_WAIVER', fundingParty: 'MERCHANT', amountMinor: 15000, ruleId: 'SHIP_FREE' },
      { sourceType: 'LOYALTY', fundingParty: 'MERCHANT', amountMinor: 30000, ruleId: 'LOYALTY_300' },
      { sourceType: 'BANK_OFFER', fundingParty: 'BANK', amountMinor: 100000, ruleId: 'BANK_1000' }
    ];

    // Generate permutations of adjustments
    function getPermutations<T>(arr: T[]): T[][] {
      if (arr.length <= 1) return [arr];
      const perms: T[][] = [];
      for (let i = 0; i < arr.length; i++) {
        const item = arr[i];
        const remaining = arr.slice(0, i).concat(arr.slice(i + 1));
        for (const sub of getPermutations(remaining)) {
          perms.push([item, ...sub]);
        }
      }
      return perms;
    }

    const permutations = getPermutations(promoPool).slice(0, 20); // Test 20 distinct ordering permutations

    for (const perm of permutations) {
      const evalResult = evaluateAtomicEconomics({
        grossAmountMinor: grossMinor,
        totalCogsMinor: cogsMinor,
        minGrossMarginBps: minMarginBps,
        adjustments: perm
      });

      if (evalResult.valid) {
        // Invariant 1: Effective margin must be >= minimum required margin floor
        expect(evalResult.effectiveMerchantMarginBps).toBeGreaterThanOrEqual(minMarginBps);
        // Invariant 2: Merchant revenue must strictly exceed COGS
        expect(evalResult.merchantNetRevenueMinor).toBeGreaterThan(cogsMinor);
        // Invariant 3: Net payable must be non-negative integer paise
        expect(evalResult.netPayableMinor).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(evalResult.netPayableMinor)).toBe(true);
      } else {
        // If rejected, rejection reason must be defined and informative
        expect(evalResult.rejectionReason).toBeDefined();
      }
    }
  });

  it('Allocates proportional multi-item discount without rounding loss', () => {
    const totalDiscountMinor = 10000; // ₹100 discount (10,000 paise)
    const items = [
      { sku: 'ITEM-1', priceMinor: 33333 },
      { sku: 'ITEM-2', priceMinor: 33333 },
      { sku: 'ITEM-3', priceMinor: 33334 }
    ];
    const totalGross = items.reduce((acc, i) => acc + i.priceMinor, 0); // 100,000 paise (₹1,000)

    let allocatedTotal = 0;
    const allocatedDiscounts = items.map((item, idx) => {
      let discount: number;
      if (idx === items.length - 1) {
        discount = totalDiscountMinor - allocatedTotal; // Remainder absorbed by final item
      } else {
        discount = Math.floor((item.priceMinor / totalGross) * totalDiscountMinor);
        allocatedTotal += discount;
      }
      return discount;
    });

    const sumAllocated = allocatedDiscounts.reduce((a, b) => a + b, 0);
    expect(sumAllocated).toBe(totalDiscountMinor);
    expect(allocatedDiscounts.every(Number.isInteger)).toBe(true);
  });
});
