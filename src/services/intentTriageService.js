import { looksLikeBusinessFactQuestion } from '../utils/businessInfoLookup.js';

/**
 * @typedef {'cancel' | 'reschedule' | 'book' | 'list_appointments' | 'faq' | 'contact' | 'menu' | 'callback' | 'sms_opt_in' | 'sms_opt_out' | 'unknown'} TriageIntent
 *
 * @typedef {Object} TriageResult
 * @property {TriageIntent} intent
 * @property {'high' | 'medium' | 'low'} confidence
 * @property {string} reason
 */

/**
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detect cancel / reschedule intent from free text.
 * Uses substring stems so "anulez", "anulare", "o anulez" match.
 * @param {string} text
 * @returns {'cancel' | 'reschedule' | null}
 */
export function detectModificationIntent(text) {
  const n = normalize(text);
  if (!n) return null;

  const cancelHints = [
    'anulez',
    'anuleaza',
    'anulare',
    'anulari',
    'anulati',
    'cancel',
    'sterge',
    'stergeti',
    'renunt',
    'renunta',
    'nu mai vin',
    'nu mai ajung',
  ];
  if (cancelHints.some((k) => n.includes(k))) {
    return 'cancel';
  }

  const rescheduleHints = [
    'reprogrameaza',
    'reprogramez',
    'reprogramare',
    'reprogramari',
    'reprogram',
    'reschedule',
    'schimb',
    'modific',
    'modificare',
    'muta programarea',
    'alta ora',
    'alta data',
    'alt slot',
    'move my appointment',
    'change my appointment',
  ];
  if (
    rescheduleHints.some((k) => n.includes(k))
    || /\bmut\b/.test(n)
    || /vreau sa (schimb|modific|mut)/.test(n)
    || /\b(move|change)\b/.test(n) && /\b(appointment|booking|slot)\b/.test(n)
  ) {
    return 'reschedule';
  }

  return null;
}

/**
 * Free-text that looks like a new slot search ("vineri la 10", "mâine 14:00").
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeOffTopicChat(text) {
  const n = normalize(text);
  if (!n) return false;
  if (/\b(vremea|vreme|weather|forecast|ploua|rain)\b/.test(n)) return true;
  if (/\b(ai mancat|ce faci|cum te cheama)\b/.test(n)) return true;
  return false;
}

export function looksLikeDatetimeOrSlot(text) {
  const n = normalize(text);
  if (!n) return false;
  if (looksLikeOffTopicChat(n)) return false;
  const days = [
    'luni', 'marti', 'miercuri', 'joi', 'vineri', 'sambata', 'duminica',
    'maine', 'azi', 'poimaine', 'today', 'tomorrow',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  ];
  if (days.some((d) => n.includes(d))) return true;
  if (/\b\d{1,2}\s*(ian|feb|mar|apr|mai|iun|iul|aug|sep|oct|nov|dec)/.test(n)) return true;
  if (/\b(dupa[\s-]*amiaza|dimineata|seara|amiaza)\b/.test(n) && /\d/.test(n)) return true;
  if (/\b\d{1,2}([:.,]h?\d{2})?\b/.test(n) && /\b(la|ora|pe|at|am|pm)\b/.test(n)) return true;
  if (/\b\d{1,2}[:.,]\d{2}\b/.test(n)) return true;
  if (/\b(jumatate|jumate|juma|sfer(?:t)?|fara)\b/.test(n) && /\d/.test(n)) return true;
  return false;
}

/**
 * Exact confirm while waiting for 1 / 2 — not "ok vineri la 10".
 * @param {string} text
 */
export function isExplicitConfirmReply(text) {
  const n = normalize(text);
  return n === '1' || [
    'da',
    'confirm',
    'confirma',
    'ok',
    'okay',
    'yes',
    'sure',
    'bine',
    'merge',
    'perfect',
    'de acord',
  ].includes(n);
}

/**
 * Client accepted the last alternative (employee/service), without a new constraint.
 * Not "1"/"2" — those stay numbered-menu shortcuts.
 * @param {string} text
 */
export function isAffirmativeReply(text) {
  const n = normalize(text);
  if (!n || n === '1' || n === '2') return false;
  if ([
    'da',
    'confirm',
    'confirma',
    'ok',
    'okay',
    'yes',
    'sure',
    'bine',
    'merge',
    'perfect',
    'de acord',
  ].includes(n)) return true;
  return /^(okey|va rog|te rog|da te rog|da va rog|hai|super|excelent|da rog)[\s!.]*$/.test(n);
}

/**
 * Explicit cancel of the pending booking — not a new request that happens to contain "nu".
 * @param {string} text
 */
export function isExplicitCancelReply(text) {
  const n = normalize(text);
  if (n === '2' || n === 'nu' || n === 'cancel') return true;
  if (n === 'anuleaza' || n === 'anulez' || n === 'anulare') return true;
  if (/(^|[^a-z])anuleaza([^a-z]|$)/.test(n)) return true;
  return false;
}

/**
 * Client likely wants the same slot they left pending (after TTL expiry).
 * @param {string} text
 * @param {TriageResult} triage
 */
export function wantsSameExpiredBooking(text, triage) {
  const n = normalize(text);
  if (!n) return false;
  if (isExplicitConfirmReply(text)) return true;
  if (
    ['aceeasi', 'aceeasi ora', 'mai vreau', 'inca vreau', 'reia', 'rezerva'].some((k) => n.includes(k))
  ) {
    return true;
  }
  if (triage.intent === 'book' && !looksLikeDatetimeOrSlot(text)) return true;
  if (/^(salut|buna|hello|hi|hey|ok)[\s!.]*$/i.test(n)) return true;
  return false;
}

/**
 * Client wants to SEE existing bookings, not create a new one.
 * @param {string} text
 */
export function looksLikeExistingAppointmentQuery(text) {
  const n = normalize(text);
  if (!n) return false;
  if (/\b(am uitat|uita)\b/.test(n) && /\b(programar|rezervar)/.test(n)) return true;
  if (/\b(ce|care|cate)\s+(programar|rezervar)/.test(n)) return true;
  if (/\b(programarile|rezervarile|programarea)\s+me[ae]\b/.test(n)) return true;
  if (/\b(arata-mi|arata mi|vezi|spune-mi|spune mi)\s+(programar|rezervar)/.test(n)) return true;
  if (/\bcand\s+(sunt|am)\s+programat\b/.test(n)) return true;
  if (/\bam\s+vreo\s+programare\b/.test(n)) return true;
  if (/\bce\s+programari\s+am\b/.test(n)) return true;
  return false;
}

/**
 * Client wants to CREATE a booking. Bare "programare" inside "ce programări am" is not this.
 * @param {string} text
 */
export function looksLikeNewBookingRequest(text) {
  const n = normalize(text);
  if (!n) return false;
  if (looksLikeExistingAppointmentQuery(n)) return false;
  if (looksLikeBusinessFactQuestion(n)) return false;
  if (looksLikeOffTopicChat(n)) return false;
  if (
    n === 'programare'
    || n === 'rezervare'
    || n === 'book'
    || n === 'o programare'
    || n === 'programare noua'
  ) {
    return true;
  }
  if (/\b(sa ma programez|programeaza-ma|programeaza ma|o programare noua)\b/.test(n)) return true;
  if (/\b(i want to book|want to book|book a|book an)\b/.test(n)) return true;
  if (/\b(haircut|appointment)\b/.test(n) && /\b(want|book|need|please)\b/.test(n)) return true;
  if (/\b(vreau|as vrea|doresc|hai|fac|face|faceti)\b/.test(n) && /\b(programar|rezervar)/.test(n)) {
    return true;
  }
  if (/\b(programez|programeaza)\b/.test(n) && !/\b(ce|care|am uitat)\b/.test(n)) return true;
  if (
    /\b(tuns|tunde|tundeti|tunsoare|barba|aranjat|aranjati|aranjez|haircut)\b/.test(n)
    && !/\b(pret|preturi|cost|cat costa|tarif|orar|orele|durata|cat dureaza|price|hours)\b/.test(n)
    && !looksLikeBusinessFactQuestion(n)
    && !(/\bprogram\b/.test(n) && !/\bprogramar/.test(n))
  ) {
    return true;
  }
  if (
    looksLikeDatetimeOrSlot(n)
    && /\b(la|ora|at|vreau|as vrea|doresc|hai|tuns|programar|rezervar|want|book)\b/.test(n)
    && !(/\bprogram\b/.test(n) && !/\bprogramar/.test(n))
  ) {
    return true;
  }
  return false;
}

/**
 * Instant keyword triage — no LLM. Keeps WhatsApp routing snappy.
 * Order: modify → list existing → callback → book → contact → faq → menu → unknown.
 *
 * @param {string} text
 * @param {{ businessType?: string }} [opts]
 * @returns {TriageResult}
 */
export function triageUserIntent(text, opts = {}) {
  const n = normalize(text);
  if (!n) {
    return { intent: 'unknown', confidence: 'low', reason: 'empty' };
  }

  const mod = detectModificationIntent(text);
  if (mod === 'cancel') {
    return { intent: 'cancel', confidence: 'high', reason: 'modification_cancel' };
  }
  if (mod === 'reschedule') {
    return { intent: 'reschedule', confidence: 'high', reason: 'modification_reschedule' };
  }

  const smsOptOutHints = ['stop sms', 'oprire sms', 'dezabonare sms', 'nu mai vreau sms', 'opt out sms'];
  if (smsOptOutHints.some((k) => n.includes(k)) || n === 'stop') {
    return { intent: 'sms_opt_out', confidence: 'high', reason: 'sms_opt_out' };
  }

  const smsOptInHints = [
    'da sms',
    'vreau sms',
    'accept sms',
    'oferte sms',
    'aboneaza-ma sms',
    'opt in sms',
    'vreau oferte pe sms',
  ];
  if (smsOptInHints.some((k) => n.includes(k))) {
    return { intent: 'sms_opt_in', confidence: 'high', reason: 'sms_opt_in' };
  }

  const callbackHints = [
    'callback',
    'call back',
    'suna-ma',
    'sunati-ma',
    'sa ma sunati',
    'sa ma sune',
    'vreau sa vorbesc',
    'vorbesc cu cineva',
    'cu un om',
    'cu un operator',
    'cu un consultant',
    'cu un specialist',
    'agent uman',
    'persoana reala',
    'reclamatie',
    'reclamatii',
    'urgenta',
    'urgent',
    'nu ma ajuta',
    'nu functioneaza',
    'problema serioasa',
  ];
  if (callbackHints.some((k) => n.includes(k))) {
    return { intent: 'callback', confidence: 'high', reason: 'human_request' };
  }

  if (looksLikeExistingAppointmentQuery(n)) {
    return { intent: 'list_appointments', confidence: 'high', reason: 'list_existing_bookings' };
  }

  if (looksLikeNewBookingRequest(n)) {
    if (opts.businessType === 'consulting') {
      return { intent: 'callback', confidence: 'high', reason: 'consulting_booking_interest' };
    }
    return { intent: 'book', confidence: 'high', reason: 'booking_keyword' };
  }

  const contactHints = [
    'contact',
    'locatie',
    'adresa',
    'telefon',
    'email',
    'unde sunteti',
    'unde va gasesc',
    'cum ajung',
    'harta',
  ];
  if (contactHints.some((k) => n.includes(k))) {
    return { intent: 'contact', confidence: 'high', reason: 'contact_keyword' };
  }

  const faqHints = [
    'pret',
    'preturi',
    'cost',
    'cat costa',
    'tarif',
    'price',
    'prices',
    'detalii',
    'info',
    'informatii',
    'servici',
    'lista',
    'ce oferi',
    'program',
    'orar',
    'orele',
    'hours',
    'deschid',
    'inchid',
    'cand sunteti',
    'durata',
    'cat dureaza',
  ];
  if (faqHints.some((k) => {
    if (k === 'program') return /\bprogram\b/.test(n) && !/\bprogramar/.test(n);
    return n.includes(k);
  })) {
    return { intent: 'faq', confidence: 'high', reason: 'faq_keyword' };
  }

  const menuHints = ['meniu', 'menu', 'start', 'ajutor', 'help', 'optiuni'];
  if (menuHints.some((k) => n === k || n.includes(k))) {
    return { intent: 'menu', confidence: 'high', reason: 'menu_keyword' };
  }

  if (looksLikeGreeting(n)) {
    return { intent: 'menu', confidence: 'high', reason: 'greeting' };
  }

  if (looksLikeBusinessFactQuestion(n)) {
    return { intent: 'unknown', confidence: 'medium', reason: 'business_fact' };
  }

  if (looksLikeOffTopicChat(n)) {
    return { intent: 'unknown', confidence: 'high', reason: 'off_topic_chat' };
  }

  return { intent: 'unknown', confidence: 'low', reason: 'no_keyword_match' };
}

/**
 * Opening hello — not small-talk, not a booking, not off-topic.
 * @param {string} text
 */
export function looksLikeGreeting(text) {
  const n = normalize(text);
  if (!n) return false;
  return /^(salut|salutari|ceau|ciao|buna|buna ziua|buna seara|buna dimineata|hello|hi|hey|servus|noroc)[\s!.]*$/i.test(n);
}

/**
 * True when free text looks like something a human should handle
 * (legal, medical, refunds, complaints, complex ops).
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeOutOfScopeRequest(text) {
  const n = normalize(text);
  if (!n || n.length < 8) return false;

  const outOfScope = [
    'factura',
    'facturare',
    'refund',
    'ramburs',
    'returnez',
    'retur',
    'avocat',
    'legal',
    'gdpr',
    'stergeti datele',
    'diagnostic',
    'tratament medical',
    'prescriptie',
    'angajare',
    'job',
    'cv',
    'parteneriat',
    'colaborare comerciala',
    'oferta personalizata',
    'negociere',
    'discount special',
    'reducere speciala',
  ];
  return outOfScope.some((k) => n.includes(k));
}
