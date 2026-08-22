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
  if (/^(english|engleza|engleză|en)$/.test(n)) return 'en';
  if (/^(romana|română|ro)$/.test(n)) return 'ro';
  return null;
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
    const id = String(opt.id || '').toLowerCase();
    let next = title;
    if (title === 'Confirmă' || id.includes('confirm')) next = t('confirmBtn', 'en');
    else if (title === 'Anulează' || id.includes('cancel')) next = t('cancelBtn', 'en');
    else if (/programare/i.test(title) || id.includes('book')) next = 'Booking';
    else if (/^orar$|program$/i.test(title.replace(/^[^\w]+/, '').trim()) || id.includes('hours')) next = 'Hours';
    else if (/contact/i.test(title)) next = 'Contact';
    else if (title === 'Servicii') next = t('listServices', 'en');
    else if (title === 'Zile disponibile') next = t('listDays', 'en');
    else if (title === 'Ore libere') next = t('listTimes', 'en');
    else if (title === 'Programările tale') next = t('listAppointments', 'en');
    return {
      ...opt,
      title: String(next).slice(0, 20),
      ...(opt.description != null
        ? {
          description: opt.description === 'Disponibil'
            ? t('available', 'en')
            : opt.description === 'Din catalog'
              ? t('fromCatalog', 'en')
              : opt.description === 'Programare activă'
                ? t('activeBooking', 'en')
                : opt.description === 'Liber'
                  ? t('freeSlot', 'en')
                  : opt.description,
        }
        : {}),
    };
  });
}

export { UI as UI_I18N_DICT };
