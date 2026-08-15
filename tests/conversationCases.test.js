import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeExistingAppointmentQuery,
  looksLikeGreeting,
  looksLikeNewBookingRequest,
  triageUserIntent,
} from '../src/services/intentTriageService.js';
import {
  recoverSoftParserIntent,
  resolveDeterministicInbound,
} from '../src/services/turnExtract.js';
import { BOOKING_WAIT, interpretNumericFreeText } from '../src/services/bookingWaitState.js';
import { renderHandlerResult } from '../src/services/turnPresent.js';
import { hydrateExtract } from '../src/services/turnExecute.js';
import { unknownInfoClientMessage } from '../src/utils/workingHours.js';

const TZ = 'Europe/Bucharest';
const HOURS_09_18 = { open: '09:00', close: '18:00' };
const ENTRY_MENU = {
  kind: 'entry',
  options: [
    { id: 'book', title: 'Programare' },
    { id: 'info', title: 'Detalii & Prețuri' },
    { id: 'contact', title: 'Contact & Locație' },
  ],
};
const BUSINESS = {
  name: 'VIDIA',
  timezone: TZ,
  menu_buttons: [
    { id: 'book', label: 'Programare', action: 'start_booking' },
    { id: 'info', label: 'Detalii', action: 'show_info' },
    { id: 'contact', label: 'Contact', action: 'show_contact' },
  ],
  booking_settings: { services: [] },
};

function reply(key, data = {}) {
  return renderHandlerResult(BUSINESS, {
    status: 'SUCCESS',
    user_message_template_key: key,
    data: { business_name: 'VIDIA', ...data },
  });
}

describe('inbound cases: greeting, menu, booking, off-topic', () => {
  it('Salut opens the menu, not off-topic', () => {
    assert.equal(looksLikeGreeting('Salut'), true);
    assert.equal(triageUserIntent('Salut').intent, 'menu');
    const text = reply('MENU');
    assert.match(text, /asistentul virtual|Bun venit|programări/i);
    assert.doesNotMatch(text, /nu pot discuta|în afara programului/i);
  });

  it('menu 1 works even when last_menu is missing (stuck session)', () => {
    const extracted = resolveDeterministicInbound({
      textBody: '1',
      lastMenu: null,
      wait: BOOKING_WAIT.TIME,
      timezone: TZ,
      pendingDateKey: '2026-08-17',
      business: BUSINESS,
      dayHours: HOURS_09_18,
    });
    assert.equal(extracted.action, 'book');
    assert.equal(extracted.source, 'menu');
    assert.equal(extracted.time_text, null);
    assert.equal(extracted.date_text, null);
  });

  it('does not glue leftover Monday + 01:00 onto a fresh menu booking', () => {
    const extract = {
      action: 'book',
      source: 'menu',
      date_text: null,
      time_text: null,
      datetime: null,
      slot_id: null,
    };
    const convState = {
      context_data: {
        pending_date_text: '2026-08-17',
        pending_time_text: '01:00',
        pending_datetime: '2026-08-16T22:00:00.000Z',
        draft_booking: { date: '2026-08-17', time: '01:00' },
      },
    };
    const hydrated = hydrateExtract(extract, convState, TZ);
    assert.equal(hydrated.date_text, null);
    assert.equal(hydrated.time_text, null);
    assert.equal(hydrated.datetime, null);
  });

  it('menu 1 starts a booking and is never 01:00', () => {
    const extracted = resolveDeterministicInbound({
      textBody: '1',
      lastMenu: ENTRY_MENU,
      wait: BOOKING_WAIT.TIME,
      timezone: TZ,
      pendingDateKey: '2026-08-17',
      business: BUSINESS,
      dayHours: HOURS_09_18,
    });
    assert.equal(extracted.action, 'book');
    assert.equal(extracted.time_text, null);
    assert.equal(extracted.date_text, null);
    assert.equal(extracted.source, 'menu');
  });

  it('menu 2 and 3 are services and contact', () => {
    const two = resolveDeterministicInbound({
      textBody: '2',
      lastMenu: ENTRY_MENU,
      wait: null,
      timezone: TZ,
      business: BUSINESS,
    });
    const three = resolveDeterministicInbound({
      textBody: '3',
      lastMenu: ENTRY_MENU,
      wait: null,
      timezone: TZ,
      business: BUSINESS,
    });
    assert.equal(two.action, 'services');
    assert.equal(three.action, 'contact');
  });

  it('Programare is a new booking even if the parser says off_topic', () => {
    assert.equal(looksLikeNewBookingRequest('Programare'), true);
    assert.equal(triageUserIntent('Programare').intent, 'book');
    assert.equal(
      recoverSoftParserIntent(
        { action: 'off_topic', confidence: 'low', source: 'nlu' },
        'Programare',
        triageUserIntent('Programare'),
      ).action,
      'book',
    );
  });

  it('isolated 1 without a wait is not a clock hour', () => {
    const numeric = interpretNumericFreeText({
      text: '1',
      wait: null,
      timezone: TZ,
      dayHours: HOURS_09_18,
    });
    assert.equal(numeric.kind, 'none');
    const extracted = resolveDeterministicInbound({
      textBody: '1',
      lastMenu: null,
      wait: null,
      timezone: TZ,
      business: BUSINESS,
      dayHours: HOURS_09_18,
    });
    assert.equal(extracted.action, 'book');
    assert.equal(extracted.time_text, null);
  });

  it('isolated 1 while waiting for time becomes 13:00 when 01:00 is closed', () => {
    const numeric = interpretNumericFreeText({
      text: '1',
      wait: BOOKING_WAIT.TIME,
      timezone: TZ,
      pendingDateKey: '2026-08-17',
      dayHours: HOURS_09_18,
    });
    assert.equal(numeric.kind, 'time');
    assert.equal(numeric.timeHHmm, '13:00');
  });

  it('isolated 17 while waiting for time stays 17:00', () => {
    const numeric = interpretNumericFreeText({
      text: '17',
      wait: BOOKING_WAIT.TIME,
      timezone: TZ,
      dayHours: HOURS_09_18,
    });
    assert.equal(numeric.kind, 'time');
    assert.equal(numeric.timeHHmm, '17:00');
  });

  it('keeps existing-appointment questions off the new-booking path', () => {
    assert.equal(looksLikeExistingAppointmentQuery('am uitat ce programari am'), true);
    assert.equal(triageUserIntent('ce programari am').intent, 'list_appointments');
    assert.equal(looksLikeNewBookingRequest('ce programari am'), false);
  });

  it('hours and contact stay FAQ, not booking', () => {
    assert.equal(triageUserIntent('ce program aveti').intent, 'faq');
    assert.equal(triageUserIntent('unde sunteti').intent, 'contact');
    assert.equal(looksLikeNewBookingRequest('ce program aveti'), false);
  });

  it('insult + booking still books; personal small-talk stays off-topic', () => {
    assert.equal(looksLikeNewBookingRequest('da ma prostule, vreau sa fac o programare'), true);
    const stolen = { action: 'off_topic', confidence: 'low', source: 'nlu' };
    assert.equal(
      recoverSoftParserIntent(stolen, 'ai mancat azi?', { intent: 'unknown', confidence: 'low', reason: 'x' }).action,
      'off_topic',
    );
    assert.equal(
      recoverSoftParserIntent(stolen, 'cum te cheama', { intent: 'unknown', confidence: 'low', reason: 'x' }).action,
      'off_topic',
    );
  });

  it('client copy never mentions Admin or inventing', () => {
    const missing = reply('MISSING_INFO');
    const off = reply('OFF_TOPIC');
    const chat = reply('CHAT_FALLBACK');
    const hours = reply('HOURS_LIST', { hours_configured: false });
    for (const text of [missing, off, chat, hours, unknownInfoClientMessage()]) {
      assert.equal(/admin|invent|setat|configur/i.test(text), false);
    }
    assert.match(missing, /Nu dețin această informație/);
    assert.match(off, /Nu pot discuta asta/);
    assert.match(chat, /Cu ce te pot ajuta/);
    assert.doesNotMatch(reply('ASK_DATE'), /în afara programului/);
  });

  it('confirmed booking includes a tappable add-to-calendar link', () => {
    const text = renderHandlerResult(BUSINESS, {
      status: 'SUCCESS',
      user_message_template_key: 'CONFIRMATION_BOOKED',
      calendar_cta: {
        url: 'https://example.com/calendar/event.ics?title=Tuns',
        title: 'Adaugă în calendar',
      },
      data: {
        service_name: 'Tuns Clasic',
        slot_label: 'Miercuri, 19 Aug. — Ora 16:00',
        client_name: 'Alin Ivan',
      },
    });
    assert.match(text, /Programare confirmată/);
    assert.match(text, /\[📅 Adaugă în calendar\]\(https:\/\/example\.com\/calendar\/event\.ics/);
    assert.doesNotMatch(text, /fișier \.ics/);
  });
});
