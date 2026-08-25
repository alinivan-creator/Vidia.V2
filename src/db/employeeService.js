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
 * Calendar ID for bookings — employee calendar only (no business fallback).
 * @param {import('./businessService.js').Business} [_business]
 * @param {Employee | null | undefined} employee
 * @param {{ allowBusinessFallback?: boolean }} [_opts] — ignored; kept for call-site compat
 * @returns {string | null}
 */
export function resolveEmployeeCalendarId(_business, employee, _opts = {}) {
  return employee?.google_calendar_id ? String(employee.google_calendar_id).trim() || null : null;
}

/**
 * Move legacy businesses.google_calendar_id onto staff (prefer Mihai / sole employee).
 * Clears the business column. Idempotent.
 *
 * @param {import('./businessService.js').Business} business
 * @returns {Promise<{ migrated: boolean; employeeId?: string | null; created?: boolean; reason?: string }>}
 */
export async function migrateBusinessCalendarToEmployees(business) {
  const bizCal = typeof business?.google_calendar_id === 'string'
    ? business.google_calendar_id.trim()
    : '';
  if (!bizCal || !business?.id) {
    return { migrated: false, reason: 'no_business_calendar' };
  }

  if (!(await isTableAvailable('employees'))) {
    return { migrated: false, reason: 'employees_table_missing' };
  }

  const employees = await listEmployees(business.id, { activeOnly: false });
  let employeeId = null;
  let created = false;

  if (!employees.length) {
    const { employee, error } = await upsertEmployeeAdmin(business.id, {
      name: 'Mihai',
      google_calendar_id: bizCal,
      active: true,
      sort_order: 0,
      service_ids: [],
    });
    if (error || !employee) {
      return { migrated: false, reason: error || 'create_mihai_failed' };
    }
    employeeId = employee.id;
    created = true;
  } else {
    const mihai = employees.find((e) => String(e.name || '').trim().toLowerCase() === 'mihai');
    const withoutCal = employees.find((e) => !e.google_calendar_id);
    const target = mihai || (employees.length === 1 ? employees[0] : withoutCal) || employees[0];
    employeeId = target.id;
    if (!target.google_calendar_id) {
      const { error } = await upsertEmployeeAdmin(business.id, {
        id: target.id,
        name: target.name,
        google_calendar_id: bizCal,
        active: target.active,
        sort_order: target.sort_order,
        service_ids: target.service_ids ?? [],
        metadata: target.metadata,
      });
      if (error) {
        return { migrated: false, reason: error, employeeId };
      }
    }
  }

  const { supabase } = await import('../config/supabase.js');
  await supabase
    .from('businesses')
    .update({ google_calendar_id: null })
    .eq('id', business.id);

  console.log('[employees] migrated business calendar → employee', {
    businessId: business.id,
    employeeId,
    created,
    calendarId: bizCal,
  });

  return { migrated: true, employeeId, created };
}

/**
 * Free-text “la Andrei” / “cu Maria” when the name is not in the catalog.
 * Never treats catalog service tokens as people ("programare la tuns").
 *
 * @param {string} text
 * @param {{ services?: Array<{ name?: string }> }} [opts]
 * @returns {string | null}
 */
export function extractLikelyEmployeeName(text, opts = {}) {
  const n = String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!n) return null;

  const serviceTokens = new Set();
  for (const s of opts.services || []) {
    const name = String(s?.name ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    for (const tok of name.split(/[^a-z0-9ăâîșț]+/).filter((t) => t.length >= 3)) {
      serviceTokens.add(tok);
    }
  }
  // Barber morphology that often follows "la" as a service, not a person.
  for (const tok of ['tuns', 'tunde', 'tunsoare', 'barba', 'barbierit', 'aranjat', 'spalat', 'vopsit', 'coafat']) {
    serviceTokens.add(tok);
  }

  const stop = new Set([
    'ora', 'mine', 'tine', 'noi', 'voi', 'ei', 'ele', 'serviciu', 'programare',
    'programari', 'dimineata', 'seara', 'pranz', 'maine', 'azi', 'luni', 'marti',
    'miercuri', 'joi', 'vineri', 'sambata', 'duminica', 'septembrie', 'octombrie',
    'noiembrie', 'decembrie', 'ianuarie', 'februarie', 'martie', 'aprilie', 'mai',
    'iunie', 'iulie', 'august',
  ]);

  /** Prefer the last "la/cu X" that looks like a person (not a service/day). */
  const re = /\b(?:la|cu)\s+(?:domnul|doamna|dna\.?|dl\.?)?\s*([a-zA-Zăâîșț]{2,40})\b/g;
  let match;
  /** @type {string | null} */
  let best = null;
  while ((match = re.exec(n)) !== null) {
    const raw = match[1];
    if (!raw || stop.has(raw) || serviceTokens.has(raw)) continue;
    // Avoid treating service roots embedded in longer words as people.
    if ([...serviceTokens].some((t) => raw === t || (t.length >= 4 && raw.startsWith(t)))) continue;
    best = raw.charAt(0).toUpperCase() + raw.slice(1);
  }
  return best;
}

/**
 * Resolve staff mention from free text against the employee catalog.
 * Unknown "la Andrei" → { employee_name } without id (caller must ask / stop).
 *
 * @param {string} text
 * @param {Employee[]} employees
 * @param {Array<{ name?: string }> | null} [services]
 * @returns {{ employee_id: string | null, employee_name: string | null }}
 */
export function resolveStaffMentionFromText(text, employees, services = null) {
  const mentioned = matchEmployeeMention(text, employees || []);
  if (mentioned) {
    return { employee_id: mentioned.id, employee_name: mentioned.name };
  }
  const guessed = extractLikelyEmployeeName(text, { services: services || [] });
  if (guessed) {
    // Second chance: guess alone might match catalog ("Andrei" typed without "la").
    const byGuess = matchEmployeeMention(guessed, employees || []);
    if (byGuess) {
      return { employee_id: byGuess.id, employee_name: byGuess.name };
    }
    return { employee_id: null, employee_name: guessed };
  }
  return { employee_id: null, employee_name: null };
}
