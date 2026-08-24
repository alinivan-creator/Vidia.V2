import { looksLikeBusinessFactQuestion } from '../utils/businessInfoLookup.js';
import { isTypedServiceAttempt, matchServiceMention, mentionsCatalogVocabulary } from '../utils/serviceMatch.js';
import { detectTimeWindowFromText, looksLikeAvailabilityQuestion } from '../utils/timeWindow.js';

export { looksLikeAvailabilityQuestion, detectTimeWindowFromText };

/**
 * @typedef {'cancel' | 'reschedule' | 'book' | 'list_appointments' | 'faq' | 'contact' | 'menu' | 'callback' | 'sms_opt_in' | 'sms_opt_out' | 'thanks' | 'unknown'} TriageIntent
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
 * GDPR / data-deletion phrasing — not a booking cancel.
 * @param {string} n already-normalized
 */
function looksLikeDataDeletion(n) {
  return /\b(datele|datele mele|gdpr|contul|account)\b/.test(n)
    && /\b(sterg|sterge|stergere|elimin|anuleaz|anulez)\w*/.test(n);
}

/**
 * Hours / price FAQ — "modificare program" is the schedule, not a booking.
 * @param {string} n already-normalized
 */
function looksLikeHoursOrPriceFaq(n) {
  if (/\bprogramar/.test(n) || /\brezervar/.test(n)) return false;
  return /\b(pret|preturi|cost|tarif|orar|orele|hours|price)\b/.test(n)
    || (/\bprogram\b/.test(n) && !/\bprogramar/.test(n));
}

/**
 * The utterance refers to saved bookings (not the in-flight hold).
 * @param {string} text
 * @returns {boolean}
 */
export function refersToSavedAppointments(text) {
  const n = normalize(text);
  if (!n) return false;
  if (looksLikeCancelAll(n) || looksLikePluralAppointments(n)) return true;
  return /\b(programar|rezervar)\w*/.test(n);
}

/**
 * Clear "thank you" / courtesy — not a booking, not off-topic.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeGratitude(text) {
  const n = normalize(text);
  if (!n) return false;
  // Mixed thanks + booking/modify language is not pure courtesy.
  if (/\b(programar|reprogram|anul|mut\w*|modific|schimb)\w*/.test(n)) return false;

  if (/^(multumesc|multumesc frumos|multumesc mult|mersi|mersi frumos|merci|thanks|thank you|thx|ty|ms|ms frumos)[\s!.❤️🙏]*$/i.test(n)) {
    return true;
  }
  if (/^(iti|va)\s+multumesc[\s!.❤️🙏]*$/i.test(n)) return true;
  if (/^thanks?\s+(a\s+lot|so\s+much)?[\s!.]*$/i.test(n)) return true;
  // Post-flow acknowledgments: "In regula multumesc", "ok multumesc", "este in regula".
  if (/^(in regula|este in regula|e in regula|ok|okay|perfect|bine|super|foarte bine)([,\s!.]+(multumesc|mersi|merci|thanks|frumos|mult))?[\s!.❤️🙏]*$/.test(n)) {
    return true;
  }
  if (/\b(in regula|este in regula|e in regula)\b/.test(n) && /\b(multumesc|mersi|merci|thanks)\b/.test(n)) {
    return true;
  }
  return false;
}

/**
 * Explicit wish to move an already-saved appointment (not the draft being built).
 * "reprogramare" / "vreau să reprogramez" always count.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeExplicitSavedReschedule(text) {
  const n = normalize(text);
  if (!n) return false;
  if (/\breprogram\w*/.test(n) || /\breschedule\b/.test(n)) return true;
  if (/\bmove my appointment\b/.test(n) || /\bchange my appointment\b/.test(n)) return true;
  if (/\b(mut|muta)\w*\s+(programar|rezervar)/.test(n)) return true;
  if (/\b(programar|rezervar)\w*\s+(mea|existenta|confirmata|deja)\b/.test(n)
    && /\b(modific|schimb|mut)\w*/.test(n)) {
    return true;
  }
  return false;
}

/**
 * Client wants to change the booking currently being built (wrong day/time, "modific").
 * Distinct from moving a confirmed appointment.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeInFlightRevision(text) {
  const n = normalize(text);
  if (!n) return false;
  if (looksLikeExplicitSavedReschedule(n)) return false;
  if (looksLikeHoursOrPriceFaq(n)) return false;
  if (/\bam gresit\b/.test(n) || /\bgresesc\b/.test(n) || /\bgresit\b/.test(n)) return true;
  if (/\b(alta|alt)\s+(zi|ziua|ora|data|slot|interval)\b/.test(n)) return true;
  if (/\b(schimb|schimba|schimbam|schimbati)\w*/.test(n)) return true;
  if (/\b(modific|modifica|modificam|modificati)\w*/.test(n)) return true;
  if (/\b(vreau|as vrea|doresc)\s+(sa\s+)?(modific|schimb)\w*/.test(n)) return true;
  return false;
}

/**
 * Prefer keeping date and only re-picking time.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeTimeOnlyRevision(text) {
  const n = normalize(text);
  if (!n) return false;
  if (/\b(ziua|data|zi)\b/.test(n) && !/\b(ora|orei|timpul|slot|interval)\b/.test(n)) return false;
  return /\b(ora|orei|timpul|slot|interval)\b/.test(n);
}

/**
 * Detect cancel / reschedule intent from free text.
 * Stems + colloquial Romanian — must beat NLU book/clarify misreads.
 * @param {string} text
 * @returns {'cancel' | 'reschedule' | null}
 */
export function detectModificationIntent(text) {
  const n = normalize(text);
  if (!n) return null;
  if (looksLikeDataDeletion(n)) return null;
  if (looksLikeGratitude(n)) return null;

  // Avoid "anul 2026" (the year) — not a cancellation.
  const yearAnul = /\banul\s+\d{4}\b/.test(n);

  /** @type {RegExp[]} */
  const cancelPatterns = [
    /\banulez\b/,
    /\banuleaza\b/,
    /\banulare\b/,
    /\banulari\b/,
    /\banulati\b/,
    /\banulam\b/,
    /\bcancel\b/,
    /\bsterg\w*/,
    /\belimin\w*/,
    /\bnu mai vin\b/,
    /\bnu mai ajung\b/,
    /\bnu mai pot veni\b/,
    /\bnu mai vreau (programar|rezervar)/,
    /\b(scoate|scoat)\w*\s+(programar|rezervar)/,
    /\b(renunt|renunta)\s+(la |de la )?(programar|rezervar)/,
    /\brenunt\w*\s+(la |de la )?(ea|o|le|tot|toate)/,
    /\b(vreau|as vrea|doresc|pot)\s+(sa\s+)?(anul|sterg|elimin)\w*/,
    /\b(anul|sterg|elimin)\w*\s+(o\s+|niste\s+|toate\s+|una\s+|ceva\s+)?(programar|rezervar)?/,
    /\b(programar|rezervar)\w*\s+(sa\s+)?(anul|sterg|elimin)\w*/,
  ];
  if (!yearAnul && cancelPatterns.some((re) => re.test(n))) {
    return 'cancel';
  }
  // Bare "renunț" only with a booking noun — otherwise it is abort/pending-cancel.
  if (/\brenunt\w*/.test(n) && /\b(programar|rezervar)\w*/.test(n)) {
    return 'cancel';
  }
  if (/^(renunt|renunta|renuntare)[\s!.]*$/.test(n)) {
    return 'cancel';
  }

  if (looksLikeHoursOrPriceFaq(n)) return null;

  /** @type {RegExp[]} */
  const reschedulePatterns = [
    /\breprogram\w*/,
    /\breschedule\b/,
    /\bmuta\s+programar/,
    /\bmut\s+programar/,
    /\bmodific\w*\s+(programar|rezervar|ora|data|slot)/,
    /\bschimb\w*\s+(programar|rezervar|ora|data)/,
    /\balt\s+(slot|interval)\b/,
    /\bmove my appointment\b/,
    /\bchange my appointment\b/,
    /\b(vreau|as vrea|doresc|pot)\s+(sa\s+)?(reprogram|modific|schimb|mut)\w*/,
    /\b(reprogram|modific|schimb|mut)\w*\s+(programar|rezervar|ora|data)/,
  ];
  if (reschedulePatterns.some((re) => re.test(n))) {
    return 'reschedule';
  }
  if (/\bmut\w*\b/.test(n) && /\b(programar|rezervar|ora|data)\w*\b/.test(n)) {
    return 'reschedule';
  }
  if (/\bmodific\w*/.test(n) && !looksLikeHoursOrPriceFaq(n)) {
    return 'reschedule';
  }
  if (/\bschimb\w*/.test(n) && !looksLikeHoursOrPriceFaq(n)) {
    return 'reschedule';
  }

  return null;
}

/**
 * Explicit "cancel everything" — not a single-booking guess.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeCancelAll(text) {
  const n = normalize(text);
  if (!n) return false;
  if (/\b(cancel all|delete all)\b/.test(n)) return true;
  if (/\b(toate programarile|toate rezervarile|toate orele)\b/.test(n)) return true;
  if (/\b(anuleaz[aă]|anulez|anulare|sterge|sterg|elimin|cancel)\b/.test(n)
      && /\b(tot|totul|toate|pe toate|le pe toate)\b/.test(n)) {
    return true;
  }
  return false;
}

/**
 * Plural / generic appointment phrasing — never auto-pick among many bookings.
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikePluralAppointments(text) {
  const n = normalize(text);
  if (!n) return false;
  if (looksLikeCancelAll(n)) return true;
  return /\b(programarile|rezervarile|pe ambele|ambele programari|toate programar|niste programar)\b/.test(n);
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
  if (['bitcoin', 'crypto', 'fotbal', 'meciul', 'aleger', 'pizza', 'gluma'].some((k) => n.includes(k))) {
    return true;
  }
  return false;
}

export function looksLikeDatetimeOrSlot(text) {
  const n = normalize(text);
  if (!n) return false;
  if (looksLikeOffTopicChat(n)) return false;
  const days = [
    'luni', 'marti', 'miercuri', 'joi', 'vineri', 'sambata', 'duminica',
    'maine', 'azi', 'astazi', 'poimaine', 'ieri', 'alaltaieri', 'today', 'tomorrow', 'yesterday',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  ];
  if (days.some((d) => n.includes(d))) return true;
  if (/\b\d{1,2}\s*(ian|feb|mar|apr|mai|iun|iul|aug|sep|oct|nov|dec)/.test(n)) return true;
  // Soft day-part without a digit still counts (evening / morning availability).
  if (/\b(dupa[\s-]*amiaza|dimineata|seara|amiaza)\b/.test(n)) return true;
  if (/\b\d{1,2}([:.,]h?\d{2})?\b/.test(n) && /\b(la|ora|pe|at|am|pm)\b/.test(n)) return true;
  if (/\b\d{1,2}[:.,]\d{2}\b/.test(n)) return true;
  if (/\b(jumatate|jumate|juma|sfer(?:t)?|fara)\b/.test(n) && /\d/.test(n)) return true;
  if (looksLikeAvailabilityQuestion(n)) return true;
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
/**
 * Client wants to CREATE a booking.
 * @param {string} text
 * @param {{ services?: { id?: string, name?: string }[] }} [opts]
 *   When `services` is provided, a catalog service mention also counts as booking intent
 *   (tenant-aware — no global barber keyword list).
 */
export function looksLikeNewBookingRequest(text, opts = {}) {
  const n = normalize(text);
  if (!n) return false;
  // Never steal cancel/reschedule phrases that also contain "programare".
  if (detectModificationIntent(text)) return false;
  if (looksLikeExistingAppointmentQuery(n)) return false;
  if (looksLikeBusinessFactQuestion(n)) return false;
  if (looksLikeOffTopicChat(n)) return false;
  if (looksLikeAvailabilityQuestion(n)) return true;
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
  // Cold-start: no greeting required — jump straight into booking.
  if (/\b(vreau sa fac|vreau sa facem|as vrea sa fac|doresc sa fac|hai sa fac)\b/.test(n)
    && /\b(programar|rezervar)/.test(n)) {
    return true;
  }
  if (/\b(i want to book|want to book|book a|book an)\b/.test(n)) return true;
  if (/\b(appointment)\b/.test(n) && /\b(want|book|need|please)\b/.test(n)) return true;
  if (/\b(vreau|as vrea|doresc|hai|fac|face|faceti)\b/.test(n) && /\b(programar|rezervar)/.test(n)) {
    return true;
  }
  if (/\b(programez|programeaza)\b/.test(n) && !/\b(ce|care|am uitat)\b/.test(n)) return true;
  if (
    Array.isArray(opts.services)
    && opts.services.length
    && !/\b(pret|preturi|cost|cat costa|tarif|orar|orele|durata|cat dureaza|price|hours)\b/.test(n)
    && !(/\bprogram\b/.test(n) && !/\bprogramar/.test(n))
  ) {
    if (mentionsCatalogVocabulary(n, opts.services)) return true;
  }
  if (
    looksLikeDatetimeOrSlot(n)
    && /\b(la|ora|at|vreau|as vrea|doresc|hai|programar|rezervar|want|book)\b/.test(n)
    && !(/\bprogram\b/.test(n) && !/\bprogramar/.test(n))
  ) {
    return true;
  }
  return false;
}

/**
 * Booking intent without naming a concrete catalog service (not "tuns si vopsit").
 * @param {string} text
 * @param {{ services?: { id?: string, name?: string }[] }} [opts]
 */
export function looksLikeGeneralBookingOnly(text, opts = {}) {
  if (!looksLikeNewBookingRequest(text, opts)) return false;
  const services = Array.isArray(opts.services) ? opts.services : [];
  if (services.length && matchServiceMention(text, services)) return false;
  const n = normalize(text);
  if (
    services.length
    && isTypedServiceAttempt(text)
    && mentionsCatalogVocabulary(n, services)
  ) {
    return false;
  }
  return true;
}

/**
 * Instant keyword triage — no LLM. Keeps WhatsApp routing snappy.
 * Order: modify → list existing → callback → book → contact → faq → menu → unknown.
 *
 * @param {string} text
 * @param {{ businessType?: string, services?: { id?: string, name?: string }[] }} [opts]
 * @returns {TriageResult}
 */
export function triageUserIntent(text, opts = {}) {
  const n = normalize(text);
  if (!n) {
    return { intent: 'unknown', confidence: 'low', reason: 'empty' };
  }

  if (looksLikeGratitude(text)) {
    return { intent: 'thanks', confidence: 'high', reason: 'gratitude' };
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

  if (looksLikeNewBookingRequest(n, opts)) {
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
  // Short stems must be whole words — "preturi" must not match "retur".
  return outOfScope.some((k) => {
    if (k.length <= 5) return new RegExp(`\\b${k.replace(/\s+/g, '\\s+')}\\b`).test(n);
    return n.includes(k);
  });
}
