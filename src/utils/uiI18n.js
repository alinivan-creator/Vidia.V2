/**
 * Minimal bilingual UI layer (RO / EN).
 *
 * Romanian strings match the stable production copy. English is an optional
 * overlay — when lang is not 'en', callers should keep the existing RO path.
 */

/** @typedef {'ro' | 'en'} UiLang */

/** @type {Record<string, { ro: string, en: string }>} */
const UI = {
  confirmTitle: { ro: 'Confirmi programarea?', en: 'Confirm this booking?' },
  labelClient: { ro: 'Client', en: 'Client' },
  labelSpecialist: { ro: 'Specialist', en: 'Specialist' },
  labelService: { ro: 'Serviciu', en: 'Service' },
  labelWhen: { ro: 'Când', en: 'When' },
  confirmBtn: { ro: 'Confirmă', en: 'Confirm' },
  cancelBtn: { ro: 'Anulează', en: 'Cancel' },
  menuFooter: { ro: 'Cu ce te putem ajuta?', en: 'How can we help you?' },
  listDays: { ro: 'Zile disponibile', en: 'Available days' },
  listTimes: { ro: 'Ore libere', en: 'Free times' },
  listServices: { ro: 'Servicii', en: 'Services' },
  listAppointments: { ro: 'Programările tale', en: 'Your appointments' },
  sectionDays: { ro: 'Zile', en: 'Days' },
  sectionTimes: { ro: 'Ore', en: 'Times' },
  sectionServices: { ro: 'Servicii', en: 'Services' },
  sectionAppointments: { ro: 'Programări', en: 'Appointments' },
  available: { ro: 'Disponibil', en: 'Available' },
  fromCatalog: { ro: 'Din catalog', en: 'From catalog' },
  activeBooking: { ro: 'Programare activă', en: 'Active booking' },
  freeSlot: { ro: 'Liber', en: 'Free' },
  addCalendar: { ro: 'Adaugă în calendar', en: 'Add to calendar' },
  seeLocation: { ro: 'Vezi locația', en: 'See location' },
  openCalendar: { ro: 'Deschide calendarul', en: 'Open calendar' },
  askServiceTitle: { ro: 'Ce serviciu dorești?', en: 'Which service would you like?' },
  askServiceHint: {
    ro: 'Apasă *Servicii* și alege din listă (durată și preț apar la fiecare opțiune).',
    en: 'Tap *Services* and pick from the list (duration and price on each option).',
  },
  askDayTitle: { ro: 'Alege ziua', en: 'Choose a day' },
  askDayHint: {
    ro: 'Apasă *Zile disponibile* și selectează data.',
    en: 'Tap *Available days* and pick a date.',
  },
  askTimeTitle: { ro: 'Alege ora', en: 'Choose a time' },
  askTimeHint: { ro: 'Atinge ora dorită mai jos.', en: 'Tap your preferred time below.' },
  labelDate: { ro: 'Data', en: 'Date' },
  langAckEn: {
    ro: 'Perfect! Continuăm în engleză.',
    en: 'Great! We will continue in English.',
  },
  langAckRo: {
    ro: 'Perfect! Continuăm în română.',
    en: 'Perfect! We will continue in Romanian.',
  },
  bookedTitle: { ro: 'Programare confirmată', en: 'Booking confirmed' },
  bookedSeeYou: { ro: 'Ne vedem curând.', en: 'See you soon.' },
  bookedFooterReschedule: { ro: '*reprogramare*', en: '*reschedule*' },
  bookedFooterCancel: { ro: '*anulează*', en: '*cancel*' },
  gdprTitle: { ro: 'Confidențialitate', en: 'Privacy' },
  gdprBody: {
    ro: 'Folosim datele pentru această programare și pentru comunicări utile (inclusiv SMS).',
    en: 'We use your data for this booking and useful updates (including SMS).',
  },
  gdprStopSms: {
    ro: 'Poți opri SMS-urile scriind *stop sms*.',
    en: 'You can stop SMS messages by typing *stop sms*.',
  },
  gdprLink: { ro: 'Detalii termeni / GDPR', en: 'Terms / privacy details' },
  gdprContact: {
    ro: 'Pentru detalii, scrie *contact*.',
    en: 'For details, type *contact*.',
  },
  mapsAnchor: { ro: 'Pornește spre locație', en: 'Get directions' },
  mapsShort: { ro: 'hartă', en: 'map' },
  switchToEnglishHint: {
    ro: '🇬🇧 Switch to English — type *English*',
    en: '🇬🇧 Switch to English — type *English*',
  },
  switchToEnglishBtn: { ro: 'English', en: 'English' },
  sessionRestarted: {
    ro: 'Sesiune repornită. Cu ce te putem ajuta?',
    en: 'Session restarted. How can we help you?',
  },
  whichToMove: {
    ro: 'Au fost identificate mai multe programări. Selectați programarea pe care doriți să o reprogramați:',
    en: 'Several appointments were found. Please select the appointment you would like to reschedule:',
  },
  whichToCancel: {
    ro: 'Au fost identificate mai multe programări. Selectați programarea pe care doriți să o anulați:',
    en: 'Several appointments were found. Please select the appointment you would like to cancel:',
  },
  whichAmbiguousMove: {
    ro: 'Au fost identificate mai multe programări în intervalul menționat. Selectați programarea pe care doriți să o reprogramați:',
    en: 'Several appointments were found in the specified period. Please select the appointment you would like to reschedule:',
  },
  whichAmbiguousCancel: {
    ro: 'Au fost identificate mai multe programări în intervalul menționat. Selectați programarea pe care doriți să o anulați:',
    en: 'Several appointments were found in the specified period. Please select the appointment you would like to cancel:',
  },
  noApptReschedule: {
    ro: 'Nu a fost găsită o programare activă de reprogramat. Scrieți *programare* pentru o solicitare nouă.',
    en: 'No active appointment was found to reschedule. Type *booking* to start a new request.',
  },
  noApptCancel: {
    ro: 'Nu a fost găsită o programare activă de anulat. Scrieți *programare* pentru o solicitare nouă.',
    en: 'No active appointment was found to cancel. Type *booking* to start a new request.',
  },
  noActiveAppts: {
    ro: 'Nicio programare activă.',
    en: 'No active appointments.',
  },
  myApptsEmptyHint: {
    ro: 'Pentru una nouă: *luni la 17*',
    en: 'For a new one: *Monday at 5pm*',
  },
  cancelledTitle: { ro: 'Am anulat programarea', en: 'Appointment cancelled' },
  cancelledHint: {
    ro: 'Pentru o programare nouă, scrieți *programare*.',
    en: 'To book a new appointment, type *booking*.',
  },
  rescheduledTitle: { ro: 'Programare reprogramată', en: 'Appointment rescheduled' },
  rescheduledHint: {
    ro: 'Vă așteptăm. Pentru modificări ulterioare, scrieți *reprogramare* sau *anulează*.',
    en: 'We look forward to seeing you. To make further changes, type *reschedule* or *cancel*.',
  },
  labelNewDate: { ro: 'Noua dată', en: 'New date' },
  cancelAllBtn: { ro: 'Anulează toate', en: 'Cancel all' },
  cancelAllDesc: { ro: 'programări active', en: 'active appointments' },
  entryBooking: { ro: 'Programare', en: 'Booking' },
  entryDetails: { ro: 'Detalii & Prețuri', en: 'Details & prices' },
  entryContact: { ro: 'Contact & Locație', en: 'Contact & location' },
  /** Typed service not in admin catalog — deterministic, no AI guess. */
  unknownServiceNotInList: {
    ro: 'Ne pare rău, serviciul introdus nu se află în lista noastră. Vă rugăm să alegeți un serviciu din listă.',
    en: "We're sorry, the entered service is not in our list. Please select a service from the list.",
  },
  unknownServiceBody: {
    ro: 'Serviciul *{label}* nu este disponibil în catalogul nostru. Puteți alege din lista de servicii sau solicita contact de la locație.',
    en: 'The service *{label}* is not available in our catalog. You may choose from the service list or request a callback from the business.',
  },
  seeServicesBtn: { ro: 'Vezi servicii', en: 'See services' },
  callbackBtn: { ro: 'Contactează-mă', en: 'Call me back' },
  contactPhone: { ro: 'Telefon', en: 'Phone' },
  contactEmail: { ro: 'Email', en: 'Email' },
  contactAddress: { ro: 'Adresă', en: 'Address' },
  contactHours: { ro: 'Program', en: 'Hours' },
  contactFooter: { ro: 'Vă stăm la dispoziție.', en: 'We are at your service.' },
  firstAvailable: { ro: 'Primul disponibil', en: 'First available' },
  hoursClosed: { ro: 'închis', en: 'closed' },
  languageInfoEn: {
    ro: 'Da — putem continua în engleză. Scrie *English* ca să comutăm.',
    en: 'Yes — this chat is in English. Type *booking*, *hours*, or *contact* anytime.',
  },
  languageInfoRo: {
    ro: 'Da — conversația este în română. Scrie *programare*, *orar* sau *contact* oricând.',
    en: 'Yes — this chat is in Romanian. Type *Română* if you prefer Romanian explicitly.',
  },
  staleChoiceBody: {
    ro: 'Opțiunea selectată nu mai este disponibilă în lista curentă. Vă rugăm alegeți din cel mai recent mesaj sau scrieți *programare*.',
    en: 'The selected option is no longer available on the current list. Please choose from the most recent message or type *booking*.',
  },
  flowCalendarPrompt: {
    ro: '🗓️ Deschide calendarul — alege ziua și ora liberă.',
    en: '🗓️ Open the calendar — pick an open day and time.',
  },
  flowCalendarPromptService: {
    ro: '🗓️ Deschide calendarul pentru *{service}* — alege ziua și ora liberă.',
    en: '🗓️ Open the calendar for *{service}* — pick an open day and time.',
  },
  noFreeTimesForService: {
    ro: 'Nu există intervale disponibile pentru *{service}*{date}.\n\n',
    en: 'There are no available time slots for *{service}*{date}.\n\n',
  },
  emptyInboundHint: {
    ro: 'Nu a fost primit niciun mesaj text. Selectați din meniu sau scrieți *programare*, *orar* sau *contact*.',
    en: 'No text message was received. Please select from the menu or type *booking*, *hours*, or *contact*.',
  },
  chatFallbackBody: {
    ro: 'Mesajul nu a putut fi interpretat. Vă rugăm selectați o opțiune din meniu sau reformulați solicitarea (ex.: *vineri la 11*).',
    en: 'Your message could not be understood. Please select a menu option or rephrase your request (e.g. *Friday at 11*).',
  },
  offTopicBody: {
    ro: 'Vă putem asista cu programări, program de lucru și date de contact. Selectați din meniu sau reformulați solicitarea (ex.: *mâine la 10*).',
    en: 'We can assist you with bookings, business hours, and contact details. Please select from the menu or rephrase your request (e.g. *tomorrow at 10*).',
  },
  specialistNotFoundIntro: {
    ro: 'Specialistul solicitat nu a fost găsit. Vă rugăm alegeți din echipă:',
    en: 'The requested specialist was not found. Please choose from the team:',
  },
  slotUnavailableBody: {
    ro: 'Vă rugăm alegeți o altă oră din listă (sau o altă zi, dacă preferați).',
    en: 'Please choose another time from the list (or another day, if you prefer).',
  },
  smsStoppedTitle: { ro: 'Notificările SMS au fost oprite', en: 'SMS notifications stopped' },
  smsStoppedBody: {
    ro: 'Cu ce vă putem ajuta în continuare?',
    en: 'How may we assist you further?',
  },
};

/**
 * @param {string} key
 * @param {UiLang} [lang]
 * @returns {string}
 */
export function t(key, lang = 'ro') {
  const row = UI[key];
  if (!row) return key;
  return lang === 'en' ? row.en : row.ro;
}

/**
 * Interpolate `{var}` placeholders in a UI string.
 * @param {string} key
 * @param {UiLang} [lang]
 * @param {Record<string, string>} [vars]
 */
export function tf(key, lang = 'ro', vars = {}) {
  let out = t(key, lang);
  for (const [k, v] of Object.entries(vars || {})) {
    out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v ?? ''));
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {UiLang}
 */
export function normalizeUiLang(value) {
  return value === 'en' || value === 'EN' ? 'en' : 'ro';
}

/**
 * Ephemeral session language (conversation only). Defaults to Romanian.
 * @param {Record<string, unknown> | null | undefined} ctx
 * @returns {UiLang}
 */
export function readSessionLanguage(ctx) {
  return normalizeUiLang(ctx?.session_language);
}

/**
 * @param {UiLang} lang
 */
export function languageAck(lang) {
  return lang === 'en' ? t('langAckEn', 'en') : t('langAckRo', 'ro');
}

/**
 * Parse an explicit language choice (button id or typed word).
 * @param {{ textBody?: string | null, buttonPayload?: string | null }} params
 * @returns {UiLang | null}
 */
export function parseLanguageChoice({ textBody, buttonPayload }) {
  const tap = String(buttonPayload ?? '').trim().toLowerCase();
  if (tap === 'lang_en' || tap === 'session_lang_en') return 'en';
  if (tap === 'lang_ro' || tap === 'session_lang_ro') return 'ro';

  const n = String(textBody ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!n) return null;
  if (/^(english|engleza|engleza|en)$/.test(n)) return 'en';
  if (/^(romana|romana|ro)$/.test(n)) return 'ro';
  if (/^(switch to english|switch english|in english)$/.test(n)) return 'en';
  if (/^(switch to romanian|in romanian|in romana)$/.test(n)) return 'ro';
  if (/^(speak english|do you speak english|vorbesti engleza|vorbesti engleza)\??$/.test(n)) return 'en';
  if (/^(speak romanian|do you speak romanian|vorbesti romana|vorbesti romana)\??$/.test(n)) return 'ro';
  return null;
}

/**
 * Twilio Content API locale for WhatsApp templates (controls system hints like list-picker footers).
 * @param {UiLang} lang
 */
export function twilioContentLocale(lang = 'ro') {
  return normalizeUiLang(lang) === 'en' ? 'en' : 'ro';
}

/**
 * Client asks whether the bot speaks a language — answer in session lang, do not switch mid-flow alone.
 * @param {string | null | undefined} textBody
 */
export function isLanguageCapabilityQuestion(textBody) {
  const n = String(textBody ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s'?]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!n) return false;
  return /^(do you speak english|speak english|can you speak english|vorbesti engleza|vorbesti engleza)\??$/.test(n)
    || /^(do you speak romanian|speak romanian|vorbesti romana|vorbesti romana)\??$/.test(n);
}

/**
 * True when the client typed the universal hard-reset command.
 * @param {string | null | undefined} textBody
 */
export function isRestartSessionCommand(textBody) {
  const n = String(textBody ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return n === 'restart session' || n === 'reset session' || n === 'reporneste sesiunea';
}

/** Menu taps / pivot words must never flip session language or turn copy. */
const LANGUAGE_NEUTRAL_UI = new Set([
  'book', 'info', 'contact', 'booking', 'programare', 'servicii', 'services',
  'orar', 'hours', 'meniu', 'menu', 'english', 'romana', 'en', 'ro',
  'restart session', 'reset session', 'reporneste sesiunea',
  'details & prices', 'detalii & preturi', 'contact & location', 'contact & locatie',
  'privacy policy', 'zile disponibile', 'available days', 'ore libere', 'free times',
  'programari', 'appointments', 'servicii', 'consultatie', 'consultation',
]);

/**
 * True for quick-reply ids, entry-menu labels, and pivot commands that must not
 * infer or persist RO/EN from a single English/RO menu title.
 *
 * @param {string | null | undefined} textBody
 * @param {string | null | undefined} [buttonPayload]
 */
export function isLanguageNeutralUiText(textBody, buttonPayload = null) {
  const tap = String(buttonPayload ?? '').trim().toLowerCase();
  if (['book', 'info', 'contact', 'lang_en', 'lang_ro', 'session_lang_en', 'session_lang_ro'].includes(tap)) {
    return true;
  }
  if (isRestartSessionCommand(textBody)) return true;

  const n = normalizeForLanguageDetect(textBody)
    .replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '')
    .trim();
  if (!n) return false;
  if (LANGUAGE_NEUTRAL_UI.has(n)) return true;

  const bare = n.replace(/[&]/g, ' ').replace(/\s+/g, ' ').trim();
  if (LANGUAGE_NEUTRAL_UI.has(bare)) return true;

  // WhatsApp echoes truncated button titles (≤20 chars).
  for (const phrase of LANGUAGE_NEUTRAL_UI) {
    if (phrase.length >= 4 && (n === phrase || n.startsWith(`${phrase} `) || phrase.startsWith(n))) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the conversation already has an explicit RO/EN choice.
 * @param {Record<string, unknown> | null | undefined} ctx
 */
export function hasExplicitSessionLanguage(ctx) {
  return ctx?.session_language === 'en' || ctx?.session_language === 'ro';
}

/**
 * Normalize free text for language heuristics (lowercase, no diacritics, clean punctuation).
 * @param {string} raw
 */
function normalizeForLanguageDetect(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Courtesy openers — excluded from the language signal (analyzed on the remainder). */
const COURTESY_GREETING_RO = /\b(?:salut(?:ari)?|buna(?:\s+(?:ziua|seara|dimineata))?|ceau|ciao|servus|noroc)\b/gi;
const COURTESY_GREETING_EN = /\b(?:hello|hi|hey|good\s+(?:morning|afternoon|evening))\b/gi;

/**
 * Drop leading/trailing courtesy greetings so mixed messages like
 * "Salut, i want an appointment" resolve from the request half.
 * @param {string} normalized — output of normalizeForLanguageDetect
 * @returns {string}
 */
export function stripCourtesyGreetingsForLanguageDetect(normalized) {
  let text = String(normalized ?? '').trim();
  if (!text) return '';

  // Peel greeting chains from both ends ("Hello, salut, I want…" → "I want…").
  for (let i = 0; i < 4; i += 1) {
    const next = text
      .replace(/^(?:salut(?:ari)?|buna(?:\s+(?:ziua|seara|dimineata))?|ceau|ciao|servus|noroc|hello|hi|hey|good\s+(?:morning|afternoon|evening))(?:[,.!?]\s*|\s+)*/i, '')
      .replace(/(?:\s*[,.!?]\s*|\s+)(?:salut(?:ari)?|buna(?:\s+(?:ziua|seara|dimineata))?|ceau|ciao|servus|noroc|hello|hi|hey|good\s+(?:morning|afternoon|evening))$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (next === text) break;
    text = next;
  }

  return text
    .replace(COURTESY_GREETING_RO, ' ')
    .replace(COURTESY_GREETING_EN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Romanian content markers (never courtesy greetings — those are stripped first). */
const RO_CONTENT_MARKERS = /\b(vraiu|vreau|programare|multumesc|te rog|maine|azi|serviciu|orar|cand|poftim|mersi|reprogramare|anuleaza|anulare|sunt|sunteti|aveti|avem|pot|este|fac|face|cat|cat costa|unde|ce|cum)\b/;

/** English content + booking markers (never courtesy greetings — stripped first). */
const EN_CONTENT_MARKERS = /\b(i want|i would like|i'd like|id like|i can|can i|do you|does it|did you|with my|pay with|my (dog|pet|cat)|appoint?ment|anpointment|booking|book a|make an|make a|please|thanks|thank you|how much|available|schedule|reschedule|cancel my|credit card|debit card|move (a |an |my )?|you|your|yours|the|is|are|was|were|have|has|had|will|would|what|when|where|why|how|who|which|this|that|for|free|with|about|any|some|get|got|eat|food|menu|price|cost|offer|included|to make)\b/;

/**
 * Infer conversation language from free text.
 * Returns 'en' or 'ro' when markers are clear; null when ambiguous (use session default).
 *
 * Mixed openers ("Salut, i want…") ignore courtesy greetings and read the request half.
 *
 * @param {string | null | undefined} textBody
 * @returns {UiLang | null}
 */
export function detectSessionLanguageFromText(textBody) {
  const raw = String(textBody ?? '').trim();
  if (!raw || raw.length < 2) return null;
  if (isLanguageNeutralUiText(raw)) return null;

  // Explicit language words are handled by parseLanguageChoice — skip here.
  if (parseLanguageChoice({ textBody: raw })) return null;

  const n = normalizeForLanguageDetect(raw);
  const stripped = stripCourtesyGreetingsForLanguageDetect(n);
  const analyze = stripped.length >= 2 ? stripped : n;

  const hasRoDiacritics = /[ăâîșț]/i.test(raw);
  const hasRo = hasRoDiacritics || RO_CONTENT_MARKERS.test(analyze);
  const hasEn = EN_CONTENT_MARKERS.test(analyze);

  if (hasEn && !hasRo) return 'en';
  if (hasRo && !hasEn) return 'ro';

  // Mixed RO+EN: score content tokens — avoids blocking on "help me with o programare".
  if (hasEn && hasRo) {
    const enHits = (analyze.match(new RegExp(EN_CONTENT_MARKERS.source, 'g')) || []).length;
    const roHits = (analyze.match(new RegExp(RO_CONTENT_MARKERS.source, 'g')) || []).length;
    if (enHits > roHits) return 'en';
    if (roHits > enHits) return 'ro';
  }

  // Greeting-only message — infer from which courtesy opener was used.
  if (stripped.length < 2) {
    const hadEnGreeting = COURTESY_GREETING_EN.test(n);
    const hadRoGreeting = COURTESY_GREETING_RO.test(n);
    if (hadEnGreeting && !hadRoGreeting) return 'en';
    if (hadRoGreeting && !hadEnGreeting) return 'ro';
  }

  return null;
}

/**
 * Language for the current turn.
 * Session lock: once `session_language` is set, all bot copy stays in that language.
 * Before lock, infer from inbound text (courtesy greetings stripped for mixed openers).
 *
 * @param {string | null | undefined} textBody
 * @param {Record<string, unknown> | null | undefined} [ctx]
 * @returns {UiLang}
 */
export function resolveTurnLanguage(textBody, ctx = null) {
  if (hasExplicitSessionLanguage(ctx)) {
    return readSessionLanguage(ctx);
  }
  const detected = detectSessionLanguageFromText(textBody);
  if (detected) return detected;
  return 'ro';
}

/**
 * Persist session_language only when text clearly signals a language (never default-lock ro).
 * @param {string | null | undefined} textBody
 * @param {string | null | undefined} [buttonPayload]
 * @returns {{ session_language?: UiLang }}
 */
export function sessionLanguagePatchFromText(textBody, buttonPayload = null) {
  if (isLanguageNeutralUiText(textBody, buttonPayload)) return {};
  const detected = detectSessionLanguageFromText(textBody);
  return detected ? { session_language: detected } : {};
}

/**
 * Romanian entry-menu body with a discrete English switch hint.
 * @param {UiLang} [lang]
 */
export function entryMenuBodyText(lang = 'ro') {
  if (lang === 'en') return t('menuFooter', 'en');
  return `${t('menuFooter', 'ro')}\n\n${t('switchToEnglishHint', 'ro')}`;
}

/**
 * When the RO menu has a free WhatsApp button slot (max 3), add English.
 * @param {{ id?: string, title?: string }[]} options
 * @param {UiLang} [lang]
 */
export function withEnglishSwitchOption(options, lang = 'ro') {
  const list = Array.isArray(options) ? [...options] : [];
  if (lang === 'en') return list;
  if (list.some((o) => String(o.id || '').toLowerCase() === 'lang_en')) return list;
  if (list.length >= 3) return list;
  list.push({ id: 'lang_en', title: t('switchToEnglishBtn', 'ro') });
  return list;
}

/**
 * Strip leading emoji / pictographs so Admin button labels still match.
 * @param {string} title
 */
function stripMenuDecor(title) {
  return String(title || '')
    .replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '')
    .trim();
}

/**
 * Localize known RO button titles for EN sessions (ids stay unchanged).
 * @param {{ id?: string, title?: string, description?: string }[]} options
 * @param {UiLang} lang
 */
export function localizeMenuOptions(options, lang = 'ro') {
  if (lang !== 'en' || !Array.isArray(options)) return options;
  return options.map((opt) => {
    const title = String(opt.title || '');
    const bare = stripMenuDecor(title);
    const id = String(opt.id || '').toLowerCase();
    let next = title;
    if (title === 'Confirmă' || bare === 'Confirmă' || id.includes('confirm')) next = t('confirmBtn', 'en');
    else if (title === 'Anulează' || bare === 'Anulează' || (id.includes('cancel') && !id.includes('cancel_all'))) {
      next = t('cancelBtn', 'en');
    }
    else if (/anuleaz[aă]\s+toate/i.test(bare) || id.includes('cancel_all')) next = t('cancelAllBtn', 'en');
    else if (/^programare$/i.test(bare) || id.includes('book')) next = t('entryBooking', 'en');
    else if (/detalii|pre[țt]uri|info/i.test(bare) || id.includes('info') || id.includes('detail')) {
      next = t('entryDetails', 'en');
    }
    else if (/^orar$|^program$/i.test(bare) || id.includes('hours')) next = 'Hours';
    else if (/contact/i.test(bare) && /loca[țt]ie/i.test(bare)) next = t('entryContact', 'en');
    else if (/contact/i.test(bare)) next = 'Contact';
    else if (/renun[țt][aă]/i.test(bare) || id.includes('abort')) next = 'Never mind';
    else if (/alte program[aă]ri/i.test(bare) || /^more appointments/i.test(bare)) {
      next = 'More appointments ›';
    }
    else if (/alte op[tț]iuni/i.test(bare) || /^more options/i.test(bare)) {
      next = 'More options ›';
    }
    else if (/[îi]napoi/i.test(bare) || /^‹?\s*back$/i.test(bare)) next = '‹ Back';
    else if (bare === 'Servicii' || title === 'Servicii') next = t('listServices', 'en');
    else if (bare === 'Zile disponibile' || title === 'Zile disponibile') next = t('listDays', 'en');
    else if (bare === 'Ore libere' || title === 'Ore libere') next = t('listTimes', 'en');
    else if (bare === 'Programările tale' || title === 'Programările tale') next = t('listAppointments', 'en');
    else if (/programare/i.test(bare) && !/program[aă]rile/i.test(bare)) next = t('entryBooking', 'en');
    return {
      ...opt,
      title: String(next).slice(0, 20),
      ...(opt.description != null
        ? {
          description: (() => {
            const desc = String(opt.description);
            if (desc === 'Disponibil') return t('available', 'en');
            if (desc === 'Din catalog') return t('fromCatalog', 'en');
            if (desc === 'Programare activă') return t('activeBooking', 'en');
            if (desc === 'Liber') return t('freeSlot', 'en');
            // "Tuns + Barba · Miercuri" → keep service, localize weekday if RO weekday present
            const weekdayMap = {
              Luni: 'Monday', Marti: 'Tuesday', Marți: 'Tuesday',
              Miercuri: 'Wednesday', Joi: 'Thursday', Vineri: 'Friday',
              Sambata: 'Saturday', Sâmbătă: 'Saturday', Duminica: 'Sunday', Duminică: 'Sunday',
            };
            let out = desc;
            for (const [ro, enLabel] of Object.entries(weekdayMap)) {
              if (out.includes(ro)) out = out.replace(ro, enLabel);
            }
            if (/program[aă]ri active/i.test(out)) {
              out = out.replace(/\d+\s*program[aă]ri active/i, (m) => {
                const n = m.match(/\d+/)?.[0] || '';
                return `${n} ${t('cancelAllDesc', 'en')}`;
              });
            }
            return out;
          })(),
        }
        : {}),
    };
  });
}

export { UI as UI_I18N_DICT };
