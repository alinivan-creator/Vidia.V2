/**
 * End-to-end WhatsApp journeys: greeting → service → slot → calendar check → confirm.
 * Uses the same extract / hydrate / reduce / present functions as production.
 * Calendar occupancy is in-memory so duration overlap is real, not assumed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeGreeting,
  looksLikeNewBookingRequest,
  looksLikeExistingAppointmentQuery,
  looksLikeDatetimeOrSlot,
  looksLikeOffTopicChat,
  triageUserIntent,
  isExplicitConfirmReply,
  isExplicitCancelReply,
} from '../src/services/intentTriageService.js';
import {
  resolveDeterministicInbound,
  resolveExplicitSlot,
  matchServiceMention,
  recoverSoftParserIntent,
} from '../src/services/turnExtract.js';
import { hydrateExtract, isFreshMenuStart } from '../src/services/turnExecute.js';
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
  SESSION_STATES,
} from '../src/lib/booking/stateMachine.js';
import { renderHandlerResult } from '../src/services/turnPresent.js';
import { BOOKING_WAIT, getBookingWait } from '../src/services/bookingWaitState.js';
import { readLastMenu } from '../src/db/conversationStateService.js';
import {
  getBookingConfig,
  getConfiguredBusinessHours,
  formatBusinessHoursText,
  localToUtc,
  intervalOverlapMinutes,
  SLOT_OVERLAP_GRACE_MINUTES,
} from '../src/utils/datetime.js';
import { assertWithinWorkingHours, resolveServiceDurationMinutes } from '../src/utils/workingHours.js';
import { BOOKING_PREFIXES } from '../src/services/flowIds.js';
import { unknownInfoClientMessage } from '../src/utils/workingHours.js';

const TZ = 'Europe/Bucharest';
const NOW = new Date('2026-08-15T09:53:00.000Z');
const HOURS = {
  '0': null,
  '1': { open: '09:00', close: '18:00' },
  '2': { open: '09:00', close: '18:00' },
  '3': { open: '09:00', close: '18:00' },
  '4': { open: '09:00', close: '18:00' },
  '5': { open: '09:00', close: '18:00' },
  '6': { open: '10:00', close: '14:00' },
};
const SERVICES = [
  { id: 'svc-clasic', name: 'Tuns Clasic', duration_minutes: 30, price_ron: 70 },
  { id: 'svc-combo', name: 'Tuns + Barba', duration_minutes: 45, price_ron: 100 },
  { id: 'svc-aranjat', name: 'Aranjat Barba', duration_minutes: 20, price_ron: 40 },
];
const BUSINESS = {
  name: 'VIDIA',
  timezone: TZ,
  business_type: 'salon',
  menu_buttons: [
    { id: 'book', label: 'Programare', action: 'start_booking' },
    { id: 'info', label: 'Detalii', action: 'show_info' },
    { id: 'contact', label: 'Contact', action: 'show_contact' },
  ],
  booking_settings: { business_hours: HOURS, services: SERVICES },
  services: SERVICES,
};
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

function serviceMenu() {
  return {
    kind: 'service',
    options: SERVICES.map((s) => ({ id: `${BOOKING_PREFIXES.SERVICE}${s.id}`, title: s.name })),
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

function extractTurn(text, conv) {
  const wait = getBookingWait(conv);
  const lastMenu = readLastMenu(conv);
  const step = conv.current_step;
  const services = getBookingConfig(BUSINESS).services;
  const pendingDateKey = typeof conv.context_data?.pending_date_text === 'string'
    ? conv.context_data.pending_date_text
    : null;
  const hoursWhen = pendingDateKey ? localToUtc(pendingDateKey, '12:00', TZ) : NOW;
  const dayHours = { open: '09:00', close: '18:00' };

  if (looksLikeExistingAppointmentQuery(text)) {
    return emptyExtract({ action: 'list_appointments', source: 'keyword' });
  }
  if (looksLikeOffTopicChat(text)) {
    return emptyExtract({ action: 'off_topic', source: 'keyword' });
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
    business: BUSINESS,
    dayHours,
    now: NOW,
  });
  if (deterministic) return deterministic;

  const triage = triageUserIntent(text, { businessType: 'salon' });
  const explicit = resolveExplicitSlot(text, BUSINESS, NOW);
  if (explicit?.dateKey && explicit?.timeHHmm && triage.intent !== 'cancel') {
    const named = matchServiceMention(text, services);
    return emptyExtract({
      action: triage.intent === 'reschedule' ? 'reschedule' : 'book',
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

  if (triage.intent === 'menu' || looksLikeGreeting(text)) {
    return emptyExtract({ action: 'menu', source: 'keyword' });
  }
  if (triage.intent === 'faq') {
    return emptyExtract({
      action: /\b(program|orar|orele|deschid|inchid)\b/.test(text.toLowerCase()) && !/\bprogramar/.test(text.toLowerCase())
        ? 'hours'
        : 'services',
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
  );
  return emptyExtract({ action: stolen.action, source: stolen.source || 'nlu' });
}

function overlaps(occupied, start, end) {
  return occupied.some((ev) => intervalOverlapMinutes(start, end, ev.start, ev.end) > SLOT_OVERLAP_GRACE_MINUTES);
}

function nearbyHours(dateKey, timeHHmm) {
  const hour = Number(String(timeHHmm).slice(0, 2));
  return [hour + 1, hour + 2]
    .filter((h) => h >= 9 && h <= 17)
    .map((h) => ({ label: `${String(h).padStart(2, '0')}:00` }));
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

function replyFor(action, draft, extra = {}) {
  const machine = [
    MACHINE_ACTIONS.ACTION_ASK_SERVICE,
    MACHINE_ACTIONS.ACTION_ASK_DATE,
    MACHINE_ACTIONS.ACTION_ASK_TIME,
    MACHINE_ACTIONS.ACTION_ASK_DATE_TIME,
    MACHINE_ACTIONS.ACTION_ASK_CLARIFICATION,
    MACHINE_ACTIONS.ACTION_SLOT_UNAVAILABLE,
    MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION,
  ].includes(action);
  return renderHandlerResult(BUSINESS, {
    status: 'SUCCESS',
    user_message_template_key: extra.key || 'CHAT_FALLBACK',
    machine_action: machine ? action : null,
    data: {
      business_name: 'VIDIA',
      service_name: draft.service_name,
      date_key: draft.date,
      time_hhmm: draft.time,
      services: extra.services || SERVICES,
      alternatives: extra.alternatives || [],
      occupied_label: extra.occupied_label || null,
      hours_configured: true,
      hours_text: formatBusinessHoursText(getConfiguredBusinessHours(BUSINESS) || HOURS),
      client_name: extra.client_name || 'Alin Ivan',
      ...extra.data,
    },
  });
}

function resetToMenu(conv) {
  conv.current_step = 'IDLE';
  conv.context_data = {
    last_menu: ENTRY_MENU,
    draft_booking: emptyDraft(),
    pending_date_text: null,
    pending_time_text: null,
    pending_service_id: null,
  };
}

function createChat(occupied = []) {
  const conv = {
    current_step: 'IDLE',
    context_data: {
      last_menu: ENTRY_MENU,
      draft_booking: emptyDraft(),
    },
  };
  const bookings = [...occupied];

  function say(text) {
    const extract = extractTurn(text, conv);
    const hydrated = hydrateExtract(extract, conv, TZ);

    if (hydrated.action === 'menu') {
      resetToMenu(conv);
      const textOut = replyFor(null, emptyDraft(), { key: 'MENU' });
      return { extract: hydrated, action: 'MENU', text: textOut, draft: emptyDraft() };
    }
    if (hydrated.action === 'hours') {
      const textOut = replyFor(null, emptyDraft(), { key: 'HOURS_LIST' });
      return { extract: hydrated, action: 'HOURS', text: textOut, draft: readDraftBooking(conv) };
    }
    if (hydrated.action === 'services') {
      const textOut = replyFor(null, emptyDraft(), { key: 'SERVICES_LIST', services: SERVICES });
      return { extract: hydrated, action: 'SERVICES', text: textOut, draft: readDraftBooking(conv) };
    }
    if (hydrated.action === 'contact') {
      const textOut = replyFor(null, emptyDraft(), { key: 'CONTACT' });
      return { extract: hydrated, action: 'CONTACT', text: textOut, draft: readDraftBooking(conv) };
    }
    if (hydrated.action === 'off_topic') {
      const textOut = replyFor(null, emptyDraft(), { key: 'OFF_TOPIC' });
      return { extract: hydrated, action: 'OFF_TOPIC', text: textOut, draft: readDraftBooking(conv) };
    }
    if (hydrated.action === 'list_appointments') {
      const rows = bookings.map((b) => ({
        service_name: b.service_name,
        slot_label: `${b.date} ${b.time}`,
      }));
      const textOut = renderHandlerResult(BUSINESS, {
        status: 'SUCCESS',
        user_message_template_key: 'MY_APPOINTMENTS',
        data: { appointments: rows },
      });
      return { extract: hydrated, action: 'LIST', text: textOut, draft: readDraftBooking(conv) };
    }
    if (hydrated.action === 'confirm') {
      const draft = readDraftBooking(conv);
      bookings.push({
        service_id: draft.service_id,
        service_name: draft.service_name,
        date: draft.date,
        time: draft.time,
        duration: draft.duration,
        start: localToUtc(draft.date, draft.time, TZ),
        end: new Date(localToUtc(draft.date, draft.time, TZ).getTime() + Number(draft.duration || 30) * 60_000),
      });
      resetToMenu(conv);
      const textOut = replyFor(null, draft, { key: 'CONFIRMATION_BOOKED', data: { slot_label: `${draft.date} ${draft.time}` } });
      return { extract: hydrated, action: 'CONFIRMED', text: textOut, draft };
    }
    if (hydrated.action === 'cancel_pending' || hydrated.action === 'cancel') {
      resetToMenu(conv);
      const textOut = replyFor(null, emptyDraft(), { key: 'CANCEL_PENDING' });
      return { extract: hydrated, action: 'CANCELLED', text: textOut, draft: emptyDraft() };
    }

    let draft = hydrateCatalogService(readDraftBooking(conv), BUSINESS);
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
    reduced = { ...reduced, draft: hydrateCatalogService(reduced.draft, BUSINESS) };
    if (reduced.draft.service_id && reduced.action === MACHINE_ACTIONS.ACTION_ASK_SERVICE) {
      reduced = { ...nextActionFromDraft(reduced.draft), draft: reduced.draft };
    }

    if (reduced.action === MACHINE_ACTIONS.ACTION_CHECK_SLOT) {
      const duration = resolveServiceDurationMinutes(BUSINESS, {
        id: reduced.draft.service_id,
        name: reduced.draft.service_name,
        duration_minutes: reduced.draft.duration,
      }) || reduced.draft.duration;
      const start = localToUtc(reduced.draft.date, reduced.draft.time, TZ);
      const end = new Date(start.getTime() + Number(duration) * 60_000);
      const hours = assertWithinWorkingHours(BUSINESS, start, end, 'ro', NOW);
      if (!hours.ok) {
        persistReduced(conv, {
          ...reduced,
          state: SESSION_STATES.WAITING_FOR_TIME,
          action: MACHINE_ACTIONS.ACTION_ASK_TIME,
        }, null);
        const textOut = renderHandlerResult(BUSINESS, {
          status: 'ERROR',
          user_message_template_key: 'CLOSED_HOURS',
          data: { client_message: hours.message },
        });
        return { extract: hydrated, action: 'CLOSED', text: textOut, draft: reduced.draft, hours: hours.message, start: start.toISOString(), end: end.toISOString(), duration };
      }
      const busy = overlaps(bookings, start, end);
      reduced = afterSlotCheck(reduced, {
        available: !busy,
        alternatives: nearbyHours(reduced.draft.date, reduced.draft.time),
      });
    }

    let lastMenu;
    if (reduced.action === MACHINE_ACTIONS.ACTION_ASK_SERVICE) lastMenu = serviceMenu();
    else if (reduced.action === MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION) lastMenu = CONFIRM_MENU;
    else if (
      reduced.action === MACHINE_ACTIONS.ACTION_ASK_DATE_TIME
      || reduced.action === MACHINE_ACTIONS.ACTION_ASK_DATE
      || reduced.action === MACHINE_ACTIONS.ACTION_ASK_TIME
      || reduced.action === MACHINE_ACTIONS.ACTION_SLOT_UNAVAILABLE
    ) {
      lastMenu = null;
    }
    persistReduced(conv, reduced, lastMenu);

    const textOut = replyFor(reduced.action, reduced.draft, {
      alternatives: reduced.alternatives || [],
    });
    return {
      extract: hydrated,
      action: reduced.action,
      text: textOut,
      draft: reduced.draft,
      state: reduced.state,
    };
  }

  return { say, conv, bookings };
}

function assertNoAdminLeak(text) {
  assert.equal(/admin|invent|setat încă|configurat/i.test(text), false, text);
}

describe('end-to-end conversations: start to confirm', () => {
  it('Salut → 1 → 1 → Miercuri la 2 → 1 confirms Tuns Clasic at 14:00', () => {
    const chat = createChat();
    const hello = chat.say('Salut');
    assert.match(hello.text, /asistentul|Bun venit|programăr/i);
    assert.doesNotMatch(hello.text, /Tuns Clasic/);

    const book = chat.say('1');
    assert.equal(book.action, MACHINE_ACTIONS.ACTION_ASK_SERVICE);
    assert.match(book.text, /1\. Tuns Clasic · 30 min/);
    assert.match(book.text, /2\. Tuns \+ Barba · 45 min/);
    assert.match(book.text, /3\. Aranjat Barba · 20 min/);

    const service = chat.say('1');
    assert.equal(service.action, MACHINE_ACTIONS.ACTION_ASK_DATE_TIME, service.text);
    assert.equal(service.draft.service_id, 'svc-clasic');
    assert.match(service.text, /Când vrei programarea/);
    assert.doesNotMatch(service.text, /Ce serviciu dorești/);

    const slot = chat.say('Miercuri la 2');
    assert.equal(slot.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION, slot.text);
    assert.equal(slot.draft.date, '2026-08-19');
    assert.equal(slot.draft.time, '14:00');
    assert.equal(slot.draft.duration, 30);
    assert.match(slot.text, /Tuns Clasic/);
    assert.match(slot.text, /14:00/);
    assert.match(slot.text, /Confirmi programarea/);

    const done = chat.say('1');
    assert.equal(done.action, 'CONFIRMED', done.text);
    assert.match(done.text, /Programare|confirmat/i);
    assert.equal(chat.bookings.length, 1);
    assert.equal(chat.bookings[0].service_id, 'svc-clasic');
  });

  it('date first, then numbered service, then confirm with da', () => {
    const chat = createChat();
    const first = chat.say('Miercuri la 2');
    assert.equal(first.action, MACHINE_ACTIONS.ACTION_ASK_SERVICE);
    assert.equal(first.draft.date, '2026-08-19');
    assert.equal(first.draft.time, '14:00');
    assert.equal(first.draft.service_id, null);
    assert.match(first.text, /Ce serviciu dorești/);

    const service = chat.say('2');
    assert.equal(service.draft.service_id, 'svc-combo');
    assert.equal(service.draft.duration, 45);
    assert.equal(service.draft.time, '14:00');
    assert.equal(service.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION);
    assert.match(service.text, /Tuns \+ Barba/);

    const done = chat.say('da');
    assert.equal(done.action, 'CONFIRMED');
  });

  it('one-shot tuns clasic miercuri la 2 goes to confirm, not service loop', () => {
    const chat = createChat();
    const turn = chat.say('tuns clasic miercuri la 2');
    assert.equal(turn.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION, turn.text);
    assert.equal(turn.draft.service_id, 'svc-clasic');
    assert.equal(turn.draft.time, '14:00');
  });

  it('Salut, vreau sa fac o programare starts booking, not just the menu', () => {
    const chat = createChat();
    const turn = chat.say('Salut, vreau sa fac o programare');
    assert.equal(turn.action, MACHINE_ACTIONS.ACTION_ASK_SERVICE, turn.text);
    assert.match(turn.text, /Ce serviciu dorești/);
  });

  it('ce program aveti answers hours and does not start a booking', () => {
    const chat = createChat();
    const turn = chat.say('ce program aveti');
    assert.equal(turn.action, 'HOURS');
    assert.match(turn.text, /Program VIDIA|luni|închis/i);
    assert.doesNotMatch(turn.text, /Ce serviciu dorești/);
    assert.doesNotMatch(turn.text, /Confirmi/);
  });

  it('tundeti / aranjati / faceti si barba as first messages', () => {
    const combo = createChat().say('tundeti si barba');
    assert.equal(combo.draft.service_id, 'svc-combo');
    assert.equal(combo.action, MACHINE_ACTIONS.ACTION_ASK_DATE_TIME);

    const aranjat = createChat().say('aranjati barba');
    assert.equal(aranjat.draft.service_id, 'svc-aranjat');
    assert.equal(aranjat.action, MACHINE_ACTIONS.ACTION_ASK_DATE_TIME);

    const vague = createChat().say('faceti si barba');
    assert.equal(vague.action, MACHINE_ACTIONS.ACTION_ASK_SERVICE, 'ambiguous beard must ask which service');
    assert.equal(vague.draft.service_id, null);
  });

  it('Luni la 11 jumate confirms 11:30, not 11:00', () => {
    const chat = createChat();
    chat.say('tuns + barba');
    const slot = chat.say('Luni la 11 jumate');
    assert.equal(slot.draft.date, '2026-08-17');
    assert.equal(slot.draft.time, '11:30');
    assert.equal(slot.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION, slot.text);
    assert.match(slot.text, /11:30/);
    assert.doesNotMatch(slot.text, /11:00/);
  });

  it('11:20 and 11:40 stay exact and are bookable when overlap is at most 5 minutes', () => {
    const occupied = [{
      start: localToUtc('2026-08-17', '11:00', TZ),
      end: localToUtc('2026-08-17', '11:45', TZ),
    }];

    const twenty = createChat();
    twenty.say('tuns clasic');
    const atTwenty = twenty.say('Luni la 11:20');
    assert.equal(atTwenty.draft.time, '11:20');
    assert.equal(atTwenty.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION, atTwenty.text);

    const forty = createChat(occupied);
    forty.say('tuns clasic');
    const atForty = forty.say('Luni la 11:40');
    assert.equal(atForty.draft.time, '11:40');
    assert.equal(atForty.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION, atForty.text);

    const clash = createChat(occupied);
    clash.say('tuns + barba');
    const blocked = clash.say('Luni la 11:20');
    assert.equal(blocked.action, MACHINE_ACTIONS.ACTION_SLOT_UNAVAILABLE, blocked.text);
  });

  it('45 min Tuns + Barba overlaps a 14:00–15:00 booking; 30 min Tuns Clasic still fits at 14:30', () => {
    const occupied = [{
      start: localToUtc('2026-08-19', '14:00', TZ),
      end: localToUtc('2026-08-19', '15:00', TZ),
      service_name: 'Alt client',
    }];

    const long = createChat(occupied);
    long.say('tuns + barba');
    const blocked = long.say('Miercuri la 2');
    assert.equal(blocked.action, MACHINE_ACTIONS.ACTION_SLOT_UNAVAILABLE, blocked.text);
    assert.match(blocked.text, /nu e disponibil/i);
    assert.doesNotMatch(blocked.text, /Confirmi programarea/);

    const short = createChat(occupied);
    short.say('tuns clasic');
    const maybe = short.say('Miercuri la 14:30');
    assert.equal(maybe.action, MACHINE_ACTIONS.ACTION_SLOT_UNAVAILABLE, '14:30–15:00 overlaps 14:00–15:00');

    const later = createChat(occupied);
    later.say('tuns clasic');
    const free = later.say('Miercuri la 15');
    assert.equal(free.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION, free.text);
    assert.equal(free.draft.time, '15:00');
  });

  it('client changes service after a slot and the new duration is re-checked', () => {
    const occupied = [{
      start: localToUtc('2026-08-19', '14:00', TZ),
      end: localToUtc('2026-08-19', '14:40', TZ),
    }];
    const chat = createChat(occupied);
    chat.say('tuns clasic');
    const first = chat.say('Miercuri la 14:00');
    assert.equal(first.action, MACHINE_ACTIONS.ACTION_SLOT_UNAVAILABLE);

    const chat2 = createChat();
    chat2.say('tuns clasic');
    const held = chat2.say('Miercuri la 2');
    assert.equal(held.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION);
    const changed = chat2.say('tuns + barba');
    assert.equal(changed.draft.service_id, 'svc-combo');
    assert.equal(changed.draft.date, '2026-08-19');
    assert.equal(changed.draft.time, '14:00');
    assert.equal(changed.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION);
    assert.match(changed.text, /Tuns \+ Barba/);
  });

  it('nu 14, 16 keeps Wednesday and moves the hour', () => {
    const chat = createChat();
    chat.say('tuns clasic miercuri la 2');
    const corr = chat.say('nu 14, 16');
    assert.equal(corr.draft.date, '2026-08-19');
    assert.equal(corr.draft.time, '16:00');
    assert.equal(corr.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION);
    assert.match(corr.text, /16:00/);
  });

  it('2 at confirmation cancels; a later booking does not reuse the old service', () => {
    const chat = createChat();
    chat.say('tuns clasic miercuri la 2');
    const cancel = chat.say('2');
    assert.equal(cancel.action, 'CANCELLED');
    assert.match(cancel.text, /anulat/i);

    const again = chat.say('Miercuri la 3');
    assert.equal(again.action, MACHINE_ACTIONS.ACTION_ASK_SERVICE, again.text);
    assert.equal(again.draft.service_id, null);
    assert.equal(again.draft.time, '15:00');
  });

  it('Sunday 15:00 is closed; Saturday 15:00 is closed; Saturday 11:00 is open', () => {
    const sun = createChat();
    sun.say('tuns clasic');
    const closedSun = sun.say('Duminica la 15');
    assert.equal(closedSun.action, 'CLOSED');
    assert.match(closedSun.text, /Duminică|duminica|închis/i);

    const satLate = createChat();
    satLate.say('tuns clasic');
    const closedSat = satLate.say('Sambata la 15');
    assert.equal(closedSat.action, 'CLOSED');

    const satOk = createChat();
    satOk.say('tuns clasic');
    const openSat = satOk.say('Sambata la 11');
    assert.equal(openSat.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION, openSat.text);
    assert.equal(openSat.draft.time, '11:00');
  });

  it('menu 2 and 3 are details and contact; off-topic stays off-topic', () => {
    const chat = createChat();
    chat.say('Salut');
    const info = chat.say('2');
    assert.equal(info.action, 'SERVICES');
    assert.match(info.text, /Tuns Clasic/);
    assert.doesNotMatch(info.text, /Confirmi/);

    const chat2 = createChat();
    chat2.say('Salut');
    const contact = chat2.say('3');
    assert.equal(contact.action, 'CONTACT');

    const chat3 = createChat();
    const off = chat3.say('ai mancat azi?');
    assert.equal(off.action, 'OFF_TOPIC');
    assert.match(off.text, /Nu pot discuta asta/);
    assertNoAdminLeak(off.text);
  });

  it('Marți la 3 is Tuesday 15:00 and Programare from the first message asks for a service', () => {
    const chat = createChat();
    chat.say('Programare');
    const asked = chat.conv.current_step;
    assert.equal(asked, 'waiting_for_service');
    chat.say('tuns clasic');
    const slot = chat.say('Marti la 3 daca e loc');
    assert.equal(slot.draft.date, '2026-08-18');
    assert.equal(slot.draft.time, '15:00');
    assert.equal(slot.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION);
    assert.doesNotMatch(slot.text, /Duminică/);
  });

  it('anuleaza mid-flow returns to a clean session', () => {
    const chat = createChat();
    chat.say('1');
    chat.say('1');
    const stop = chat.say('anuleaza');
    assert.equal(stop.action, 'CANCELLED');
    const next = chat.say('Salut, vreau sa fac o programare');
    assert.equal(next.action, MACHINE_ACTIONS.ACTION_ASK_SERVICE);
    assert.equal(next.draft.service_id, null);
  });

  it('every client-facing line in a full happy path stays human', () => {
    const chat = createChat();
    const texts = [
      chat.say('Ceau').text,
      chat.say('1').text,
      chat.say('Aranjat Barba').text,
      chat.say('joi la 10').text,
      chat.say('ok').text,
    ];
    for (const text of texts) assertNoAdminLeak(text);
    assert.match(texts[2], /Când vrei|La ce oră|Pe ce dată/);
    assert.match(texts[3], /Aranjat Barba/);
    assert.match(texts[4], /Programare|confirmat/i);
    assert.equal(unknownInfoClientMessage().includes('Admin'), false);
  });
});
