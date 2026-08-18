/**
 * Operational tenant snapshot for booking / calendar / WhatsApp routing.
 * AI prompts and conversation logic are NOT read here — use loadAiTenantContext.
 */

import { getBusinessById } from '../db/businessService.js';
import { listEmployees } from '../db/employeeService.js';
import { listFaqsForBusiness } from '../db/faqService.js';
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
  const faqs = await listFaqsForBusiness(business.id);

  const settings =
    business.booking_settings && typeof business.booking_settings === 'object'
      ? { ...business.booking_settings }
      : {};
  delete settings.conversation_logic;

  return {
    business: {
      ...business,
      services,
      employees,
      faqs,
      booking_settings: settings,
      ai_system_prompt: '',
    },
    hours,
    hoursConfigured: Boolean(hours),
    hasOpenDay: hasConfiguredOpenDay(business),
    services,
    employees,
    timezone: business.timezone,
  };
}
