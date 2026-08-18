import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGoogleCalendarUrl,
  buildAddToCalendarLink,
  toGoogleCalendarUtc,
} from '../src/utils/calendarLink.js';
import { normalizeHttpUrl, buildContactLinkButtons } from '../src/utils/businessMessages.js';
import { formatContactMessage } from '../src/services/contactService.js';

describe('calendar + contact link rendering', () => {
  it('builds a Google Calendar TEMPLATE URL with title and dates', () => {
    const url = buildGoogleCalendarUrl({
      title: 'Tuns — Salon Test',
      startIso: '2026-08-18T07:00:00.000Z',
      endIso: '2026-08-18T07:30:00.000Z',
      description: 'Serviciu: Tuns',
      location: 'Strada Test 1',
    });
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, 'https://calendar.google.com/calendar/render');
    assert.equal(parsed.searchParams.get('action'), 'TEMPLATE');
    assert.match(parsed.searchParams.get('text') || '', /Tuns/);
    assert.match(parsed.searchParams.get('dates') || '', /20260818T070000Z/);
    assert.equal(parsed.searchParams.get('location'), 'Strada Test 1');
  });

  it('WhatsApp add-to-calendar prefers Google TEMPLATE over hosted .ics', () => {
    const { url, kind } = buildAddToCalendarLink({
      title: 'Tuns',
      startIso: '2026-08-18T07:00:00.000Z',
      endIso: '2026-08-18T07:30:00.000Z',
    });
    assert.equal(kind, 'google');
    assert.match(url, /calendar\.google\.com\/calendar\/render/);
    assert.doesNotMatch(url, /event\.ics/);
    assert.equal(toGoogleCalendarUtc('2026-08-18T07:00:00.000Z'), '20260818T070000Z');
  });

  it('normalizes Admin links and builds compact CTAs without body URLs', () => {
    assert.equal(normalizeHttpUrl('salon.ro'), 'https://salon.ro/');
    assert.equal(normalizeHttpUrl('javascript:alert(1)'), null);

    const business = {
      name: 'Salon Test',
      booking_settings: {
        contact: {
          phone: '0722000000',
          address: 'Strada Test 1',
          website: 'salon.ro',
          maps_url: 'https://maps.google.com/?q=Salon+Test',
        },
      },
    };
    const buttons = buildContactLinkButtons(business);
    assert.equal(buttons.length, 2);
    assert.equal(buttons[0].title, 'Vezi locația');
    assert.equal(buttons[1].title, 'Website');
    assert.match(buttons[1].url, /^https:\/\/salon\.ro/);

    const customOnly = buildContactLinkButtons({
      name: 'Salon Test',
      booking_settings: {
        contact: { website_url: 'https://custom.salon.ro/booking' },
      },
    });
    assert.equal(customOnly.length, 1);
    assert.match(customOnly[0].url, /custom\.salon\.ro/);

    const text = formatContactMessage(business);
    assert.match(text, /Strada Test 1/);
    assert.doesNotMatch(text, /salon\.ro/);
    assert.doesNotMatch(text, /maps\.google/);
    assert.doesNotMatch(text, /\]\(/);
  });
});
