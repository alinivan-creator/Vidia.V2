import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { env } from './config/env.js';
import { whatsappRouter } from './api/whatsapp.js';
import { googleWebhookRouter } from './api/googleWebhook.js';
import { cronRouter } from './api/cron.js';
import { adminRouter } from './api/admin.js';
import { calendarRouter } from './api/calendar.js';
import { logError, registerProcessErrorHandlers } from './db/loggerService.js';
import { getActiveBusinesses } from './db/businessService.js';
import { runStartupHealthCheck } from './db/schemaHealth.js';
import { runConnectionTest, testSupabaseConnection, printConnectionReport } from './db/testConnection.js';
import {
  globalRateLimiter,
  whatsappWebhookRateLimiter,
  googleWebhookRateLimiter,
  adminLoginRateLimiter,
  adminApiRateLimiter,
} from './middleware/rateLimit.js';

registerProcessErrorHandlers();

const publicDir = path.join(process.cwd(), 'public');

/** All public routes — used by GET /routes (connectivity test). */
export const ROUTE_MAP = [
  { method: 'GET', path: '/health', description: 'Health check' },
  { method: 'GET', path: '/routes', description: 'Route listing (connectivity test)' },
  { method: 'GET', path: '/test/db', description: 'Supabase connection + seed test (disabled in production)' },
  { method: 'GET', path: '/webhook/whatsapp', description: 'Twilio WhatsApp webhook info' },
  { method: 'POST', path: '/webhook/whatsapp', description: 'Twilio WhatsApp inbound (form-urlencoded)' },
  { method: 'POST', path: '/webhook/google/calendar', description: 'Google Calendar push notifications' },
  { method: 'GET', path: '/calendar/event.ics', description: 'Add-to-calendar .ics download (client phones)' },
  { method: 'GET', path: '/cron/expire-pending', description: 'Background: expire pending booking holds (CRON_SECRET)' },
  { method: 'POST', path: '/cron/expire-pending', description: 'Background: expire pending booking holds (CRON_SECRET)' },
  { method: 'GET', path: '/', description: 'Admin dashboard (HTML)' },
  { method: 'POST', path: '/admin/login', description: 'Admin authentication' },
  { method: 'GET', path: '/admin/ai-defaults', description: 'Default AI system prompt for Admin' },
  { method: 'POST', path: '/admin/businesses', description: 'Create/update business (auth required)' },
  { method: 'PATCH', path: '/admin/businesses/:id/status', description: 'Suspend / activate business' },
  { method: 'DELETE', path: '/admin/businesses/:id', description: 'Delete business' },
  { method: 'GET', path: '/admin/system-settings/google-master', description: 'Master Google settings' },
  { method: 'PUT', path: '/admin/system-settings/google-master', description: 'Update Master Google settings' },
  { method: 'GET', path: '/admin/health', description: 'Schema / module health (auth required)' },
  { method: 'POST', path: '/admin/schema/refresh', description: 'Reload PostgREST schema cache' },
  { method: 'GET', path: '/admin/logs', description: 'Error logs (auth required)' },
  { method: 'GET', path: '/admin/businesses/:id/journal', description: 'Per-business errors / activity journal' },
  { method: 'GET', path: '/admin/businesses/:id/callbacks', description: 'Callback request queue' },
  { method: 'PATCH', path: '/admin/businesses/:id/callbacks/:callbackId', description: 'Update callback status' },
  { method: 'GET', path: '/admin/businesses/:id/employees', description: 'List employees' },
  { method: 'POST', path: '/admin/businesses/:id/employees', description: 'Upsert employee' },
  { method: 'DELETE', path: '/admin/businesses/:id/employees/:employeeId', description: 'Delete employee' },
  { method: 'GET', path: '/admin/businesses/:id/sms-opted-in', description: 'SMS opted-in clients' },
  { method: 'POST', path: '/admin/businesses/:id/sms-campaigns', description: 'Send SMS campaign (opt-in only)' },
];

const app = express();

// Cloudflare / reverse proxy — needed for accurate rate-limit IP keys
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(
  cors({
    origin: env.corsOrigins.length > 0 ? env.corsOrigins : true,
  }),
);

app.use(express.json({ limit: '1mb' }));
// Twilio webhooks send application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

app.use(globalRateLimiter);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/health', async (_req, res) => {
  const businesses = await getActiveBusinesses();
  res.json({
    status: 'ok',
    service: 'vidia-v2',
    environment: env.nodeEnv,
    activeBusinesses: businesses.length,
    messagingProvider: 'twilio',
    timestamp: new Date().toISOString(),
  });
});

app.get('/routes', (_req, res) => {
  res.json({
    service: 'vidia-v2',
    routes: ROUTE_MAP,
    timestamp: new Date().toISOString(),
  });
});

app.get('/test/db', async (_req, res) => {
  // Never expose DB probe / seed diagnostics in production
  if (env.isProduction) {
    return res.status(404).json({ error: 'Not found' });
  }
  const result = await testSupabaseConnection();
  printConnectionReport(result);
  res.status(result.status === 'ok' ? 200 : 503).json(result);
});

app.use('/webhook/whatsapp', whatsappWebhookRateLimiter, whatsappRouter);
app.use('/webhook/google', googleWebhookRateLimiter, googleWebhookRouter);
app.use('/calendar', calendarRouter);
app.use('/cron', cronRouter);
app.use('/admin/login', adminLoginRateLimiter);
app.use('/admin', adminApiRateLimiter, adminRouter);

app.use('/assets', express.static(path.join(publicDir, 'assets')));
app.use('/admin.js', express.static(path.join(publicDir, 'admin.js')));
app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ---------------------------------------------------------------------------
// 404 & global error handler
// ---------------------------------------------------------------------------
app.use((req, res) => {
  if (req.path.startsWith('/admin')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).json({ error: 'Not found' });
});

app.use(async (err, req, res, _next) => {
  await logError({
    message: 'Unhandled Express error',
    source: 'system',
    severity: 'critical',
    requestId: req.headers['x-request-id']?.toString() ?? null,
    error: err,
    details: { path: req.path, method: req.method },
  });

  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start (local only — Vercel uses the default export as a Function)
// ---------------------------------------------------------------------------
export default app;

if (!process.env.VERCEL) {
  app.listen(env.port, async () => {
    console.log(`[vidia-v2] Server running on port ${env.port} (${env.nodeEnv})`);
    console.log('[vidia-v2] Routes exposed:');
    for (const route of ROUTE_MAP) {
      console.log(`  ${route.method.padEnd(6)} ${route.path}`);
    }

    try {
      const health = await runStartupHealthCheck({ persist: true });
      console.log(`[schema-health] ${health.summary}`);
    } catch (error) {
      console.error('[schema-health] Startup check failed (server stays up):', error);
    }

    if (!env.isProduction) {
      await runConnectionTest();
    }
  });
}
