import { supabase } from '../config/supabase.js';
import { logError } from './loggerService.js';
import { isTableAvailable, reportQueryFailure } from './schemaHealth.js';

/**
 * @typedef {Object} BusinessService
 * @property {string} id
 * @property {string} business_id
 * @property {string} name
 * @property {string | null} [slug]
 * @property {number | null} price_ron
 * @property {number} duration_minutes
 * @property {number} [sort_order]
 * @property {boolean} [is_active]
 */

/**
 * @returns {Promise<boolean>}
 */
export async function isServicesTableAvailable() {
  return isTableAvailable('services');
}

/**
 * Maps DB row → booking/AI-friendly shape (id usable in WhatsApp button ids).
 * @param {Record<string, unknown>} row
 * @returns {{ id: string; name: string; price_ron: number | null; duration_minutes: number }}
 */
export function mapServiceRow(row) {
  const slug = typeof row.slug === 'string' && row.slug ? row.slug : null;
  const id = slug || String(row.id);
  const duration = Number(row.duration_minutes);

  return {
    id,
    name: String(row.name ?? 'Serviciu'),
    price_ron: row.price_ron != null ? Number(row.price_ron) : null,
    duration_minutes: Number.isFinite(duration) && duration > 0 ? duration : 0,
    _db_id: String(row.id),
  };
}

/**
 * @param {string} businessId
 * @param {{ activeOnly?: boolean }} [opts]
 * @returns {Promise<ReturnType<typeof mapServiceRow>[]>}
 */
export async function listServicesForBusiness(businessId, opts = {}) {
  const activeOnly = opts.activeOnly !== false;

  if (!(await isServicesTableAvailable())) {
    return [];
  }

  let query = supabase
    .from('services')
    .select('id, business_id, name, slug, price_ron, duration_minutes, sort_order, is_active')
    .eq('business_id', businessId)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });

  if (activeOnly) {
    query = query.eq('is_active', true);
  }

  const { data, error } = await query;

  if (error) {
    await reportQueryFailure({
      table: 'services',
      error,
      op: 'listServicesForBusiness',
      businessId,
    });
    return [];
  }

  return (data ?? [])
    .map((row) => mapServiceRow(/** @type {Record<string, unknown>} */ (row)))
    .filter((s) => Number(s.duration_minutes) > 0);
}

/**
 * Replaces the full service catalog for a business (admin save).
 * @param {string} businessId
 * @param {Array<{ id?: string; name: string; price_ron?: number | null; duration_minutes?: number }>} services
 * @returns {Promise<{ ok: boolean; error: string | null; services: ReturnType<typeof mapServiceRow>[] }>}
 */
export async function replaceServicesForBusiness(businessId, services) {
  if (!(await isServicesTableAvailable())) {
    await reportQueryFailure({
      table: 'services',
      error: { code: 'PGRST205', message: "Could not find the table 'public.services' in the schema cache" },
      op: 'replaceServicesForBusiness',
      businessId,
    });
    return { ok: false, error: 'Eroare: Tabelă lipsă — public.services', services: [] };
  }

  const { error: delError } = await supabase
    .from('services')
    .delete()
    .eq('business_id', businessId);

  if (delError) {
    await logError({
      message: 'replaceServicesForBusiness delete failed',
      source: 'database',
      severity: 'error',
      businessId,
      error: delError,
    });
    return { ok: false, error: delError.message, services: [] };
  }

  const rows = (services ?? [])
    .filter((s) => String(s.name ?? '').trim() && Number(s.duration_minutes) > 0)
    .map((s, index) => {
      const name = String(s.name).trim();
      const rawId = s.id ? String(s.id) : '';
      const looksUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId);

      return {
        business_id: businessId,
        name,
        slug: looksUuid ? slugifyService(name) : (rawId || slugifyService(name)),
        price_ron: s.price_ron != null && s.price_ron !== '' ? Number(s.price_ron) : null,
        duration_minutes: Number(s.duration_minutes),
        sort_order: index,
        is_active: true,
      };
    });

  if (!rows.length) {
    return { ok: true, error: null, services: [] };
  }

  const { data, error } = await supabase
    .from('services')
    .insert(rows)
    .select('id, business_id, name, slug, price_ron, duration_minutes, sort_order, is_active');

  if (error) {
    await logError({
      message: 'replaceServicesForBusiness insert failed',
      source: 'database',
      severity: 'error',
      businessId,
      error,
    });
    return { ok: false, error: error.message, services: [] };
  }

  return {
    ok: true,
    error: null,
    services: (data ?? []).map((row) => mapServiceRow(/** @type {Record<string, unknown>} */ (row))),
  };
}

/**
 * @param {string} name
 */
function slugifyService(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || `svc-${Date.now()}`;
}
