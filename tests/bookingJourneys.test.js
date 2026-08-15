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
} from '../src/services/turnExtract.js';
import { hydrateExtract } from '../src/services/turnExecute.js';
import {
  emptyDraft,
  reduceBookingTurn,
  hydrateCatalogService,
  MACHINE_ACTIONS,
  SESSION_STATES,
  parseInFlightCorrection,
} from '../src/lib/booking/stateMachine.js';
import { renderHandlerResult } from '../src/services/turnPresent.js';
import { BOOKING_WAIT } from '../src/services/bookingWaitState.js';

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

function hoursCheck(dateKey, hhmm) {
  const start = localToUtc(dateKey, hhmm, TZ);
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  return assertWithinWorkingHours(BUSINESS, start, end);
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
      lastMenu: null,
      wait: BOOKING_WAIT.DATE_TIME,
      timezone: TZ,
      pendingDateKey: '2026-08-16',
      business: BUSINESS,
    });
    assert.equal(one.action, 'book');
    assert.equal(one.date_text, null);
    assert.equal(one.time_text, null);

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

  it('client-facing copy stays human', () => {
    for (const key of ['MISSING_INFO', 'OFF_TOPIC', 'CHAT_FALLBACK', 'ASK_DATE', 'MENU']) {
      const text = reply(key);
      assert.equal(/admin|invent|setat încă|configurat/i.test(text), false, key);
    }
  });
});
