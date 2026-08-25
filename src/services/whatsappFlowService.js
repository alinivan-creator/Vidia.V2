/**
 * Optional WhatsApp Flows booking UI (Meta DatePicker + free-slot radios).
 * Enabled per tenant when booking_settings.whatsapp_flow_id is set.
 * Publish docs/flows/vidia-booking-flow.json in Meta Business Manager, then store the Flow ID.
 */

import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { listOpenDayWindows, listTimeWindows } from '../utils/bookingGrid.js';
import { addCalendarDays, formatDateKey, getBookingConfig } from '../utils/datetime.js';
import { getAvailableSlots } from '../db/cacheService.js';
import { resolveServiceDurationMinutes } from '../utils/workingHours.js';
import { getEmployeeById, resolveEmployeeCalendarId } from '../db/employeeService.js';
import {
  lazySyncCalendar,
  queryFreeBusyBatch,
  isIntervalFreeInBusyBlocks,
  isBusinessMockMode,
} from './googleCalendarService.js';

/** @typedef {import('../db/businessService.js').Business} Business */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function flowTokenSecret() {
  return env.supabaseServiceRoleKey;
}

function flowTokenHmac(businessId) {
  return crypto.createHmac('sha256', flowTokenSecret()).update(businessId).digest('hex').slice(0, 16);
}

function timingSafeHexEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Signed tenant binding for WhatsApp Flows. Never accept a client `business_id`.
 * @param {string} businessId
 * @returns {string}
 */
export function createFlowToken(businessId) {
  const id = String(businessId || '');
  if (!UUID_RE.test(id)) return '';
  return `vidia.${id}.${flowTokenHmac(id)}`;
}

/**
 * @param {string | null | undefined} token
 * @returns {string | null} business UUID
 */
export function parseFlowToken(token) {
  const raw = String(token || '').trim();
  const signed = raw.split('.');
  if (signed.length !== 3 || signed[0] !== 'vidia') return null;
  const id = signed[1];
  const sig = signed[2];
  if (!UUID_RE.test(id) || !timingSafeHexEqual(sig, flowTokenHmac(id))) return null;
  return id;
}

/**
 * Catalog row for this tenant only — ignore client-supplied duration.
 * @param {Business} business
 * @param {Record<string, unknown>} data
 */
export function catalogServiceFromFlowData(business, data) {
  const name = typeof data.service_name === 'string' ? data.service_name.trim() : '';
  const id = typeof data.service_id === 'string' ? data.service_id.trim() : '';
  if (!name && !id) return null;
  const services = [
    ...(Array.isArray(business.services) ? business.services : []),
    ...(Array.isArray(business.booking_settings?.services)
      ? /** @type {Array<{ id?: string, name?: string, duration_minutes?: number }>} */ (
        business.booking_settings.services
      )
      : []),
  ];
  return services.find((s) => (id && s.id === id) || (name && s.name === name)) || null;
}

/**
 * @param {Business} business
 * @returns {string | null}
 */
export function getConfiguredFlowId(business) {
  const settings = business?.booking_settings || {};
  const id = settings.whatsapp_flow_id || settings.whatsappFlowId || null;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/**
 * @param {Business} business
 */
export function flowsEnabled(business) {
  return Boolean(getConfiguredFlowId(business));
}

/**
 * Build initial Flow screen data (open horizon + empty slots until date pick).
 * @param {Business} business
 * @param {{ name?: string, duration_minutes?: number } | null} service
 */
export function buildFlowInitData(business, service = null) {
  const tz = business.timezone || 'Europe/Bucharest';
  const days = listOpenDayWindows(business);
  const today = formatDateKey(new Date(), tz);
  const horizon = getBookingConfig(business).bookingHorizonDays || 14;
  return {
    service_label: service?.name || 'Serviciu',
    min_date: days[0]?.dateKey || today,
    max_date: days[days.length - 1]?.dateKey || addCalendarDays(today, horizon),
    available_slots: [
      { id: 'slot_pick_date_first', title: 'Alege mai întâi ziua' },
    ],
  };
}

/**
 * @param {Object} params
 * @param {Business} params.business
 * @param {{ name?: string, duration_minutes?: number } | null} params.service
 * @param {string} params.dateKey
 * @param {string | null} [params.employeeId]
 * @param {string | null} [params.draftId]
 */
export async function buildFlowSlotsForDate({
  business,
  service,
  dateKey,
  employeeId = null,
  draftId = null,
}) {
  const duration = resolveServiceDurationMinutes(business, service);
  if (!duration) {
    return [{ id: 'slot_none', title: 'Nicio oră liberă' }];
  }
  const scopedEmployee = employeeId
    ? await getEmployeeById(employeeId, business.id)
    : null;
  const scopedEmployeeId = scopedEmployee?.id || null;
  const calendarId = resolveEmployeeCalendarId(business, scopedEmployee);
  await lazySyncCalendar({
    business,
    force: true,
    calendarId,
    employeeId: scopedEmployeeId,
  });
  let slots = await getAvailableSlots({
    business,
    durationMinutes: duration,
    limit: 24,
    excludeDraftId: draftId,
    employeeId: scopedEmployeeId,
    dateKey,
  });
  if (calendarId && slots.length && !isBusinessMockMode(business)) {
    const batch = await queryFreeBusyBatch({
      business,
      timeMinIso: slots[0].start.toISOString(),
      timeMaxIso: slots[slots.length - 1].end.toISOString(),
      calendarIds: [calendarId],
    });
    const entry = batch.ok ? batch.calendars[calendarId] : null;
    if (entry && !entry.errors) {
      const busy = entry.busy || [];
      slots = slots.filter((s) => isIntervalFreeInBusyBlocks(s.start, s.end, busy));
    }
  }
  const times = listTimeWindows(slots, business.timezone || 'Europe/Bucharest');
  if (!times.length) {
    return [{ id: 'slot_none', title: 'Nicio oră liberă' }];
  }
  return times.map((t) => ({ id: t.id, title: t.title }));
}

/**
 * Parse Twilio InteractiveData / FlowData JSON from webhook.
 * @param {unknown} raw
 * @returns {{ dateKey: string | null, slotId: string | null, raw: Record<string, unknown> } | null}
 */
export function parseFlowSubmission(raw) {
  if (raw == null || raw === '') return null;
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object') return null;
  const row = /** @type {Record<string, unknown>} */ (data);
  const nested = (row.response_json && typeof row.response_json === 'object')
    ? /** @type {Record<string, unknown>} */ (row.response_json)
    : row;
  const dateKey = String(nested.appointment_date || nested.date || '').slice(0, 10);
  const slotId = String(nested.appointment_slot || nested.slot || '').trim();
  return {
    dateKey: /^\d{4}-\d{2}-\d{2}$/.test(dateKey) ? dateKey : null,
    slotId: slotId.startsWith('slot_') ? slotId : null,
    raw: nested,
  };
}

/**
 * Meta Flow endpoint encryption helpers (optional — set WHATSAPP_FLOW_PRIVATE_PEM).
 * @param {string} encryptedB64
 * @param {string} aesKeyB64
 * @param {string} ivB64
 */
export function decryptFlowRequest(encryptedB64, aesKeyB64, ivB64) {
  const pem = process.env.WHATSAPP_FLOW_PRIVATE_PEM;
  if (!pem) throw new Error('WHATSAPP_FLOW_PRIVATE_PEM missing');
  const privateKey = pem.replace(/\\n/g, '\n');
  const aesKey = crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(aesKeyB64, 'base64'),
  );
  const decipher = crypto.createDecipheriv(
    'aes-128-gcm',
    aesKey,
    Buffer.from(ivB64, 'base64'),
  );
  const encrypted = Buffer.from(encryptedB64, 'base64');
  const authTag = encrypted.subarray(encrypted.length - 16);
  const data = encrypted.subarray(0, encrypted.length - 16);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return { aesKey, payload: JSON.parse(decipheredUtf8(decrypted)) };
}

function decipheredUtf8(buf) {
  return buf.toString('utf8');
}

/**
 * @param {object} response
 * @param {Buffer} aesKey
 * @returns {string} base64 ciphertext+tag for Meta
 */
export function encryptFlowResponse(response, aesKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, iv);
  const plaintext = Buffer.from(JSON.stringify(response), 'utf8');
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: Buffer.concat([enc, tag]).toString('base64'),
    iv: iv.toString('base64'),
  };
}

/** Public base for documenting the Flow endpoint URL. */
export function flowEndpointUrl() {
  return env.publicBaseUrl ? `${env.publicBaseUrl}/webhook/whatsapp-flows` : null;
}
