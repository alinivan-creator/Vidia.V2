import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyInboundMessage,
  looksLikeFreeTextBody,
  looksLikeInteractiveChoiceId,
  shouldPreferTypedTextOverTap,
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

  it('keeps short reschedule free-text as text even with a stale payload and no ButtonText', () => {
    const inbound = classifyInboundMessage({
      body: 'vreau sa reprogramez',
      buttonPayload: 'slot_2026-08-19_10:00',
      buttonText: '',
    });
    assert.equal(inbound.kind, 'text');
    assert.equal(inbound.buttonPayload, null);
    assert.equal(inbound.textBody, 'vreau sa reprogramez');
  });

  it('keeps "vreau sa reprogramez o programare" as text with a stray day payload', () => {
    const inbound = classifyInboundMessage({
      body: 'vreau sa reprogramez o programare',
      buttonPayload: 'day_2026-08-24',
      buttonText: 'Luni, 24 Aug',
    });
    assert.equal(inbound.kind, 'text');
    assert.equal(inbound.textBody, 'vreau sa reprogramez o programare');
    assert.equal(inbound.buttonPayload, null);
  });

  it('keeps typed Contact / orar over a stale day_ payload (mid day-grid)', () => {
    const contact = classifyInboundMessage({
      body: 'Contact',
      buttonPayload: 'day_2026-08-24',
      buttonText: 'Luni, 24 Aug',
    });
    assert.equal(contact.kind, 'text');
    assert.equal(contact.buttonPayload, null);
    assert.equal(contact.textBody, 'Contact');

    const hours = classifyInboundMessage({
      body: 'orar',
      buttonPayload: 'slot_2026-08-24_10:00',
      buttonText: '10:00',
    });
    assert.equal(hours.kind, 'text');
    assert.equal(hours.buttonPayload, null);
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

  it('prefers Multumesc / Modific over a stray confirm_booking payload', () => {
    assert.equal(
      shouldPreferTypedTextOverTap({
        typed: 'Multumesc',
        tappedId: 'confirm_booking',
        buttonTitle: 'Confirmă',
      }),
      true,
    );
    assert.equal(
      shouldPreferTypedTextOverTap({
        typed: 'Modific',
        tappedId: 'confirm_booking',
        buttonTitle: 'Confirmă',
      }),
      true,
    );

    const thanks = classifyInboundMessage({
      body: 'Multumesc',
      buttonPayload: 'confirm_booking',
      buttonText: 'Confirmă',
    });
    assert.equal(thanks.kind, 'text');
    assert.equal(thanks.buttonPayload, null);
    assert.equal(thanks.textBody, 'Multumesc');

    const revise = classifyInboundMessage({
      body: 'Modific',
      buttonPayload: 'confirm_booking',
      buttonText: 'Confirmă',
    });
    assert.equal(revise.kind, 'text');
    assert.equal(revise.buttonPayload, null);
    assert.equal(revise.textBody, 'Modific');
  });

  it('keeps Alte opțiuni / 16:00 Disponibil as taps when Body includes description', () => {
    assert.equal(
      shouldPreferTypedTextOverTap({
        typed: 'Alte opțiuni > Vezi următoarele zile / ore',
        tappedId: 'grid_next',
        buttonTitle: 'Alte opțiuni ›',
      }),
      false,
    );
    assert.equal(
      shouldPreferTypedTextOverTap({
        typed: '16:00 Disponibil',
        tappedId: 'slot_2026-08-31_16:00',
        buttonTitle: '16:00',
      }),
      false,
    );

    const pager = classifyInboundMessage({
      body: 'Alte opțiuni > Vezi următoarele zile / ore',
      buttonPayload: 'grid_next',
      buttonText: 'Alte opțiuni ›',
    });
    assert.equal(pager.kind, 'interactive');
    assert.equal(pager.buttonPayload, 'grid_next');

    const slot = classifyInboundMessage({
      body: '16:00 Disponibil',
      buttonPayload: 'slot_2026-08-31_16:00',
      buttonText: '16:00',
    });
    assert.equal(slot.kind, 'interactive');
    assert.equal(slot.buttonPayload, 'slot_2026-08-31_16:00');
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

describe('list/button taps vs free-text (no false stale)', () => {
  it('keeps Alte opțiuni › + grid_next as a tap (title ≠ id is normal)', () => {
    assert.equal(
      shouldPreferTypedTextOverTap({
        typed: 'Alte opțiuni ›',
        tappedId: 'grid_next',
        buttonTitle: 'Alte opțiuni ›',
      }),
      false,
    );
    assert.equal(
      shouldPreferTypedTextOverTap({
        typed: 'Alte opțiuni ›',
        tappedId: 'grid_next',
      }),
      false,
    );
  });

  it('keeps a day list row as a tap when Body is the title', () => {
    assert.equal(
      shouldPreferTypedTextOverTap({
        typed: 'Vineri, 28 Aug',
        tappedId: 'day_2026-08-28',
        buttonTitle: 'Vineri, 28 Aug',
      }),
      false,
    );
  });

  it('still prefers a typed booking sentence over a stray payload', () => {
    assert.equal(
      shouldPreferTypedTextOverTap({
        typed: 'vreau sa reprogramez o programare',
        tappedId: 'grid_next',
        buttonTitle: 'Alte opțiuni ›',
      }),
      true,
    );
  });

  it('classifies Alte opțiuni list pick as interactive grid_next', () => {
    const inbound = classifyInboundMessage({
      body: 'Alte opțiuni ›',
      buttonPayload: 'grid_next',
      buttonText: 'Alte opțiuni ›',
    });
    assert.equal(inbound.kind, 'interactive');
    assert.equal(inbound.buttonPayload, 'grid_next');
    assert.equal(inbound.textBody, 'grid_next');
  });
});

describe('inbound router wiring', () => {
  it('maps buttonText to buttonTitle without ReferenceError', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../src/services/inboundTurnService.js', import.meta.url), 'utf8'),
    );
    assert.match(src, /buttonTitle:\s*buttonText/);
    assert.doesNotMatch(src, /buttonTitle,\s*\n\s*typedText/);
  });
});
