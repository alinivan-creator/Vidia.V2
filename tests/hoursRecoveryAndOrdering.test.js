import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertWithinWorkingHours,
  outOfHoursNotice,
  pickAnotherDayNotice,
} from '../src/utils/workingHours.js';
import { readInboundStamp } from '../src/services/sessionValidator.js';
import {
  beginInboundTurn,
  isStaleOutboundTurn,
  resetTurnSequencer,
} from '../src/services/turnSequencer.js';

const BIZ = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Salon Test',
  timezone: 'Europe/Bucharest',
  booking_settings: {
    services: [{ id: 's1', name: 'Tuns', duration_minutes: 30 }],
    business_hours: {
      '0': null,
      '1': { open: '09:00', close: '18:00' },
      '2': { open: '09:00', close: '18:00' },
      '3': { open: '09:00', close: '18:00' },
      '4': { open: '09:00', close: '18:00' },
      '5': { open: '09:00', close: '18:00' },
      '6': { open: '10:00', close: '14:00' },
    },
  },
};

// Monday 2026-08-24, local Europe/Bucharest is UTC+3 in August.
const MONDAY_20_00 = new Date('2026-08-24T17:00:00.000Z');
const MONDAY_16_00 = new Date('2026-08-24T13:00:00.000Z');
const SUNDAY_11_00 = new Date('2026-08-23T08:00:00.000Z');
const BEFORE = new Date('2026-08-20T09:00:00.000Z');

describe('out-of-hours notice', () => {
  it('states the real window and asks for an hour inside it', () => {
    const check = assertWithinWorkingHours(
      BIZ,
      MONDAY_20_00,
      new Date(MONDAY_20_00.getTime() + 30 * 60_000),
      'ro',
      BEFORE,
    );
    assert.equal(check.ok, false);
    assert.equal(check.reason, 'outside_hours');

    const notice = outOfHoursNotice(BIZ, MONDAY_20_00);
    assert.match(notice, /Programul nostru pentru \*Luni\* este \*09:00–18:00\*/);
    assert.match(notice, /alegi o oră din acest interval/);
    assert.doesNotMatch(notice, /meniu/i);
  });

  it('keeps a valid hour bookable', () => {
    const check = assertWithinWorkingHours(
      BIZ,
      MONDAY_16_00,
      new Date(MONDAY_16_00.getTime() + 30 * 60_000),
      'ro',
      BEFORE,
    );
    assert.equal(check.ok, true);
  });

  it('has no hour window to offer on a closed day', () => {
    assert.equal(outOfHoursNotice(BIZ, SUNDAY_11_00), null);
    const notice = pickAnotherDayNotice(BIZ, SUNDAY_11_00, 'closed');
    assert.match(notice, /închiși/);
    assert.match(notice, /altă zi/);
  });

  it('asks for another day when the time already passed', () => {
    const notice = pickAnotherDayNotice(BIZ, MONDAY_16_00, 'past');
    assert.match(notice, /a trecut deja/);
    assert.match(notice, /altă zi/);
  });

  it('returns no recoverable notice when Admin hours are unset', () => {
    const blank = { ...BIZ, booking_settings: { services: BIZ.booking_settings.services } };
    assert.equal(outOfHoursNotice(blank, MONDAY_20_00), null);
    assert.equal(pickAnotherDayNotice(blank, MONDAY_20_00, 'hours_unset'), null);
  });
});

describe('outbound turn ordering', () => {
  beforeEach(() => {
    resetTurnSequencer();
  });

  it('lets the newest turn reply and drops the previous one', () => {
    beginInboundTurn(BIZ.id, '40721000000', 'req-1');
    assert.equal(isStaleOutboundTurn(BIZ.id, '40721000000', 'req-1'), false);

    beginInboundTurn(BIZ.id, '40721000000', 'req-2');
    assert.equal(isStaleOutboundTurn(BIZ.id, '40721000000', 'req-1'), true);
    assert.equal(isStaleOutboundTurn(BIZ.id, '40721000000', 'req-2'), false);
  });

  it('keeps tenants and clients isolated', () => {
    beginInboundTurn(BIZ.id, '40721000000', 'req-1');
    beginInboundTurn(BIZ.id, '40721000000', 'req-2');
    beginInboundTurn(BIZ.id, '40722000000', 'req-3');
    assert.equal(isStaleOutboundTurn(BIZ.id, '40722000000', 'req-3'), false);
    assert.equal(isStaleOutboundTurn('other-business', '40721000000', 'req-1'), false);
  });

  it('never blocks sends it does not know (cron, reminders, Admin)', () => {
    beginInboundTurn(BIZ.id, '40721000000', 'req-1');
    beginInboundTurn(BIZ.id, '40721000000', 'req-2');
    assert.equal(isStaleOutboundTurn(BIZ.id, '40721000000', 'cron-job'), false);
    assert.equal(isStaleOutboundTurn(BIZ.id, '40721000000', null), false);
  });
});

describe('inbound stamp reader', () => {
  it('ignores updated_at so backend writes are not read as a new message', () => {
    const conv = {
      updated_at: '2026-08-24T10:00:00.000Z',
      context_data: { session_timestamp: '2026-08-24T09:00:00.000Z' },
    };
    assert.equal(readInboundStamp(conv), Date.parse('2026-08-24T09:00:00.000Z'));
    assert.equal(readInboundStamp({ updated_at: '2026-08-24T10:00:00.000Z', context_data: {} }), 0);
  });
});
