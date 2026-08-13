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
 */

const COLUMNS = 'id, business_id, name, google_calendar_id, active, sort_order';

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
  return /** @type {Employee[]} */ (data ?? []);
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
  return /** @type {Employee | null} */ (data);
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

  const payload = {
    business_id: businessId,
    name,
    google_calendar_id: input.google_calendar_id
      ? String(input.google_calendar_id).trim()
      : null,
    active: input.active !== false && input.active !== 'false',
    sort_order: Number(input.sort_order ?? 0) || 0,
  };

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
    return { employee: /** @type {Employee} */ (data), error: null };
  }

  const { data, error } = await safeQuery(
    'employees',
    (from) => from.insert(payload).select(COLUMNS).single(),
    { fallback: null, businessId, op: 'upsertEmployeeAdmin:insert' },
  );
  if (error) return { employee: null, error: error.message || 'Inserare eșuată' };
  return { employee: /** @type {Employee} */ (data), error: null };
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
 * Calendar ID for bookings: employee calendar if set, else business fallback.
 * @param {import('./businessService.js').Business} business
 * @param {Employee | null | undefined} employee
 * @returns {string | null}
 */
export function resolveEmployeeCalendarId(business, employee) {
  if (employee?.google_calendar_id) return employee.google_calendar_id;
  return business.google_calendar_id ?? null;
}
