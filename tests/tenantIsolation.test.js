import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheBusinessForWhatsAppTo,
  getCachedBusinessForWhatsAppTo,
  invalidateBusinessCacheForWhatsAppTo,
  matchBusinessRowsByPhoneKey,
} from '../src/db/businessService.js';
import {
  catalogServiceFromFlowData,
  createFlowToken,
  parseFlowToken,
} from '../src/services/whatsappFlowService.js';
import { resolveServiceDurationMinutes } from '../src/utils/workingHours.js';

const BIZ_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BIZ_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('tenant phone routing', () => {
  it('fails closed when two tenants share a WhatsApp number', () => {
    const rows = [
      { id: BIZ_A, whatsapp_phone_number_id: 'whatsapp:+40721111111' },
      { id: BIZ_B, whatsapp_phone_number_id: '+40 721 111 111' },
    ];
    const picked = matchBusinessRowsByPhoneKey(rows, '40721111111');
    assert.equal(picked.kind, 'duplicate');
  });

  it('matches a single tenant across number formats', () => {
    const rows = [
      { id: BIZ_A, whatsapp_phone_number_id: 'whatsapp:+40721111111' },
      { id: BIZ_B, whatsapp_phone_number_id: '+40722222222' },
    ];
    const picked = matchBusinessRowsByPhoneKey(rows, '40721111111');
    assert.equal(picked.kind, 'one');
    assert.equal(picked.row.id, BIZ_A);
  });

  it('drops the To-cache after a successful miss', () => {
    const business = { id: BIZ_A, name: 'Old tenant', booking_settings: {} };
    cacheBusinessForWhatsAppTo('+40721111111', business);
    assert.equal(getCachedBusinessForWhatsAppTo('+40721111111')?.id, BIZ_A);
    invalidateBusinessCacheForWhatsAppTo('whatsapp:+40721111111');
    assert.equal(getCachedBusinessForWhatsAppTo('+40721111111'), null);
  });
});

describe('WhatsApp Flow tenant token', () => {
  it('binds the tenant with HMAC and rejects a guessed UUID', () => {
    const token = createFlowToken(BIZ_A);
    assert.equal(parseFlowToken(token), BIZ_A);
    assert.equal(parseFlowToken(`vidia.${BIZ_B}.deadbeefdeadbeef`), null);
    assert.equal(parseFlowToken(`vidia_${BIZ_A}_abc`), null);
    assert.equal(parseFlowToken(BIZ_A), null);
  });

  it('ignores client-supplied duration and uses the tenant catalog', () => {
    const business = {
      id: BIZ_A,
      timezone: 'Europe/Bucharest',
      services: [{ id: 'svc-tuns', name: 'Tuns', duration_minutes: 45 }],
      booking_settings: { services: [{ id: 'svc-tuns', name: 'Tuns', duration_minutes: 45 }] },
    };
    const service = catalogServiceFromFlowData(business, {
      service_name: 'Tuns',
      duration_minutes: 5,
    });
    assert.equal(service?.duration_minutes, 45);
    assert.equal(resolveServiceDurationMinutes(business, { name: 'Tuns', duration_minutes: 5 }), 45);
    assert.equal(
      catalogServiceFromFlowData(business, { service_name: 'Inventat', duration_minutes: 30 }),
      null,
    );
  });
});
