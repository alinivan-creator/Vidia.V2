import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeGroundedExtract } from '../src/services/turnExtract.js';
import { matchServiceMention } from '../src/utils/serviceMatch.js';
import { renderHandlerResult } from '../src/services/turnPresent.js';
import { executeTurn } from '../src/services/turnExecute.js';

const CATALOG = [
  { id: 'svc-tuns', name: 'Tuns Clasic', duration_minutes: 30, price_ron: 50 },
  { id: 'svc-barba', name: 'Tuns + Barba', duration_minutes: 45, price_ron: 80 },
];

const business = {
  id: 'biz-unknown-e2e',
  name: 'Barber Test',
  timezone: 'Europe/Bucharest',
  booking_settings: { services: CATALOG },
  menu_buttons: [{ id: 'book', label: 'Programare' }],
};

describe('unknown_service end-to-end (semantic null → catalog offer)', () => {
  it('deterministic catalog rejects invented service before semantic layer', () => {
    assert.equal(matchServiceMention('quantum flux haircut', CATALOG), null);
    assert.equal(matchServiceMention('teeth whitening', CATALOG), null);
  });

  it('finalizeGroundedExtract forces unknown_service when name has no catalog id', () => {
    const grounded = finalizeGroundedExtract({
      action: 'book',
      service_name: null,
      service_id: null,
      unknown_service_name: 'quantum flux haircut',
      confidence: 'high',
      source: 'nlu',
    });
    assert.equal(grounded.action, 'unknown_service');
    assert.equal(grounded.unknown_service_name, 'quantum flux haircut');
    assert.equal(grounded.service_id, null);
  });

  it('simulates semantic null: NLU service_name stripped → unknown_service action', () => {
    // Mirrors applyCatalogMatches when LLM names a service outside catalog.
    const nluExtract = {
      action: 'book',
      service_name: 'Quantum Flux Deluxe',
      service_id: null,
      confidence: 'medium',
      source: 'nlu',
    };
    const hit = matchServiceMention(nluExtract.service_name, CATALOG);
    assert.equal(hit, null);
    const withUnknown = {
      ...nluExtract,
      service_name: null,
      unknown_service_name: 'Quantum Flux Deluxe',
    };
    const grounded = finalizeGroundedExtract(withUnknown);
    assert.equal(grounded.action, 'unknown_service');
  });

  it('UNKNOWN_SERVICE shows fixed EN error then service list picker', () => {
    const text = renderHandlerResult(business, {
      user_message_template_key: 'UNKNOWN_SERVICE',
      data: {
        ui_language: 'en',
        client_message: 'We\'re sorry, the entered service is not in our list. Please select a service from the list.',
        services: CATALOG,
        ui: 'list_picker',
        list_button: 'Services',
      },
      menu: {
        kind: 'service',
        options: [
          { id: 'svc_svc-tuns', title: 'Classic Haircut' },
          { id: 'svc_svc-barba', title: 'Haircut & Beard Trim' },
        ],
      },
    });
    assert.match(text, /entered service is not in our list/i);
    assert.match(text, /Please select a service from the list/i);
    assert.doesNotMatch(text, /quantum flux/i);
    assert.doesNotMatch(text, /callback/i);
    assert.doesNotMatch(text, /Din păcate/);
  });

  it('UNKNOWN_SERVICE shows fixed RO error message', () => {
    const text = renderHandlerResult(business, {
      user_message_template_key: 'UNKNOWN_SERVICE',
      data: {
        ui_language: 'ro',
        client_message: 'Ne pare rău, serviciul introdus nu se află în lista noastră. Vă rugăm să alegeți un serviciu din listă.',
      },
    });
    assert.match(text, /serviciul introdus nu se află în lista noastră/i);
    assert.match(text, /alegeți un serviciu din listă/i);
  });

  it('executeTurn unknown_service path returns service list picker (no callback menu)', async () => {
    const result = await executeTurn({
      business,
      recipientPhone: '+40700000099',
      extract: {
        action: 'unknown_service',
        unknown_service_name: 'quantum flux haircut',
        confidence: 'high',
        source: 'nlu',
      },
      convState: {
        current_step: 'IDLE',
        context_data: { session_language: 'en' },
      },
      textBody: 'quantum flux haircut',
      requestId: 'test-unknown-service-e2e',
    });

    assert.equal(result.user_message_template_key, 'UNKNOWN_SERVICE');
    assert.equal(result.data?.ui_language, 'en');
    assert.match(result.data?.client_message || '', /not in our list/i);
    assert.equal(result.data?.ui, 'list_picker');
    assert.equal(result.menu?.kind, 'service');
    const rendered = renderHandlerResult(business, result);
    assert.match(rendered, /not in our list/i);
    assert.doesNotMatch(rendered, /quantum flux/i);
    assert.doesNotMatch(rendered, /Call me back/i);
    assert.ok(result.menu?.options?.length >= 1, 'should offer catalog service rows');
    const ids = (result.menu?.options || []).map((o) => o.id);
    assert.ok(ids.every((id) => String(id).startsWith('svc_')), 'menu must be service list only');
  });
});
