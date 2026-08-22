import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeClientLanguage,
  detectClientLanguage,
  resolveClientLanguage,
  languageScrubPatch,
  needsLanguageScrub,
} from '../src/utils/clientLanguage.js';
import { renderHandlerResult } from '../src/services/turnPresent.js';

describe('language safety (RO lock + scrub)', () => {
  it('defaults corrupt / null language to ro', () => {
    assert.equal(normalizeClientLanguage(null), 'ro');
    assert.equal(normalizeClientLanguage(undefined), 'ro');
    assert.equal(normalizeClientLanguage(''), 'ro');
    assert.equal(normalizeClientLanguage('xyz'), 'ro');
    assert.equal(normalizeClientLanguage('en'), 'en');
    assert.equal(normalizeClientLanguage('ro'), 'ro');
  });

  it('UI language is locked to Romanian until bilingual rebuild', () => {
    assert.equal(detectClientLanguage('Hello I want a booking'), 'ro');
    assert.equal(resolveClientLanguage('English', 'en', {
      language_confirmed: true,
      client_language: 'en',
    }), 'ro');
  });

  it('scrubs experimental language-gate residue from old sessions', () => {
    const patch = languageScrubPatch({
      language_confirmed: true,
      language_gate_pending: false,
      client_language: 'en',
      deferred_inbound: 'Booking',
      draft_id: 'x',
    });
    assert.equal(needsLanguageScrub({
      language_confirmed: true,
      client_language: 'en',
    }), true);
    assert.deepEqual(patch, {
      language_confirmed: null,
      language_gate_pending: null,
      deferred_inbound: null,
      client_language: 'ro',
    });
    assert.equal(needsLanguageScrub({ client_language: 'ro' }), false);
  });

  it('ASK_CONFIRM always renders Romanian confirm card with session fields', () => {
    const business = { id: 'b1', name: 'Salon Test', timezone: 'Europe/Bucharest' };
    const text = renderHandlerResult(business, {
      user_message_template_key: 'ASK_CONFIRM',
      data: {
        client_name: 'Ana Popescu',
        employee_name: null,
        service_name: 'Tuns Clasic',
        slot_label: 'Luni, 31 Aug · 10:00',
        client_language: 'en',
      },
    });
    assert.match(text, /Confirmi programarea/);
    assert.match(text, /Ana Popescu/);
    assert.match(text, /Tuns Clasic/);
    assert.match(text, /Luni, 31 Aug/);
    assert.doesNotMatch(text, /Confirm this booking/i);
  });
});
