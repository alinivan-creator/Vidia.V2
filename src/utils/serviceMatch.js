/**
 * Match a free-text reply to a catalog service.
 * Never auto-picks when the name is missing or ambiguous — duration
 * must come from a service the client actually chose.
 */

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

  const hits = list.filter((s) => {
    const name = normalize(s.name);
    const parts = nameTokens(s.name);
    return tokens.some((t) => name === t || parts.includes(t) || name.includes(t));
  });
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const distinctive = hits.filter((s) => {
      const parts = nameTokens(s.name);
      return tokens.some((t) => parts.includes(t) && !hits.every((h) => nameTokens(h.name).includes(t)));
    });
    if (distinctive.length === 1) return distinctive[0];
  }
  return null;
}

/**
 * @param {{ name?: string, duration_minutes?: number }[]} services
 */
export function formatServiceAskMessage(services) {
  const list = (Array.isArray(services) ? services : []).filter((s) => s?.name);
  if (!list.length) return 'Ce serviciu dorești? Scrie numele lui (ex: *tuns*).';
  const lines = list.map((s, i) => {
    const dur = Number(s.duration_minutes);
    const extra = Number.isFinite(dur) && dur > 0 ? ` (${dur} min)` : '';
    return `${i + 1}. ${s.name}${extra}`;
  });
  return `Ce serviciu dorești?\n${lines.join('\n')}\nRăspunde cu numărul sau numele.`;
}
