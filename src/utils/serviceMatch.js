/**
 * Match a free-text reply to a catalog service.
 * Never auto-picks when the name is missing or ambiguous — duration
 * must come from a service the client actually chose.
 *
 * Morphology aliases (tuns/tunde, etc.) activate only when the catalog
 * already contains that root — so a dental clinic does not inherit barber stems.
 */

import { waJoin, waTitle } from './waCopy.js';
import { svcDisplay } from '../services/serviceDisplayI18n.js';

/** Morphological variants; only used when a group root appears in the tenant catalog. */
const MORPHOLOGY_GROUPS = [
  ['tuns', 'tunde', 'tundeti', 'tunsoare', 'tunsu', 'haircut'],
  ['barba', 'barbierit', 'barbier'],
  ['aranj', 'aranjat', 'aranjati', 'aranjez', 'aranjezi', 'aranjeaza'],
];

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameTokens(name) {
  return normalize(name).split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
}

/**
 * @param {{ name?: string }[]} services
 * @returns {string[][]}
 */
function activeMorphologyGroups(services) {
  const catalogTokens = new Set();
  for (const s of services || []) {
    for (const t of nameTokens(s?.name || '')) catalogTokens.add(t);
  }
  if (!catalogTokens.size) return [];

  return MORPHOLOGY_GROUPS.filter((group) =>
    group.some((g) =>
      [...catalogTokens].some(
        (t) => t === g || t.startsWith(g) || (g.startsWith(t) && t.length >= 4),
      ),
    ),
  );
}

function stemToken(token, groups) {
  const t = normalize(token);
  for (const group of groups) {
    if (group.some((g) => t === g || t.startsWith(g) || (g.startsWith(t) && t.length >= 4))) {
      return group[0];
    }
  }
  return t;
}

/** @type {Set<string>} */
const SERVICE_STOP_TOKENS = new Set([
  'si', 'sau', 'cu', 'la', 'de', 'pentru', 'un', 'o', 'the', 'and', 'for', 'or', 'with',
]);

/**
 * True when free text looks like a typed service name (not date/time/menu).
 * @param {string | null | undefined} text
 */
export function isTypedServiceAttempt(text) {
  const n = normalize(text);
  if (!n || n.length < 3) return false;
  if (/^\d{1,2}$/.test(n)) return false;
  if (n === 'meniu' || n === 'menu' || n === 'servicii' || n === 'services') return false;
  const tokens = n.split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !SERVICE_STOP_TOKENS.has(t));
  return tokens.length >= 1;
}

/**
 * Every meaningful token in the user phrase must appear in the catalog service name.
 * Prevents „tuns si vopsit” from matching „Tuns Clasic” on „tuns” alone.
 * @param {string} userText
 * @param {string} serviceName
 * @param {string[][]} [groups]
 */
export function serviceCoversUserRequest(userText, serviceName, groups = []) {
  const n = normalize(userText);
  const name = normalize(serviceName);
  if (!n || !name) return false;
  if (name.length >= 3 && n.includes(name)) return true;

  const userTokens = n.split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !SERVICE_STOP_TOKENS.has(t));
  if (!userTokens.length) return false;

  const nameParts = nameTokens(serviceName);
  const nameStems = new Set(nameParts.map((part) => stemToken(part, groups)));

  return userTokens.every((tok) => {
    const stem = stemToken(tok, groups);
    if (name.includes(tok)) return true;
    if (nameParts.some((part) => part === tok || part.startsWith(tok) || tok.startsWith(part))) return true;
    return nameStems.has(stem);
  });
}

function scoreService(userStems, service, groups) {
  const name = normalize(service.name);
  const parts = nameTokens(service.name).map((tok) => stemToken(tok, groups));
  let score = 0;
  for (const stem of userStems) {
    if (name === stem || parts.includes(stem) || name.includes(stem)) score += 1;
  }
  return score;
}

/**
 * True when the client text touches this tenant's catalog vocabulary
 * (unique match OR shared stem like „barbă” when the catalog has beard services).
 * Used for booking intent — does not pick a service when ambiguous.
 *
 * @param {string} text
 * @param {{ id?: string, name?: string }[]} services
 */
export function mentionsCatalogVocabulary(text, services) {
  const list = Array.isArray(services) ? services : [];
  const n = normalize(text);
  if (!n || n.length < 3 || !list.length) return false;
  if (matchServiceMention(n, list)) return true;

  const groups = activeMorphologyGroups(list);
  const userTokens = n.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  const userStems = new Set(userTokens.map((tok) => stemToken(tok, groups)));

  for (const s of list) {
    for (const tok of nameTokens(s?.name || '')) {
      const stem = stemToken(tok, groups);
      if (userStems.has(stem) || userStems.has(tok) || n.includes(tok)) return true;
    }
  }
  for (const group of groups) {
    if (group.some((g) => userStems.has(g) || n.includes(g))) return true;
  }
  return false;
}

/**
 * @param {string} text
 * @param {{ id: string, name: string }[]} services
 * @returns {{ id: string, name: string } | null}
 */
export function matchServiceMention(text, services) {
  const list = Array.isArray(services) ? services : [];
  const n = normalize(text);
  if (!n || n.length < 3 || !list.length) return null;

  const groups = activeMorphologyGroups(list);

  /** @type {{ id: string, name: string } | null} */
  let best = null;
  let bestLen = 0;
  for (const s of list) {
    const name = normalize(s.name);
    if (name.length >= 3 && n.includes(name) && name.length > bestLen && serviceCoversUserRequest(text, s.name, groups)) {
      best = s;
      bestLen = name.length;
    }
  }
  if (best) return best;

  const tokens = n.split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !SERVICE_STOP_TOKENS.has(t));
  if (!tokens.length) return null;
  const userStems = [...new Set(tokens.map((tok) => stemToken(tok, groups)))];

  /** @type {{ service: { id: string, name: string }, score: number }[]} */
  const ranked = list
    .map((service) => ({ service, score: scoreService(userStems, service, groups) }))
    .filter((row) => row.score > 0 && serviceCoversUserRequest(text, row.service.name, groups))
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return null;
  if (ranked.length === 1) return ranked[0].service;
  if (ranked[0].score > ranked[1].score) return ranked[0].service;
  return null;
}

/**
 * @param {{ name?: string, id?: string, duration_minutes?: number }[]} services
 * @param {'ro' | 'en'} [lang]
 */
export function formatServiceAskMessage(services, lang = 'ro') {
  const list = (Array.isArray(services) ? services : []).filter((s) => s?.name);
  const first = list[0];
  const example = lang === 'en' && first
    ? svcDisplay(first.name, first.id, 'en')
    : (first?.name || (lang === 'en' ? 'service' : 'programare'));
  if (lang === 'en') {
    return waJoin(
      waTitle('Which service would you like?'),
      '',
      'Tap *Services* and pick from the list (duration and price on each option).',
      `Or type the name — e.g. *${example}*.`,
    );
  }
  return waJoin(
    waTitle('Ce serviciu dorești?'),
    '',
    'Apasă *Servicii* și alege din listă (durată și preț apar la fiecare opțiune).',
    `Poți și scrie numele — ex: *${example}*.`,
  );
}

export function bookingExamplePhrase(services, lang = 'ro') {
  const first = (Array.isArray(services) ? services : []).find((s) => s?.name);
  if (lang === 'en') {
    const label = first ? svcDisplay(first.name, first.id, 'en') : null;
    return label ? `${label} Monday at 10` : 'Monday at 10';
  }
  return first?.name ? `${first.name} luni la 10` : 'luni la 10';
}
