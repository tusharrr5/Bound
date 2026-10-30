import { pool } from '../db/pool.js';
import { QueryCostGovernor } from './governor.js';

export interface CatalogSearchParams {
  query: string;
  category?: string;
  maxPriceMinor?: number;
  inStockOnly?: boolean;
  limit?: number;
}

export interface ProductSearchResult {
  productId: string;
  variantId: string;
  sku: string;
  title: string;
  brand: string;
  categoryPath: string[];
  description: string;
  agentSummary: string;
  priceMinor: number;
  compareAtPriceMinor: number | null;
  currency: string;
  availableStock: number;
  returnable: boolean;
  returnWindowDays: number;
  warrantyMonths: number;
  safetyFacts: Record<string, 'TRUE' | 'FALSE' | 'UNKNOWN'>;
  proof: {
    matchType: 'FTS_MATCH' | 'CATEGORY_MATCH';
    rankScore: number;
  };
}

// Match listings containing any query term (ranked by how many match) rather than all of them,
// so a natural-language agent query like "metal chai warmer" still finds the flasks.
const MATCH_ANY_TERM = `NULLIF(replace(plainto_tsquery('english', $1)::text, '&', '|'), '')::tsquery`;

export async function searchCatalog(params: CatalogSearchParams): Promise<{
  summaryFact: string;
  totalMatches: number;
  results: ProductSearchResult[];
  queryCostScore?: number;
  error?: string;
}> {
  // Query Cost Governor Gate
  const govEval = QueryCostGovernor.evaluateQueryCost({
    query: params.query,
    limit: params.limit,
    category: params.category
  });

  if (!govEval.allowed) {
    return {
      summaryFact: 'QUERY_BUDGET_EXCEEDED',
      totalMatches: 0,
      results: [],
      queryCostScore: govEval.costScore,
      error: govEval.reason
    };
  }

  const limit = Math.min(params.limit || 10, 50);
  const q = params.query.trim().replace(/'/g, "''");

  let sql = `
    SELECT 
      p.id AS product_id,
      p.title,
      p.brand,
      p.category_path,
      p.description,
      p.agent_summary,
      p.returnable,
      p.return_window_days,
      p.warranty_months,
      p.safety_facts,
      pv.id AS variant_id,
      pv.sku,
      pv.price_minor,
      pv.compare_at_price_minor,
      pv.currency,
      (pv.stock_qty - pv.reserved_qty) AS available_stock,
      ts_rank_cd(ps.search_vector, ${MATCH_ANY_TERM}) AS rank
    FROM product_search ps
    JOIN products p ON p.id = ps.product_id
    JOIN product_variants pv ON pv.product_id = p.id
    WHERE (
      ps.search_vector @@ ${MATCH_ANY_TERM}
      OR p.title ILIKE '%' || $1 || '%'
      OR p.description ILIKE '%' || $1 || '%'
      OR $1 = ''
    )
  `;

  const queryParams: any[] = [q];

  if (params.category) {
    queryParams.push(params.category);
    sql += ` AND $${queryParams.length} = ANY(p.category_path)`;
  }

  if (params.maxPriceMinor) {
    queryParams.push(params.maxPriceMinor);
    sql += ` AND pv.price_minor <= $${queryParams.length}`;
  }

  if (params.inStockOnly) {
    sql += ` AND (pv.stock_qty - pv.reserved_qty) > 0`;
  }

  sql += ` ORDER BY rank DESC, pv.price_minor ASC LIMIT $${queryParams.length + 1};`;
  queryParams.push(limit);

  const res = await pool.query(sql, queryParams);

  const results: ProductSearchResult[] = res.rows.map(row => ({
    productId: row.product_id,
    variantId: row.variant_id,
    sku: row.sku,
    title: row.title,
    brand: row.brand,
    categoryPath: row.category_path,
    description: row.description,
    agentSummary: row.agent_summary,
    priceMinor: Number(row.price_minor),
    compareAtPriceMinor: row.compare_at_price_minor ? Number(row.compare_at_price_minor) : null,
    currency: row.currency,
    availableStock: Math.max(0, Number(row.available_stock)),
    returnable: row.returnable,
    returnWindowDays: row.return_window_days,
    warrantyMonths: row.warranty_months,
    safetyFacts: row.safety_facts || {},
    proof: {
      matchType: 'FTS_MATCH',
      rankScore: Number(row.rank)
    }
  }));

  const inStockCount = results.filter(r => r.availableStock > 0).length;
  const summaryFact = `Found ${results.length} total SKUs matching query '${params.query}' (${inStockCount} in-stock).`;

  return {
    summaryFact,
    totalMatches: results.length,
    results,
    queryCostScore: govEval.costScore
  };
}

export async function getProductDetail(productId: string) {
  const res = await pool.query(`
    SELECT p.*, json_agg(pv.*) as variants
    FROM products p
    JOIN product_variants pv ON pv.product_id = p.id
    WHERE p.id::text = $1 OR pv.id::text = $1 OR pv.sku = $1
    GROUP BY p.id;
  `, [productId]);

  if (res.rows.length === 0) return null;
  return res.rows[0];
}
