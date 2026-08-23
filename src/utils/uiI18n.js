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
    ro: 'Am găsit câteva programări. Pe care o mutăm?',
    en: 'I found a few appointments. Which one should we move?',
  },
  whichToCancel: {
    ro: 'Am găsit câteva programări. Pe care o anulăm?',
    en: 'I found a few appointments. Which one should we cancel?',
  },
  whichAmbiguousMove: {
    ro: 'Am găsit mai multe programări pe intervalul menționat. Care o mutăm?',
    en: 'I found several appointments in that window. Which one should we move?',
  },
  whichAmbiguousCancel: {
    ro: 'Am găsit mai multe programări pe intervalul menționat. Care o anulăm?',
    en: 'I found several appointments in that window. Which one should we cancel?',
  },
  noApptReschedule: {
    ro: 'Nu am găsit o programare activă de modificat. Scrie *programare* pentru una nouă.',
    en: 'I could not find an active appointment to change. Type *booking* for a new one.',
  },
  noApptCancel: {
    ro: 'Nu am găsit o programare activă de anulat. Scrie *programare* pentru una nouă.',
    en: 'I could not find an active appointment to cancel. Type *booking* for a new one.',
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
    ro: 'Când vrei din nou, scrie *programare* — te ajut eu.',
    en: 'When you want another one, type *booking* — I can help.',
  },
  rescheduledTitle: { ro: 'Gata, am mutat programarea', en: 'Done — appointment moved' },
  rescheduledHint: {
    ro: 'Te așteptăm! Dacă mai schimbi ceva, scrie *reprogramare* sau *anulează*.',
    en: 'See you soon! To change again, type *reschedule* or *cancel*.',
  },
  labelNewDate: { ro: 'Noua dată', en: 'New date' },
  cancelAllBtn: { ro: 'Anulează toate', en: 'Cancel all' },
  cancelAllDesc: { ro: 'programări active', en: 'active appointments' },
  entryBooking: { ro: 'Programare', en: 'Booking' },
  entryDetails: { ro: 'Detalii & Prețuri', en: 'Details & prices' },
  entryContact: { ro: 'Contact & Locație', en: 'Contact & location' },
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
  return null;
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
 * Language for the current inbound turn: message text wins, then explicit session pick, then ro.
 * @param {string | null | undefined} textBody
 * @param {Record<string, unknown> | null | undefined} [ctx]
 * @returns {UiLang}
 */
export function resolveTurnLanguage(textBody, ctx = null) {
  const detected = detectSessionLanguageFromText(textBody);
  if (detected) return detected;
  if (hasExplicitSessionLanguage(ctx)) return readSessionLanguage(ctx);
  return 'ro';
}

/**
 * Persist session_language only when text clearly signals a language (never default-lock ro).
 * @param {string | null | undefined} textBody
 * @returns {{ session_language?: UiLang }}
 */
export function sessionLanguagePatchFromText(textBody) {
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
