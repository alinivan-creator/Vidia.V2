import { safeQuery } from './safeQuery.js';
import { isTableAvailable } from './schemaHealth.js';

/**
 * @typedef {Object} Employee
 * @property {string} id
 * @property {string} business_id
 * @property {string} name
 * @property {string | null} google_calendar_id
 * @property {boolean} active
 * @property {number} sort_order
 * @property {string[]} [service_ids]
 * @property {Record<string, unknown>} [metadata]
 */

// Keep select list migration-safe: service association lives in metadata.service_ids
// (and optionally column service_ids after 022_employee_service_ids.sql).
const COLUMNS = 'id, business_id, name, google_calendar_id, active, sort_order, metadata';

/**
 * Normalize service_ids from DB (jsonb array / null).
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeServiceIds(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((id) => String(id ?? '').trim()).filter(Boolean);
}

/**
 * Empty service_ids = employee can perform every catalog service (legacy tenants).
 * @param {Employee} employee
 * @param {string | null | undefined} serviceId
 */
export function employeeOffersService(employee, serviceId) {
  if (!serviceId) return true;
  const ids = normalizeServiceIds(employee.service_ids);
  if (!ids.length) return true;
  return ids.includes(String(serviceId));
}

/**
 * @param {Record<string, unknown> | null | undefined} row
 * @returns {Employee | null}
 */
function mapEmployeeRow(row) {
  if (!row || typeof row !== 'object') return null;
  const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? /** @type {Record<string, unknown>} */ (row.metadata)
    : {};
  const fromColumn = normalizeServiceIds(row.service_ids);
  const fromMeta = normalizeServiceIds(metadata.service_ids);
  return {
    id: String(row.id),
    business_id: String(row.business_id),
    name: String(row.name),
    google_calendar_id: row.google_calendar_id != null ? String(row.google_calendar_id) : null,
    active: row.active !== false,
    sort_order: Number(row.sort_order) || 0,
    service_ids: fromColumn.length ? fromColumn : fromMeta,
    metadata,
  };
}

/**
 * @param {string} businessId
 * @param {{ activeOnly?: boolean }} [opts]
 * @returns {Promise<Employee[]>}
 */
export async function listEmployees(businessId, opts = {}) {
  const { data } = await safeQuery(
    'employees',
    (from) => {
      let query = from
        .select(COLUMNS)
        .eq('business_id', businessId)
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true });
      if (opts.activeOnly !== false) {
        query = query.eq('active', true);
      }
      return query;
    },
    { fallback: [], businessId, op: 'listEmployees', critical: true },
  );
  return (Array.isArray(data) ? data : [])
    .map((row) => mapEmployeeRow(/** @type {Record<string, unknown>} */ (row)))
    .filter(Boolean);
}

/**
 * Active employees who offer a given service (empty service_ids = all services).
 * @param {string} businessId
 * @param {string | null | undefined} serviceId
 * @param {{ activeOnly?: boolean }} [opts]
 * @returns {Promise<Employee[]>}
 */
export async function listEmployeesForService(businessId, serviceId, opts = {}) {
  const all = await listEmployees(businessId, opts);
  if (!serviceId) return all;
  return all.filter((emp) => employeeOffersService(emp, serviceId));
}

/**
 * Tenant-scoped employee lookup — `business_id` is mandatory.
 * @param {string} employeeId
 * @param {string} businessId
 * @returns {Promise<Employee | null>}
 */
export async function getEmployeeById(employeeId, businessId) {
  if (!employeeId || !businessId) return null;
  const { data } = await safeQuery(
    'employees',
    (from) =>
      from
        .select(COLUMNS)
        .eq('id', employeeId)
        .eq('business_id', businessId)
        .maybeSingle(),
    { fallback: null, businessId, op: 'getEmployeeById' },
  );
  return mapEmployeeRow(/** @type {Record<string, unknown> | null} */ (data));
}

/**
 * Match free-text mention to an employee name (e.g. "cu Maria", "la Andrei").
 * @param {string} text
 * @param {Employee[]} employees
 * @returns {Employee | null}
 */
export function matchEmployeeMention(text, employees) {
  if (!employees.length) return null;
  const n = String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (!n) return null;

  /** @type {Employee | null} */
  let best = null;
  let bestLen = 0;
  for (const emp of employees) {
    const name = emp.name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
    if (name.length < 2) continue;
    if (n.includes(name) && name.length > bestLen) {
      best = emp;
      bestLen = name.length;
    }
    const first = name.split(/\s+/)[0];
    if (first.length >= 3 && n.includes(first) && first.length > bestLen) {
      best = emp;
      bestLen = first.length;
    }
  }
  return best;
}

/**
 * Admin upsert (create or update).
 * @param {Object} input
 * @returns {Promise<{ employee: Employee | null; error: string | null }>}
 */
export async function upsertEmployeeAdmin(input) {
  if (!(await isTableAvailable('employees'))) {
    return {
      employee: null,
      error: 'Eroare: Tabelă lipsă — public.employees. Rulează 012_ensure_employees.sql în SQL Editor.',
    };
  }

  const businessId = String(input.business_id ?? '').trim();
  const name = String(input.name ?? '').trim();
  if (!businessId || !name) {
    return { employee: null, error: 'business_id și name sunt obligatorii' };
  }

  const serviceIds = normalizeServiceIds(
    input.service_ids
    ?? (typeof input.servicii === 'string'
      ? String(input.servicii).split(/[,;\s]+/)
      : input.servicii),
  );
  const baseMeta = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? { ...input.metadata }
    : {};
  if (serviceIds.length || input.service_ids != null || input.servicii != null) {
    baseMeta.service_ids = serviceIds;
  }

  const payload = {
    business_id: businessId,
    name,
    google_calendar_id: input.google_calendar_id
      ? String(input.google_calendar_id).trim()
      : null,
    active: input.active !== false && input.active !== 'false',
    sort_order: Number(input.sort_order ?? 0) || 0,
    metadata: baseMeta,
  };

  if (payload.active && !payload.google_calendar_id) {
    return {
      employee: null,
      error:
        'Acest angajat nu are calendar Google conectat — dezactivează-l sau adaugă un calendar înainte de a-l activa.',
    };
  }

  if (input.id) {
    const { data, error } = await safeQuery(
      'employees',
      (from) =>
        from
          .update(payload)
          .eq('id', input.id)
          .eq('business_id', businessId)
          .select(COLUMNS)
          .single(),
      { fallback: null, businessId, op: 'upsertEmployeeAdmin:update' },
    );
    if (error) return { employee: null, error: error.message || 'Actualizare eșuată' };
    return { employee: mapEmployeeRow(/** @type {Record<string, unknown>} */ (data)), error: null };
  }

  const { data, error } = await safeQuery(
    'employees',
    (from) => from.insert(payload).select(COLUMNS).single(),
    { fallback: null, businessId, op: 'upsertEmployeeAdmin:insert' },
  );
  if (error) return { employee: null, error: error.message || 'Inserare eșuată' };
  return { employee: mapEmployeeRow(/** @type {Record<string, unknown>} */ (data)), error: null };
}

/**
 * @param {string} businessId
 * @param {string} employeeId
 */
export async function deleteEmployeeAdmin(businessId, employeeId) {
  if (!(await isTableAvailable('employees'))) {
    return { ok: false, error: 'Eroare: Tabelă lipsă — public.employees' };
  }
  const { error } = await safeQuery(
    'employees',
    (from) => from.delete().eq('id', employeeId).eq('business_id', businessId),
    { fallback: null, businessId, op: 'deleteEmployeeAdmin' },
  );
  if (error) return { ok: false, error: error.message || 'Ștergere eșuată' };
  return { ok: true, error: null };
}

/**
 * Calendar ID for bookings: employee calendar if set, else optional business fallback.
 * @param {import('./businessService.js').Business} business
 * @param {Employee | null | undefined} employee
 * @param {{ allowBusinessFallback?: boolean }} [opts]
 * @returns {string | null}
 */
export function resolveEmployeeCalendarId(business, employee, opts = {}) {
  const allowFallback = opts.allowBusinessFallback !== false;
  if (employee?.google_calendar_id) return employee.google_calendar_id;
  if (allowFallback) return business.google_calendar_id ?? null;
  return null;
}

/**
 * Free-text “la Andrei” / “cu Maria” when the name is not in the catalog.
 * @param {string} text
 * @returns {string | null}
 */
export function extractLikelyEmployeeName(text) {
  const n = String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!n) return null;
  const m = n.match(/\b(?:la|cu)\s+(?:domnul|doamna|dna\.?|dl\.?)?\s*([a-zA-Zăâîșț]{2,40})\b/);
  if (!m?.[1]) return null;
  const raw = m[1];
  if (['ora', 'mine', 'tine', 'noi', 'voi', 'ei', 'ele', 'serviciu', 'programare'].includes(raw)) {
    return null;
  }
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}
