import { INTENTS, ATTRIBUTE_PHRASES } from './taxonomy.js';

export type ResolutionStatus = 'RESOLVED' | 'AMBIGUOUS' | 'UNRESOLVED';

export interface IntentResolution {
  status: ResolutionStatus;
  /** Set only when exactly one intent matched. */
  intent?: string;
  /** Every intent that matched, for a human to choose from when ambiguous. */
  candidates: string[];
  requiredAttributes: Record<string, boolean>;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Deterministically proposes a structured intent from the human's own words. It never reads
 * seller content, and anything other than a single unambiguous match must be confirmed by a
 * human before a task becomes ACTIVE. A model may help a human phrase the request, but this
 * function, not the model, decides what the request authorizes.
 */
export function resolveIntent(request: string): IntentResolution {
  const text = request.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ');

  const candidates = Object.entries(INTENTS)
    .filter(([, def]) => def.phrases.some(p => new RegExp(`\\b${escape(p)}\\b`).test(text)))
    .map(([id]) => id);

  const requiredAttributes: Record<string, boolean> = {};
  for (const { pattern, attribute, value } of ATTRIBUTE_PHRASES) {
    if (pattern.test(text)) requiredAttributes[attribute] = value;
  }

  if (candidates.length === 1) return { status: 'RESOLVED', intent: candidates[0], candidates, requiredAttributes };
  return { status: candidates.length === 0 ? 'UNRESOLVED' : 'AMBIGUOUS', candidates, requiredAttributes };
}
