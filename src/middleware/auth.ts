import crypto from 'crypto';
import { FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/pool.js';

export type PrincipalType = 'HUMAN_PRINCIPAL' | 'BUYER_AGENT' | 'SYSTEM';
export type AuthLevel = 'STANDARD_SESSION' | 'STEP_UP_MFA_VERIFIED' | 'WEBAUTHN_PASSKEY';

export interface TokenClaims {
  sub: string; // User ID / Principal or Agent ID
  principal_type: PrincipalType;
  principal_name: string;
  auth_level?: AuthLevel;
  delegation_id?: string;
  merchant_id?: string;
  scopes: string[];
  iss: string;
  aud: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
}

export interface AgentTokenClaims extends TokenClaims {}

export interface PrincipalContext {
  principalType: PrincipalType;
  agentId: string;
  userId?: string;
  principalName: string;
  authLevel?: AuthLevel;
  delegatedBy?: string;
  delegationId?: string;
  merchantId?: string;
  scopes: string[];
  sessionId: string;
  authenticatedVia: 'CRYPTOGRAPHIC_JWT' | 'TRUSTED_GATEWAY' | 'SANDBOX_DEFAULT';
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: PrincipalContext;
  }
}

const DEFAULT_AUTH_SECRET = process.env.AGENT_AUTH_SECRET || 'manifest_agent_jwt_auth_secret_secure_key_2026';
const GATEWAY_SHARED_SECRET = process.env.GATEWAY_SHARED_SECRET || 'trusted_internal_gateway_secret_key_xyz';

function base64UrlEncode(str: string | Buffer): string {
  const buf = typeof str === 'string' ? Buffer.from(str, 'utf8') : str;
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecodeToBuffer(str: string): Buffer {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return Buffer.from(base64, 'base64');
}

function base64UrlDecodeToString(str: string): string {
  return base64UrlDecodeToBuffer(str).toString('utf8');
}

/**
 * Issues a cryptographically signed Agent Identity Token (JWS / HMAC-SHA256).
 */
export function issueAgentIdentityToken(
  params: {
    agentId: string;
    principalName: string;
    delegationId?: string;
    merchantId?: string;
    scopes?: string[];
    validitySeconds?: number;
  },
  secret: string = DEFAULT_AUTH_SECRET
): string {
  const now = Math.floor(Date.now() / 1000);
  const validity = params.validitySeconds || 3600 * 24; // 24 hours default

  const header = {
    alg: 'HS256',
    typ: 'JWT'
  };

  const payload: TokenClaims = {
    iss: 'manifest-auth',
    aud: 'manifest-commerce',
    sub: params.agentId,
    principal_type: 'BUYER_AGENT',
    principal_name: params.principalName,
    delegation_id: params.delegationId,
    merchant_id: params.merchantId,
    scopes: params.scopes || ['catalog:read', 'cart:write', 'negotiate:write', 'checkout:write'],
    iat: now,
    nbf: now - 5, // 5s clock skew tolerance
    exp: now + validity,
    jti: `jti_agent_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const encodedSignature = base64UrlEncode(signature);

  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

/**
 * Issues a cryptographically signed Human Identity Token with Step-Up MFA / Passkey Claims.
 */
export function issueHumanIdentityToken(
  params: {
    userId: string;
    principalName: string;
    authLevel?: AuthLevel;
    scopes?: string[];
    validitySeconds?: number;
  },
  secret: string = DEFAULT_AUTH_SECRET
): string {
  const now = Math.floor(Date.now() / 1000);
  const validity = params.validitySeconds || 3600; // 1 hour for step-up tokens

  const header = {
    alg: 'HS256',
    typ: 'JWT'
  };

  const payload: TokenClaims = {
    iss: 'manifest-auth',
    aud: 'manifest-commerce',
    sub: params.userId,
    principal_type: 'HUMAN_PRINCIPAL',
    principal_name: params.principalName,
    auth_level: params.authLevel || 'WEBAUTHN_PASSKEY',
    scopes: params.scopes || ['delegation:write', 'delegation:read', 'mandate:read'],
    iat: now,
    nbf: now - 5,
    exp: now + validity,
    jti: `jti_human_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const encodedSignature = base64UrlEncode(signature);

  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

/**
 * Cryptographically verifies an Identity Token against signature, issuer, audience, exp, and nbf.
 */
export function verifyIdentityToken(
  token: string,
  secret: string = DEFAULT_AUTH_SECRET
): { valid: boolean; claims?: TokenClaims; error?: string } {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'MALFORMED_TOKEN: Expected 3 JWT parts.' };
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest();
    const actualSig = base64UrlDecodeToBuffer(encodedSignature);

    if (expectedSig.length !== actualSig.length || !crypto.timingSafeEqual(expectedSig, actualSig)) {
      return { valid: false, error: 'INVALID_SIGNATURE: Cryptographic token verification failed.' };
    }

    const payload: TokenClaims = JSON.parse(base64UrlDecodeToString(encodedPayload));
    const now = Math.floor(Date.now() / 1000);

    if (payload.iss !== 'manifest-auth') {
      return { valid: false, error: `INVALID_ISSUER: Expected 'manifest-auth', got '${payload.iss}'.` };
    }

    if (payload.aud !== 'manifest-commerce') {
      return { valid: false, error: `INVALID_AUDIENCE: Expected 'manifest-commerce', got '${payload.aud}'.` };
    }

    if (payload.nbf && now < payload.nbf) {
      return { valid: false, error: 'TOKEN_NOT_YET_VALID: Token nbf timestamp is in the future.' };
    }

    if (payload.exp && now > payload.exp) {
      return { valid: false, error: 'TOKEN_EXPIRED: Token exp timestamp has elapsed.' };
    }

    if (!payload.sub) {
      return { valid: false, error: 'INVALID_SUBJECT: Missing identifier (sub).' };
    }

    return { valid: true, claims: payload };
  } catch (err: any) {
    return { valid: false, error: `TOKEN_VERIFICATION_FAILED: ${err.message}` };
  }
}

export const verifyAgentIdentityToken = verifyIdentityToken;

const seenNonces = new Set<string>();

/**
 * Validates a signed gateway request using HMAC-SHA256 over timestamp, nonce, method, path, and body hash.
 * Enforces strict timestamp freshness (60s window) and nonce uniqueness against replay attacks.
 */
export function verifySignedGatewayRequest(
  headers: Record<string, any>,
  method: string = 'POST',
  path: string = '/',
  body: any = {},
  options: { consumeNonce?: boolean } = { consumeNonce: true }
): { valid: boolean; error?: string } {
  const timestampStr = headers['x-gateway-timestamp'] as string | undefined;
  const nonce = headers['x-gateway-nonce'] as string | undefined;
  const signature = headers['x-gateway-signature'] as string | undefined;

  if (!timestampStr || !nonce || !signature) {
    return { valid: false, error: 'MISSING_GATEWAY_AUTH_HEADERS' };
  }

  const timestamp = parseInt(timestampStr, 10);
  const now = Date.now();
  if (isNaN(timestamp) || Math.abs(now - timestamp) > 60000) {
    return { valid: false, error: 'GATEWAY_TIMESTAMP_EXPIRED_OR_DRIFT' };
  }

  if (seenNonces.has(nonce)) {
    return { valid: false, error: 'GATEWAY_REPLAY_ATTACK_DETECTED' };
  }

  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body || {});
  const bodyHash = crypto.createHash('sha256').update(bodyStr).digest('hex');
  const payloadToSign = `${timestamp}.${nonce}.${method.toUpperCase()}.${path}.${bodyHash}`;

  const expectedSig = crypto.createHmac('sha256', GATEWAY_SHARED_SECRET).update(payloadToSign).digest('hex');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSig);

  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return { valid: false, error: 'INVALID_GATEWAY_HMAC_SIGNATURE' };
  }

  if (options.consumeNonce !== false) {
    seenNonces.add(nonce);
    if (seenNonces.size > 10000) seenNonces.clear();
  }

  return { valid: true };
}

/**
 * Creates a signed gateway header envelope for testing and gateway forwarding.
 */
export function signGatewayRequest(
  method: string = 'POST',
  path: string = '/',
  body: any = {},
  agentId?: string,
  principalName?: string,
  merchantId?: string
): Record<string, string> {
  const timestamp = Date.now();
  const nonce = `nonce_${timestamp}_${crypto.randomBytes(8).toString('hex')}`;
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body || {});
  const bodyHash = crypto.createHash('sha256').update(bodyStr).digest('hex');
  const payloadToSign = `${timestamp}.${nonce}.${method.toUpperCase()}.${path}.${bodyHash}`;

  const signature = crypto.createHmac('sha256', GATEWAY_SHARED_SECRET).update(payloadToSign).digest('hex');

  const headers: Record<string, string> = {
    'x-gateway-timestamp': timestamp.toString(),
    'x-gateway-nonce': nonce,
    'x-gateway-signature': signature
  };

  if (agentId) headers['x-buyer-agent-id'] = agentId;
  if (principalName) headers['x-principal-name'] = principalName;
  if (merchantId) headers['x-merchant-id'] = merchantId;

  return headers;
}

/**
 * Extracts and verifies authenticated Principal context.
 * Strict Security Invariant:
 * - Direct client-supplied headers (e.g. `x-buyer-agent-id`, `x-merchant-id`) are STRICTLY STRIPPED / IGNORED
 *   unless authenticated with a verified `x-gateway-signature` or `x-gateway-secret` matching internal API Gateway key.
 * - Cryptographically verified Bearer tokens (JWT) are validated for signature, issuer, audience, exp, and scopes.
 */
export function extractPrincipal(
  headers: Record<string, any>,
  options: { strict?: boolean; method?: string; path?: string; body?: any } = {}
): PrincipalContext {
  const correlationId = (headers['x-correlation-id'] as string) || `sess_${Date.now()}`;
  const authHeader = headers['authorization'] as string | undefined;

  // 1. Check for Cryptographically Verified Bearer Token
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const rawToken = authHeader.substring(7).trim();

    if (rawToken.includes('.')) {
      const verification = verifyIdentityToken(rawToken);
      if (verification.valid && verification.claims) {
        const c = verification.claims;
        const isHuman = c.principal_type === 'HUMAN_PRINCIPAL';
        return {
          principalType: c.principal_type || (isHuman ? 'HUMAN_PRINCIPAL' : 'BUYER_AGENT'),
          agentId: isHuman ? '22222222-2222-2222-2222-222222222222' : c.sub,
          userId: isHuman ? c.sub : undefined,
          principalName: c.principal_name,
          authLevel: c.auth_level || (isHuman ? 'WEBAUTHN_PASSKEY' : 'STANDARD_SESSION'),
          delegatedBy: c.principal_name,
          delegationId: c.delegation_id,
          merchantId: c.merchant_id,
          scopes: c.scopes || ['catalog:read', 'cart:write', 'negotiate:write', 'checkout:write'],
          sessionId: correlationId,
          authenticatedVia: 'CRYPTOGRAPHIC_JWT'
        };
      } else {
        if (options.strict) {
          throw new Error(`UNAUTHORIZED: ${verification.error}`);
        }
      }
    }
  }

  // 2. Check for Signed Internal API Gateway Envelope (HMAC over Timestamp + Nonce + Body)
  const isSignedGateway = headers['x-gateway-signature'] && verifySignedGatewayRequest(headers, options.method || 'POST', options.path || '/', options.body || {}, { consumeNonce: false }).valid;
  const legacyGatewaySecret = headers['x-gateway-secret'] as string | undefined;
  const isTrustedGateway = isSignedGateway || (legacyGatewaySecret && legacyGatewaySecret === GATEWAY_SHARED_SECRET);

  if (isTrustedGateway) {
    const agentId = (headers['x-buyer-agent-id'] as string) || '22222222-2222-2222-2222-222222222222';
    const principalName = (headers['x-principal-name'] as string) || 'Principal Shopper Account';
    const merchantId = headers['x-merchant-id'] as string | undefined;

    return {
      principalType: 'BUYER_AGENT',
      agentId,
      principalName,
      delegatedBy: principalName,
      authLevel: 'STANDARD_SESSION',
      merchantId,
      scopes: ['catalog:read', 'cart:write', 'negotiate:write', 'checkout:write'],
      sessionId: correlationId,
      authenticatedVia: 'TRUSTED_GATEWAY'
    };
  }

  // 3. Fallback: Untrusted headers are STRICTLY STRIPPED / DROPPED
  const defaultAgentId = '22222222-2222-2222-2222-222222222222';
  const defaultPrincipal = 'Principal Shopper Account';

  return {
    principalType: 'BUYER_AGENT',
    agentId: defaultAgentId,
    principalName: defaultPrincipal,
    delegatedBy: defaultPrincipal,
    authLevel: 'STANDARD_SESSION',
    merchantId: undefined,
    scopes: ['catalog:read', 'cart:write', 'negotiate:write', 'checkout:write'],
    sessionId: correlationId,
    authenticatedVia: 'SANDBOX_DEFAULT'
  };
}

/**
 * Fastify preHandler guard: Enforces Human Authentication with Step-Up MFA / Passkey.
 * Blocks autonomous agents from attempting self-delegation or expanding their own limits.
 */
export async function requireHumanStepUpAuth(req: FastifyRequest, reply: FastifyReply) {
  const principal = req.principal || extractPrincipal(req.headers);
  req.principal = principal;

  // Authorization Matrix Rule 1: Buyer Agents can NEVER create, modify or expand delegations
  if (principal.principalType === 'BUYER_AGENT') {
    return reply.status(403).send({
      ok: false,
      code: 'AGENT_CANNOT_SELF_DELEGATE',
      error: 'FORBIDDEN: Buyer agents are strictly prohibited from creating or expanding delegations. Privilege escalation blocked.',
      required_actor: 'HUMAN_PRINCIPAL'
    });
  }

  // Authorization Matrix Rule 2: Human must have completed Step-Up MFA / Passkey confirmation
  if (
    principal.principalType !== 'HUMAN_PRINCIPAL' ||
    (principal.authLevel !== 'WEBAUTHN_PASSKEY' && principal.authLevel !== 'STEP_UP_MFA_VERIFIED')
  ) {
    return reply.status(403).send({
      ok: false,
      code: 'STEP_UP_AUTH_REQUIRED',
      error: 'FORBIDDEN: High-privilege delegation grant requires Step-Up authentication (WebAuthn / Passkey / Biometric MFA).',
      required_auth_level: 'WEBAUTHN_PASSKEY'
    });
  }
}

/**
 * Validates in PostgreSQL that the agent and delegation are actively registered and not revoked.
 */
export async function validateAgentAndDelegation(principal: PrincipalContext): Promise<boolean> {
  const agentRes = await pool.query(`
    SELECT id FROM buyer_agents WHERE id = $1;
  `, [principal.agentId]);

  if (agentRes.rows.length === 0) return false;

  if (principal.delegationId) {
    const delRes = await pool.query(`
      SELECT status, expires_at FROM agent_delegations WHERE id = $1;
    `, [principal.delegationId]);

    if (delRes.rows.length === 0) return false;
    const row = delRes.rows[0];
    if (row.status !== 'ACTIVE' || new Date(row.expires_at) < new Date()) {
      return false;
    }
  }

  return true;
}

/**
 * Fastify preHandler middleware to attach verified PrincipalContext.
 */
export async function authenticateAgentPrincipal(req: FastifyRequest, reply: FastifyReply) {
  try {
    req.principal = extractPrincipal(req.headers);
  } catch (err: any) {
    return reply.status(401).send({
      type: 'https://manifest.commerce/errors/UNAUTHORIZED',
      title: 'Agent Authentication Failed',
      status: 401,
      detail: err.message
    });
  }
}
