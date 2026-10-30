import crypto from 'crypto';

/**
 * Deterministic JSON (RFC 8785 style): object keys sorted at every depth, undefined dropped,
 * Dates as ISO strings. Used for every hash or signature over structured data.
 */
export function canonicalJson(obj: any): string {
  if (obj === null || obj === undefined) return 'null';
  if (obj instanceof Date) return JSON.stringify(obj.toISOString());
  if (typeof obj === 'bigint') return JSON.stringify(obj.toString());
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalJson).join(',') + ']';
  }
  const sortedKeys = Object.keys(obj)
    .filter(k => obj[k] !== undefined)
    .sort();
  const pairs = sortedKeys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return '{' + pairs.join(',') + '}';
}

/**
 * SHA-256 over a domain tag plus canonical JSON, so a hash made for one purpose (a Merkle leaf,
 * an intent, a mandate) can never be replayed as a hash for another.
 */
export function domainHash(domain: string, value: unknown): string {
  return crypto.createHash('sha256').update(`${domain}\u0000${canonicalJson(value)}`).digest('hex');
}
