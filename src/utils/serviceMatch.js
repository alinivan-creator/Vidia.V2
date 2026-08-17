/**
 * Match a free-text reply to a catalog service.
 * Never auto-picks when the name is missing or ambiguous — duration
 * must come from a service the client actually chose.
 *
 * Morphology aliases (tuns/tunde, etc.) activate only when the catalog
 * already contains that root — so a dental clinic does not inherit barber stems.
 */

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

  /** @type {{ id: string, name: string } | null} */
  let best = null;
  let bestLen = 0;
  for (const s of list) {
    const name = normalize(s.name);
    if (name.length >= 3 && n.includes(name) && name.length > bestLen) {
      best = s;
      bestLen = name.length;
    }
  }
  if (best) return best;

  const groups = activeMorphologyGroups(list);
  const tokens = n.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  if (!tokens.length) return null;
  const userStems = [...new Set(tokens.map((tok) => stemToken(tok, groups)))];

  /** @type {{ service: { id: string, name: string }, score: number }[]} */
  const ranked = list
    .map((service) => ({ service, score: scoreService(userStems, service, groups) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return null;
  if (ranked.length === 1) return ranked[0].service;
  if (ranked[0].score > ranked[1].score) return ranked[0].service;
  return null;
}

import { waJoin, waTitle } from './waCopy.js';

/**
 * @param {{ name?: string, duration_minutes?: number }[]} services
 */
export function formatServiceAskMessage(services) {
  const list = (Array.isArray(services) ? services : []).filter((s) => s?.name);
  const example = list[0]?.name || 'programare';
  return waJoin(
    waTitle('Ce serviciu dorești?'),
    '',
    'Apasă *Servicii* și alege din listă (durată și preț apar la fiecare opțiune).',
    `Poți și scrie numele — ex: *${example}*.`,
  );
}

export function bookingExamplePhrase(services) {
  const first = (Array.isArray(services) ? services : []).find((s) => s?.name);
  return first?.name ? `${first.name} luni la 10` : 'luni la 10';
}
