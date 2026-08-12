import { supabase } from '../config/supabase.js';
import { logError } from './loggerService.js';

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

/** @type {boolean | null} */
let tableAvailable = null;

async function isTableAvailable() {
  if (tableAvailable !== null) return tableAvailable;
  const { error } = await supabase.from('employees').select('id').limit(1);
  if (!error) {
    tableAvailable = true;
    return true;
  }
  if (/does not exist|PGRST205|42P01/i.test(error.message ?? '') || error.code === '42P01') {
    tableAvailable = false;
    return false;
  }
  tableAvailable = true;
  return true;
}

/**
 * @param {string} businessId
 * @param {{ activeOnly?: boolean }} [opts]
 * @returns {Promise<Employee[]>}
 */
export async function listEmployees(businessId, opts = {}) {
  if (!(await isTableAvailable())) return [];

  let query = supabase
    .from('employees')
    .select(COLUMNS)
    .eq('business_id', businessId)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });

  if (opts.activeOnly !== false) {
    query = query.eq('active', true);
  }

  const { data, error } = await query;
  if (error) {
    if (/does not exist|PGRST205/i.test(error.message ?? '')) {
      tableAvailable = false;
      return [];
    }
    await logError({
      message: 'listEmployees failed',
      source: 'database',
      businessId,
      error,
    });
    return [];
  }
  return /** @type {Employee[]} */ (data ?? []);
}

/**
 * Tenant-scoped employee lookup — `business_id` is mandatory.
 * @param {string} employeeId
 * @param {string} businessId
 * @returns {Promise<Employee | null>}
 */
export async function getEmployeeById(employeeId, businessId) {
  if (!employeeId || !businessId || !(await isTableAvailable())) return null;
  const { data, error } = await supabase
    .from('employees')
    .select(COLUMNS)
    .eq('id', employeeId)
    .eq('business_id', businessId)
    .maybeSingle();
  if (error) return null;
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
    // Match first token of name
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
  if (!(await isTableAvailable())) {
    return { employee: null, error: 'Tabela employees lipsește — rulează migrarea 010' };
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
    const { data, error } = await supabase
      .from('employees')
      .update(payload)
      .eq('id', input.id)
      .eq('business_id', businessId)
      .select(COLUMNS)
      .single();
    if (error) return { employee: null, error: error.message };
    return { employee: /** @type {Employee} */ (data), error: null };
  }

  const { data, error } = await supabase
    .from('employees')
    .insert(payload)
    .select(COLUMNS)
    .single();
  if (error) return { employee: null, error: error.message };
  return { employee: /** @type {Employee} */ (data), error: null };
}

/**
 * @param {string} businessId
 * @param {string} employeeId
 */
export async function deleteEmployeeAdmin(businessId, employeeId) {
  if (!(await isTableAvailable())) return { ok: false, error: 'Tabela employees lipsește' };
  const { error } = await supabase
    .from('employees')
    .delete()
    .eq('id', employeeId)
    .eq('business_id', businessId);
  if (error) return { ok: false, error: error.message };
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
