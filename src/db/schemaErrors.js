/**
 * Shared classifiers for PostgREST / Postgres errors.
 * Kept dependency-free so logger + health check can both use them.
 */

const MISSING_TABLE_RE =
  /does not exist|PGRST205|42P01|schema cache|Could not find the table/i;

const TABLE_IN_MESSAGE_RE = /(?:public\.)?([a-z_][a-z0-9_]*)/i;

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isMissingTableError(error) {
  if (!error || typeof error !== 'object') return false;
  const code = /** @type {{ code?: string }} */ (error).code ?? '';
  const message = /** @type {{ message?: string }} */ (error).message ?? '';
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    MISSING_TABLE_RE.test(message)
  );
}

/**
 * @param {unknown} error
 * @param {string} [fallbackTable]
 * @returns {string | null}
 */
export function extractTableName(error, fallbackTable = '') {
  const message = error && typeof error === 'object'
    ? String(/** @type {{ message?: string }} */ (error).message ?? '')
    : '';
  const quoted = message.match(/['"]public\.([a-z_][a-z0-9_]*)['"]/i)
    || message.match(/relation ["']?([a-z_][a-z0-9_]*)["']? does not exist/i)
    || message.match(/table ['"]public\.([a-z_][a-z0-9_]*)['"]/i);
  if (quoted?.[1]) return quoted[1];
  if (fallbackTable) return fallbackTable;
  const loose = message.match(TABLE_IN_MESSAGE_RE);
  return loose?.[1] ?? null;
}

/**
 * @typedef {'missing_table' | 'schema_cache' | 'calendar_config' | 'query_failed'} AlertKind
 */

/**
 * @param {unknown} error
 * @param {{ table?: string }} [opts]
 * @returns {{ kind: AlertKind; table: string | null; adminMessage: string; hint: string } | null}
 */
export function classifyDbError(error, opts = {}) {
  if (!isMissingTableError(error)) return null;

  const message = error && typeof error === 'object'
    ? String(/** @type {{ message?: string }} */ (error).message ?? '')
    : '';
  const table = extractTableName(error, opts.table) || opts.table || 'unknown';
  const cacheStale = /schema cache|PGRST205/i.test(message)
    || (error && typeof error === 'object' && /** @type {{ code?: string }} */ (error).code === 'PGRST205');

  if (cacheStale) {
    return {
      kind: 'schema_cache',
      table,
      adminMessage: `Eroare: Tabelă lipsă — public.${table} (sau cache schemă învechit)`,
      hint: 'Rulează SQL-ul de migrare, apoi Reîmprospătează schema din Admin.',
    };
  }

  return {
    kind: 'missing_table',
    table,
    adminMessage: `Eroare: Tabelă lipsă — public.${table}`,
    hint: table === 'employees'
      ? 'Rulează supabase/migrations/012_ensure_employees.sql în SQL Editor.'
      : 'Rulează supabase/SAFE_REAPPLY_ALL.sql în SQL Editor.',
  };
}

export const USER_DEGRADED_REPLY =
  'Momentan nu pot finaliza această acțiune. Te rog încearcă din nou în câteva minute.';
