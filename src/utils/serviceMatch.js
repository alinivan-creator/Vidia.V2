/**
 * Match a free-text reply to a catalog service.
 * Never auto-picks when the name is missing or ambiguous — duration
 * must come from a service the client actually chose.
 */

const ALIAS_GROUPS = [
  ['tuns', 'tunde', 'tundeti', 'tunsoare', 'tunsu'],
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

function stemToken(token) {
  const t = normalize(token);
  for (const group of ALIAS_GROUPS) {
    if (group.some((g) => t === g || t.startsWith(g) || (g.startsWith(t) && t.length >= 4))) {
      return group[0];
    }
  }
  return t;
}

function scoreService(userStems, service) {
  const name = normalize(service.name);
  const parts = nameTokens(service.name).map(stemToken);
  let score = 0;
  for (const stem of userStems) {
    if (name === stem || parts.includes(stem) || name.includes(stem)) score += 1;
  }
  return score;
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

  const tokens = n.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  if (!tokens.length) return null;
  const userStems = [...new Set(tokens.map(stemToken))];

  /** @type {{ service: { id: string, name: string }, score: number }[]} */
  const ranked = list
    .map((service) => ({ service, score: scoreService(userStems, service) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return null;
  if (ranked.length === 1) return ranked[0].service;
  if (ranked[0].score > ranked[1].score) return ranked[0].service;
  return null;
}

/**
 * @param {{ name?: string, duration_minutes?: number }[]} services
 */
export function formatServiceAskMessage(services) {
  const list = (Array.isArray(services) ? services : []).filter((s) => s?.name);
  if (!list.length) return '✨ *Ce serviciu dorești?*\nScrie numele — ex: *tuns*.';
  const lines = list.map((s, i) => {
    const dur = Number(s.duration_minutes);
    const extra = Number.isFinite(dur) && dur > 0 ? ` · ${dur} min` : '';
    return `${i + 1}. ${s.name}${extra}`;
  });
  return `✨ *Ce serviciu dorești?*\n\n${lines.join('\n')}\n\nScrie *numărul* sau *numele*.`;
}
