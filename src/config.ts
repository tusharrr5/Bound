import crypto from 'crypto';
import dotenv from 'dotenv';

// Loaded here, before any module reads process.env, so import order cannot change security settings.
dotenv.config();

/**
 * Security-relevant configuration, validated once. Production fails closed: missing or
 * well-known secrets, or any demo/sandbox/simulation switch, stop the process at startup.
 * Development never falls back to a hardcoded secret: unset secrets get a random per-process
 * value, so tokens from one run are useless in the next.
 */

const KNOWN_PUBLIC_SECRETS = new Set([
  'manifest_agent_jwt_auth_secret_secure_key_2026',
  'trusted_internal_gateway_secret_key_xyz',
  'demo_webhook_secret_abcde',
  'demo_secret_key_12345',
  'your_webhook_secret',
  'your_key_secret'
]);



export class ConfigError extends Error {}

export interface SecurityConfig {
  isProduction: boolean;
  authSecret: string;
  gatewaySecret: string;
  /** Unauthenticated requests act as a fixed demo buyer agent. Never in production. */
  sandboxAuth: boolean;
  /** /v1/demo/*, /v1/arena/* and scripted playbooks are registered. Never in production. */
  demoRoutes: boolean;
  /** Synthetic payment results (simulated autonomous rail, simulated Razorpay adapter). Never in production. */
  simulatedPayments: boolean;
  corsOrigins: string[];
}

function secret(env: NodeJS.ProcessEnv, name: string, isProduction: boolean): string {
  const value = env[name];
  if (value && !KNOWN_PUBLIC_SECRETS.has(value)) {
    if (isProduction && value.length < 32) throw new ConfigError(`${name} must be at least 32 characters in production.`);
    return value;
  }
  if (isProduction) throw new ConfigError(`${name} must be set to a private value in production.`);
  return crypto.randomBytes(32).toString('hex');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const isProduction = env.NODE_ENV === 'production';
  const flag = (name: string) => env[name] === 'true';
  const cfg: SecurityConfig = {
    isProduction,
    authSecret: secret(env, 'AGENT_AUTH_SECRET', isProduction),
    gatewaySecret: secret(env, 'GATEWAY_SHARED_SECRET', isProduction),
    sandboxAuth: flag('BOUND_SANDBOX_AUTH'),
    demoRoutes: flag('BOUND_DEMO_ROUTES'),
    simulatedPayments: flag('BOUND_SIMULATED_PAYMENTS'),
    corsOrigins: (env.BOUND_CORS_ORIGINS || (isProduction ? '' : 'http://localhost:3000,http://localhost:4000'))
      .split(',').map(s => s.trim()).filter(Boolean)
  };
  if (isProduction) {
    const forbidden = (['sandboxAuth', 'demoRoutes', 'simulatedPayments'] as const).filter(k => cfg[k]);
    if (forbidden.length) throw new ConfigError(`Refusing to start in production with ${forbidden.join(', ')} enabled.`);
    if (cfg.corsOrigins.length === 0) throw new ConfigError('BOUND_CORS_ORIGINS must list allowed origins in production.');
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || KNOWN_PUBLIC_SECRETS.has(env.RAZORPAY_KEY_SECRET)) {
      throw new ConfigError('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in production.');
    }
    if (!env.RAZORPAY_WEBHOOK_SECRET || KNOWN_PUBLIC_SECRETS.has(env.RAZORPAY_WEBHOOK_SECRET)) {
      throw new ConfigError('RAZORPAY_WEBHOOK_SECRET must be set to a private value in production.');
    }
  }
  return cfg;
}

export const config: SecurityConfig = loadConfig();

/** What is switched on, without any secret values. Printed at startup. */
export function configReport(cfg: SecurityConfig = config) {
  return {
    environment: cfg.isProduction ? 'production' : 'development',
    authSecret: process.env.AGENT_AUTH_SECRET ? 'configured' : 'random per process (development)',
    gatewaySecret: process.env.GATEWAY_SHARED_SECRET ? 'configured' : 'random per process (development)',
    razorpay: process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET ? 'test/live keys configured' : 'no keys',
    sandboxAuth: cfg.sandboxAuth,
    demoRoutes: cfg.demoRoutes,
    simulatedPayments: cfg.simulatedPayments,
    corsOrigins: cfg.corsOrigins
  };
}
