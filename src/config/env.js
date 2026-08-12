import dotenv from 'dotenv';

dotenv.config();

/** @typedef {'development' | 'production' | 'test'} NodeEnv */

/**
 * @param {string} key
 * @param {string} [fallback]
 * @returns {string}
 */
function requireEnv(key, fallback) {
  const value = process.env[key] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  if (value.endsWith('...')) {
    throw new Error(
      `${key} pare trunchiat (se termină cu "..."). Copiază cheia completă din Supabase → Project Settings → API.`,
    );
  }
  return value;
}

/**
 * Public origin for webhooks, .ics links, and Google Calendar watch channels.
 * Prefer an explicit URL; on Vercel fall back to the deployment host.
 * @returns {string | null}
 */
function resolvePublicBaseUrl() {
  const explicit = process.env.PUBLIC_WEBHOOK_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');

  const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (productionHost) {
    return `https://${productionHost.replace(/^https?:\/\//, '')}`;
  }

  const deploymentHost = process.env.VERCEL_URL?.trim();
  if (deploymentHost) {
    return `https://${deploymentHost.replace(/^https?:\/\//, '')}`;
  }

  return null;
}

/**
 * Validated environment configuration loaded once at startup.
 * @type {{
 *   port: number;
 *   nodeEnv: NodeEnv;
 *   supabaseUrl: string;
 *   supabaseServiceRoleKey: string;
 *   metaWebhookVerifyToken: string;
 *   adminPassword: string | null;
 *   corsOrigins: string[];
 *   isProduction: boolean;
 *   publicBaseUrl: string | null;
 * }}
 */
export const env = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: /** @type {NodeEnv} */ (process.env.NODE_ENV ?? 'development'),
  supabaseUrl: requireEnv('SUPABASE_URL'),
  supabaseServiceRoleKey: requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  metaWebhookVerifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN ?? 'unused',
  adminPassword: process.env.ADMIN_PASSWORD ?? null,
  // TWILIO_* must be set per business in Supabase — never read from .env here.
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  isProduction: process.env.NODE_ENV === 'production',
  publicBaseUrl: resolvePublicBaseUrl(),
};

if (Number.isNaN(env.port) || env.port <= 0) {
  throw new Error('PORT must be a positive number');
}
