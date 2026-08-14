import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  afterSlotCheck,
  MACHINE_ACTIONS,
  SESSION_STATES,
  emptyDraft,
  parseInFlightCorrection,
  reduceBookingTurn,
} from '../src/lib/booking/stateMachine.js';
import { formatMachineAction, formatRomanianDate } from '../src/lib/ai/responseFormatter.js';
import { coerceHourToOpenHours, parseRomanianDateTimeParts } from '../src/utils/roDateTime.js';
import {
  looksLikeExistingAppointmentQuery,
  looksLikeNewBookingRequest,
  triageUserIntent,
} from '../src/services/intentTriageService.js';

const TZ = 'Europe/Bucharest';
const HOURS_09_18 = { open: '09:00', close: '18:00' };
/** Saturday 15 Aug 2026 — next Monday is 17 Aug 2026 */
const SATURDAY = new Date('2026-08-15T12:00:00.000Z');
const MONDAY = '2026-08-17';

describe('12h → 24h against business hours', () => {
  it('maps "la 5" to 17:00 when 05:00 is closed (09:00–18:00)', () => {
    const coerced = coerceHourToOpenHours(5, 0, HOURS_09_18);
    assert.equal(`${String(coerced.hour).padStart(2, '0')}:00`, '17:00');

    const parsed = parseRomanianDateTimeParts('la 5', TZ, SATURDAY, { dayHours: HOURS_09_18 });
    assert.equal(parsed.timeHHmm, '17:00');
  });

  it('maps "la 5 pm" to 17:00', () => {
    const parsed = parseRomanianDateTimeParts('la 5 pm', TZ, SATURDAY, { dayHours: HOURS_09_18 });
    assert.equal(parsed.timeHHmm, '17:00');
  });

  it('keeps "la 10" as 10:00 when the shop is open', () => {
    const parsed = parseRomanianDateTimeParts('la 10', TZ, SATURDAY, { dayHours: HOURS_09_18 });
    assert.equal(parsed.timeHHmm, '10:00');
  });
});

describe('waiting_for_time isolated numbers', () => {
  it('treats isolated 17 as 17:00, not a calendar day', () => {
    const reduced = reduceBookingTurn({
      state: SESSION_STATES.WAITING_FOR_TIME,
      draft: emptyDraft({
        service_id: 'svc-tuns',
        service_name: 'Tuns',
        date: MONDAY,
        time: null,
        duration: 30,
      }),
      extraction: {
        intent: 'unknown',
        extracted_service: null,
        extracted_date: null,
        extracted_time: null,
        is_ambiguous: true,
        ambiguity_reason: '17 could be date or time',
        confidence: 0.4,
      },
      text: '17',
      timezone: TZ,
    });
    assert.equal(reduced.draft.date, MONDAY);
    assert.equal(reduced.draft.time, '17:00');
    assert.equal(reduced.action, MACHINE_ACTIONS.ACTION_CHECK_SLOT);
  });
});

describe('in-flight correction: luni la 17 → nu 17, 18', () => {
  it('parses the correction pair', () => {
    const parsed = parseInFlightCorrection('Ah scuze, nu 17, 18');
    assert.deepEqual(parsed, { rejected: 17, value: 18 });
  });

  it('keeps Monday and moves the time to 18:00, then confirmation', () => {
    const firstParse = parseRomanianDateTimeParts(
      'Vreau o programare luni la 17',
      TZ,
      SATURDAY,
      { dayHours: HOURS_09_18 },
    );
    assert.equal(firstParse.dateKey, MONDAY);
    assert.equal(firstParse.timeHHmm, '17:00');

    const afterFirst = reduceBookingTurn({
      state: SESSION_STATES.INIT,
      draft: emptyDraft({
        service_id: 'svc-tuns',
        service_name: 'Tuns',
        duration: 30,
      }),
      extraction: {
        intent: 'book',
        extracted_service: 'Tuns',
        extracted_date: firstParse.dateKey,
        extracted_time: firstParse.timeHHmm,
        is_ambiguous: false,
        ambiguity_reason: null,
        confidence: 0.95,
      },
      text: 'Vreau o programare luni la 17',
      timezone: TZ,
      extractDate: firstParse.dateKey,
      extractTime: firstParse.timeHHmm,
      extractServiceId: 'svc-tuns',
      extractServiceName: 'Tuns',
    });
    const held = afterSlotCheck(afterFirst, { available: true });
    assert.equal(held.draft.date, MONDAY);
    assert.equal(held.draft.time, '17:00');
    assert.equal(held.state, SESSION_STATES.WAITING_FOR_CONFIRMATION);
    assert.equal(held.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION);

    const afterCorrection = reduceBookingTurn({
      state: held.state,
      draft: held.draft,
      extraction: {
        intent: 'unknown',
        extracted_service: null,
        extracted_date: null,
        extracted_time: null,
        is_ambiguous: true,
        ambiguity_reason: 'User wrote 18, which could mean 18th or 18:00',
        confidence: 0.3,
      },
      text: 'Ah scuze, nu 17, 18',
      timezone: TZ,
    });
    const confirmed = afterSlotCheck(afterCorrection, { available: true });

    assert.equal(confirmed.draft.date, MONDAY, 'date must stay Monday');
    assert.equal(confirmed.draft.time, '18:00', 'time must become 18:00');
    assert.equal(confirmed.state, SESSION_STATES.WAITING_FOR_CONFIRMATION);
    assert.equal(confirmed.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION);

    const text = formatMachineAction({
      action: confirmed.action,
      draft: confirmed.draft,
      clientName: 'Ana',
      timezone: TZ,
    });
    assert.match(text, /Ana/);
    assert.match(text, /Tuns/);
    assert.match(text, /18:00/);
    assert.equal(formatRomanianDate(MONDAY, TZ), 'Luni, 17 august');
    assert.match(text, /Luni, 17 august/);
  });

  it('asks date vs time when "nu 17, 18" has no time/date wait state', () => {
    const reduced = reduceBookingTurn({
      state: SESSION_STATES.INIT,
      draft: emptyDraft(),
      extraction: {
        intent: 'unknown',
        extracted_service: null,
        extracted_date: null,
        extracted_time: null,
        is_ambiguous: true,
        ambiguity_reason: '18 could be date or time',
        confidence: 0.3,
      },
      text: 'nu 17, 18',
      timezone: TZ,
    });
    assert.equal(reduced.action, MACHINE_ACTIONS.ACTION_ASK_CLARIFICATION);
    assert.equal(reduced.clarify_value, 18);
  });
});

describe('existing appointments vs new booking', () => {
  it('treats "am uitat ce programari am" as list, not a new booking', () => {
    const triage = triageUserIntent('am uitat ce programari am');
    assert.equal(triage.intent, 'list_appointments');
    assert.equal(looksLikeExistingAppointmentQuery('am uitat ce programari am'), true);
    assert.equal(looksLikeNewBookingRequest('am uitat ce programari am'), false);
  });

  it('treats "vreau o programare luni la 17" as a new booking', () => {
    const triage = triageUserIntent('vreau o programare luni la 17');
    assert.equal(triage.intent, 'book');
  });
});
