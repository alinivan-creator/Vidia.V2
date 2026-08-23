import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isEntryMenuChoiceId,
  normalizeEntryMenuLabel,
  resolveEntryMenuChoiceId,
} from '../src/utils/entryMenu.js';
import { extractTurnIntent } from '../src/services/turnExtract.js';

const BUSINESS = {
  id: 'biz-entry-test',
  name: 'Salon Test',
  timezone: 'Europe/Bucharest',
  business_type: 'salon',
  menu_buttons: [
    { id: 'book', label: '📅 Programare', action: 'start_booking' },
    { id: 'info', label: 'ℹ️ Detalii & Prețuri', action: 'show_info' },
    { id: 'contact', label: '📞 Contact & Locație', action: 'show_contact' },
  ],
  booking_settings: {
    services: [{ id: 's1', name: 'Tuns', duration_minutes: 30 }],
    contact: { phone: '+40123456789', address: 'Str. Test 1' },
  },
};

describe('entry menu resolution', () => {
  it('normalizes emoji-prefixed labels', () => {
    assert.equal(normalizeEntryMenuLabel('📞 Contact & Locație'), 'contact & locatie');
  });

  it('recognizes configured entry button ids', () => {
    assert.equal(isEntryMenuChoiceId(BUSINESS, 'contact'), true);
    assert.equal(isEntryMenuChoiceId(BUSINESS, 'slot_2026-08-24_10:00'), false);
  });

  it('maps visible label text to entry button id', () => {
    assert.equal(
      resolveEntryMenuChoiceId(BUSINESS, { textBody: '📞 Contact & Locație' }),
      'contact',
    );
    assert.equal(
      resolveEntryMenuChoiceId(BUSINESS, { textBody: '📞 Contact & Loca' }),
      'contact',
    );
  });

  it('contact tap resolves even when last_menu was cleared after booking', async () => {
    const convState = {
      current_step: 'IDLE',
      context_data: {
        last_menu: null,
        ai_disclosed: true,
        session_language: 'ro',
      },
    };

    const extract = await extractTurnIntent({
      business: BUSINESS,
      textBody: 'contact',
      buttonPayload: 'contact',
      buttonTitle: '📞 Contact & Loca',
      typedText: '📞 Contact & Loca',
      convState,
      activeDraft: null,
      requestId: 'req-entry-contact',
    });

    assert.equal(extract.action, 'contact');
    assert.notEqual(extract.action, 'stale_choice');
  });
});
