import pg from 'pg';
import { PurchaseTask, taskIntegrityHolds } from './tasks.js';

export type ProductAuthorizationCode =
  | 'AUTHORIZED'
  | 'TASK_NOT_ACTIVE'
  | 'TASK_EXPIRED'
  | 'TASK_INTEGRITY_FAILED'
  | 'TASK_AGENT_MISMATCH'
  | 'MERCHANT_MISMATCH'
  | 'PRODUCT_REQUIRES_HUMAN_APPROVAL'
  | 'PRODUCT_EXCLUDED'
  | 'VARIANT_NOT_AUTHORIZED'
  | 'PRODUCT_NOT_AUTHORIZED_FOR_TASK'
  | 'PRODUCT_ATTRIBUTE_MISMATCH'
  | 'QUANTITY_NOT_ALLOWED'
  | 'TASK_BUDGET_EXCEEDED';

export interface ProductAuthorizationResult {
  allowed: boolean;
  code: ProductAuthorizationCode;
  reason: string;
}

/** Trusted, merchant-controlled facts about a variant. Seller descriptions are deliberately absent. */
export interface AuthorizableProduct {
  variantId: string;
  sku: string;
  merchantId: string;
  productType: string | null;
  verifiedAttributes: Record<string, unknown>;
  priceMinor: number;
}

/**
 * Loads the authorization-relevant facts for a variant. Only columns the merchant controls are
 * read: product_type and verified_attributes, never title or description.
 */
export async function loadAuthorizableProduct(variantId: string, runner: pg.PoolClient | pg.Pool): Promise<AuthorizableProduct | null> {
  if (!/^[0-9a-f-]{36}$/i.test(variantId)) return null;
  const res = await runner.query(`
    SELECT pv.id, pv.sku, pv.price_minor, p.merchant_id, p.product_type, p.verified_attributes
    FROM product_variants pv JOIN products p ON p.id = pv.product_id
    WHERE pv.id = $1;
  `, [variantId]);
  if (!res.rows.length) return null;
  const r = res.rows[0];
  return {
    variantId: r.id,
    sku: r.sku,
    merchantId: r.merchant_id,
    productType: r.product_type,
    verifiedAttributes: r.verified_attributes || {},
    priceMinor: Number(r.price_minor)
  };
}

const readable = (type: string) => type.replace(/_/g, ' ');
const withArticle = (noun: string) => `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;

const deny = (code: ProductAuthorizationCode, reason: string): ProductAuthorizationResult => ({ allowed: false, code, reason });

/**
 * Decides whether one cart line may exist under a purchase task. Pure and deterministic, so the
 * same rule runs when the line is added and again at checkout. "Under budget" is only the last
 * check: a product must first be something the human asked for.
 *
 * @param line.quantityForVariant  total quantity of this variant in the cart after the change
 * @param line.cartQuantityAfter   total quantity across the cart after the change
 * @param line.cartGrossAfterMinor cart value after the change
 */
export function authorizeLineForTask(
  task: PurchaseTask,
  buyerAgentId: string,
  product: AuthorizableProduct,
  line: { quantityForVariant: number; cartQuantityAfter: number; cartGrossAfterMinor: number },
  now: Date = new Date()
): ProductAuthorizationResult {
  if (!taskIntegrityHolds(task)) return deny('TASK_INTEGRITY_FAILED', 'Purchase task record does not match its intent hash.');
  if (task.status !== 'ACTIVE') return deny('TASK_NOT_ACTIVE', `Purchase task is ${task.status}; a human must confirm it first.`);
  if (now > new Date(task.expiresAt)) return deny('TASK_EXPIRED', 'Purchase task has expired.');
  if (task.buyerAgentId !== buyerAgentId) return deny('TASK_AGENT_MISMATCH', 'This agent is not authorized for the purchase task.');
  if (product.merchantId !== task.merchantId) return deny('MERCHANT_MISMATCH', 'Product belongs to a different merchant than the task.');

  if (!product.productType) {
    return deny('PRODUCT_REQUIRES_HUMAN_APPROVAL', `${product.sku} has no merchant-verified product type, so it cannot be matched to the task automatically.`);
  }
  if (task.excludedProductTypes.includes(product.productType)) {
    return deny('PRODUCT_EXCLUDED', `${product.sku} is a ${product.productType}, which the task excludes.`);
  }
  if (task.allowedVariantIds.length > 0 && !task.allowedVariantIds.includes(product.variantId)) {
    return deny('VARIANT_NOT_AUTHORIZED', `${product.sku} is not one of the variants this task allows.`);
  }
  if (!task.allowedProductTypes.includes(product.productType)) {
    return deny('PRODUCT_NOT_AUTHORIZED_FOR_TASK',
      `${product.sku} is ${withArticle(readable(product.productType))}; the task "${task.originalRequest}" only authorizes ${task.allowedProductTypes.map(readable).join(', ')}.`);
  }
  for (const [attribute, required] of Object.entries(task.requiredAttributes)) {
    const actual = product.verifiedAttributes[attribute];
    if (actual === undefined) {
      return deny('PRODUCT_REQUIRES_HUMAN_APPROVAL', `${product.sku} has no verified value for "${attribute}", which the task requires.`);
    }
    if (actual !== required) {
      return deny('PRODUCT_ATTRIBUTE_MISMATCH', `${product.sku} has ${attribute}=${String(actual)}; the task requires ${String(required)}.`);
    }
  }

  const q = line.quantityForVariant;
  if (!Number.isInteger(q) || q < 1 || q > task.maxQuantityPerItem || line.cartQuantityAfter > task.maxTotalQuantity) {
    return deny('QUANTITY_NOT_ALLOWED',
      `Quantity ${q} (cart total ${line.cartQuantityAfter}) exceeds the task limits of ${task.maxQuantityPerItem} per item and ${task.maxTotalQuantity} in total.`);
  }
  if (line.cartGrossAfterMinor > task.maxBudgetMinor) {
    return deny('TASK_BUDGET_EXCEEDED',
      `Cart would reach ₹${(line.cartGrossAfterMinor / 100).toFixed(2)}, over the task budget of ₹${(task.maxBudgetMinor / 100).toFixed(2)}.`);
  }
  return { allowed: true, code: 'AUTHORIZED', reason: `${product.sku} (${product.productType}) satisfies the task.` };
}
