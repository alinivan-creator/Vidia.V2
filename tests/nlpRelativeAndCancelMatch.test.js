import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRomanianDateTimeParts } from '../src/utils/roDateTime.js';
import { buildSystemClock } from '../src/services/entityExtractor.js';
import {
  matchAppointmentsBySlotHints,
  resolveTargetAppointment,
  nextRescheduleSlotStep,
} from '../src/utils/appointmentMatch.js';

const TZ = 'Europe/Bucharest';
// Fixed: Monday 17 Aug 2026 08:52 Bucharest (summer = UTC+3)
const NOW = new Date('2026-08-17T05:52:00.000Z');

describe('relative NLP datetime', () => {
  it('buildSystemClock exposes human Romanian label', () => {
    const clock = buildSystemClock(TZ, NOW);
    assert.match(clock.human, /Astăzi este Luni/i);
    assert.match(clock.human, /17 august 2026/i);
    assert.match(clock.human, /ora 08:52/);
    assert.equal(clock.date, '2026-08-17');
  });

  it('parses mâine / peste 3 zile / joi săptămâna viitoare', () => {
    assert.equal(parseRomanianDateTimeParts('mâine', TZ, NOW).dateKey, '2026-08-18');
    assert.equal(parseRomanianDateTimeParts('peste 3 zile', TZ, NOW).dateKey, '2026-08-20');
    assert.equal(parseRomanianDateTimeParts('peste 3 zile la 9 dimineața', TZ, NOW).dateKey, '2026-08-20');
    assert.equal(parseRomanianDateTimeParts('peste 3 zile la 9 dimineața', TZ, NOW).timeHHmm, '09:00');
    // 17 Aug 2026 is Monday → next week Thursday = 27 Aug
    assert.equal(parseRomanianDateTimeParts('joi săptămâna viitoare', TZ, NOW).dateKey, '2026-08-27');
    assert.equal(parseRomanianDateTimeParts('de azi într-o săptămână', TZ, NOW).dateKey, '2026-08-24');
  });

  it('parses săptămâna viitoare / peste două zile|ore / poimâine', () => {
    assert.equal(parseRomanianDateTimeParts('Săptămâna viitoare', TZ, NOW).dateKey, '2026-08-24');
    assert.equal(parseRomanianDateTimeParts('saptamana urmatoare', TZ, NOW).dateKey, '2026-08-24');
    assert.equal(parseRomanianDateTimeParts('peste doua zile', TZ, NOW).dateKey, '2026-08-19');
    assert.equal(parseRomanianDateTimeParts('peste 2 zile', TZ, NOW).dateKey, '2026-08-19');
    assert.equal(parseRomanianDateTimeParts('poimâine', TZ, NOW).dateKey, '2026-08-19');
    const inTwoHours = parseRomanianDateTimeParts('peste doua ore', TZ, NOW);
    assert.equal(inTwoHours.dateKey, '2026-08-17');
    assert.equal(inTwoHours.timeHHmm, '10:52');
  });

  it('parses peste 2 ore from now', () => {
    const parsed = parseRomanianDateTimeParts('peste 2 ore', TZ, NOW);
    assert.equal(parsed.dateKey, '2026-08-17');
    assert.equal(parsed.timeHHmm, '10:52');
  });
});

describe('deterministic date beats LLM today', () => {
  it('applyParsedDateTime overwrites ISO today when text is relative', async () => {
    const { resolveExplicitSlot } = await import('../src/services/turnExtract.js');
    // resolveExplicitSlot uses the same parser; verify relative phrases resolve off "today"
    const business = { timezone: TZ, business_hours: {} };
    const week = resolveExplicitSlot('De azi într-o săptămână', business, NOW);
    assert.equal(week?.dateKey, '2026-08-24');
    const nextWeek = resolveExplicitSlot('Săptămâna viitoare', business, NOW);
    assert.equal(nextWeek?.dateKey, '2026-08-24');
    const twoDays = resolveExplicitSlot('peste doua zile', business, NOW);
    assert.equal(twoDays?.dateKey, '2026-08-19');
  });

  it('reduceBookingTurn prefers uttered relative date over LLM extracted_date=today', async () => {
    const { reduceBookingTurn, SESSION_STATES } = await import('../src/lib/booking/stateMachine.js');
    const reduced = reduceBookingTurn({
      state: SESSION_STATES.WAITING_FOR_DATE,
      draft: { service_id: 'svc1', service_name: 'Tuns', date: null, time: null, duration: 30 },
      extraction: {
        intent: 'book',
        extracted_service: 'Tuns',
        extracted_date: '2026-08-17',
        extracted_time: null,
        is_ambiguous: false,
        ambiguity_reason: null,
        confidence: 0.9,
      },
      text: 'De azi într-o săptămână',
      timezone: TZ,
      extractDate: '2026-08-17',
      extractTime: null,
      extractServiceId: 'svc1',
      extractServiceName: 'Tuns',
      now: NOW,
    });
    assert.equal(reduced.draft.date, '2026-08-24');
  });
});
describe('appointment match by slot hints', () => {
  const appts = [
    {
      id: 'a1',
      selected_slot_start: '2026-08-17T08:00:00.000Z', // 11:00 Bucharest
      selected_service: { name: 'Tuns' },
    },
    {
      id: 'a2',
      selected_slot_start: '2026-08-18T07:00:00.000Z', // 10:00 next day
      selected_service: { name: 'Barba' },
    },
  ];

  it('resolves unique cancel target from date+time', () => {
    const matched = matchAppointmentsBySlotHints(
      appts,
      { dateKey: '2026-08-17', timeHHmm: '11:00' },
      TZ,
    );
    assert.equal(matched.match?.id, 'a1');

    const resolved = resolveTargetAppointment(
      appts,
      { dateKey: '2026-08-17', timeHHmm: '11:00' },
      TZ,
      'cancel',
    );
    assert.equal(resolved.appointment?.id, 'a1');
    assert.equal(resolved.reason, 'slot_hint');
  });

  it('skips the picker when the client has exactly one booking', () => {
    const resolved = resolveTargetAppointment(
      [appts[0]],
      {},
      TZ,
      'cancel',
    );
    assert.equal(resolved.appointment?.id, 'a1');
    assert.equal(resolved.reason, 'single');
  });

  it('does not guess a generic weekday among multiple bookings', () => {
    const resolved = resolveTargetAppointment(
      appts,
      { dateKey: '2026-08-17' },
      TZ,
      'cancel',
    );
    assert.equal(resolved.appointment, null);
    assert.equal(resolved.reason, 'need_choice');
    assert.equal(resolved.candidates.length, 1);
    assert.equal(resolved.candidates[0].id, 'a1');
  });

  it('does not guess when forceChoice (anulează tot / plural)', () => {
    const resolved = resolveTargetAppointment(
      appts,
      { dateKey: '2026-08-17', timeHHmm: '11:00' },
      TZ,
      'cancel',
      { forceChoice: true },
    );
    assert.equal(resolved.appointment, null);
    assert.equal(resolved.reason, 'need_choice');
  });

  it('locks the tapped booking_id even among many', () => {
    const resolved = resolveTargetAppointment(
      appts,
      { appointmentId: 'a2' },
      TZ,
      'cancel',
      { forceChoice: true },
    );
    assert.equal(resolved.appointment?.id, 'a2');
    assert.equal(resolved.reason, 'id');
  });

  it('does not loop: not_found for cancel when hint misses', () => {
    const resolved = resolveTargetAppointment(
      appts,
      { dateKey: '2026-08-19', timeHHmm: '15:00' },
      TZ,
      'cancel',
    );
    assert.equal(resolved.appointment, null);
    assert.equal(resolved.reason, 'not_found');
  });

  it('reschedule treats unmatched date as new-slot need_choice', () => {
    const resolved = resolveTargetAppointment(
      appts,
      { dateKey: '2026-08-20', timeHHmm: '09:00' },
      TZ,
      'reschedule',
    );
    assert.equal(resolved.reason, 'need_choice');
    assert.equal(resolved.newSlotHints, true);
  });

  it('reschedule asks for a new day unless date+time of the new slot are both known', () => {
    assert.equal(nextRescheduleSlotStep({ resolvedReason: 'single' }).kind, 'ask_date');
    assert.equal(nextRescheduleSlotStep({ resolvedReason: 'id' }).kind, 'ask_date');
    assert.equal(
      nextRescheduleSlotStep({
        resolvedReason: 'slot_hint',
        extractDate: '2026-08-17',
        extractTime: '11:00',
      }).kind,
      'ask_date',
    );
    assert.equal(
      nextRescheduleSlotStep({ resolvedReason: 'single', extractDate: '2026-08-20' }).kind,
      'ask_time',
    );
    assert.deepEqual(
      nextRescheduleSlotStep({
        resolvedReason: 'single',
        extractDate: '2026-08-20',
        extractTime: '10:00',
      }),
      { kind: 'apply', date: '2026-08-20', time: '10:00' },
    );
    assert.equal(
      nextRescheduleSlotStep({
        resolvedReason: 'id',
        pendingDate: '2026-08-21',
        extractTime: '14:00',
      }).kind,
      'apply',
    );
  });
});

describe('cancel-all + appointment list picker', () => {
  it('detects anulează tot / toate', async () => {
    const { looksLikeCancelAll, looksLikePluralAppointments } = await import('../src/services/intentTriageService.js');
    assert.equal(looksLikeCancelAll('Vreau să anulez tot'), true);
    assert.equal(looksLikeCancelAll('anulează toate programările'), true);
    assert.equal(looksLikeCancelAll('anulează-le pe toate'), true);
    assert.equal(looksLikeCancelAll('Vreau să anulez'), false);
    assert.equal(looksLikePluralAppointments('anulează programările'), true);
  });

  it('builds WhatsApp-safe titles and optional cancel-all row', async () => {
    const { buildAppointmentChoiceMenu } = await import('../src/utils/appointmentMatch.js');
    const { MOD_PREFIX } = await import('../src/services/flowIds.js');
    const rows = buildAppointmentChoiceMenu(
      [
        {
          id: 'a1',
          selected_slot_start: '2026-08-17T08:00:00.000Z',
          selected_service: { name: 'Tuns + spălat + aranjat' },
        },
        {
          id: 'a2',
          selected_slot_start: '2026-08-21T07:00:00.000Z',
          selected_service: { name: 'Barba' },
        },
      ],
      TZ,
      { includeCancelAll: true, apptPrefix: MOD_PREFIX.APPT, cancelAllId: MOD_PREFIX.CANCEL_ALL },
    );
    assert.equal(rows.length, 3);
    for (const row of rows) {
      assert.ok(row.title.length <= 24, row.title);
      assert.ok((row.description || '').length <= 72);
    }
    assert.equal(rows[0].id, `${MOD_PREFIX.APPT}a1`);
    assert.match(rows[0].description, /Tuns/);
    assert.equal(rows[2].id, MOD_PREFIX.CANCEL_ALL);
    assert.match(rows[2].title, /toate/i);
  });
});

describe('colloquial cancel / reschedule NLP', () => {
  it('captures Romanian cancel variants and skips fallback intents', async () => {
    const { detectModificationIntent, triageUserIntent } = await import('../src/services/intentTriageService.js');
    const phrases = [
      'vreau să anulez niște programări',
      'să șterg o programare',
      'renunț la programare',
      'șterg vineri',
      'anulează programarea',
      'nu mai vin',
    ];
    for (const phrase of phrases) {
      assert.equal(detectModificationIntent(phrase), 'cancel', phrase);
      assert.equal(triageUserIntent(phrase).intent, 'cancel', phrase);
    }
    assert.equal(detectModificationIntent('reprogramez programarea'), 'reschedule');
    assert.equal(detectModificationIntent('vreau să modific ora'), 'reschedule');
    assert.equal(detectModificationIntent('ce prețuri aveți'), null);
    assert.equal(detectModificationIntent('ștergeți datele mele'), null);
  });

  it('does not auto-pick a weekday among many bookings', () => {
    const fridayAndSat = [
      {
        id: 'a1',
        selected_slot_start: '2026-08-21T07:00:00.000Z', // Friday 10:00 Bucharest
        selected_service: { name: 'Tuns' },
      },
      {
        id: 'a2',
        selected_slot_start: '2026-08-22T07:00:00.000Z',
        selected_service: { name: 'Barba' },
      },
    ];
    const resolved = resolveTargetAppointment(
      fridayAndSat,
      { dateKey: '2026-08-21' },
      TZ,
      'cancel',
    );
    assert.equal(resolved.appointment, null);
    assert.equal(resolved.reason, 'need_choice');
    assert.equal(resolved.candidates.length, 1);
    assert.equal(resolved.candidates[0].id, 'a1');
  });
});
