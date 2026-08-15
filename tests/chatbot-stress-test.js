/**
 * Mass E2E stress suite: human-like RO/EN WhatsApp turns against the
 * booking engine. Two tenants (parking configured vs missing).
 * Writes tests/chatbot-stress-report.json after the run.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
import { looksLikeBusinessFactQuestion, lookupBusinessInfo, formatBusinessInfoReply } from '../src/utils/businessInfoLookup.js';
import { detectClientLanguage } from '../src/utils/clientLanguage.js';
import { hydrateExtract } from '../src/services/turnExecute.js';
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
import { parseRomanianDateTimeParts } from '../src/utils/roDateTime.js';

const TZ = 'Europe/Bucharest';
const NOW = new Date('2026-08-15T12:00:00.000Z');
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

function makeBusiness(name, extraSettings = {}) {
  return {
    name,
    timezone: TZ,
    business_type: 'salon',
    menu_buttons: [
      { id: 'book', label: 'Programare', action: 'start_booking' },
      { id: 'info', label: 'Detalii', action: 'show_info' },
      { id: 'contact', label: 'Contact', action: 'show_contact' },
    ],
    booking_settings: {
      business_hours: HOURS,
      services: SERVICES,
      ...extraSettings,
    },
    services: SERVICES,
  };
}

const TENANT_PARKING = makeBusiness('Salon Park', {
  business_info: {
    parking: true,
    parking_note: 'Avem parcare proprie chiar în fața salonului.',
    women: true,
    women_note: 'Da, tundem și doamne — tuns clasic și aranjat.',
    children: true,
    children_note: 'Primim și copii, fete și băieți.',
  },
  ai_facts: 'Avem parcare proprie chiar în fața salonului.',
});

const TENANT_NO_PARKING = makeBusiness('Salon Centru', {
  business_info: {
    parking: null,
    women: false,
    children: null,
  },
  ai_facts: '',
});

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

function extractTurn(text, conv, business) {
  const wait = getBookingWait(conv);
  const lastMenu = readLastMenu(conv);
  const step = conv.current_step;
  const services = getBookingConfig(business).services;
  const pendingDateKey = typeof conv.context_data?.pending_date_text === 'string'
    ? conv.context_data.pending_date_text
    : null;
  const dayHours = { open: '09:00', close: '18:00' };
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
    now: NOW,
  });
  if (deterministic) return deterministic;

  const triage = triageUserIntent(text, { businessType: 'salon' });
  const explicit = resolveExplicitSlot(text, business, NOW);
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
    const parts = parseRomanianDateTimeParts(text, TZ, NOW, { dayHours });
    return emptyExtract({
      action: 'book',
      date_text: parts.dateKey,
      time_text: parts.timeHHmm,
      datetime: parts.datetime,
      source: 'keyword',
    });
  }

  const stolen = recoverSoftParserIntent(
    { action: 'off_topic', confidence: 'low', source: 'nlu' },
    text,
    triage,
    inModify,
  );
  return emptyExtract({ action: stolen.action, source: stolen.source || 'nlu' });
}

function overlaps(occupied, start, end) {
  return occupied.some((ev) => intervalOverlapMinutes(start, end, ev.start, ev.end) > SLOT_OVERLAP_GRACE_MINUTES);
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
      services: extra.services || SERVICES,
      alternatives: extra.alternatives || [],
      occupied_label: extra.occupied_label || null,
      hours_configured: true,
      hours_text: formatBusinessHoursText(getConfiguredBusinessHours(business) || HOURS),
      client_name: extra.client_name || 'Alin Ivan',
      client_language: lang,
      ...extra.data,
    },
  });
}

function createChat(business, occupied = []) {
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
    const extract = extractTurn(text, conv, business);
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
    if (hydrated.action === 'reschedule') {
      conv.context_data.mode = 'reschedule';
      if (bookings[0] && !hydrated.date_text && !hydrated.time_text) {
        return {
          extract: hydrated,
          action: MACHINE_ACTIONS.ACTION_ASK_DATE_TIME,
          text: replyFor(business, MACHINE_ACTIONS.ACTION_ASK_DATE_TIME, readDraftBooking(conv), { lang }),
          draft: readDraftBooking(conv),
          lang,
        };
      }
    }

    let draft = readDraftBooking(conv);
    const keep = sessionKeepsChosenService(mapSessionState(conv.current_step));
    if (hydrated.action === 'book' && !keep && !hydrated.service_id) {
      draft = emptyDraft({ date: hydrated.date_text || draft.date, time: hydrated.time_text || draft.time });
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
      const hours = assertWithinWorkingHours(business, start, end, lang, NOW);
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
    if (reduced.action === MACHINE_ACTIONS.ACTION_ASK_SERVICE) {
      lastMenu = {
        kind: 'service',
        options: getBookingConfig(business).services.map((s) => ({
          id: `${BOOKING_PREFIXES.SERVICE}${s.id}`,
          title: s.name,
        })),
      };
    } else if (reduced.action === MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION) lastMenu = CONFIRM_MENU;
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

const ROBOT = /admin|invent|setat încă|configurat în admin|hardcod/i;

/** @type {{ id: string, ok: boolean, lang: string, tenant: string, turns: object[], error?: string }[]} */
const REPORT = [];

function record(id, tenant, lang, turns, error = null) {
  REPORT.push({
    id,
    ok: !error,
    lang,
    tenant,
    turns: turns.map((t) => ({
      user: t.user,
      action: t.action,
      draft_date: t.draft?.date || null,
      draft_time: t.draft?.time || null,
      reply: String(t.text || '').slice(0, 220),
    })),
    error,
  });
  if (error) throw new Error(`${id}: ${error}`);
}

function runScript(id, tenant, lang, business, lines, check) {
  const chat = createChat(business);
  const turns = [];
  try {
    for (const line of lines) {
      const out = chat.say(line);
      turns.push({ user: line, ...out });
      if (!out.text) throw new Error(`empty reply after "${line}"`);
      if (ROBOT.test(out.text)) throw new Error(`robotic leak after "${line}": ${out.text}`);
    }
    check(turns, chat);
    record(id, tenant, lang, turns);
  } catch (err) {
    record(id, tenant, lang, turns, err instanceof Error ? err.message : String(err));
  }
}

describe('VIDIA chatbot stress suite', () => {
  it('A1 pe 17 then la 17 then nu 17, 18 keeps the date and moves the hour', () => {
    runScript('A1-17-vs-18', 'Salon Park', 'ro', TENANT_PARKING, [
      'tuns clasic',
      'Salut, Vreau o programare pe 17',
      'La 17',
      'Nuuu, am greșit, nu 17, 18',
    ], (turns) => {
      const afterDate = turns[1];
      assert.notEqual(afterDate.draft.time, '17:00', 'pe 17 must not become 17:00');
      assert.equal(afterDate.draft.date, '2026-08-17');
      const afterTime = turns[2];
      assert.equal(afterTime.draft.time, '17:00');
      assert.equal(afterTime.draft.date, '2026-08-17');
      const afterFix = turns[3];
      assert.equal(afterFix.draft.date, '2026-08-17');
      assert.equal(afterFix.draft.time, '18:00');
      assert.notEqual(afterFix.action, 'ERROR');
    });
  });

  it('A2 isolated pe 17 is a calendar day', () => {
    const parsed = parseRomanianDateTimeParts('pe 17', TZ, NOW);
    assert.equal(parsed.dateKey, '2026-08-17');
    assert.equal(parsed.timeHHmm, null);
  });

  it('A3 nuuu correction variants', () => {
    const variants = [
      ['tuns clasic', 'luni la 17', 'nu 17, 18'],
      ['tuns clasic', 'luni la 17', 'Nuuu, am gresit, nu 17, 18'],
      ['tuns clasic', 'luni la 17', 'nu 17 ci 18'],
    ];
    variants.forEach((lines, i) => {
      runScript(`A3-corr-${i + 1}`, 'Salon Park', 'ro', TENANT_PARKING, lines, (turns) => {
        const last = turns[turns.length - 1];
        assert.equal(last.draft.date, '2026-08-17');
        assert.equal(last.draft.time, '18:00');
      });
    });
  });

  it('B1 parking is tenant-specific, never hardcoded', () => {
    runScript('B1-parking-yes', 'Salon Park', 'ro', TENANT_PARKING, ['Aveți parcare?'], (turns) => {
      assert.equal(turns[0].action, 'ADMIN_FACT');
      assert.match(turns[0].text, /parcare/i);
      assert.match(turns[0].text, /fața salonului|fata salonului/i);
    });
    runScript('B1-parking-missing', 'Salon Centru', 'ro', TENANT_NO_PARKING, ['Aveti parcare?'], (turns) => {
      assert.equal(turns[0].action, 'MISSING_INFO');
      assert.match(turns[0].text, /din păcate|din pacate|nu dețin|nu detin/i);
      assert.match(turns[0].text, /parcare/i);
      assert.doesNotMatch(turns[0].text, /fața salonului|în față/i);
    });
  });

  it('B2 women and children come from Admin, not source code', () => {
    runScript('B2-women-yes', 'Salon Park', 'ro', TENANT_PARKING, ['Tundeți și femei?'], (turns) => {
      assert.equal(turns[0].action, 'ADMIN_FACT');
      assert.match(turns[0].text, /doamne|femei/i);
      assert.notEqual(turns[0].action, MACHINE_ACTIONS.ACTION_ASK_DATE_TIME);
    });
    runScript('B2-kids-yes', 'Salon Park', 'ro', TENANT_PARKING, ['Tundeți și copii?'], (turns) => {
      assert.equal(turns[0].action, 'ADMIN_FACT');
      assert.match(turns[0].text, /copii/i);
    });
    runScript('B2-women-no', 'Salon Centru', 'ro', TENANT_NO_PARKING, ['Tundeti si femei?'], (turns) => {
      assert.equal(turns[0].action, 'ADMIN_FACT');
      assert.match(turns[0].text, /din păcate|nu oferim/i);
    });
    runScript('B2-kids-missing', 'Salon Centru', 'ro', TENANT_NO_PARKING, ['Tundeti si copii?'], (turns) => {
      assert.equal(turns[0].action, 'MISSING_INFO');
      assert.match(turns[0].text, /copii/i);
    });
  });

  it('B3 prices and hours together, plus weather off-topic', () => {
    runScript('B3-prices-hours', 'Salon Park', 'ro', TENANT_PARKING, [
      'Care sunt prețurile voastre și ce program aveți?',
    ], (turns) => {
      assert.equal(turns[0].action, 'HOURS_AND_SERVICES');
      assert.match(turns[0].text, /70|100|LEI/i);
      assert.match(turns[0].text, /09:00|18:00/);
    });
    runScript('B3-weather', 'Salon Park', 'ro', TENANT_PARKING, ['Cum va fi vremea mâine?'], (turns) => {
      assert.equal(turns[0].action, 'OFF_TOPIC');
      assert.match(turns[0].text, /programare|orar|contact/i);
      assert.doesNotMatch(turns[0].text, /Confirmi/);
    });
  });

  it('C1 cancel mid-flow and closed 23:00', () => {
    runScript('C1-cancel', 'Salon Park', 'ro', TENANT_PARKING, [
      'tuns clasic',
      'luni la 11',
      'anulează',
    ], (turns) => {
      assert.equal(turns[2].action, 'CANCELLED');
      assert.match(turns[2].text, /anulat/i);
    });
    runScript('C1-23', 'Salon Park', 'ro', TENANT_PARKING, [
      'tuns clasic',
      'luni la 23:00',
    ], (turns) => {
      const last = turns[turns.length - 1];
      assert.ok(last.action === 'CLOSED' || last.draft.time !== '23:00' || /închis|afara programului|afară/i.test(last.text));
      if (last.action === 'CLOSED') {
        assert.match(last.text, /09:00|18:00|închis|afara|afară/i);
      }
    });
  });

  it('C2 reschedule tomorrow 14:00', () => {
    const chat = createChat(TENANT_PARKING);
    chat.say('tuns clasic');
    const held = chat.say('luni la 11');
    assert.equal(held.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION);
    chat.say('1');
    const moved = chat.say('Vreau să mut mâine la 14:00');
    assert.equal(moved.draft.time, '14:00');
    assert.equal(moved.draft.date, '2026-08-16');
    record('C2-reschedule', 'Salon Park', 'ro', [
      { user: 'Vreau să mut mâine la 14:00', ...moved },
    ]);
  });

  it('D1 English booking Monday 4 PM; Sunday tomorrow is closed', () => {
    runScript('D1-en-book', 'Salon Park', 'en', TENANT_PARKING, [
      'Hello, I want to book Tuns Clasic for Monday at 4 PM',
    ], (turns) => {
      const t = turns[0];
      assert.equal(t.lang, 'en');
      assert.equal(t.draft.date, '2026-08-17');
      assert.equal(t.draft.time, '16:00');
      assert.match(t.text, /Confirm|time|Monday|16:00|Tuns|luni/i);
      assert.doesNotMatch(t.text, /Când vrei programarea/);
    });
    runScript('D1-en-sunday-closed', 'Salon Park', 'en', TENANT_PARKING, [
      'Tuns Clasic tomorrow at 4 PM',
    ], (turns) => {
      assert.equal(turns[0].action, 'CLOSED');
      assert.match(turns[0].text, /închiși|inchisi|closed|Duminică|Duminica|Sunday/i);
    });
  });

  it('D2 English FAQ parking split by tenant', () => {
    runScript('D2-en-parking-yes', 'Salon Park', 'en', TENANT_PARKING, ['Do you have parking?'], (turns) => {
      assert.equal(turns[0].action, 'ADMIN_FACT');
      assert.match(turns[0].text, /parcare|parking/i);
    });
    runScript('D2-en-parking-no', 'Salon Centru', 'en', TENANT_NO_PARKING, ['Do you have parking?'], (turns) => {
      assert.equal(turns[0].action, 'MISSING_INFO');
      assert.match(turns[0].text, /unfortunately|don't have|do not have/i);
      assert.match(turns[0].text, /parking/i);
    });
  });

  it('D3 English cancel and off-topic weather', () => {
    runScript('D3-en-cancel', 'Salon Park', 'en', TENANT_PARKING, [
      'Tuns Clasic',
      'Monday at 11',
      'cancel',
    ], (turns) => {
      assert.equal(turns[2].action, 'CANCELLED');
    });
    runScript('D3-en-weather', 'Salon Park', 'en', TENANT_PARKING, ['How is the weather tomorrow?'], (turns) => {
      assert.equal(turns[0].action, 'OFF_TOPIC');
      assert.match(turns[0].text, /booking|hours|contact/i);
    });
    runScript('D3-en-prices-hours', 'Salon Park', 'en', TENANT_PARKING, [
      'What are your prices and hours?',
    ], (turns) => {
      assert.equal(turns[0].action, 'HOURS_AND_SERVICES');
      assert.match(turns[0].text, /70|100|LEI|09:00/i);
    });
    runScript('D3-en-women', 'Salon Park', 'en', TENANT_PARKING, ['Do you cut women\'s hair?'], (turns) => {
      assert.equal(turns[0].action, 'ADMIN_FACT');
    });
    runScript('D3-en-23', 'Salon Park', 'en', TENANT_PARKING, ['Tuns Clasic', 'Monday at 11 PM'], (turns) => {
      const last = turns[turns.length - 1];
      assert.equal(last.action, 'CLOSED');
      assert.match(last.text, /closed|18:00|Monday/i);
    });
  });

  it('relative days, spaced clock, and no past morning slots', () => {
    runScript('E-maine-not-today', 'Salon Park', 'ro', TENANT_PARKING, ['tuns clasic', 'Maine la 12'], (turns) => {
      const last = turns[turns.length - 1];
      assert.equal(last.draft.date, '2026-08-16', 'maine on Saturday must be Sunday, not Saturday');
      assert.notEqual(last.draft.date, '2026-08-15');
      if (last.action === 'CLOSED') {
        assert.match(last.text, /Duminică/);
        assert.doesNotMatch(last.text, /Sâmbătă/);
      }
    });
    runScript('E-luni-12-30-space', 'Salon Park', 'ro', TENANT_PARKING, ['tuns clasic', 'Luni la 12 30'], (turns) => {
      const last = turns[turns.length - 1];
      assert.equal(last.draft.date, '2026-08-17');
      assert.equal(last.draft.time, '12:30');
    });
    runScript('E-azi-past-morning', 'Salon Park', 'ro', TENANT_PARKING, ['tuns clasic', 'azi la 10'], (turns) => {
      const last = turns[turns.length - 1];
      assert.equal(last.action, 'CLOSED');
      assert.match(last.text, /trecut|viitor/i);
    });
    const matrix = [
      ['tuns clasic', 'luni la 11 jumate'],
      ['tuns clasic', 'luni la 11 jumatate'],
      ['tuns clasic', 'Luni la 11:30'],
      ['tuns clasic', 'luni la 11,20'],
      ['tuns clasic', 'luni la 11:40'],
      ['tuns + barba', 'marti la 3'],
      ['programare', '1', 'tuns clasic', 'joi la 10'],
      ['salut', '1', '2', 'vineri la 16'],
      ['tuns clasic', 'azi la 15'],
      ['tuns clasic', 'maine la 10'],
    ];
    matrix.forEach((lines, i) => {
      runScript(`E-matrix-${i + 1}`, 'Salon Park', 'ro', TENANT_PARKING, lines, (turns) => {
        const last = turns[turns.length - 1];
        assert.ok(last.text.length > 8);
        assert.equal(ROBOT.test(last.text), false);
      });
    });
  });

  it('E2 English matrix weekdays and 4pm', () => {
    const matrix = [
      ['Tuns Clasic', 'Monday at 11'],
      ['Tuns Clasic', 'tomorrow at 4pm'],
      ['Tuns Clasic', 'today at 15:00'],
      ['Hello', 'I want to book a haircut'],
      ['Tuns Clasic', 'Tuesday at 10'],
      ['Tuns Clasic', 'Wednesday at 2 PM'],
      ['Tuns Clasic', 'Friday at 16:00'],
    ];
    matrix.forEach((lines, i) => {
      runScript(`E2-en-${i + 1}`, 'Salon Park', 'en', TENANT_PARKING, lines, (turns) => {
        const last = turns[turns.length - 1];
        assert.ok(last.text.length > 8);
        if (i < 3) assert.ok(last.draft.time, `expected a time on ${lines.join(' → ')}`);
      });
    });
  });
});

after(() => {
  const passed = REPORT.filter((r) => r.ok).length;
  const failed = REPORT.filter((r) => !r.ok);
  const payload = {
    generated_at: new Date().toISOString(),
    total: REPORT.length,
    passed,
    failed: failed.length,
    tenants: ['Salon Park (parking:true)', 'Salon Centru (parking:null)'],
    failures: failed,
    scenarios: REPORT,
  };
  const dir = dirname(fileURLToPath(import.meta.url));
  writeFileSync(join(dir, 'chatbot-stress-report.json'), JSON.stringify(payload, null, 2), 'utf8');
});
