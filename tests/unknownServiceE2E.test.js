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

  it('UNKNOWN_SERVICE template stays EN when ui_language is en (catalog names may stay RO)', () => {
    const text = renderHandlerResult(business, {
      user_message_template_key: 'UNKNOWN_SERVICE',
      data: {
        ui_language: 'en',
        unknown_service_name: 'quantum flux haircut',
        service_name: 'quantum flux haircut',
        services: CATALOG,
      },
    });
    assert.match(text, /not available in our catalog/i);
    assert.match(text, /quantum flux haircut/i);
    assert.match(text, /service list/i);
    assert.doesNotMatch(text, /Din păcate/);
    assert.doesNotMatch(text, /Poți alege/);
  });

  it('executeTurn unknown_service path returns localized handler for EN session', async () => {
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
    const rendered = renderHandlerResult(business, result);
    assert.match(rendered, /not available in our catalog/i);
    assert.match(rendered, /quantum flux/i);
    assert.doesNotMatch(rendered, /Din păcate/);
    assert.ok(result.menu?.options?.length >= 2, 'should offer catalog + callback buttons');
    const catalogTitles = (result.menu?.catalog || result.menu?.options || [])
      .filter((o) => String(o.id || '').startsWith('svc_') || String(o.id || '').includes('SERVICE'))
      .map((o) => o.title);
    if (catalogTitles.length) {
      assert.ok(
        catalogTitles.some((t) => /Classic|Haircut|Beard/i.test(t)),
        `EN session should show translated service titles, got: ${catalogTitles.join(', ')}`,
      );
    }
  });
});
