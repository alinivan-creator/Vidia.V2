import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyInboundMessage,
  looksLikeFreeTextBody,
  looksLikeInteractiveChoiceId,
} from '../src/utils/inboundPayload.js';
import {
  timeWindowForDate,
  timeWindowFullNotice,
  timeWindowOutsideHoursNotice,
} from '../src/utils/workingHours.js';
import {
  detectTimeWindowFromText,
  looksLikeAvailabilityQuestion,
  timeWindowLabel,
} from '../src/utils/timeWindow.js';
import { parseRomanianDateTimeParts } from '../src/utils/roDateTime.js';

const BIZ = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Salon Test',
  timezone: 'Europe/Bucharest',
  booking_settings: {
    services: [{ id: 's1', name: 'Tuns', duration_minutes: 30 }],
    business_hours: {
      '0': null,
      '1': { open: '09:00', close: '18:00' },
      '2': { open: '09:00', close: '17:00' },
      '3': { open: '09:00', close: '21:00' },
      '4': { open: '09:00', close: '18:00' },
      '5': { open: '09:00', close: '18:00' },
      '6': { open: '10:00', close: '14:00' },
    },
  },
};

const MONDAY = '2026-08-24';
const TUESDAY = '2026-08-25';
const WEDNESDAY = '2026-08-26';
const SUNDAY = '2026-08-23';

describe('inbound payload classification', () => {
  it('reads a quick-reply tap as interactive', () => {
    const inbound = classifyInboundMessage({
      body: 'Programare',
      buttonPayload: 'menu_book',
      buttonText: 'Programare',
    });
    assert.equal(inbound.kind, 'interactive');
    assert.equal(inbound.buttonPayload, 'menu_book');
    assert.equal(inbound.textBody, 'menu_book');
  });

  it('reads a list pick as interactive even without ListTitle', () => {
    const inbound = classifyInboundMessage({
      body: 'Luni, 24 Aug',
      buttonPayload: 'day_2026-08-24',
      buttonText: '',
    });
    assert.equal(inbound.kind, 'interactive');
    assert.equal(inbound.buttonPayload, 'day_2026-08-24');
  });

  it('keeps a typed sentence as text when a stale payload rides along', () => {
    const inbound = classifyInboundMessage({
      body: 'Aveti liber maine seara?',
      buttonPayload: 'day_2026-08-20',
      buttonText: '',
    });
    assert.equal(inbound.kind, 'text');
    assert.equal(inbound.buttonPayload, null);
    assert.equal(inbound.textBody, 'Aveti liber maine seara?');
  });

  it('keeps a typed sentence as text when the payload echoes another button', () => {
    const inbound = classifyInboundMessage({
      body: 'as vrea o programare pentru tuns',
      buttonPayload: 'menu_book',
      buttonText: 'Programare',
    });
    assert.equal(inbound.kind, 'text');
    assert.equal(inbound.buttonPayload, null);
  });

  it('drops a payload that is not shaped like an option id', () => {
    const inbound = classifyInboundMessage({
      body: 'Vezi programul',
      buttonPayload: 'Vezi programul',
      buttonText: 'Vezi programul',
    });
    assert.equal(inbound.kind, 'text');
    assert.equal(inbound.buttonPayload, null);
  });

  it('treats plain text as text', () => {
    const inbound = classifyInboundMessage({ body: 'Aveti liber maine seara?' });
    assert.equal(inbound.kind, 'text');
    assert.equal(inbound.isInteractive, false);
  });

  it('knows option ids from sentences', () => {
    assert.equal(looksLikeInteractiveChoiceId('slot_2026-08-24T16:00'), true);
    assert.equal(looksLikeInteractiveChoiceId('svc_s1'), true);
    assert.equal(looksLikeInteractiveChoiceId('mod_cancel_all'), true);
    assert.equal(looksLikeInteractiveChoiceId('Aveti liber maine seara?'), false);
    assert.equal(looksLikeInteractiveChoiceId(''), false);
  });

  it('recognises bodies no option title could carry', () => {
    assert.equal(looksLikeFreeTextBody('Aveti liber maine seara?'), true);
    assert.equal(looksLikeFreeTextBody('as vrea o programare pentru tuns'), true);
    assert.equal(looksLikeFreeTextBody('Luni, 24 Aug'), false);
    assert.equal(looksLikeFreeTextBody('16:00'), false);
  });
});

describe('day-part parsing', () => {
  it('reads "maine seara" as tomorrow evening', () => {
    assert.equal(detectTimeWindowFromText('Aveti liber maine seara?'), 'evening');
    assert.equal(looksLikeAvailabilityQuestion('Aveti liber maine seara?'), true);
    const parts = parseRomanianDateTimeParts('Aveti liber maine seara?', BIZ.timezone);
    assert.match(parts.dateKey, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(parts.timeHHmm, null);
  });

  it('never leaks the internal window key', () => {
    assert.equal(timeWindowLabel('evening'), 'seara');
    assert.equal(timeWindowLabel('morning'), 'dimineața');
    assert.equal(timeWindowLabel('nonsense'), null);
  });
});

describe('day-part clipped to Admin hours', () => {
  it('maps evening to the real closing hour of that day', () => {
    assert.deepEqual(
      timeWindowForDate(BIZ, MONDAY, 'evening'),
      {
        window: 'evening',
        label: 'seara',
        dayName: 'Luni',
        open: true,
        overlaps: true,
        startHHmm: '17:00',
        endHHmm: '18:00',
        dayOpen: '09:00',
        dayClose: '18:00',
      },
    );
    assert.equal(timeWindowForDate(BIZ, WEDNESDAY, 'evening').endHHmm, '21:00');
    assert.equal(timeWindowForDate(BIZ, MONDAY, 'morning').startHHmm, '09:00');
  });

  it('reports no overlap when the day closes before the window', () => {
    const info = timeWindowForDate(BIZ, TUESDAY, 'evening');
    assert.equal(info.overlaps, false);
    const notice = timeWindowOutsideHoursNotice(BIZ, TUESDAY, 'evening');
    assert.match(notice, /\*Marți\* nu lucrăm seara/);
    assert.match(notice, /\*09:00–17:00\*/);
    assert.match(notice, /orele libere din acest interval/);
  });

  it('asks for another day only when the business is closed', () => {
    const notice = timeWindowOutsideHoursNotice(BIZ, SUNDAY, 'evening');
    assert.match(notice, /închiși/);
    assert.match(notice, /altă zi/);
  });

  it('stays silent when the requested window is bookable', () => {
    assert.equal(timeWindowOutsideHoursNotice(BIZ, MONDAY, 'evening'), null);
    assert.equal(timeWindowForDate(BIZ, MONDAY, null), null);
  });

  it('offers the rest of the day when the window is full', () => {
    const notice = timeWindowFullNotice(BIZ, MONDAY, 'evening');
    assert.match(notice, /\*Luni\* seara nu mai am ore libere/);
    assert.match(notice, /restul intervalelor/);
  });
});
