/**
 * Tenant snapshot loaded from Supabase before any booking / AI / calendar decision.
 */

import { getBusinessById } from '../db/businessService.js';
import { listEmployees } from '../db/employeeService.js';
import { getBookingConfig } from '../utils/datetime.js';
import {
  getAdminBusinessHours,
  hasConfiguredOpenDay,
} from '../utils/workingHours.js';

/** @typedef {import('../db/businessService.js').Business} Business */

/**
 * @typedef {Object} BusinessContext
 * @property {Business} business
 * @property {Record<string, { open: string, close: string } | null> | null} hours
 * @property {boolean} hoursConfigured
 * @property {boolean} hasOpenDay
 * @property {{ id: string, name: string, duration_minutes: number, price_ron?: number | null }[]} services
 * @property {import('../db/employeeService.js').Employee[]} employees
 * @property {string} timezone
 * @property {string} aiInstructions
 */

/**
 * @param {string | Business} businessOrId
 * @returns {Promise<BusinessContext | null>}
 */
export async function loadBusinessContext(businessOrId) {
  const id = typeof businessOrId === 'string' ? businessOrId : businessOrId?.id;
  if (!id) return null;

  const business = await getBusinessById(id);
  if (!business) return null;

  const hours = getAdminBusinessHours(business);
  const config = getBookingConfig(business);
  const services = (config.services || []).filter((s) => Number(s.duration_minutes) > 0);
  const employees = await listEmployees(business.id, { activeOnly: true });
  const aiInstructions = typeof business.ai_system_prompt === 'string'
    ? business.ai_system_prompt.trim()
    : '';

  return {
    business: { ...business, services, employees },
    hours,
    hoursConfigured: Boolean(hours),
    hasOpenDay: hasConfiguredOpenDay(business),
    services,
    employees,
    timezone: business.timezone,
    aiInstructions,
  };
}
