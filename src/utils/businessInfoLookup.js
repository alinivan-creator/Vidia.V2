/**
 * Tenant FAQ from Admin `booking_settings.business_info` + `ai_facts`.
 * Universal topic detection; answers are never hardcoded per business.
 */

function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** @type {Record<string, { keys: string[], labelRo: string, labelEn: string }>} */
export const FACT_TOPICS = {
  parking: {
    keys: ['parcare', 'parking', 'parchez', 'parcat', 'parcam'],
    labelRo: 'parcare',
    labelEn: 'parking',
  },
  women: {
    keys: ['femei', 'femeie', 'doamne', 'doamna', 'ladies', 'women', 'woman', 'fete'],
    labelRo: 'servicii pentru femei',
    labelEn: 'services for women',
  },
  children: {
    keys: ['copii', 'copil', 'fetita', 'baiat', 'baieti', 'kids', 'children', 'child'],
    labelRo: 'servicii pentru copii',
    labelEn: 'services for children',
  },
};

/**
 * @param {string} text
 * @returns {string | null}
 */
export function detectFactTopic(text) {
  const n = normalize(text);
  if (!n) return null;
  for (const [topic, spec] of Object.entries(FACT_TOPICS)) {
    if (spec.keys.some((k) => n.includes(k))) return topic;
  }
  return null;
}

/**
 * Question about a tenant fact (parking / women / children), not a new booking.
 * @param {string} text
 */
export function looksLikeBusinessFactQuestion(text) {
  const topic = detectFactTopic(text);
  const n = normalize(text);
  // Availability / soft booking questions are not amenity FAQ.
  if (
    /\b(liber|libere|disponibil|disponibile|loc liber|ore libere)\b/.test(n)
    || /\b(seara|dimineata|dupa[\s-]*amiaza|amiaza)\b/.test(n)
  ) {
    if (!topic) return false;
  }
  if (topic) {
    if (/[?]/.test(String(text ?? ''))) return true;
    if (/\b(aveti|avem|tundeti|primiti|acceptati|faceti|do you|have you|are there|is there)\b/.test(n)) {
      return true;
    }
    if (topic === 'parking') return true;
  }
  if (/\b(aveti|avem|acceptati|do you have)\b/.test(n)
    && /\b(wifi|wi-fi|card|pos|numerar|cash|lift|rampa)\b/.test(n)
    && !/\b(programar|rezervar|luni|marti|maine|azi|ora|la \d|liber|disponibil|seara|dimineata)\b/.test(n)
  ) {
    return true;
  }
  // Policy / amenity questions Admin may answer via ai_facts — never invent.
  // Do not steal price/hours FAQ ("ce program aveți?", "care sunt prețurile?").
  // Do not steal soft availability ("mai pe seară aveți liber?").
  if (
    /\b(aveti|avem|primiti|acceptati|lucrati|do you|have you|are there)\b/.test(n)
    && /[?]/.test(String(text ?? ''))
    && !/\b(programar|rezervar|maine|azi|luni|marti|miercuri|joi|vineri|ora|la \d|liber|libere|disponibil|disponibile|seara|dimineata|dupa[\s-]*amiaza)\b/.test(n)
    && !/\b(pret|preturi|price|prices|cost|tarif|program|orar|orele|hours|servici|detalii)\b/.test(n)
  ) {
    return true;
  }
  return false;
}

function readStructuredFlag(info, topic) {
  if (!info || typeof info !== 'object') return { configured: false, value: null, note: null };
  const raw = info[topic];
  const note = typeof info[`${topic}_note`] === 'string' ? info[`${topic}_note`].trim() : '';
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const enabled = raw.enabled ?? raw.value ?? raw.has;
    const nestedNote = typeof raw.note === 'string' ? raw.note.trim() : note;
    if (enabled === true || enabled === 'true') {
      return { configured: true, value: true, note: nestedNote || null };
    }
    if (enabled === false || enabled === 'false') {
      return { configured: true, value: false, note: nestedNote || null };
    }
    return { configured: false, value: null, note: nestedNote || null };
  }
  if (raw === true || raw === 'true' || raw === 1) {
    return { configured: true, value: true, note: note || null };
  }
  if (raw === false || raw === 'false' || raw === 0) {
    return { configured: true, value: false, note: note || null };
  }
  if (typeof raw === 'string' && raw.trim()) {
    return { configured: true, value: true, note: raw.trim() };
  }
  return { configured: false, value: null, note: note || null };
}

function matchAiFactLine(facts, text) {
  if (typeof facts !== 'string' || !facts.trim()) return null;
  const q = normalize(text);
  const tokens = q.split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
  const stop = new Set([
    'vreau', 'aveti', 'avem', 'este', 'sunt', 'pentru', 'aceasta', 'acesta',
    'informatie', 'spune', 'puteti', 'poate', 'despre', 'care',
    'have', 'does', 'your', 'with', 'this', 'that', 'what', 'when',
  ]);
  const keys = tokens.filter((t) => !stop.has(t));
  if (!keys.length) return null;
  const lines = facts.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  return lines.find((line) => {
    const nl = normalize(line);
    return keys.some((k) => nl.includes(k));
  }) || null;
}

/**
 * @param {import('../db/businessService.js').Business | { booking_settings?: Record<string, unknown> }} business
 * @param {string} text
 * @returns {{
 *   found: boolean,
 *   topic: string | null,
 *   topicLabelRo: string | null,
 *   topicLabelEn: string | null,
 *   polarity: 'yes' | 'no' | 'fact' | null,
 *   text: string | null,
 * }}
 */
export function lookupBusinessInfo(business, text) {
  const topic = detectFactTopic(text);
  const spec = topic ? FACT_TOPICS[topic] : null;
  const settings = business?.booking_settings && typeof business.booking_settings === 'object'
    ? business.booking_settings
    : {};
  const info = settings.business_info && typeof settings.business_info === 'object'
    ? settings.business_info
    : {};

  if (topic) {
    const structured = readStructuredFlag(info, topic);
    if (structured.configured) {
      return {
        found: true,
        topic,
        topicLabelRo: spec.labelRo,
        topicLabelEn: spec.labelEn,
        polarity: structured.value ? 'yes' : 'no',
        text: structured.note,
      };
    }
  }

  const faqHit = matchBusinessFaq(business?.faqs, text);
  if (faqHit) {
    return {
      found: true,
      topic,
      topicLabelRo: spec?.labelRo ?? null,
      topicLabelEn: spec?.labelEn ?? null,
      polarity: 'fact',
      text: faqHit.answer,
    };
  }

  const line = matchAiFactLine(settings.ai_facts, text);
  if (line) {
    return {
      found: true,
      topic,
      topicLabelRo: spec?.labelRo ?? null,
      topicLabelEn: spec?.labelEn ?? null,
      polarity: 'fact',
      text: line,
    };
  }

  return {
    found: false,
    topic,
    topicLabelRo: spec?.labelRo ?? null,
    topicLabelEn: spec?.labelEn ?? null,
    polarity: null,
    text: null,
  };
}

/**
 * Match a client question to a tenant FAQ row (question + answer tokens).
 * @param {Array<{ question?: string, answer?: string }> | null | undefined} faqs
 * @param {string} text
 * @returns {{ question: string, answer: string } | null}
 */
export function matchBusinessFaq(faqs, text) {
  const list = Array.isArray(faqs) ? faqs : [];
  const q = normalize(text);
  if (!q || !list.length) return null;
  const stop = new Set([
    'vreau', 'aveti', 'avem', 'este', 'sunt', 'pentru', 'aceasta', 'acesta',
    'informatie', 'spune', 'puteti', 'poate', 'despre', 'care', 'cum',
    'have', 'does', 'your', 'with', 'this', 'that', 'what', 'when',
    'pot', 'plata', 'please',
  ]);
  const keys = q.split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !stop.has(t));
  if (!keys.length) return null;

  let best = null;
  let bestScore = 0;
  for (const row of list) {
    const question = String(row?.question || '').trim();
    const answer = String(row?.answer || '').trim();
    if (!question || !answer) continue;
    const nq = normalize(question);
    const na = normalize(answer);
    let score = 0;
    if (q.includes(nq) || nq.includes(q)) score += 10;
    for (const k of keys) {
      if (nq.includes(k)) score += 3;
      if (na.includes(k)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = { question, answer };
    }
  }
  if (bestScore >= 3 && best) return best;
  return null;
}

/**
 * Natural reply from Admin data only — never invents a location or extra amenity.
 * @param {ReturnType<typeof lookupBusinessInfo>} looked
 * @param {'ro' | 'en'} [lang]
 */
export function formatBusinessInfoReply(looked, lang = 'ro') {
  if (!looked?.found) return null;
  if (looked.polarity === 'fact' && looked.text) return looked.text;
  if (looked.text && looked.text.length > 12) return looked.text;
  const label = lang === 'en' ? looked.topicLabelEn : looked.topicLabelRo;
  if (looked.polarity === 'yes') {
    if (looked.text) {
      return lang === 'en' ? `Yes — ${looked.text}.` : `Sigur că da, ${looked.text}.`;
    }
    if (looked.topic === 'parking') {
      return lang === 'en' ? 'Yes, we have parking.' : 'Sigur că da, avem parcare.';
    }
    return lang === 'en'
      ? `Yes, we offer ${label}.`
      : `Sigur că da, oferim ${label}.`;
  }
  if (looked.polarity === 'no') {
    if (looked.text) return looked.text;
    if (looked.topic === 'parking') {
      return lang === 'en' ? 'Unfortunately we do not have parking.' : 'Din păcate nu avem parcare.';
    }
    return lang === 'en'
      ? `Unfortunately we do not offer ${label}.`
      : `Din păcate nu oferim ${label}.`;
  }
  return looked.text;
}

/**
 * @param {string | null} topicLabel
 * @param {'ro' | 'en'} [lang]
 */
export function missingBusinessInfoMessage(topicLabel = null, lang = 'ro') {
  if (lang === 'en') {
    return topicLabel
      ? `Unfortunately I don't have information about ${topicLabel} right now. Want me to connect you with someone at the location?`
      : 'Unfortunately I don\'t have that information, so I can\'t answer this question.';
  }
  return topicLabel
    ? `Din păcate, nu dețin informații despre ${topicLabel} în acest moment. Vrei să te pun în legătură directă cu cineva de la locație?`
    : 'Nu dețin această informație, din păcate nu vă pot răspunde la această întrebare.';
}
