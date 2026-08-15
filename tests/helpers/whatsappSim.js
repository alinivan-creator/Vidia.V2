/**
 * In-memory WhatsApp client. Same extract → hydrate → reduce → present
 * path as the live engine, without Twilio.
 */
import {
  looksLikeGreeting,
  looksLikeNewBookingRequest,
  looksLikeExistingAppointmentQuery,
  looksLikeDatetimeOrSlot,
  looksLikeOffTopicChat,
  looksLikeOutOfScopeRequest,
  triageUserIntent,
  isExplicitConfirmReply,
  isExplicitCancelReply,
} from '../../src/services/intentTriageService.js';
import {
  resolveDeterministicInbound,
  resolveExplicitSlot,
  matchServiceMention,
  recoverSoftParserIntent,
} from '../../src/services/turnExtract.js';
import { looksLikeBusinessFactQuestion, lookupBusinessInfo, formatBusinessInfoReply } from '../../src/utils/businessInfoLookup.js';
import { detectClientLanguage } from '../../src/utils/clientLanguage.js';
import { hydrateExtract, isFreshMenuStart } from '../../src/services/turnExecute.js';
import {
  emptyDraft,
  reduceBookingTurn,
  hydrateCatalogService,
  readDraftBooking,
  nextActionFromDraft,
  mapSessionState,
  toConversationStep,
  sessionKeepsChosenService,
  afterSlotCheck,
  MACHINE_ACTIONS,
} from '../../src/lib/booking/stateMachine.js';
import { renderHandlerResult } from '../../src/services/turnPresent.js';
import { BOOKING_WAIT, getBookingWait } from '../../src/services/bookingWaitState.js';
import { readLastMenu } from '../../src/db/conversationStateService.js';
import {
  getBookingConfig,
  getConfiguredBusinessHours,
  formatBusinessHoursText,
  localToUtc,
  intervalOverlapMinutes,
  SLOT_OVERLAP_GRACE_MINUTES,
} from '../../src/utils/datetime.js';
import { assertWithinWorkingHours, resolveServiceDurationMinutes, getHoursForDate } from '../../src/utils/workingHours.js';
import { BOOKING_PREFIXES } from '../../src/services/flowIds.js';

export const TZ = 'Europe/Bucharest';
export const NOW = new Date('2026-08-15T13:00:00.000Z');

export const WEEKEND_CLOSED = {
  '0': null,
  '1': { open: '09:00', close: '18:00' },
  '2': { open: '09:00', close: '18:00' },
  '3': { open: '09:00', close: '18:00' },
  '4': { open: '09:00', close: '18:00' },
  '5': { open: '09:00', close: '18:00' },
  '6': null,
};

export const ROBOT = /admin|invent|setat încă|configurat în admin|hardcod/i;

const ENTRY_MENU = {
  kind: 'entry',
  options: [
    { id: 'book', title: 'Programare' },
    { id: 'info', title: 'Detalii & Prețuri' },
    { id: 'contact', title: 'Contact & Locație' },
  ],
};
const CONFIRM_MENU = {
  kind: 'confirm',
  options: [
    { id: BOOKING_PREFIXES.CONFIRM, title: '✅ Confirm' },
    { id: BOOKING_PREFIXES.CANCEL, title: '❌ Anulează' },
  ],
};

export function makeTenant({
  name,
  services,
  hours = WEEKEND_CLOSED,
  businessInfo = {},
  aiFacts = '',
  businessType = 'booking',
}) {
  return {
    name,
    timezone: TZ,
    business_type: businessType,
    menu_buttons: [
      { id: 'book', label: 'Programare', action: 'start_booking' },
      { id: 'info', label: 'Detalii', action: 'show_info' },
      { id: 'contact', label: 'Contact', action: 'show_contact' },
    ],
    booking_settings: {
      business_hours: hours,
      services,
      business_info: businessInfo,
      ai_facts: aiFacts,
    },
    services,
  };
}

function emptyExtract(overrides = {}) {
  return {
    action: 'unknown',
    service_id: null,
    service_name: null,
    employee_id: null,
    date_text: null,
    time_text: null,
    datetime: null,
    slot_id: null,
    source: 'parser',
    ...overrides,
  };
}

function catalogMenu(business) {
  return {
    kind: 'service',
    options: getBookingConfig(business).services.map((s) => ({
      id: `${BOOKING_PREFIXES.SERVICE}${s.id}`,
      title: s.name,
    })),
  };
}

function extractTurn(text, conv, business, now) {
  const wait = getBookingWait(conv);
  const lastMenu = readLastMenu(conv);
  const step = conv.current_step;
  const services = getBookingConfig(business).services;
  const pendingDateKey = typeof conv.context_data?.pending_date_text === 'string'
    ? conv.context_data.pending_date_text
    : null;
  const hoursWhen = pendingDateKey ? localToUtc(pendingDateKey, '12:00', TZ) : now;
  const dayHours = getHoursForDate(business, hoursWhen).dayHours;
  const inModify = step === 'RESCHEDULING' || step === 'MODIFYING' || conv.context_data?.mode === 'reschedule';

  if (looksLikeExistingAppointmentQuery(text)) {
    return emptyExtract({ action: 'list_appointments', source: 'keyword' });
  }
  if (looksLikeBusinessFactQuestion(text)) {
    return emptyExtract({ action: 'missing_info', source: 'keyword' });
  }
  if (looksLikeOffTopicChat(text)) {
    return emptyExtract({ action: 'off_topic', source: 'keyword' });
  }

  const triageEarly = triageUserIntent(text, { businessType: business.business_type });
  if (
    looksLikeOutOfScopeRequest(text)
    && triageEarly.intent !== 'faq'
    && triageEarly.intent !== 'book'
    && triageEarly.intent !== 'contact'
    && triageEarly.intent !== 'menu'
    && triageEarly.intent !== 'list_appointments'
  ) {
    return emptyExtract({ action: 'callback', source: 'keyword' });
  }

  const onConfirm = step === 'waiting_for_confirmation'
    || step === 'CONFIRMING'
    || wait === BOOKING_WAIT.CONFIRMATION;
  if (onConfirm && isExplicitConfirmReply(text) && !looksLikeDatetimeOrSlot(text)) {
    return emptyExtract({ action: 'confirm', source: 'state' });
  }
  if (onConfirm && isExplicitCancelReply(text) && !looksLikeDatetimeOrSlot(text)) {
    return emptyExtract({ action: 'cancel_pending', source: 'state' });
  }

  const deterministic = resolveDeterministicInbound({
    textBody: text,
    lastMenu,
    wait,
    timezone: TZ,
    pendingDateKey,
    business,
    inModify,
    dayHours,
    now,
  });
  if (deterministic) return deterministic;

  const triage = triageUserIntent(text, { businessType: business.business_type });
  const explicit = resolveExplicitSlot(text, business, now);
  if (explicit?.dateKey && explicit?.timeHHmm && triage.intent !== 'cancel') {
    const named = matchServiceMention(text, services);
    return emptyExtract({
      action: triage.intent === 'reschedule' || inModify ? 'reschedule' : 'book',
      date_text: explicit.dateKey,
      time_text: explicit.timeHHmm,
      datetime: explicit.datetime,
      service_id: named?.id ?? null,
      service_name: named?.name ?? null,
      source: 'parser',
    });
  }

  if (
    triage.intent !== 'faq'
    && triage.intent !== 'contact'
    && triage.intent !== 'cancel'
    && !looksLikeDatetimeOrSlot(text)
    && !looksLikeBusinessFactQuestion(text)
  ) {
    const named = matchServiceMention(text, services);
    if (named) {
      return emptyExtract({
        action: wait === BOOKING_WAIT.SERVICE ? 'select_service' : 'book',
        service_id: named.id,
        service_name: named.name,
        source: 'parser',
      });
    }
  }

  if (triage.intent === 'callback') {
    return emptyExtract({ action: 'callback', source: 'keyword' });
  }
  if (triage.intent === 'list_appointments') {
    return emptyExtract({ action: 'list_appointments', source: 'keyword' });
  }
  if (triage.intent === 'menu' || looksLikeGreeting(text)) {
    return emptyExtract({ action: 'menu', source: 'keyword' });
  }
  if (triage.intent === 'faq') {
    const n = text.toLowerCase();
    const hours = /\b(program|orar|orele|hours)\b/.test(n) && !/\bprogramar/.test(n);
    const prices = /\b(pret|preț|price|prices|cost)\b/.test(n);
    return emptyExtract({
      action: hours && prices ? 'hours_and_services' : hours ? 'hours' : 'services',
      source: 'keyword',
    });
  }
  if (triage.intent === 'contact') return emptyExtract({ action: 'contact', source: 'keyword' });
  if (triage.intent === 'cancel') return emptyExtract({ action: 'cancel', source: 'keyword' });
  if (triage.intent === 'reschedule') return emptyExtract({ action: 'reschedule', source: 'keyword' });
  if (triage.intent === 'book' || looksLikeNewBookingRequest(text)) {
    return emptyExtract({ action: 'book', source: 'keyword' });
  }

  const stolen = recoverSoftParserIntent(
    { action: 'off_topic', confidence: 'low', source: 'nlu' },
    text,
    triage,
    inModify,
  );
  return emptyExtract({ action: stolen.action, source: stolen.source || 'nlu' });
}

function persistReduced(conv, reduced, lastMenu = undefined) {
  const step = toConversationStep(reduced.state);
  const draft = reduced.draft;
  conv.current_step = step;
  conv.context_data = {
    ...conv.context_data,
    draft_booking: draft,
    pending_date_text: draft.date,
    pending_time_text: draft.time,
    pending_service_id: draft.service_id,
    booking_wait: getBookingWait({ current_step: step, context_data: { draft_booking: draft } }),
    last_menu: lastMenu === undefined ? conv.context_data.last_menu : lastMenu,
  };
}

function replyFor(business, action, draft, extra = {}) {
  const lang = extra.lang || 'ro';
  const machine = [
    MACHINE_ACTIONS.ACTION_ASK_SERVICE,
    MACHINE_ACTIONS.ACTION_ASK_DATE,
    MACHINE_ACTIONS.ACTION_ASK_TIME,
    MACHINE_ACTIONS.ACTION_ASK_DATE_TIME,
    MACHINE_ACTIONS.ACTION_ASK_CLARIFICATION,
    MACHINE_ACTIONS.ACTION_SLOT_UNAVAILABLE,
    MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION,
  ].includes(action);
  return renderHandlerResult(business, {
    status: 'SUCCESS',
    user_message_template_key: extra.key || 'CHAT_FALLBACK',
    machine_action: machine ? action : null,
    data: {
      business_name: business.name,
      service_name: draft.service_name,
      date_key: draft.date,
      time_hhmm: draft.time,
      services: extra.services || getBookingConfig(business).services,
      alternatives: extra.alternatives || [],
      occupied_label: extra.occupied_label || null,
      hours_configured: true,
      hours_text: formatBusinessHoursText(getConfiguredBusinessHours(business) || {}),
      client_name: extra.client_name || 'Alin Ivan',
      client_language: lang,
      ...extra.data,
    },
  });
}

export function createChat(business, occupied = [], now = NOW) {
  const conv = {
    current_step: 'IDLE',
    context_data: {
      last_menu: ENTRY_MENU,
      draft_booking: emptyDraft(),
      client_language: 'ro',
    },
  };
  const bookings = [...occupied];

  function say(text) {
    const lang = detectClientLanguage(text, conv.context_data.client_language);
    conv.context_data.client_language = lang;
    const extract = extractTurn(text, conv, business, now);
    const hydrated = hydrateExtract(extract, conv, TZ);

    if (hydrated.action === 'menu') {
      conv.current_step = 'IDLE';
      conv.context_data.last_menu = ENTRY_MENU;
      return {
        extract: hydrated,
        action: 'MENU',
        text: replyFor(business, null, emptyDraft(), { key: 'MENU', lang }),
        draft: emptyDraft(),
        lang,
      };
    }
    if (hydrated.action === 'hours') {
      return {
        extract: hydrated,
        action: 'HOURS',
        text: replyFor(business, null, readDraftBooking(conv), { key: 'HOURS_LIST', lang }),
        draft: readDraftBooking(conv),
        lang,
      };
    }
    if (hydrated.action === 'services') {
      return {
        extract: hydrated,
        action: 'SERVICES',
        text: replyFor(business, null, readDraftBooking(conv), { key: 'SERVICES_LIST', lang }),
        draft: readDraftBooking(conv),
        lang,
      };
    }
    if (hydrated.action === 'hours_and_services') {
      return {
        extract: hydrated,
        action: 'HOURS_AND_SERVICES',
        text: replyFor(business, null, readDraftBooking(conv), { key: 'HOURS_AND_SERVICES', lang }),
        draft: readDraftBooking(conv),
        lang,
      };
    }
    if (hydrated.action === 'contact') {
      return {
        extract: hydrated,
        action: 'CONTACT',
        text: replyFor(business, null, emptyDraft(), { key: 'CONTACT', lang }),
        draft: readDraftBooking(conv),
        lang,
      };
    }
    if (hydrated.action === 'off_topic') {
      return {
        extract: hydrated,
        action: 'OFF_TOPIC',
        text: replyFor(business, null, emptyDraft(), { key: 'OFF_TOPIC', lang }),
        draft: readDraftBooking(conv),
        lang,
      };
    }
    if (hydrated.action === 'missing_info') {
      const looked = lookupBusinessInfo(business, text);
      const topicLabel = lang === 'en' ? looked.topicLabelEn : looked.topicLabelRo;
      if (looked.found) {
        return {
          extract: hydrated,
          action: 'ADMIN_FACT',
          text: replyFor(business, null, emptyDraft(), {
            key: 'ADMIN_FACT',
            lang,
            data: { fact: formatBusinessInfoReply(looked, lang) },
          }),
          draft: readDraftBooking(conv),
          lang,
          looked,
        };
      }
      return {
        extract: hydrated,
        action: 'MISSING_INFO',
        text: replyFor(business, null, emptyDraft(), {
          key: 'MISSING_INFO',
          lang,
          data: { topic_label: topicLabel },
        }),
        draft: readDraftBooking(conv),
        lang,
        looked,
      };
    }
    if (hydrated.action === 'confirm') {
      const draft = readDraftBooking(conv);
      bookings.push({
        service_id: draft.service_id,
        service_name: draft.service_name,
        date: draft.date,
        time: draft.time,
        start: localToUtc(draft.date, draft.time, TZ),
        end: new Date(localToUtc(draft.date, draft.time, TZ).getTime() + Number(draft.duration || 30) * 60_000),
      });
      conv.current_step = 'IDLE';
      const textOut = replyFor(business, null, draft, {
        key: 'CONFIRMATION_BOOKED',
        lang,
        data: { slot_label: `${draft.date} ${draft.time}` },
      });
      return { extract: hydrated, action: 'CONFIRMED', text: textOut, draft, lang };
    }
    if (hydrated.action === 'cancel_pending' || hydrated.action === 'cancel') {
      conv.current_step = 'IDLE';
      conv.context_data.draft_booking = emptyDraft();
      conv.context_data.mode = null;
      return {
        extract: hydrated,
        action: 'CANCELLED',
        text: replyFor(business, null, emptyDraft(), { key: 'CANCEL_PENDING', lang }),
        draft: emptyDraft(),
        lang,
      };
    }
    if (hydrated.action === 'list_appointments') {
      const rows = bookings.map((b) => ({
        service_name: b.service_name,
        slot_label: `${b.date} ${b.time}`,
      }));
      return {
        extract: hydrated,
        action: 'LIST_APPOINTMENTS',
        text: replyFor(business, null, emptyDraft(), {
          key: 'MY_APPOINTMENTS',
          lang,
          data: { appointments: rows },
        }),
        draft: readDraftBooking(conv),
        lang,
      };
    }
    if (hydrated.action === 'callback') {
      return {
        extract: hydrated,
        action: 'CALLBACK',
        text: replyFor(business, null, emptyDraft(), { key: 'CALLBACK_SENT', lang }),
        draft: readDraftBooking(conv),
        lang,
      };
    }

    let draft = hydrateCatalogService(readDraftBooking(conv), business);
    const namedThisTurn = Boolean(hydrated.service_id || hydrated.service_name);
    const keep = namedThisTurn || sessionKeepsChosenService(mapSessionState(conv.current_step));
    if (isFreshMenuStart(hydrated)) {
      draft = emptyDraft();
    } else if (!keep) {
      draft = emptyDraft({ date: draft.date, time: draft.time });
    }
    if (hydrated.service_id) {
      draft.service_id = hydrated.service_id;
      draft.service_name = hydrated.service_name || draft.service_name;
    }

    let reduced = reduceBookingTurn({
      state: mapSessionState(conv.current_step),
      draft,
      text,
      timezone: TZ,
      extractDate: hydrated.date_text,
      extractTime: hydrated.time_text,
      extractServiceId: hydrated.service_id,
      extractServiceName: hydrated.service_name,
    });
    reduced = { ...reduced, draft: hydrateCatalogService(reduced.draft, business) };
    if (reduced.draft.service_id && reduced.action === MACHINE_ACTIONS.ACTION_ASK_SERVICE) {
      reduced = { ...nextActionFromDraft(reduced.draft), draft: reduced.draft };
    }

    if (reduced.action === MACHINE_ACTIONS.ACTION_CHECK_SLOT) {
      const duration = resolveServiceDurationMinutes(business, {
        id: reduced.draft.service_id,
        name: reduced.draft.service_name,
        duration_minutes: reduced.draft.duration,
      }) || reduced.draft.duration;
      const start = localToUtc(reduced.draft.date, reduced.draft.time, TZ);
      const end = new Date(start.getTime() + Number(duration) * 60_000);
      const hours = assertWithinWorkingHours(business, start, end, lang, now);
      if (!hours.ok) {
        persistReduced(conv, {
          ...reduced,
          state: reduced.state,
          action: MACHINE_ACTIONS.ACTION_ASK_TIME,
        }, null);
        const textOut = renderHandlerResult(business, {
          status: 'ERROR',
          user_message_template_key: 'CLOSED_HOURS',
          data: { client_message: hours.message, client_language: lang },
        });
        return {
          extract: hydrated,
          action: 'CLOSED',
          text: textOut,
          draft: reduced.draft,
          hours: hours.message,
          lang,
        };
      }
      const busy = overlaps(bookings, start, end);
      reduced = afterSlotCheck(reduced, { available: !busy, alternatives: [] });
    }

    let lastMenu;
    if (reduced.action === MACHINE_ACTIONS.ACTION_ASK_SERVICE) lastMenu = catalogMenu(business);
    else if (reduced.action === MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION) lastMenu = CONFIRM_MENU;
    else lastMenu = conv.context_data.last_menu;
    persistReduced(conv, reduced, lastMenu);

    return {
      extract: hydrated,
      action: reduced.action,
      text: replyFor(business, reduced.action, reduced.draft, { lang, alternatives: reduced.alternatives || [] }),
      draft: reduced.draft,
      state: reduced.state,
      lang,
    };
  }

  return { say, conv, bookings, business };
}

function overlaps(occupied, start, end) {
  return occupied.some((ev) => intervalOverlapMinutes(start, end, ev.start, ev.end) > SLOT_OVERLAP_GRACE_MINUTES);
}

export { MACHINE_ACTIONS, emptyDraft };
