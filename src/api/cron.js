import { Router } from 'express';
import crypto from 'node:crypto';
import { runPendingExpiryCron } from '../services/pendingExpiryCron.js';
import { logError } from '../db/loggerService.js';

/**
 * Background jobs (Vercel Cron / external schedulers).
 * Auth: Authorization Bearer CRON_SECRET, or x-cron-secret header.
 */
export const cronRouter = Router();

/**
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isAuthorizedCron(req) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  if (!secret) {
    // Local/dev without secret: allow only on non-production
    return process.env.NODE_ENV !== 'production' && process.env.VERCEL_ENV !== 'production';
  }

  const auth = String(req.headers.authorization || '');
  if (auth === `Bearer ${secret}`) return true;

  const header = String(req.headers['x-cron-secret'] || '').trim();
  if (header && header === secret) return true;

  const query = String(req.query?.secret || '').trim();
  if (query && query === secret) return true;

  return false;
}

async function handleExpirePending(req, res) {
  const requestId = crypto.randomUUID();

  if (!isAuthorizedCron(req)) {
    await logError({
      message: 'Unauthorized cron expire-pending',
      source: 'cron',
      severity: 'warning',
      requestId,
    });
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    const summary = await runPendingExpiryCron({ requestId });
    return res.status(200).json({ ok: true, requestId, ...summary });
  } catch (error) {
    console.error('[cron] expire-pending failed', error);
    await logError({
      message: 'cron expire-pending crashed',
      source: 'cron',
      severity: 'error',
      requestId,
      error,
    });
    return res.status(500).json({ ok: false, requestId, error: 'Cron failed' });
  }
}

cronRouter.get('/expire-pending', handleExpirePending);
cronRouter.post('/expire-pending', handleExpirePending);
