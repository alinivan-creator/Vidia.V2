/**
 * DISPLAY-ONLY translation layer for WhatsApp UI.
 *
 * Admin catalog is always authored in Romanian. Foreign sessions (EN) see
 * translated labels, but booking/confirmation always uses catalog service_id
 * from Supabase — never a translated string or invented service.
 *
 *   DISPLAY  → translate names from admin.services (+ optional client phrase)
 *   BOOKING  → service_id must match admin catalog (see serviceMatch / turnExtract)
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { getBookingConfig } from '../utils/datetime.js';
import { completeTenantChat } from './aiContextLoader.js';

/** @typedef {'ro' | 'en'} UiLang */

/** Exact-match shortcuts only — never partial/substring (avoids wrong niche labels). */
const STATIC_GLOSSARY_EXACT = {
  'tuns clasic': 'Classic Haircut',
  'tuns dama': "Women's Haircut",
  'tuns barbati': "Men's Haircut",
  'tuns copii': "Children's Haircut",
  'tuns': 'Haircut',
  'barba': 'Beard Trim',
  'manichiura': 'Manicure',
  'pedichiura': 'Pedicure',
  'masaj': 'Massage',
  'detartraj': 'Dental Scaling',
  'consultatie': 'Consultation',
};

/** @type {Map<string, string>} `${businessId}:${serviceId}:en` */
const catalogDisplayCache = new Map();

/** @type {Map<string, string>} `${businessId}:${hash}:en` for client free-text labels */
const clientLabelCache = new Map();

const displayAls = new AsyncLocalStorage();

function getAls() {
  return displayAls;
}

/**
 * @param {string} raw
 */
export function normalizePhrase(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s+/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Exact glossary hit only — no fuzzy matching (niche names stay intact until LLM).
 * @param {string | null | undefined} name
 */
export function staticTranslateServiceNameExact(name) {
  const original = String(name ?? '').trim();
  if (!original) return original;
  const normalized = normalizePhrase(original);
  return STATIC_GLOSSARY_EXACT[normalized] || original;
}

/**
 * @param {string | null | undefined} raw
 * @returns {Record<string, unknown> | null}
 */
function parseJsonObject(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      const parsed = JSON.parse(m[0]);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
}

/**
 * Translate every admin catalog row for EN UI (LLM batch + cache).
 * Only ids present in admin.services receive entries — nothing invented.
 *
 * @param {import('../db/businessService.js').Business} business
 * @param {UiLang} lang
 * @param {string | null} [requestId]
 * @param {{ id: string, name: string }[]} [extraServices]
 */
export async function buildServiceDisplayMap({
  business,
  lang = 'ro',
  requestId = null,
  extraServices = [],
}) {
  if (lang !== 'en' || !business?.id) return {};

  const catalog = getBookingConfig(business).services || [];
  const merged = new Map();
  for (const row of [...catalog, ...(extraServices || [])]) {
    if (row?.id && row?.name) merged.set(String(row.id), String(row.name));
  }

  /** @type {Record<string, string>} */
  const map = {};
  /** @type {{ id: string, name: string }[]} */
  const needsLlm = [];

  for (const [id, name] of merged.entries()) {
    const cacheKey = `${business.id}:${id}:en`;
    if (catalogDisplayCache.has(cacheKey)) {
      map[id] = catalogDisplayCache.get(cacheKey);
      continue;
    }
    const exact = staticTranslateServiceNameExact(name);
    if (exact !== name) {
      map[id] = exact;
      catalogDisplayCache.set(cacheKey, exact);
      continue;
    }
    needsLlm.push({ id, name });
  }

  if (needsLlm.length) {
    const chat = await completeTenantChat({
      businessId: business.id,
      parserMode: true,
      extraSystem: [
        'Translate Romanian business service names into clear professional English for a WhatsApp booking menu.',
        'The business can be any niche (dental, ITP, barber, massage, pet grooming, etc.).',
        'Return ONLY JSON: {"translations":[{"id":"<uuid>","en":"<English name>"}, ...]}',
        'Rules:',
        '- Translate ONLY the provided catalog rows — one output per input id',
        '- Preserve the meaning of compound names (e.g. "Tuns + Spalat" → "Haircut + Wash")',
        '- Never invent services, ids, or add offerings not in the input list',
        '- Concise Title Case; no marketing fluff',
      ].join('\n'),
      userContent: JSON.stringify({
        target_language: 'en',
        business_type: 'any',
        services: needsLlm.slice(0, 40),
      }),
      temperature: 0,
      maxTokens: 900,
      requestId,
    });

    if (chat.ok && chat.text) {
      const parsed = parseJsonObject(chat.text);
      const rows = Array.isArray(parsed?.translations) ? parsed.translations : [];
      for (const row of rows) {
        const id = typeof row?.id === 'string' ? row.id.trim() : '';
        const en = typeof row?.en === 'string' ? row.en.trim() : '';
        if (!id || !en || !merged.has(id)) continue;
        map[id] = en;
        catalogDisplayCache.set(`${business.id}:${id}:en`, en);
      }
    }

    for (const row of needsLlm) {
      if (!map[row.id]) {
        map[row.id] = row.name;
        catalogDisplayCache.set(`${business.id}:${row.id}:en`, row.name);
      }
    }
  }

  return map;
}

/**
 * DISPLAY ONLY — translate what the client asked for when it is NOT in catalog.
 * Does not create or confirm any service.
 *
 * @param {Object} params
 * @param {import('../db/businessService.js').Business} params.business
 * @param {string} params.text
 * @param {string | null} [params.requestId]
 */
export async function translateClientRequestLabel({ business, text, requestId = null }) {
  const phrase = String(text ?? '').trim();
  if (!phrase || !business?.id) return phrase;

  const cacheKey = `${business.id}:${normalizePhrase(phrase)}:en`;
  if (clientLabelCache.has(cacheKey)) return clientLabelCache.get(cacheKey);

  if (/^[a-z0-9\s'/-]+$/i.test(phrase) && !/[ăâîșț]/i.test(phrase)) {
    clientLabelCache.set(cacheKey, phrase);
    return phrase;
  }

  const chat = await completeTenantChat({
    businessId: business.id,
    parserMode: true,
    extraSystem: [
      'Translate a client service request phrase into concise professional English for display in an error message.',
      'Return ONLY JSON: {"en":"<translation>"}',
      'Rules:',
      '- Translate the phrase only — do NOT invent services or imply availability',
      '- This is display-only; the service may not be offered',
    ].join('\n'),
    userContent: JSON.stringify({ client_phrase: phrase, target_language: 'en' }),
    temperature: 0,
    maxTokens: 80,
    requestId,
  });

  let en = phrase;
  if (chat.ok && chat.text) {
    const parsed = parseJsonObject(chat.text);
    if (typeof parsed?.en === 'string' && parsed.en.trim()) {
      en = parsed.en.trim();
    }
  }

  clientLabelCache.set(cacheKey, en);
  return en;
}

/**
 * @param {Object} params
 * @param {import('../db/businessService.js').Business} params.business
 * @param {UiLang} params.lang
 * @param {string | null} [params.requestId]
 * @param {{ id: string, name: string }[]} [params.extraServices]
 * @param {() => Promise<T>} params.run
 * @template T
 */
export async function runWithServiceDisplay({
  business,
  lang,
  requestId = null,
  extraServices = [],
  run,
}) {
  const uiLang = lang === 'en' ? 'en' : 'ro';
  if (uiLang !== 'en') {
    return getAls().run({ lang: uiLang, map: {} }, run);
  }
  const map = await buildServiceDisplayMap({ business, lang: uiLang, requestId, extraServices });
  return getAls().run({ lang: uiLang, map }, run);
}

/**
 * Catalog service label for client UI. Requires catalog id for translated output.
 * Without a catalog id, returns the raw name unchanged (never guesses from glossary).
 *
 * @param {string | null | undefined} name
 * @param {string | null | undefined} [serviceId]
 * @param {UiLang} [lang]
 * @param {Record<string, string>} [displayMap]
 */
export function svcDisplay(name, serviceId = null, lang = null, displayMap = null) {
  const ctx = getAls().getStore();
  const uiLang = lang === 'en' ? 'en' : (ctx?.lang === 'en' ? 'en' : 'ro');
  const raw = String(name ?? '').trim();
  if (uiLang !== 'en') return raw;

  const id = serviceId ? String(serviceId) : '';
  if (!id) return raw;

  const map = displayMap || ctx?.map || {};
  return map[id] || raw;
}

/** @deprecated Use svcDisplay with catalog id — kept for tests migrating off fuzzy glossary. */
export function staticTranslateServiceName(name) {
  return staticTranslateServiceNameExact(name);
}

/**
 * @param {{ id?: string, name?: string } | null | undefined} service
 * @param {UiLang} [lang]
 */
export function svcDisplayFromRow(service, lang = null) {
  if (!service) return '';
  return svcDisplay(service.name, service.id, lang);
}

/**
 * @param {{ id?: string, name?: string, duration_minutes?: number, price_ron?: number | null }[]} services
 * @param {UiLang} [lang]
 */
export function localizeServicesList(services, lang = null) {
  const uiLang = lang === 'en' ? 'en' : (getAls().getStore()?.lang === 'en' ? 'en' : 'ro');
  return (services || []).map((s) => ({
    ...s,
    name: svcDisplay(s.name, s.id, uiLang),
  }));
}

/** Test helper — reset in-memory cache between tests. */
export function _clearServiceDisplayCacheForTests() {
  catalogDisplayCache.clear();
  clientLabelCache.clear();
}
