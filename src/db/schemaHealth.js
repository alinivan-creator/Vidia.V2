import { supabase } from '../config/supabase.js';
import { logError } from './loggerService.js';
import {
  classifyDbError,
  isMissingTableError,
  USER_DEGRADED_REPLY,
} from './schemaErrors.js';

export { isMissingTableError, USER_DEGRADED_REPLY };

const PROBE_RETRY_MS = 30_000;
const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * @typedef {Object} TableSpec
 * @property {string} module
 * @property {boolean} critical
 * @property {string} label
 * @property {string} [migration]
 * @property {boolean} [optional]
 */

/** @type {Record<string, TableSpec>} */
export const TABLE_SPECS = {
  businesses: { module: 'businesses', critical: true, label: 'Afaceri' },
  services: { module: 'services', critical: false, label: 'Servicii', migration: '003_services_and_twilio_fields.sql' },
  employees: { module: 'employees', critical: false, label: 'Angajați', migration: '012_ensure_employees.sql' },
  draft_bookings: { module: 'appointments', critical: true, label: 'Programări' },
  appointments: { module: 'appointments', critical: false, label: 'View programări', optional: true },
  clients: { module: 'clients', critical: true, label: 'Clienți' },
  conversation_states: { module: 'conversations', critical: false, label: 'Sesiuni', migration: '005_conversation_states.sql' },
  callback_requests: { module: 'callbacks', critical: false, label: 'Callback-uri', migration: '008_callback_requests.sql' },
  sms_campaigns: { module: 'sms', critical: false, label: 'SMS', migration: '010_employees_and_sms.sql' },
  error_logs: { module: 'errors', critical: true, label: 'Jurnale erori' },
  calendar_cache: { module: 'calendar', critical: false, label: 'Cache calendar' },
  system_settings: { module: 'settings', critical: false, label: 'Setări sistem' },
};

/** Tables required by the Admin / WhatsApp health banner. */
export const STARTUP_TABLES = ['employees', 'businesses', 'services', 'appointments', 'draft_bookings'];

/** @type {Map<string, { status: 'ok' | 'missing' | 'error'; until: number; message?: string }>} */
const probeCache = new Map();

/** @type {Map<string, number>} */
const alertCooldown = new Map();

/**
 * @param {string} table
 * @returns {Promise<'ok' | 'missing' | 'error'>}
 */
export async function probeTable(table) {
  const cached = probeCache.get(table);
  if (cached && Date.now() < cached.until && cached.status === 'ok') {
    return 'ok';
  }
  if (cached && cached.status !== 'ok' && Date.now() < cached.until) {
    return cached.status;
  }

  try {
    const { error } = await supabase.from(table).select('*').limit(1);
    if (!error) {
      probeCache.set(table, { status: 'ok', until: Date.now() + PROBE_RETRY_MS });
      return 'ok';
    }
    if (isMissingTableError(error)) {
      probeCache.set(table, {
        status: 'missing',
        until: Date.now() + PROBE_RETRY_MS,
        message: error.message,
      });
      return 'missing';
    }
    probeCache.set(table, {
      status: 'error',
      until: Date.now() + 10_000,
      message: error.message,
    });
    return 'error';
  } catch (error) {
    probeCache.set(table, {
      status: 'error',
      until: Date.now() + 10_000,
      message: error instanceof Error ? error.message : String(error),
    });
    return 'error';
  }
}

/**
 * @param {string} table
 * @returns {Promise<boolean>}
 */
export async function isTableAvailable(table) {
  const status = await probeTable(table);
  return status === 'ok' || status === 'error';
}

/**
 * @param {string} module
 * @returns {Promise<boolean>}
 */
export async function isModuleEnabled(module) {
  const required = Object.entries(TABLE_SPECS)
    .filter(([, spec]) => spec.module === module && spec.critical && !spec.optional)
    .map(([name]) => name);

  const optionalOnly = Object.entries(TABLE_SPECS)
    .filter(([, spec]) => spec.module === module && !spec.optional)
    .map(([name]) => name);

  const tables = required.length ? required : optionalOnly;
  if (!tables.length) return true;

  for (const table of tables) {
    if ((await probeTable(table)) === 'missing') return false;
  }
  return true;
}

/**
 * @param {string} [table]
 */
export function invalidateSchemaHealth(table) {
  if (table) {
    probeCache.delete(table);
    return;
  }
  probeCache.clear();
}

/**
 * @param {string} table
 */
export function markTableMissing(table) {
  probeCache.set(table, { status: 'missing', until: Date.now() + PROBE_RETRY_MS });
}

/**
 * @param {Object} input
 * @param {string} input.key
 * @param {string} input.message
 * @param {import('./loggerService.js').ErrorSource} [input.source]
 * @param {import('./loggerService.js').ErrorSeverity} [input.severity]
 * @param {string | null} [input.businessId]
 * @param {Record<string, unknown>} [input.details]
 * @param {unknown} [input.error]
 */
export async function persistAlertOnce({
  key,
  message,
  source = 'database',
  severity = 'error',
  businessId = null,
  details = {},
  error = null,
}) {
  const prev = alertCooldown.get(key) ?? 0;
  if (Date.now() - prev < ALERT_COOLDOWN_MS) return;
  alertCooldown.set(key, Date.now());

  console.error(`[schema-health] ${message}`);
  await logError({
    message,
    source,
    severity,
    businessId,
    error,
    details: {
      ...details,
      alert: true,
      dedupeKey: key,
    },
  });
}

/**
 * @param {Object} input
 * @param {string} [input.table]
 * @param {unknown} input.error
 * @param {string} [input.op]
 * @param {string | null} [input.businessId]
 * @param {boolean} [input.critical]
 */
export async function reportQueryFailure({
  table = '',
  error,
  op = 'query',
  businessId = null,
  critical = false,
}) {
  const classified = classifyDbError(error, { table });
  if (classified) {
    markTableMissing(classified.table || table);
    await persistAlertOnce({
      key: `${classified.kind}:${classified.table || table}`,
      message: classified.adminMessage,
      source: 'database',
      severity: critical ? 'critical' : 'error',
      businessId,
      error,
      details: {
        alertKind: classified.kind,
        table: classified.table,
        hint: classified.hint,
        op,
      },
    });
    return classified;
  }

  const fallbackMessage = `Eroare: Interogare eșuată — ${op}${table ? ` (${table})` : ''}`;
  await persistAlertOnce({
    key: `query_failed:${op}:${table}`,
    message: fallbackMessage,
    source: 'database',
    severity: 'error',
    businessId,
    error,
    details: { alertKind: 'query_failed', table, op },
  });
  return null;
}

/**
 * @param {Object} input
 * @param {string | null} [input.businessId]
 * @param {string | null} [input.employeeId]
 * @param {string} [input.op]
 */
export async function reportCalendarConfigMissing({
  businessId = null,
  employeeId = null,
  op = 'createCalendarEvent',
}) {
  await persistAlertOnce({
    key: `calendar_config:${businessId || 'system'}:${employeeId || 'business'}`,
    message: 'Eroare: Configurare calendar absentă — lipsește google_calendar_id',
    source: 'google_calendar',
    severity: 'error',
    businessId,
    details: {
      alertKind: 'calendar_config',
      hint: 'Setează google_calendar_id pe afacere sau pe angajat (Admin → Angajați).',
      op,
      employeeId,
    },
  });
}

/**
 * @param {{ persist?: boolean }} [opts]
 */
export async function runStartupHealthCheck(opts = {}) {
  const persist = opts.persist !== false;
  /** @type {Record<string, { status: string; module: string; critical: boolean; message?: string }>} */
  const tables = {};
  /** @type {Array<{ kind: string; table: string; message: string; hint: string; module: string }>} */
  const alerts = [];

  for (const name of STARTUP_TABLES) {
    const spec = TABLE_SPECS[name] || { module: name, critical: false, label: name };
    const status = await probeTable(name);
    const cached = probeCache.get(name);
    tables[name] = {
      status,
      module: spec.module,
      critical: Boolean(spec.critical),
      message: cached?.message,
    };

    if (status === 'missing') {
      const classified = classifyDbError(
        { code: 'PGRST205', message: `Could not find the table 'public.${name}' in the schema cache` },
        { table: name },
      );
      const message = classified?.adminMessage || `Eroare: Tabelă lipsă — public.${name}`;
      const hint = classified?.hint
        || (spec.migration ? `Rulează supabase/migrations/${spec.migration}` : 'Rulează SAFE_REAPPLY_ALL.sql');
      alerts.push({
        kind: classified?.kind || 'missing_table',
        table: name,
        message,
        hint,
        module: spec.module,
      });
      console.error(`[schema-health] Modulul "${spec.module}" este dezactivat: ${message}`);
      if (persist) {
        await persistAlertOnce({
          key: `startup:${name}`,
          message,
          source: 'database',
          severity: spec.critical ? 'critical' : 'error',
          details: { alertKind: classified?.kind || 'missing_table', table: name, hint, op: 'startup_health_check' },
        });
      }
    } else {
      console.log(`[schema-health] ${name}: ${status}`);
    }
  }

  const degraded = alerts.length > 0;
  return {
    status: degraded ? 'degraded' : 'ok',
    checkedAt: new Date().toISOString(),
    tables,
    alerts,
    summary: degraded
      ? `${alerts.length} tabele lipsă — modulele afectate rulează în degradare`
      : 'Toate tabelele critice sunt disponibile',
  };
}

/**
 * Full snapshot for Admin banner (all known tables, not only startup set).
 */
export async function getSchemaHealthSnapshot() {
  /** @type {Record<string, { ok: boolean; tables: Record<string, string>; message?: string }>} */
  const modules = {};
  /** @type {Array<{ kind: string; table: string; message: string; hint: string; module: string }>} */
  const alerts = [];

  for (const [name, spec] of Object.entries(TABLE_SPECS)) {
    const status = await probeTable(name);
    if (!modules[spec.module]) {
      modules[spec.module] = { ok: true, tables: {} };
    }
    modules[spec.module].tables[name] = status;
    if (status === 'missing' && !spec.optional) {
      modules[spec.module].ok = false;
      const message = `Eroare: Tabelă lipsă — public.${name}`;
      const hint = spec.migration
        ? `Rulează supabase/migrations/${spec.migration} în SQL Editor.`
        : 'Rulează supabase/SAFE_REAPPLY_ALL.sql în SQL Editor.';
      modules[spec.module].message = message;
      alerts.push({ kind: 'missing_table', table: name, message, hint, module: spec.module });
    }
  }

  return {
    status: alerts.length ? 'degraded' : 'ok',
    checkedAt: new Date().toISOString(),
    modules,
    alerts,
  };
}

/**
 * Ask PostgREST to reload its schema cache, then re-probe local module flags.
 * @returns {Promise<{ ok: boolean; rpc: boolean; message: string; health: Awaited<ReturnType<typeof getSchemaHealthSnapshot>> }>}
 */
export async function refreshSchemaCache() {
  invalidateSchemaHealth();

  let rpc = false;
  let rpcMessage = '';
  try {
    const { data, error } = await supabase.rpc('refresh_postgrest_schema');
    if (!error) {
      rpc = true;
      rpcMessage = typeof data === 'string' ? data : 'ok';
    } else {
      rpcMessage = error.message;
    }
  } catch (error) {
    rpcMessage = error instanceof Error ? error.message : String(error);
  }

  invalidateSchemaHealth();
  const health = await getSchemaHealthSnapshot();

  return {
    ok: health.status === 'ok',
    rpc,
    message: rpc
      ? 'Schema PostgREST a fost reîmprospătată.'
      : `RPC indisponibil (${rpcMessage}). Rulează NOTIFY pgrst, 'reload schema'; în SQL Editor, apoi reîncearcă.`,
    health,
  };
}
