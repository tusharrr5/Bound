export interface QueryBudgetEvaluation {
  allowed: boolean;
  costScore: number;
  maxBudget: number;
  retryAfterMs?: number;
  suggestedAction?: 'REDUCE_QUERY_SCOPE' | 'PAGINATE_RESULTS' | 'SIMPLIFY_REGEX';
  reason?: string;
}

export class QueryCostGovernor {
  private static MAX_BUDGET = 100;

  /**
   * Meters query computational complexity using Compute Units (CU).
   * 
   * METERS:
   * - Base structured search: 10 CU
   * - Long query string (>150 chars): +0.5 CU per char (up to +60 CU)
   * - Pagination limit: >50 (+40 CU), >20 (+15 CU)
   * - Complex regex/wildcards (>5): +50 CU
   * - Combinatorial filter count (>8): +45 CU
   */
  public static evaluateQueryCost(params: {
    query: string;
    limit?: number;
    category?: string;
    filters?: Record<string, any>;
  }): QueryBudgetEvaluation {
    let cost = 10; // Base query cost

    const q = params.query || '';
    // String length complexity penalty
    if (q.length > 150) {
      cost += Math.min(60, Math.floor((q.length - 150) / 2));
    }

    // Pagination limit penalty
    const limit = params.limit || 10;
    if (limit > 50) cost += 40;
    else if (limit > 20) cost += 15;

    // Regex and wildcard combinatorics penalty
    const regexPatternCount = (q.match(/[*+?{}()|[\]\\]/g) || []).length;
    if (regexPatternCount > 5) cost += 50;

    // Excessive filter combinatorics
    if (params.filters && Object.keys(params.filters).length > 8) {
      cost += 45;
    }

    if (cost > this.MAX_BUDGET) {
      return {
        allowed: false,
        costScore: cost,
        maxBudget: this.MAX_BUDGET,
        retryAfterMs: 10000,
        suggestedAction: 'REDUCE_QUERY_SCOPE',
        reason: `Query complexity cost (${cost} CU) exceeds maximum allowed budget (${this.MAX_BUDGET} CU). Suggested action: REDUCE_QUERY_SCOPE.`
      };
    }

    return {
      allowed: true,
      costScore: cost,
      maxBudget: this.MAX_BUDGET
    };
  }
}
