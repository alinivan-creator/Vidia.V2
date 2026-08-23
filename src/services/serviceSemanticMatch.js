/**
 * Map free-text service requests (EN/RO) to active Supabase catalog rows via LLM.
 * Deterministic substring match runs first in serviceMatch.js; this is the fallback.
 */

import { completeTenantChat } from './aiContextLoader.js';

/**
 * @param {string} raw
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
 * Semantic match: client phrase → catalog service id (Romanian names in DB).
 *
 * @param {Object} params
 * @param {import('../db/businessService.js').Business} params.business
 * @param {string} params.text — client utterance or extracted service phrase
 * @param {{ id: string, name: string }[]} params.services — active catalog
 * @param {string | null} [params.requestId]
 * @returns {Promise<{ id: string, name: string, client_label: string | null } | null>}
 */
export async function matchServiceSemantically({
  business,
  text,
  services,
  requestId = null,
}) {
  const query = String(text ?? '').trim();
  const list = (Array.isArray(services) ? services : []).filter((s) => s?.id && s?.name);
  if (!query || query.length < 3 || !list.length || !business?.id) return null;

  const catalog = list.slice(0, 40).map((s) => ({ id: s.id, name: s.name }));

  const chat = await completeTenantChat({
    businessId: business.id,
    parserMode: true,
    extraSystem: [
      'You map client service requests to EXACT entries from the tenant catalog (Supabase).',
      'Return ONLY JSON: {"service_id":"<uuid|null>","confidence":"high|low"}',
      'Rules:',
      '- service_id MUST be one of the catalog ids below, or null if no honest match',
      '- Catalog names are Romanian; client may write English or Romanian',
      '- Map semantically (e.g. "teeth whitening" → whitening service in catalog)',
      '- Never invent ids or services outside the catalog',
      '- If multiple could match equally, return null',
    ].join('\n'),
    userContent: JSON.stringify({ client_text: query, catalog }),
    temperature: 0,
    maxTokens: 160,
    requestId,
  });

  if (!chat.ok || !chat.text) return null;

  const parsed = parseJsonObject(chat.text);
  const serviceId = typeof parsed?.service_id === 'string' ? parsed.service_id.trim() : null;
  const confidence = String(parsed?.confidence || '').toLowerCase();
  if (!serviceId || confidence === 'low') return null;

  const hit = list.find((s) => s.id === serviceId);
  if (!hit) return null;

  return {
    id: hit.id,
    name: hit.name,
    client_label: query,
  };
}
