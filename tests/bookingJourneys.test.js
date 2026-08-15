import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRomanianDateTimeParts } from '../src/utils/roDateTime.js';
import { assertWithinWorkingHours, getHoursForDate } from '../src/utils/workingHours.js';
import { localToUtc } from '../src/utils/datetime.js';
import {
  looksLikeGreeting,
  looksLikeNewBookingRequest,
  looksLikeExistingAppointmentQuery,
  triageUserIntent,
  detectModificationIntent,
} from '../src/services/intentTriageService.js';
import {
  recoverSoftParserIntent,
  resolveDeterministicInbound,
  resolveExplicitSlot,
  matchServiceMention,
} from '../src/services/turnExtract.js';
import { hydrateExtract } from '../src/services/turnExecute.js';
import {
  emptyDraft,
  reduceBookingTurn,
  hydrateCatalogService,
  MACHINE_ACTIONS,
  SESSION_STATES,
  parseInFlightCorrection,
  sessionKeepsChosenService,
  afterSlotCheck,
} from '../src/lib/booking/stateMachine.js';
import { renderHandlerResult } from '../src/services/turnPresent.js';
import { BOOKING_WAIT } from '../src/services/bookingWaitState.js';
import { formatServiceAskMessage } from '../src/utils/serviceMatch.js';

const TZ = 'Europe/Bucharest';
/** Saturday 15 Aug 2026 12:53 in Bucharest */
const NOW = new Date('2026-08-15T09:53:00.000Z');
const TUESDAY = '2026-08-18';
const HOURS = {
  '0': null,
  '1': { open: '09:00', close: '18:00' },
  '2': { open: '09:00', close: '18:00' },
  '3': { open: '09:00', close: '18:00' },
  '4': { open: '09:00', close: '18:00' },
  '5': { open: '09:00', close: '18:00' },
  '6': { open: '10:00', close: '14:00' },
};
const BUSINESS = {
  name: 'VIDIA',
  timezone: TZ,
  menu_buttons: [
    { id: 'book', label: 'Programare', action: 'start_booking' },
    { id: 'info', label: 'Detalii', action: 'show_info' },
    { id: 'contact', label: 'Contact', action: 'show_contact' },
  ],
  booking_settings: {
    business_hours: HOURS,
    services: [{ id: 'svc-tuns', name: 'Tuns', duration_minutes: 30, price_ron: 80 }],
  },
  services: [{ id: 'svc-tuns', name: 'Tuns', duration_minutes: 30, price_ron: 80 }],
};

const SALON_SERVICES = [
  { id: 'svc-clasic', name: 'Tuns Clasic', duration_minutes: 30 },
  { id: 'svc-combo', name: 'Tuns + Barba', duration_minutes: 45 },
  { id: 'svc-aranjat', name: 'Aranjat Barba', duration_minutes: 20 },
];
const SALON = {
  ...BUSINESS,
  services: SALON_SERVICES,
  booking_settings: { ...BUSINESS.booking_settings, services: SALON_SERVICES },
};
const ENTRY_MENU = {
  kind: 'entry',
  options: [
    { id: 'book', title: 'Programare' },
    { id: 'info', title: 'Detalii & Prețuri' },
    { id: 'contact', title: 'Contact & Locație' },
  ],
};

function afterHydrateReduce(extract, convState, text = '') {
  const hydrated = hydrateExtract(extract, convState, TZ);
  const reduced = reduceBookingTurn({
    state: convState.current_step === 'waiting_for_service'
      ? SESSION_STATES.WAITING_FOR_SERVICE
      : SESSION_STATES.INIT,
    draft: emptyDraft(convState.context_data?.draft_booking),
    text,
    timezone: TZ,
    extractDate: hydrated.date_text,
    extractTime: hydrated.time_text,
    extractServiceId: hydrated.service_id,
    extractServiceName: hydrated.service_name,
  });
  return { hydrated, reduced };
}

function hoursCheck(dateKey, hhmm) {
  const start = localToUtc(dateKey, hhmm, TZ);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return assertWithinWorkingHours(BUSINESS, start, end, 'ro', NOW);
}

function reply(key, data = {}) {
  return renderHandlerResult(BUSINESS, {
    status: 'SUCCESS',
    user_message_template_key: key,
    data: { business_name: 'VIDIA', ...data },
  });
}

describe('real booking journeys', () => {
  it('Ceau is a greeting; 1 starts booking; Marți la 3 is Tuesday 15:00, not Sunday', () => {
    assert.equal(looksLikeGreeting('Ceau'), true);
    assert.equal(triageUserIntent('Ceau').intent, 'menu');

    const one = resolveDeterministicInbound({
      textBody: '1',
      lastMenu: ENTRY_MENU,
      wait: null,
      timezone: TZ,
      business: BUSINESS,
      now: NOW,
    });
    assert.equal(one.action, 'book');
    assert.equal(one.date_text, null);
    assert.equal(one.time_text, null);
    assert.equal(one.source, 'menu');

    const slot = resolveExplicitSlot('Marti la 3 daca e loc', BUSINESS, NOW);
    assert.equal(slot.dateKey, TUESDAY);
    assert.equal(slot.timeHHmm, '15:00');
    const info = getHoursForDate(BUSINESS, localToUtc(slot.dateKey, '12:00', TZ));
    assert.equal(info.dayName, 'Marți');
    assert.equal(info.open, true);
    const check = hoursCheck(slot.dateKey, slot.timeHHmm);
    assert.equal(check.ok, true, check.message);
    assert.doesNotMatch(check.message || '', /Duminică|duminica/i);
  });

  it('does not keep a leftover Sunday when the client says marți', () => {
    const poisoned = hydrateExtract(
      { action: 'book', source: 'menu', date_text: null, time_text: null, datetime: null, slot_id: null },
      { context_data: { pending_date_text: '2026-08-16', pending_time_text: '01:00' } },
      TZ,
    );
    assert.equal(poisoned.date_text, null);

    const slot = resolveExplicitSlot('marti la 3', BUSINESS, NOW);
    assert.notEqual(slot.dateKey, '2026-08-16');
    assert.equal(getHoursForDate(BUSINESS, localToUtc(slot.dateKey, '12:00', TZ)).dayName, 'Marți');
  });

  it('luni la 17 then nu 17, 18 keeps Monday and moves to 18:00', () => {
    const first = parseRomanianDateTimeParts('luni la 17', TZ, NOW, { dayHours: HOURS['1'] });
    assert.equal(first.dateKey, '2026-08-17');
    assert.equal(first.timeHHmm, '17:00');
    const corr = parseInFlightCorrection('nu 17, 18');
    assert.deepEqual(corr, { rejected: 17, value: 18 });
    const reduced = reduceBookingTurn({
      state: SESSION_STATES.WAITING_FOR_CONFIRMATION,
      draft: emptyDraft({
        service_id: 'svc-tuns',
        service_name: 'Tuns',
        date: first.dateKey,
        time: first.timeHHmm,
        duration: 30,
      }),
      extraction: { intent: 'change_time', extracted_time: '18:00', extracted_date: null, is_ambiguous: false, confidence: 1 },
      text: 'nu 17, 18',
      timezone: TZ,
      extractTime: '18:00',
    });
    assert.equal(reduced.draft.date, '2026-08-17');
    assert.equal(reduced.draft.time, '18:00');
  });

  it('client changes service, asks hours, then books, then cancels, then reschedules', () => {
    assert.equal(triageUserIntent('ce program aveti').intent, 'faq');
    assert.equal(triageUserIntent('unde sunteti').intent, 'contact');
    assert.equal(looksLikeExistingAppointmentQuery('ce programari am'), true);
    assert.equal(looksLikeNewBookingRequest('vreau tuns luni la 10'), true);
    assert.equal(
      looksLikeNewBookingRequest('tuns', {
        services: [{ id: 'svc-tuns', name: 'Tuns Clasic' }],
      }),
      true,
    );
    assert.equal(
      looksLikeNewBookingRequest('tuns', {
        services: [{ id: 'svc-det', name: 'Detartraj' }],
      }),
      false,
    );
    assert.equal(
      triageUserIntent('tuns', {
        services: [{ id: 'svc-det', name: 'Detartraj' }],
      }).intent !== 'book',
      true,
    );
    assert.equal(detectModificationIntent('anuleaza'), 'cancel');
    assert.equal(detectModificationIntent('reprogramare'), 'reschedule');
    assert.equal(detectModificationIntent('muta programarea'), 'reschedule');

    const stolen = { action: 'off_topic', confidence: 'low', source: 'nlu' };
    assert.equal(recoverSoftParserIntent(stolen, 'Programare', triageUserIntent('Programare')).action, 'book');
    assert.equal(recoverSoftParserIntent(stolen, 'anuleaza', triageUserIntent('anuleaza')).action, 'cancel');
    assert.equal(
      recoverSoftParserIntent(stolen, 'ai mancat azi?', { intent: 'unknown', confidence: 'low', reason: 'x' }).action,
      'off_topic',
    );
  });

  it('typos and hedges still parse the slot', () => {
    const cases = [
      'marti la 3 daca e loc',
      'Marți la 15',
      'marti la 3:00',
      'marti de la 3',
    ];
    for (const text of cases) {
      const slot = resolveExplicitSlot(text, BUSINESS, NOW);
      assert.ok(slot?.dateKey, text);
      assert.equal(slot.dateKey, TUESDAY, text);
      const info = getHoursForDate(BUSINESS, localToUtc(slot.dateKey, '12:00', TZ));
      assert.equal(info.dayName, 'Marți', text);
    }
  });

  it('closed Sunday is only for Sunday, never for marți', () => {
    const sun = hoursCheck('2026-08-16', '15:00');
    assert.equal(sun.ok, false);
    assert.match(sun.message, /Duminică/);
    const tue = hoursCheck(TUESDAY, '15:00');
    assert.equal(tue.ok, true);
  });

  it('never auto-picks a service; date/time wait for the service duration', () => {
    const oneService = {
      ...BUSINESS,
      booking_settings: {
        ...BUSINESS.booking_settings,
        services: [{ id: 'svc-barba', name: 'Tuns + Barba', duration_minutes: 60, price_ron: 100 }],
      },
    };
    const auto = hydrateCatalogService(emptyDraft(), oneService);
    assert.equal(auto.service_id, null);

    const afterSlot = reduceBookingTurn({
      state: SESSION_STATES.WAITING_FOR_DATE_TIME,
      draft: emptyDraft(),
      text: 'Miercuri la 2',
      timezone: TZ,
      extractDate: '2026-08-19',
      extractTime: '14:00',
    });
    assert.equal(afterSlot.action, MACHINE_ACTIONS.ACTION_ASK_SERVICE);
    assert.equal(afterSlot.draft.date, '2026-08-19');
    assert.equal(afterSlot.draft.time, '14:00');
    assert.equal(afterSlot.draft.service_id, null);

    const afterService = reduceBookingTurn({
      state: SESSION_STATES.WAITING_FOR_SERVICE,
      draft: afterSlot.draft,
      text: 'Tuns + Barba',
      timezone: TZ,
      extractServiceId: 'svc-barba',
      extractServiceName: 'Tuns + Barba',
    });
    assert.equal(afterService.action, MACHINE_ACTIONS.ACTION_CHECK_SLOT);
    assert.equal(afterService.draft.service_id, 'svc-barba');
    assert.equal(afterService.draft.date, '2026-08-19');
    assert.equal(afterService.draft.time, '14:00');
  });

  it('names the service in the same message and then checks that duration', () => {
    const reduced = reduceBookingTurn({
      state: SESSION_STATES.INIT,
      draft: emptyDraft(),
      text: 'tuns miercuri la 2',
      timezone: TZ,
      extractDate: '2026-08-19',
      extractTime: '14:00',
      extractServiceId: 'svc-tuns',
      extractServiceName: 'Tuns',
    });
    assert.equal(reduced.action, MACHINE_ACTIONS.ACTION_CHECK_SLOT);
    assert.equal(reduced.draft.service_id, 'svc-tuns');
  });

  it('leftover Tuns + Barba is ignored until the client names a service', () => {
    const leftover = hydrateExtract(
      { action: 'book', source: 'parser', date_text: '2026-08-19', time_text: '14:00', datetime: null, slot_id: null },
      {
        current_step: 'IDLE',
        context_data: {
          pending_service_id: 'svc-barba',
          draft_booking: { service_id: 'svc-barba', service_name: 'Tuns + Barba', duration: 60 },
        },
      },
      TZ,
    );
    assert.equal(leftover.service_id, undefined);

    const afterDate = reduceBookingTurn({
      state: SESSION_STATES.INIT,
      draft: emptyDraft({ service_id: leftover.service_id || null }),
      text: 'Miercuri la 2',
      timezone: TZ,
      extractDate: leftover.date_text,
      extractTime: leftover.time_text,
    });
    assert.equal(afterDate.action, MACHINE_ACTIONS.ACTION_ASK_SERVICE);
    assert.equal(afterDate.draft.date, '2026-08-19');
    assert.equal(afterDate.draft.time, '14:00');
    assert.equal(afterDate.draft.service_id, null);
    assert.equal(sessionKeepsChosenService(SESSION_STATES.INIT), false);
    assert.equal(sessionKeepsChosenService(SESSION_STATES.WAITING_FOR_DATE), true);
  });

  it('keeps the chosen service when the client later sends only the slot', () => {
    const hydrated = hydrateExtract(
      { action: 'book', source: 'parser', date_text: '2026-08-19', time_text: '14:00', datetime: null, slot_id: null },
      {
        current_step: 'waiting_for_date_time',
        context_data: { pending_service_id: 'svc-barba' },
      },
      TZ,
    );
    assert.equal(hydrated.service_id, 'svc-barba');
  });

  it('while asking for service, 1 is the first catalog item, not Programare', () => {
    const catalog = [
      { id: 'svc-tuns', name: 'Tuns', duration_minutes: 30 },
      { id: 'svc-barba', name: 'Tuns + Barba', duration_minutes: 60 },
    ];
    const twoServices = {
      ...BUSINESS,
      services: catalog,
      booking_settings: {
        ...BUSINESS.booking_settings,
        services: catalog,
      },
    };
    const extracted = resolveDeterministicInbound({
      textBody: '1',
      lastMenu: {
        kind: 'entry',
        options: [
          { id: 'book', title: 'Programare' },
          { id: 'info', title: 'Detalii' },
        ],
      },
      wait: BOOKING_WAIT.SERVICE,
      timezone: TZ,
      business: twoServices,
    });
    assert.equal(extracted.action, 'select_service');
    assert.equal(extracted.service_id, 'svc-tuns');
    const two = resolveDeterministicInbound({
      textBody: '2',
      lastMenu: { kind: 'entry', options: [{ id: 'book', title: 'Programare' }] },
      wait: BOOKING_WAIT.SERVICE,
      timezone: TZ,
      business: twoServices,
    });
    assert.equal(two.service_id, 'svc-barba');
  });

  it('matches a unique short name and refuses an ambiguous tuns', () => {
    const onlyCombo = [{ id: 'svc-barba', name: 'Tuns + Barba' }];
    const both = [
      { id: 'svc-tuns', name: 'Tuns clasic' },
      { id: 'svc-barba', name: 'Tuns + Barba' },
    ];
    assert.equal(matchServiceMention('tuns', onlyCombo)?.id, 'svc-barba');
    assert.equal(matchServiceMention('barba', both)?.id, 'svc-barba');
    assert.equal(matchServiceMention('tuns', both), null);
    assert.equal(matchServiceMention('tuns clasic', both)?.id, 'svc-tuns');
  });

  it('changing the service after a slot re-checks that duration', () => {
    const afterChange = reduceBookingTurn({
      state: SESSION_STATES.WAITING_FOR_CONFIRMATION,
      draft: emptyDraft({
        service_id: 'svc-tuns',
        service_name: 'Tuns',
        date: '2026-08-19',
        time: '14:00',
        duration: 30,
      }),
      text: 'tuns + barba',
      timezone: TZ,
      extractServiceId: 'svc-barba',
      extractServiceName: 'Tuns + Barba',
    });
    assert.equal(afterChange.action, MACHINE_ACTIONS.ACTION_CHECK_SLOT);
    assert.equal(afterChange.draft.service_id, 'svc-barba');
    assert.equal(afterChange.draft.date, '2026-08-19');
    assert.equal(afterChange.draft.time, '14:00');

    const busy = afterSlotCheck(afterChange, { available: false, alternatives: [{ label: '15:00' }] });
    assert.equal(busy.action, MACHINE_ACTIONS.ACTION_SLOT_UNAVAILABLE);
    const free = afterSlotCheck(afterChange, { available: true });
    assert.equal(free.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION);
  });

  it('service ask lists duration so the client sees why the slot depends on it', () => {
    const text = formatServiceAskMessage([
      { name: 'Tuns', duration_minutes: 30 },
      { name: 'Tuns + Barba', duration_minutes: 60 },
    ]);
    assert.match(text, /\*1\. Tuns\*/);
    assert.match(text, /30 min/);
    assert.match(text, /\*2\. Tuns \+ Barba\*/);
    assert.match(text, /60 min/);
    assert.match(text, /numărul.*numele/);
    const presented = reply('MISSING_SERVICE', {
      services: [
        { id: 'svc-barba', name: 'Tuns + Barba', duration_minutes: 60 },
      ],
    });
    assert.match(presented, /Tuns \+ Barba/);
    assert.match(presented, /60 min/);
  });

  it('Salut → 1 → 1 keeps Tuns Clasic and asks for the slot, not the service again', () => {
    const start = resolveDeterministicInbound({
      textBody: '1',
      lastMenu: ENTRY_MENU,
      wait: null,
      timezone: TZ,
      business: SALON,
    });
    assert.equal(start.action, 'book');
    const first = afterHydrateReduce(start, { current_step: 'IDLE', context_data: {} }, '1');
    assert.equal(first.hydrated.service_id, null);
    assert.equal(first.reduced.action, MACHINE_ACTIONS.ACTION_ASK_SERVICE);

    const pick = resolveDeterministicInbound({
      textBody: '1',
      lastMenu: {
        kind: 'service',
        options: SALON_SERVICES.map((s) => ({ id: `svc_${s.id}`, title: s.name })),
      },
      wait: BOOKING_WAIT.SERVICE,
      timezone: TZ,
      business: SALON,
    });
    assert.equal(pick.action, 'select_service');
    assert.equal(pick.service_id, 'svc-clasic');
    const second = afterHydrateReduce(
      pick,
      {
        current_step: 'waiting_for_service',
        context_data: { draft_booking: {}, last_menu: { kind: 'service' } },
      },
      '1',
    );
    assert.equal(second.hydrated.service_id, 'svc-clasic', 'hydrate must not wipe the chosen service');
    assert.equal(second.reduced.action, MACHINE_ACTIONS.ACTION_ASK_DATE_TIME);
    assert.equal(second.reduced.draft.service_id, 'svc-clasic');
  });

  it('first-message intents: greeting+book, hours, and beard wording', () => {
    assert.equal(triageUserIntent('Salut, vreau sa fac o programare').intent, 'book');
    assert.equal(looksLikeGreeting('Salut, vreau sa fac o programare'), false);
    assert.equal(looksLikeNewBookingRequest('Salut, vreau sa fac o programare'), true);

    assert.equal(triageUserIntent('ce program aveti').intent, 'faq');
    assert.equal(looksLikeNewBookingRequest('ce program aveti'), false);

    assert.equal(matchServiceMention('tundeti si barba', SALON_SERVICES)?.id, 'svc-combo');
    assert.equal(matchServiceMention('aranjati barba', SALON_SERVICES)?.id, 'svc-aranjat');
    assert.equal(matchServiceMention('tuns clasic', SALON_SERVICES)?.id, 'svc-clasic');
    assert.equal(matchServiceMention('faceti si barba', SALON_SERVICES), null);

    const named = matchServiceMention('tundeti si barba', SALON_SERVICES);
    const fromName = reduceBookingTurn({
      state: SESSION_STATES.INIT,
      draft: emptyDraft(),
      text: 'tundeti si barba',
      timezone: TZ,
      extractServiceId: named.id,
      extractServiceName: named.name,
    });
    assert.equal(fromName.action, MACHINE_ACTIONS.ACTION_ASK_DATE_TIME);
    assert.equal(fromName.draft.service_id, 'svc-combo');
  });

  it('client-facing copy stays human', () => {
    for (const key of ['MISSING_INFO', 'OFF_TOPIC', 'CHAT_FALLBACK', 'ASK_DATE', 'MENU']) {
      const text = reply(key);
      assert.equal(/admin|invent|setat încă|configurat/i.test(text), false, key);
    }
  });
});
