import crypto from 'node:crypto';
import { env } from '../config/env.js';

export const SESSION_COOKIE = 'vidia_admin_session';
const SESSION_MAX_AGE_SEC = 12 * 60 * 60;

/**
 * Signed cookies work across Vercel serverless isolates.
 * In-memory Maps do not — they caused instant logout on Edit.
 * @returns {string}
 */
function sessionSecret() {
  return env.adminPassword || 'vidia-admin-dev-secret';
}

/**
 * @returns {string} `expiryMs.hmac`
 */
function createSessionToken() {
  const payload = String(Date.now() + SESSION_MAX_AGE_SEC * 1000);
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

/**
 * @param {string | undefined} header
 * @returns {Record<string, string>}
 */
function parseCookies(header) {
  if (!header) return {};

  return header.split(';').reduce((acc, part) => {
    const [key, ...rest] = part.trim().split('=');
    if (key) acc[key] = decodeURIComponent(rest.join('='));
    return acc;
  }, /** @type {Record<string, string>} */ ({}));
}

/**
 * @param {import('express').Request} req
 * @param {string} name
 */
export function getCookie(req, name) {
  return parseCookies(req.headers.cookie)[name];
}

/**
 * @param {string | undefined} token
 */
function isValidSession(token) {
  if (!token || typeof token !== 'string') return false;
  const sep = token.lastIndexOf('.');
  if (sep < 1) return false;
  const payload = token.slice(0, sep);
  const sig = token.slice(sep + 1);
  if (!/^\d+$/.test(payload) || !/^[a-f0-9]{64}$/i.test(sig)) return false;

  const exp = Number(payload);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;

  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('hex');
  try {
    const a = Buffer.from(sig.toLowerCase(), 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * @param {import('express').Response} res
 */
export function setAdminSessionCookie(res) {
  const token = createSessionToken();
  const secure = env.isProduction || Boolean(process.env.VERCEL) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SEC}${secure}`,
  );
}

/**
 * @param {import('express').Response} res
 */
export function clearAdminSessionCookie(res) {
  const secure = env.isProduction || Boolean(process.env.VERCEL) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
  );
}

/**
 * @param {string} password
 */
export function verifyAdminPassword(password) {
  if (!env.adminPassword) return false;

  const a = Buffer.from(password);
  const b = Buffer.from(env.adminPassword);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requireAdminAuth(req, res, next) {
  const token = getCookie(req, SESSION_COOKIE);
  if (isValidSession(token)) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}
