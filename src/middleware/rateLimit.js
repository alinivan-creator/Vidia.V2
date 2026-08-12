import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { env } from '../config/env.js';

/**
 * Standard JSON 429 body for API clients.
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 */
function rateLimitHandler(_req, res) {
  res.status(429).json({
    error: 'Too many requests',
    message: 'Prea multe cereri. Încearcă din nou în câteva momente.',
  });
}

/**
 * Prefer real client IP behind Cloudflare / reverse proxies.
 * @param {import('express').Request} req
 * @returns {string}
 */
function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();

  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim();
  }

  return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

/**
 * @param {import('express').Request} req
 * @param {string} [suffix]
 */
function ipKey(req, suffix = '') {
  const key = ipKeyGenerator(clientIp(req));
  return suffix ? `${key}:${suffix}` : key;
}

/** Global soft limit — all routes */
export const globalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.isProduction ? 120 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKey(req, 'global'),
  handler: rateLimitHandler,
  skip: (req) => req.path === '/health' || req.path === '/routes',
});

/** Admin login — brute-force protection */
export const adminLoginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKey(req, 'admin-login'),
  handler: rateLimitHandler,
});

/** Authenticated admin API */
export const adminApiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.isProduction ? 60 : 180,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKey(req, 'admin-api'),
  handler: rateLimitHandler,
});

/**
 * WhatsApp webhook — limit by IP + Twilio From (phone) to curb floods / prompt spam.
 */
export const whatsappWebhookRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.isProduction ? 40 : 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const from = String(req.body?.From ?? req.query?.From ?? '').trim().toLowerCase();
    const phoneKey = from.replace(/[^\d+]/g, '') || 'unknown';
    return ipKey(req, `wa:${phoneKey}`);
  },
  handler: (req, res) => {
    console.warn('[rate-limit] WhatsApp webhook throttled', {
      ip: clientIp(req),
      from: req.body?.From ?? null,
    });
    res.status(429).type('text/plain').send('Rate limited');
  },
});

/** Google Calendar push notifications */
export const googleWebhookRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKey(req, 'gcal'),
  handler: rateLimitHandler,
});
