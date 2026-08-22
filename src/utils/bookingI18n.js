/**
 * Booking UX copy — RO / EN (presentation only; facts stay from Admin/SSOT).
 */

/** @typedef {'ro' | 'en'} UiLang */

/** @type {Record<string, { ro: string, en: string }>} */
export const BOOKING_UI = {
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
  confirmBooking: { ro: 'Confirmă', en: 'Confirm' },
  cancelBooking: { ro: 'Anulează', en: 'Cancel' },
  addCalendar: { ro: 'Adaugă în calendar', en: 'Add to calendar' },
  seeLocation: { ro: 'Vezi locația', en: 'See location' },
  openCalendar: { ro: 'Deschide calendarul', en: 'Open calendar' },
  listChoose: { ro: 'Alege', en: 'Choose' },
  navPrev: { ro: '‹ Înapoi', en: '‹ Back' },
  navNext: { ro: 'Alte opțiuni ›', en: 'More options ›' },
  navPrevDesc: { ro: 'Pagina anterioară', en: 'Previous page' },
  navNextDesc: { ro: 'Pagina următoare', en: 'Next page' },
  today: { ro: 'Astăzi', en: 'Today' },
  fromCatalog: { ro: 'Din catalog', en: 'From catalog' },
  activeBooking: { ro: 'Programare activă', en: 'Active booking' },
  freeSlot: { ro: 'Liber', en: 'Free' },
};

/**
 * @param {string} key
 * @param {UiLang} [lang]
 */
export function bookingUi(key, lang = 'ro') {
  const row = BOOKING_UI[key];
  if (!row) return key;
  return lang === 'en' ? row.en : row.ro;
}

/** Common entry-menu labels when Admin buttons are in Romanian. */
const ENTRY_LABEL_EN = {
  programare: 'Booking',
  booking: 'Booking',
  orar: 'Hours',
  program: 'Hours',
  contact: 'Contact',
  servicii: 'Services',
  services: 'Services',
};

/**
 * @param {{ id?: string, title?: string }} option
 * @param {UiLang} [lang]
 */
export function localizeMenuOption(option, lang = 'ro') {
  if (lang !== 'en' || !option?.title) return option;
  const id = String(option.id || '').toLowerCase();
  const titleNorm = String(option.title).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const [key, en] of Object.entries(ENTRY_LABEL_EN)) {
    if (id.includes(key) || titleNorm.includes(key)) {
      return { ...option, title: en.slice(0, 20) };
    }
  }
  return option;
}

/**
 * @param {{ id?: string, title?: string }[]} options
 * @param {UiLang} [lang]
 */
export function localizeMenuOptions(options, lang = 'ro') {
  return (options || []).map((o) => localizeMenuOption(o, lang));
}

/**
 * @param {UiLang} lang
 * @param {string | null | undefined} serviceName
 */
export function chooseDayHead(lang, serviceName = null) {
  if (serviceName) {
    return lang === 'en' ? `*Choose a day — ${serviceName}*` : `*Alege ziua — ${serviceName}*`;
  }
  return lang === 'en' ? '*Choose a day*' : '*Alege ziua*';
}

/**
 * @param {UiLang} lang
 * @param {string | null | undefined} serviceName
 */
export function chooseTimeHead(lang, serviceName = null) {
  if (serviceName) {
    return lang === 'en' ? `*Choose a time — ${serviceName}*` : `*Alege ora — ${serviceName}*`;
  }
  return lang === 'en' ? '*Choose a time*' : '*Alege ora*';
}

/**
 * @param {UiLang} lang
 * @param {string | null | undefined} serviceName
 */
export function dayGridBody(lang, serviceName = null) {
  const head = chooseDayHead(lang, serviceName);
  return lang === 'en'
    ? `${head}\n\nTap *Available days* (next 14 days with openings) or type, e.g. *tomorrow at 10*.`
    : `${head}\n\nApasă *Zile disponibile* (următoarele 14 zile cu locuri libere) sau scrie, ex: *mâine la 10*.`;
}

/**
 * @param {UiLang} lang
 * @param {string | null | undefined} dateLabel
 * @param {boolean} [fewButtons]
 */
export function timeGridBody(lang, dateLabel = null, fewButtons = false) {
  const dateLine = dateLabel
    ? (lang === 'en' ? `*Date:* ${dateLabel}` : `*Data:* ${dateLabel}`)
    : null;
  const hint = fewButtons
    ? (lang === 'en' ? 'Tap your preferred time below.' : 'Atinge ora dorită mai jos.')
    : (lang === 'en' ? 'Tap *Free times* and pick a slot.' : 'Apasă *Ore libere* și selectează intervalul.');
  return [dateLine, '', hint].filter(Boolean).join('\n');
}

/**
 * @param {{ name?: string }[]} services
 * @param {UiLang} [lang]
 */
export function serviceAskCopy(services, lang = 'ro') {
  const list = (Array.isArray(services) ? services : []).filter((s) => s?.name);
  const example = list[0]?.name || (lang === 'en' ? 'booking' : 'programare');
  if (lang === 'en') {
    return {
      title: 'Which service would you like?',
      lines: [
        'Tap *Services* and pick from the list (duration and price on each option).',
        `Or type the name — e.g. *${example}*.`,
      ],
    };
  }
  return {
    title: 'Ce serviciu dorești?',
    lines: [
      'Apasă *Servicii* și alege din listă (durată și preț apar la fiecare opțiune).',
      `Poți și scrie numele — ex: *${example}*.`,
    ],
  };
}

/**
 * @param {{ name?: string }[]} services
 * @param {UiLang} [lang]
 */
export function bookingExamplePhrase(services, lang = 'ro') {
  const first = (Array.isArray(services) ? services : []).find((s) => s?.name);
  if (lang === 'en') {
    return first?.name ? `${first.name} Monday at 10` : 'Monday at 10';
  }
  return first?.name ? `${first.name} luni la 10` : 'luni la 10';
}

/**
 * @param {import('./handlerResult.js').HandlerResult} result
 * @param {UiLang} lang
 */
export function stampResultLanguage(result, lang) {
  if (!result || typeof result !== 'object') return result;
  return {
    ...result,
    data: {
      ...(result.data || {}),
      client_language: lang,
    },
  };
}
