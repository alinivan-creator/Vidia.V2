import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatServiceAskMessage } from '../src/utils/serviceMatch.js';
import { buildBookingConfirmationMessage, buildGdprNote } from '../src/utils/businessMessages.js';
import { TECHNICAL_FALLBACK_MESSAGE } from '../src/services/circuitBreaker.js';
import { t } from '../src/utils/uiI18n.js';

const business = {
  id: 'b1',
  name: 'Salon Test',
  timezone: 'Europe/Bucharest',
  booking_settings: {},
};

describe('VIDIA message tone', () => {
  it('service ask can greet once and stays short', () => {
    const withHi = formatServiceAskMessage(
      [{ id: '1', name: 'Tuns Clasic', duration_minutes: 30 }],
      'ro',
      { withGreeting: true },
    );
    assert.match(withHi, /Salut! 👋/);
    assert.match(withHi, /Ce serviciu dorești/);
    assert.match(withHi, /Servicii/);

    const again = formatServiceAskMessage(
      [{ id: '1', name: 'Tuns Clasic', duration_minutes: 30 }],
      'ro',
      { withGreeting: false },
    );
    assert.doesNotMatch(again, /Salut!/);
  });

  it('booking confirmation closes warmly with next step', () => {
    const text = buildBookingConfirmationMessage({
      business,
      serviceName: 'Tuns Clasic',
      slotLabel: 'vineri 15:00',
      clientName: 'Ana',
      mapsLine: '',
      lang: 'ro',
    });
    assert.match(text, /✅/);
    assert.match(text, /Programare confirmată/);
    assert.match(text, /Te așteptăm/);
    assert.match(text, /modifici sau anulezi/);
  });

  it('technical fallback offers a concrete next step', () => {
    assert.match(TECHNICAL_FALLBACK_MESSAGE, /problemă tehnică/);
    assert.match(TECHNICAL_FALLBACK_MESSAGE, /programare/);
    assert.doesNotMatch(TECHNICAL_FALLBACK_MESSAGE, /Sistemul întâmpină/);
  });

  it('hours invite copy is actionable', () => {
    assert.match(t('hoursBookingInvite', 'ro'), /programare/);
  });

  it('GDPR note stays short with policy link label', () => {
    const note = buildGdprNote({
      ...business,
      gdpr_url: 'https://example.com/privacy',
    }, 'ro');
    assert.match(note, /Confidențialitate/);
    assert.match(note, /stop sms/);
    assert.ok(note.split('\n').length <= 8);
  });
});
