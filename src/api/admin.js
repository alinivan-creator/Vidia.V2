import { Router } from 'express';
import {
  clearAdminSessionCookie,
  requireAdminAuth,
  setAdminSessionCookie,
  verifyAdminPassword,
} from '../middleware/adminAuth.js';
import {
  deleteBusinessAdmin,
  getBusinessJournalAdmin,
  getErrorLogsAdmin,
  listAllBusinessesAdmin,
  resolveErrorLog,
  setBusinessStatusAdmin,
  upsertBusinessAdmin,
} from '../db/adminService.js';
import {
  getGoogleMasterSettings,
  maskGoogleMasterSettings,
  updateGoogleMasterSettings,
} from '../db/systemSettingsService.js';
import {
  listEmployees,
  upsertEmployeeAdmin,
  deleteEmployeeAdmin,
} from '../db/employeeService.js';
import {
  listCallbackRequestsAdmin,
  updateCallbackRequestStatus,
} from '../db/callbackRequestService.js';
import { getBusinessById } from '../db/businessService.js';
import { invalidateGoogleAccessToken } from '../services/googleCalendarService.js';
import {
  sendSmsCampaign,
  listSmsOptedInClients,
} from '../services/smsMarketingService.js';
import { logError } from '../db/loggerService.js';
import { DEFAULT_SYSTEM_PROMPT } from '../config/defaultSystemPrompt.js';
import { DEFAULT_CONVERSATION_LOGIC } from '../config/conversationConfig.js';

export const adminRouter = Router();

adminRouter.post('/login', (req, res) => {
  const password = String(req.body?.password ?? '');

  if (!verifyAdminPassword(password)) {
    return res.status(401).json({ error: 'Parolă incorectă' });
  }

  setAdminSessionCookie(res);
  return res.json({ ok: true });
});

adminRouter.post('/logout', (_req, res) => {
  clearAdminSessionCookie(res);
  res.json({ ok: true });
});

adminRouter.use(requireAdminAuth);

adminRouter.get('/ai-defaults', (_req, res) => {
  res.json({
    system_prompt: DEFAULT_SYSTEM_PROMPT,
    conversation_logic: DEFAULT_CONVERSATION_LOGIC,
  });
});

adminRouter.get('/businesses', async (_req, res) => {
  const businesses = await listAllBusinessesAdmin();
  res.json({ businesses });
});

adminRouter.post('/businesses', async (req, res) => {
  try {
    const { business, error } = await upsertBusinessAdmin(req.body ?? {});

    if (error) {
      return res.status(400).json({ error });
    }

    res.status(business?.id && req.body?.id ? 200 : 201).json({ business });
  } catch (error) {
    await logError({
      message: 'POST /admin/businesses failed',
      source: 'system',
      severity: 'error',
      error,
    });
    res.status(500).json({ error: 'Eroare server' });
  }
});

adminRouter.patch('/businesses/:id/status', async (req, res) => {
  try {
    const status = req.body?.status === 'paused' ? 'paused' : 'active';
    const { business, error } = await setBusinessStatusAdmin(req.params.id, status);
    if (error) return res.status(400).json({ error });
    res.json({ business });
  } catch (error) {
    await logError({
      message: 'PATCH /admin/businesses/:id/status failed',
      source: 'system',
      severity: 'error',
      error,
    });
    res.status(500).json({ error: 'Eroare server' });
  }
});

adminRouter.delete('/businesses/:id', async (req, res) => {
  try {
    const { ok, error } = await deleteBusinessAdmin(req.params.id);
    if (!ok) return res.status(400).json({ error: error || 'Ștergere eșuată' });
    res.json({ ok: true });
  } catch (error) {
    await logError({
      message: 'DELETE /admin/businesses/:id failed',
      source: 'system',
      severity: 'error',
      error,
    });
    res.status(500).json({ error: 'Eroare server' });
  }
});

adminRouter.get('/system-settings/google-master', async (_req, res) => {
  const settings = await getGoogleMasterSettings(true);
  res.json({ settings: maskGoogleMasterSettings(settings) });
});

adminRouter.put('/system-settings/google-master', async (req, res) => {
  try {
    const { settings, error } = await updateGoogleMasterSettings(req.body ?? {});
    if (error) return res.status(400).json({ error });
    invalidateGoogleAccessToken('master');
    res.json({ settings });
  } catch (error) {
    await logError({
      message: 'PUT /admin/system-settings/google-master failed',
      source: 'system',
      severity: 'error',
      error,
    });
    res.status(500).json({ error: 'Eroare server' });
  }
});

adminRouter.get('/logs', async (req, res) => {
  const businessId = typeof req.query.business_id === 'string' ? req.query.business_id : null;
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const unresolvedOnly = req.query.unresolved === 'true';
  const severity = typeof req.query.severity === 'string' && req.query.severity
    ? req.query.severity
    : null;
  const source = typeof req.query.source === 'string' && req.query.source
    ? req.query.source
    : null;

  const logs = await getErrorLogsAdmin({
    businessId,
    limit,
    unresolvedOnly,
    severity,
    source,
  });
  res.json({ logs });
});

adminRouter.patch('/logs/:id/resolve', async (req, res) => {
  const ok = await resolveErrorLog(req.params.id);
  if (!ok) {
    return res.status(400).json({ error: 'Nu s-a putut marca log-ul ca rezolvat' });
  }
  res.json({ ok: true });
});

/** Per-business journal: errors + callbacks + bookings + SMS */
adminRouter.get('/businesses/:id/journal', async (req, res) => {
  try {
    const journal = await getBusinessJournalAdmin(req.params.id, {
      limit: Number(req.query.limit ?? 40),
    });
    res.json(journal);
  } catch (error) {
    await logError({
      message: 'GET /admin/businesses/:id/journal failed',
      source: 'system',
      severity: 'error',
      businessId: req.params.id,
      error,
    });
    res.status(500).json({ error: 'Eroare server' });
  }
});

adminRouter.get('/businesses/:id/callbacks', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const callbacks = await listCallbackRequestsAdmin(req.params.id, {
    status,
    limit: Number(req.query.limit ?? 50),
  });
  res.json({ callbacks });
});

adminRouter.patch('/businesses/:id/callbacks/:callbackId', async (req, res) => {
  try {
    const status = String(req.body?.status ?? '');
    const { callback, error } = await updateCallbackRequestStatus({
      businessId: req.params.id,
      callbackId: req.params.callbackId,
      status: /** @type {'pending' | 'contacted' | 'closed'} */ (status),
    });
    if (error) return res.status(400).json({ error });
    res.json({ callback });
  } catch (error) {
    await logError({
      message: 'PATCH /admin/businesses/:id/callbacks/:callbackId failed',
      source: 'system',
      severity: 'error',
      businessId: req.params.id,
      error,
    });
    res.status(500).json({ error: 'Eroare server' });
  }
});

// --- Employees (multi-calendar) ---
adminRouter.get('/businesses/:id/employees', async (req, res) => {
  const employees = await listEmployees(req.params.id, { activeOnly: false });
  res.json({ employees });
});

adminRouter.post('/businesses/:id/employees', async (req, res) => {
  try {
    const { employee, error } = await upsertEmployeeAdmin({
      ...(req.body ?? {}),
      business_id: req.params.id,
    });
    if (error) return res.status(400).json({ error });
    res.status(req.body?.id ? 200 : 201).json({ employee });
  } catch (error) {
    await logError({
      message: 'POST /admin/businesses/:id/employees failed',
      source: 'system',
      severity: 'error',
      error,
    });
    res.status(500).json({ error: 'Eroare server' });
  }
});

adminRouter.delete('/businesses/:id/employees/:employeeId', async (req, res) => {
  const { ok, error } = await deleteEmployeeAdmin(req.params.id, req.params.employeeId);
  if (!ok) return res.status(400).json({ error: error || 'Ștergere eșuată' });
  res.json({ ok: true });
});

// --- SMS Marketing ---
adminRouter.get('/businesses/:id/sms-opted-in', async (req, res) => {
  const clients = await listSmsOptedInClients(req.params.id);
  res.json({ clients, count: clients.length });
});

adminRouter.post('/businesses/:id/sms-campaigns', async (req, res) => {
  try {
    const business = await getBusinessById(req.params.id);
    if (!business) return res.status(404).json({ error: 'Afacere inexistentă' });

    const body = String(req.body?.body ?? '').trim();
    const clientIds = Array.isArray(req.body?.client_ids) ? req.body.client_ids : null;
    const phones = req.body?.phones ?? req.body?.recipients ?? null;

    const result = await sendSmsCampaign({
      business,
      body,
      phones,
      clientIds,
      createdBy: 'admin',
    });

    res.status(result.ok ? 201 : 200).json(result);
  } catch (error) {
    await logError({
      message: 'POST /admin/businesses/:id/sms-campaigns failed',
      source: 'system',
      severity: 'error',
      error,
    });
    res.status(500).json({ error: 'Eroare server' });
  }
});

adminRouter.get('/session', (_req, res) => {
  res.json({ authenticated: true });
});
