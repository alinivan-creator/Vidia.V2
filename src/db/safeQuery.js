import { supabase } from '../config/supabase.js';
import {
  isTableAvailable,
  markTableMissing,
  reportQueryFailure,
} from './schemaHealth.js';
import { isMissingTableError } from './schemaErrors.js';

/**
 * Run a Supabase query without crashing the process.
 * Missing tables / stale schema cache → log + fallback, never throw.
 *
 * @template T
 * @param {string} table
 * @param {(from: ReturnType<typeof supabase.from>) => PromiseLike<{ data: T | null; error: { message?: string; code?: string } | null; count?: number | null }>} build
 * @param {{ fallback?: T; businessId?: string | null; op?: string; critical?: boolean }} [opts]
 * @returns {Promise<{ data: T | null; error: { message?: string; code?: string } | null; degraded: boolean; count?: number | null }>}
 */
export async function safeQuery(table, build, opts = {}) {
  const fallback = opts.fallback ?? null;

  try {
    const cachedMissing = !(await isTableAvailable(table));
    if (cachedMissing) {
      return { data: fallback, error: { code: 'MODULE_DISABLED', message: `Tabela ${table} indisponibilă` }, degraded: true };
    }

    const result = await build(supabase.from(table));
    if (result?.error) {
      if (isMissingTableError(result.error)) {
        markTableMissing(table);
      }
      await reportQueryFailure({
        table,
        error: result.error,
        op: opts.op || `safeQuery:${table}`,
        businessId: opts.businessId ?? null,
        critical: opts.critical,
      });
      return {
        data: fallback,
        error: result.error,
        degraded: true,
        count: result.count ?? null,
      };
    }

    return {
      data: /** @type {T | null} */ (result?.data ?? fallback),
      error: null,
      degraded: false,
      count: result?.count ?? null,
    };
  } catch (error) {
    await reportQueryFailure({
      table,
      error,
      op: opts.op || `safeQuery:${table}`,
      businessId: opts.businessId ?? null,
      critical: opts.critical,
    });
    return { data: fallback, error: { message: error instanceof Error ? error.message : String(error) }, degraded: true };
  }
}
