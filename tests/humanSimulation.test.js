/**
 * Five simulation waves. Each case asserts the calendar day and clock,
 * not that the bot merely replied. Frozen clock: Saturday 15 Aug 2026, 16:00 Bucharest.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRomanianDateTimeParts } from '../src/utils/roDateTime.js';
import { BOOKING_WAIT, interpretNumericFreeText } from '../src/services/bookingWaitState.js';
import { resolveDeterministicInbound } from '../src/services/turnExtract.js';
import { assertWithinWorkingHours } from '../src/utils/workingHours.js';
import { localToUtc } from '../src/utils/datetime.js';

const TZ = 'Europe/Bucharest';
const NOW = new Date('2026-08-15T13:00:00.000Z');
const HOURS_09_18 = { open: '09:00', close: '18:00' };
const SUNDAY = '2026-08-16';
const MONDAY = '2026-08-17';
const SATURDAY = '2026-08-15';

const WEEKEND_CLOSED = {
  name: 'Salon',
  timezone: TZ,
  services: [
    { id: 'svc-clasic', name: 'Tuns Clasic', duration_minutes: 30 },
    { id: 'svc-combo', name: 'Tuns + Barba', duration_minutes: 45 },
    { id: 'svc-aranjat', name: 'Aranjat Barba', duration_minutes: 20 },
  ],
  booking_settings: {
    services: [
      { id: 'svc-clasic', name: 'Tuns Clasic', duration_minutes: 30 },
      { id: 'svc-combo', name: 'Tuns + Barba', duration_minutes: 45 },
      { id: 'svc-aranjat', name: 'Aranjat Barba', duration_minutes: 20 },
    ],
    business_hours: {
      '0': null,
      '1': HOURS_09_18,
      '2': HOURS_09_18,
      '3': HOURS_09_18,
      '4': HOURS_09_18,
      '5': HOURS_09_18,
      '6': null,
    },
  },
};

const SERVICE_MENU = {
  kind: 'service',
  options: [
    { id: 'svc_svc-clasic', title: 'Tuns Clasic' },
    { id: 'svc_svc-combo', title: 'Tuns + Barba' },
    { id: 'svc_svc-aranjat', title: 'Aranjat Barba' },
  ],
};

function parse(text) {
  return parseRomanianDateTimeParts(text, TZ, NOW, { dayHours: HOURS_09_18 });
}

function numeric(text, wait = BOOKING_WAIT.DATE_TIME) {
  return interpretNumericFreeText({
    text,
    wait,
    timezone: TZ,
    dayHours: HOURS_09_18,
    now: NOW,
  });
}

function inbound(text, wait = BOOKING_WAIT.DATE_TIME) {
  return resolveDeterministicInbound({
    textBody: text,
    lastMenu: SERVICE_MENU,
    wait,
    timezone: TZ,
    business: WEEKEND_CLOSED,
    dayHours: HOURS_09_18,
    now: NOW,
  });
}

function hours(dateKey, hhmm) {
  const start = localToUtc(dateKey, hhmm, TZ);
  const end = new Date(start.getTime() + 30 * 60_000);
  return assertWithinWorkingHours(WEEKEND_CLOSED, start, end, 'ro', NOW);
}

function expectSlot(text, dateKey, timeHHmm) {
  const parsed = parse(text);
  assert.equal(parsed.dateKey, dateKey, `${text} date`);
  assert.equal(parsed.timeHHmm, timeHHmm, `${text} time`);
  const spoken = numeric(text);
  assert.equal(spoken.kind, 'datetime', `${text} kind`);
  assert.equal(spoken.dateKey, dateKey, `${text} numeric date`);
  assert.equal(spoken.timeHHmm, timeHHmm, `${text} numeric time`);
}

describe('wave 1 — relative days with accents, caps, no diacritics', () => {
  it('maine / poimaine / ieri / alaltaieri / azi / astazi follow the business clock', () => {
    const cases = [
      ['Maine la 12', SUNDAY, '12:00'],
      ['mâine la 12', SUNDAY, '12:00'],
      ['MÂINE LA 12', SUNDAY, '12:00'],
      ['maine ora 12', SUNDAY, '12:00'],
      ['maine la ora 12', SUNDAY, '12:00'],
      ['pt maine la 12', SUNDAY, '12:00'],
      ['as vrea maine la 12', SUNDAY, '12:00'],
      ['poimaine la 11', MONDAY, '11:00'],
      ['poimâine la 11', MONDAY, '11:00'],
      ['peste 2 zile la 11', MONDAY, '11:00'],
      ['peste o zi la 12', SUNDAY, '12:00'],
      ['ieri la 12', '2026-08-14', '12:00'],
      ['alaltaieri la 10', '2026-08-13', '10:00'],
      ['alaltăieri la 10', '2026-08-13', '10:00'],
      ['azi la 10', SATURDAY, '10:00'],
      ['astazi la 10', SATURDAY, '10:00'],
      ['astăzi la 10', SATURDAY, '10:00'],
      ['tomorrow at 12', SUNDAY, '12:00'],
      ['yesterday at 10', '2026-08-14', '10:00'],
    ];
    for (const [text, dateKey, time] of cases) {
      expectSlot(text, dateKey, time);
    }
  });
});

describe('wave 2 — clock spellings people actually type', () => {
  it('accepts missing la, spaces, comma, jumate, seara, pranz', () => {
    const cases = [
      ['maine 12', SUNDAY, '12:00'],
      ['luni 12 30', MONDAY, '12:30'],
      ['Luni la 12 30', MONDAY, '12:30'],
      ['luni 12:30', MONDAY, '12:30'],
      ['luni la 12.30', MONDAY, '12:30'],
      ['luni la 12,30', MONDAY, '12:30'],
      ['luni la 11 jumate', MONDAY, '11:30'],
      ['luni la 11 si jumatate', MONDAY, '11:30'],
      ['luni la 11 si jumătate', MONDAY, '11:30'],
      ['luni la 11,20', MONDAY, '11:20'],
      ['luni seara la 7', MONDAY, '19:00'],
      ['luni dimineata la 10', MONDAY, '10:00'],
      ['luni dimineață la 10', MONDAY, '10:00'],
      ['daca se poate luni la 10', MONDAY, '10:00'],
      ['maine la pranz', SUNDAY, '12:00'],
      ['maine la amiaza', SUNDAY, '12:00'],
      ['maine la prânz', SUNDAY, '12:00'],
      ['Monday at 12 30', MONDAY, '12:30'],
      ['tuns clasic luni la 12 30', MONDAY, '12:30'],
    ];
    for (const [text, dateKey, time] of cases) {
      expectSlot(text, dateKey, time);
    }
    assert.equal(parse('12 30').timeHHmm, '12:30');
    assert.equal(numeric('12 30', BOOKING_WAIT.TIME).kind, 'time');
    assert.equal(numeric('12 30', BOOKING_WAIT.TIME).timeHHmm, '12:30');
  });
});

describe('wave 3 — the WhatsApp screenshot sequence', () => {
  it('1 picks Tuns Clasic; Maine is Sunday not Saturday; Luni 12 30 is Monday 12:30', () => {
    const pick = resolveDeterministicInbound({
      textBody: '1',
      lastMenu: SERVICE_MENU,
      wait: BOOKING_WAIT.SERVICE,
      timezone: TZ,
      business: WEEKEND_CLOSED,
      now: NOW,
    });
    assert.equal(pick.action, 'select_service');
    assert.equal(pick.service_name, 'Tuns Clasic');

    const maine = inbound('Maine la 12', BOOKING_WAIT.DATE_TIME);
    assert.equal(maine.date_text, SUNDAY);
    assert.equal(maine.time_text, '12:00');
    assert.equal(maine.service_name, null);
    const closed = hours(SUNDAY, '12:00');
    assert.equal(closed.ok, false);
    assert.equal(closed.reason, 'closed');
    assert.match(closed.message, /Duminică/);
    assert.doesNotMatch(closed.message, /Sâmbătă/);

    const luni = inbound('Luni la 12 30', BOOKING_WAIT.DATE_TIME);
    assert.equal(luni.date_text, MONDAY);
    assert.equal(luni.time_text, '12:30');
    const open = hours(MONDAY, '12:30');
    assert.equal(open.ok, true, open.message);
  });

  it('while asking for a slot, leftover service menu 3 is 15:00 not Aranjat Barba', () => {
    const extracted = inbound('3', BOOKING_WAIT.DATE_TIME);
    assert.equal(extracted.service_name, null);
    assert.equal(extracted.time_text, '15:00');
  });

  it('nu 12, 13 while asking for date/time moves the hour to 13:00', () => {
    const spoken = numeric('nu 12, 13', BOOKING_WAIT.DATE_TIME);
    assert.equal(spoken.kind, 'time');
    assert.equal(spoken.timeHHmm, '13:00');
  });
});

describe('wave 4 — no past slots; closed day is the day they asked for', () => {
  it('rejects ieri, alaltaieri, and this morning, and names Sunday not Saturday for maine', () => {
    assert.equal(hours('2026-08-14', '12:00').reason, 'past');
    assert.equal(hours('2026-08-13', '10:00').reason, 'past');
    assert.equal(hours(SATURDAY, '10:00').reason, 'past');
    const maineClosed = hours(SUNDAY, '12:00');
    assert.equal(maineClosed.reason, 'closed');
    assert.match(maineClosed.message, /Duminică/);
    const seara = hours(MONDAY, '19:00');
    assert.equal(seara.reason, 'outside_hours');
    assert.match(seara.message, /Luni/);
    const ok = hours(MONDAY, '10:00');
    assert.equal(ok.ok, true);
  });
});

describe('wave 5 — one-shot messy booking lines keep service + slot together', () => {
  it('names the service and the slot in the same WhatsApp bubble', () => {
    const lines = [
      ['tuns clasic maine la 12', 'Tuns Clasic', SUNDAY, '12:00'],
      ['tuns clasic luni la 12 30', 'Tuns Clasic', MONDAY, '12:30'],
      ['aranjat barba luni la 10', 'Aranjat Barba', MONDAY, '10:00'],
      ['Tuns + Barba marți la 3', 'Tuns + Barba', '2026-08-18', '15:00'],
    ];
    for (const [text, service, dateKey, time] of lines) {
      const extracted = inbound(text, BOOKING_WAIT.DATE_TIME);
      assert.equal(extracted.action, 'book', text);
      assert.equal(extracted.service_name, service, text);
      assert.equal(extracted.date_text, dateKey, text);
      assert.equal(extracted.time_text, time, text);
    }
  });
});
