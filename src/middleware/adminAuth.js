import crypto from 'node:crypto';
import { env } from '../config/env.js';

export const SESSION_COOKIE = 'vidia_admin_session';
const SESSION_MAX_AGE_SEC = 12 * 60 * 60;

/** @type {Map<string, number>} */
const sessions = new Map();

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
 * @param {import('express').Response} res
 */
export function setAdminSessionCookie(res) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_MAX_AGE_SEC * 1000);

  const secure = env.isProduction ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SEC}${secure}`,
  );
}

/**
 * @param {import('express').Response} res
 */
export function clearAdminSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
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
 * @param {string | undefined} token
 */
function isValidSession(token) {
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (!expiresAt || Date.now() > expiresAt) {
    sessions.delete(token ?? '');
    return false;
  }
  return true;
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
