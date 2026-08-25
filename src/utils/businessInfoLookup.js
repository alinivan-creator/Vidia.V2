/**
 * Tenant FAQ from Admin `booking_settings.business_info` + `ai_facts`,
 * plus operational tables already used by booking (employees, services).
 */

import { matchEmployeeMention } from '../db/employeeService.js';
import { matchServiceMention } from './serviceMatch.js';

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
 * "Mihai lucrează la voi?", "aveți pe Stefan?", "does Andrei work here?"
 * Not a booking request — roster / membership fact.
 * @param {string} text
 */
export function looksLikeStaffRosterQuestion(text) {
  const n = normalize(text);
  if (!n) return false;
  if (/\b(programar|rezervar|maine|azi|ora|la \d{1,2})\b/.test(n)) return false;
  if (/\b(cine\s+lucreaza|ce\s+angajati|care\s+angajati|who\s+works|your\s+team|echipa\s+voastra)\b/.test(n)) {
    return true;
  }
  if (/\b(lucreaza|lucrati|works?\s+here|work\s+with\s+you|on\s+(?:your\s+)?(?:staff|team)|in\s+(?:your\s+)?team|face\s+parte|din\s+echipa)\b/.test(n)) {
    return true;
  }
  // "Aveți pe Mihai?" / "Do you have Andrei?"
  if (
    /\b(aveti|avem|exista|is\s+there|do\s+you\s+have)\b/.test(n)
    && /[?]/.test(String(text ?? ''))
    && !/\b(parcare|parking|wifi|card|program|orar|pret|servici|tuns|barba)\b/.test(n)
    && !/\b(programar|rezervar)\b/.test(n)
  ) {
    return true;
  }
  return false;
}

/**
 * "Aveți Tuns Clasic?", "oferiți tuns + barbă?"
 * @param {string} text
 */
export function looksLikeServiceCatalogQuestion(text) {
  const n = normalize(text);
  if (!n) return false;
  if (/\b(programar|rezervar|maine|azi|ora|la \d{1,2}|vreau|as vrea|doresc)\b/.test(n)) return false;
  if (!/[?]/.test(String(text ?? ''))
    && !/\b(aveti|avem|oferiti|faceti|do you\s+offer|have\s+you)\b/.test(n)) {
    return false;
  }
  return /\b(aveti|avem|oferiti|faceti|exista|do you\s+offer|is\s+there)\b/.test(n)
    && /\b(servici|tuns|barba|coafat|vopsit|masaj|tratament|haircut|beard|service)\b/.test(n);
}

/**
 * Question about a tenant fact (parking / women / children / staff roster), not a new booking.
 * @param {string} text
 */
export function looksLikeBusinessFactQuestion(text) {
  if (looksLikeStaffRosterQuestion(text)) return true;
  if (looksLikeServiceCatalogQuestion(text)) return true;
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
  if (
    /\b(aveti|avem|primiti|acceptati|lucrati|lucreaza|do you|have you|are there)\b/.test(n)
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
 * Best-effort person token for roster questions (not catalog services).
 * @param {string} normalized
 * @param {Array<{ name?: string }>} services
 */
function extractPersonGuess(normalized, services) {
  const serviceTokens = new Set();
  for (const s of services || []) {
    for (const tok of normalize(s?.name || '').split(/[^a-z0-9]+/).filter((t) => t.length >= 3)) {
      serviceTokens.add(tok);
    }
  }
  const stop = new Set([
    'lucreaza', 'lucrati', 'aveti', 'avem', 'exista', 'voi', 'voastra', 'voastre',
    'la', 'pe', 'cu', 'din', 'echipa', 'echipei', 'angajat', 'angajati', 'coleg',
    'works', 'here', 'your', 'team', 'staff', 'with', 'have', 'does', 'the',
    'salon', 'salonul', 'clinica', 'programare', 'serviciu',
  ]);
  for (const tok of serviceTokens) stop.add(tok);

  const m = normalized.match(
    /\b(?:pe|la|cu)?\s*([a-z]{2,40})\s+(?:lucreaza|lucrati|works)|(?:lucreaza|lucrati|works)\s+(?:la\s+voi\s+)?([a-z]{2,40})\b/,
  );
  if (m) {
    const raw = m[1] || m[2];
    if (raw && !stop.has(raw)) return raw.charAt(0).toUpperCase() + raw.slice(1);
  }
  const lead = normalized.match(/^([a-z]{2,40})\s+(?:lucreaza|lucrati|works)\b/);
  if (lead && !stop.has(lead[1])) {
    return lead[1].charAt(0).toUpperCase() + lead[1].slice(1);
  }
  const pe = normalized.match(/\b(?:aveti|avem|exista)\s+(?:pe\s+)?([a-z]{2,40})\b/);
  if (pe && !stop.has(pe[1])) {
    return pe[1].charAt(0).toUpperCase() + pe[1].slice(1);
  }
  return null;
}

/**
 * Ground staff/service answers on live operational rows (same data booking uses).
 *
 * @param {Object} params
 * @param {string} params.text
 * @param {Array<{ id?: string, name?: string, active?: boolean, service_ids?: string[] }>} [params.employees]
 * @param {Array<{ id?: string, name?: string }>} [params.services]
 */
export function lookupOperationalInfo({ text, employees = undefined, services = undefined }) {
  const n = normalize(text);
  const staffLoaded = Array.isArray(employees);
  const servicesLoaded = Array.isArray(services);
  const staffList = staffLoaded ? employees.filter((e) => e?.name) : [];
  const serviceList = servicesLoaded ? services.filter((s) => s?.name) : [];

  if (staffLoaded
    && (looksLikeStaffRosterQuestion(text) || /\b(lucreaza|works?\s+here|din\s+echipa|face\s+parte|angajat)\b/.test(n))) {
    const hit = matchEmployeeMention(text, staffList);
    if (hit) {
      const svcNames = serviceList
        .filter((s) => {
          const ids = Array.isArray(hit.service_ids) ? hit.service_ids : [];
          if (!ids.length) return true;
          return ids.includes(s.id);
        })
        .map((s) => s.name)
        .filter(Boolean)
        .slice(0, 4);
      const svcHintRo = svcNames.length ? ` (inclusiv ${svcNames.join(', ')})` : '';
      const svcHintEn = svcNames.length ? ` (including ${svcNames.join(', ')})` : '';
      return {
        found: true,
        topic: 'staff',
        topicLabelRo: 'echipă',
        topicLabelEn: 'team',
        polarity: /** @type {'yes'} */ ('yes'),
        text: null,
        entity_name: hit.name,
        text_ro: `Da, *${hit.name}* e în echipa noastră și poate fi programat${svcHintRo}.`,
        text_en: `Yes, *${hit.name}* is on our team and available for bookings${svcHintEn}.`,
      };
    }

    if (/\b(lucreaza|works?\s+here|din\s+echipa|face\s+parte|aveti\s+pe|do you have)\b/.test(n)) {
      const guess = extractPersonGuess(n, serviceList);
      if (guess) {
        return {
          found: true,
          topic: 'staff',
          topicLabelRo: 'echipă',
          topicLabelEn: 'team',
          polarity: /** @type {'no'} */ ('no'),
          text: null,
          entity_name: guess,
          text_ro: `*${guess}* nu face parte din echipa noastră actuală.`,
          text_en: `*${guess}* is not on our current team.`,
        };
      }
    }

    if (/\b(cine\s+lucreaza|ce\s+angajati|care\s+angajati|who\s+works|your\s+team|echipa)\b/.test(n)
      && staffList.length) {
      const names = staffList.map((e) => e.name).filter(Boolean);
      return {
        found: true,
        topic: 'staff',
        topicLabelRo: 'echipă',
        topicLabelEn: 'team',
        polarity: /** @type {'fact'} */ ('fact'),
        text: null,
        entity_name: null,
        text_ro: `În echipă avem: *${names.join(', ')}*.`,
        text_en: `Our team: *${names.join(', ')}*.`,
      };
    }
  }

  if (servicesLoaded && (looksLikeServiceCatalogQuestion(text) || (
    /\b(aveti|avem|oferiti|faceti)\b/.test(n)
    && /\b(tuns|barba|servici)\b/.test(n)
    && /[?]/.test(String(text ?? ''))
  ))) {
    const svc = matchServiceMention(text, serviceList);
    if (svc) {
      return {
        found: true,
        topic: 'service_catalog',
        topicLabelRo: 'servicii',
        topicLabelEn: 'services',
        polarity: /** @type {'yes'} */ ('yes'),
        text: null,
        entity_name: svc.name,
        text_ro: `Da, oferim *${svc.name}* — poți face o programare scriind *programare*.`,
        text_en: `Yes, we offer *${svc.name}* — type *booking* to schedule.`,
      };
    }
  }

  return {
    found: false,
    topic: null,
    topicLabelRo: null,
    topicLabelEn: null,
    polarity: null,
    text: null,
  };
}

/**
 * @param {import('../db/businessService.js').Business | { booking_settings?: Record<string, unknown>, faqs?: unknown }} business
 * @param {string} text
 * @param {{ employees?: unknown[], services?: unknown[] }} [operational]
 */
export function lookupBusinessInfo(business, text, operational = {}) {
  const fromOps = lookupOperationalInfo({
    text,
    employees: Object.prototype.hasOwnProperty.call(operational, 'employees')
      ? operational.employees
      : undefined,
    services: Object.prototype.hasOwnProperty.call(operational, 'services')
      ? operational.services
      : undefined,
  });
  if (fromOps.found) return fromOps;

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
 * @param {Array<{ question?: string, answer?: string }> | null | undefined} faqs
 * @param {string} text
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
 * @param {ReturnType<typeof lookupBusinessInfo>} looked
 * @param {'ro' | 'en'} [lang]
 */
export function formatBusinessInfoReply(looked, lang = 'ro') {
  if (!looked?.found) return null;
  const en = lang === 'en';
  if (looked.text_ro || looked.text_en) {
    return en ? (looked.text_en || looked.text_ro) : (looked.text_ro || looked.text_en);
  }
  const label = en ? looked.topicLabelEn : looked.topicLabelRo;
  const raw = typeof looked.text === 'string' ? looked.text.trim() : '';
  const rawIsRo = looksMostlyRomanian(raw);

  if (looked.topic === 'staff' && looked.entity_name) {
    if (looked.polarity === 'yes') {
      return en
        ? `Yes, *${looked.entity_name}* is on our team and available for bookings.`
        : `Da, *${looked.entity_name}* e în echipa noastră și poate fi programat.`;
    }
    if (looked.polarity === 'no') {
      return en
        ? `*${looked.entity_name}* is not on our current team.`
        : `*${looked.entity_name}* nu face parte din echipa noastră actuală.`;
    }
  }

  if (looked.polarity === 'yes') {
    if (en) {
      if (looked.topic === 'parking') return 'Yes, we have parking.';
      if (looked.topic === 'card' || /card|payment/i.test(String(label || ''))) {
        return 'Yes, you can pay by card.';
      }
      if (looked.topic === 'pets' || /pet|dog|animal/i.test(String(label || ''))) {
        return 'Yes, pets are welcome.';
      }
      if (raw && !rawIsRo) return `Yes — ${raw}.`;
      return label ? `Yes, we offer ${label}.` : 'Yes.';
    }
    if (raw) return `Sigur că da, ${raw}.`;
    if (looked.topic === 'parking') return 'Sigur că da, avem parcare.';
    return label ? `Sigur că da, oferim ${label}.` : 'Sigur că da.';
  }

  if (looked.polarity === 'no') {
    if (en) {
      if (looked.topic === 'parking') return 'Unfortunately we do not have parking.';
      if (looked.topic === 'pets' || /pet|dog|animal/i.test(String(label || ''))) {
        return 'Unfortunately pets are not allowed.';
      }
      if (raw && !rawIsRo) return raw;
      return label
        ? `Unfortunately we do not offer ${label}.`
        : 'Unfortunately we do not offer that.';
    }
    if (raw) return raw;
    if (looked.topic === 'parking') return 'Din păcate nu avem parcare.';
    return label ? `Din păcate nu oferim ${label}.` : 'Din păcate nu oferim asta.';
  }

  if (raw) {
    if (en && rawIsRo) {
      if (looked.topic === 'card' || /card|plăt|plat/i.test(raw)) {
        return 'Yes, you can pay by card.';
      }
      if (looked.topic === 'pets' || /caine|câine|animal|pet|dog/i.test(raw)) {
        return /nu|not|no\b/i.test(raw)
          ? 'Unfortunately pets are not allowed.'
          : 'Yes, pets are welcome.';
      }
      return label
        ? `Here is what I know about ${label}: please ask the front desk for details in English, or type *contact*.`
        : missingBusinessInfoMessage(null, 'en');
    }
    return raw;
  }

  return null;
}

/**
 * @param {string} text
 */
export function looksMostlyRomanian(text) {
  const s = String(text || '');
  if (/[ăâîșțĂÂÎȘȚ]/u.test(s)) return true;
  return /\b(nu|da|sigur|puteti|puteți|avem|din pacate|din păcate|informație|intrebare|întrebare|plati|plăti|cardul|caine|câine)\b/i.test(s);
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
