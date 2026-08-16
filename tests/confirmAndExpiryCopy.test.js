import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatNumberedMenu } from '../src/services/whatsappService.js';
import { buildSessionExpiredRestartMessage } from '../src/services/pendingExpiryCron.js';
import { BOOKING_PREFIXES } from '../src/services/flowIds.js';

describe('confirm menu + session expiry copy', () => {
  it('confirm footer asks Confirmă/Anulează, not free-text name', () => {
    const body = formatNumberedMenu(
      '*Confirmi programarea?*\n\n*Serviciu*\nTuns',
      [
        { id: BOOKING_PREFIXES.CONFIRM, title: 'Confirmă' },
        { id: BOOKING_PREFIXES.CANCEL, title: 'Anulează' },
      ],
      null,
      'confirm',
    );
    assert.match(body, /Răspunde cu \*Confirmă\* sau \*Anulează\*/);
    assert.match(body, /\*1\* \/ \*2\*/);
    assert.doesNotMatch(body, /Poți răspunde cu \*numele\*/);
  });

  it('generic menus still allow name or number', () => {
    const body = formatNumberedMenu('Alege', [{ id: 'a', title: 'Tuns' }], null, 'service');
    assert.match(body, /Poți răspunde cu \*numele\*/);
  });

  it('session expiry restart asks for a service', () => {
    const text = buildSessionExpiredRestartMessage({
      name: 'Salon Test',
      booking_settings: {
        services: [{ id: '1', name: 'Tuns', duration_minutes: 30 }],
      },
    });
    assert.match(text, /Sesiunea ta a expirat din motive de inactivitate/);
    assert.match(text, /Hai să o luăm de la început/);
    assert.match(text, /Ce serviciu/);
    assert.match(text, /Tuns/);
  });
});
