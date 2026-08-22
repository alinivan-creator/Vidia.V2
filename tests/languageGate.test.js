import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLanguageGateEnabled,
  buildLanguageGateWelcome,
  LANGUAGE_BUTTONS,
} from '../src/config/languageGate.js';
import {
  hasConfirmedLanguage,
  shouldRunLanguageGate,
  resolveLanguageChoice,
} from '../src/services/languageOnboardingService.js';
import { preservedLanguageContext } from '../src/config/languageGate.js';
import { resolveClientLanguage } from '../src/utils/clientLanguage.js';
import { CONVERSATION_STEPS } from '../src/db/conversationStateService.js';

describe('language gate (optional onboarding)', () => {
  const business = {
    id: 'biz_1',
    name: 'Test Salon',
    booking_settings: {},
  };

  it('is disabled by default', () => {
    const prev = process.env.LANGUAGE_GATE_ENABLED;
    delete process.env.LANGUAGE_GATE_ENABLED;
    assert.equal(isLanguageGateEnabled(business), false);
    if (prev) process.env.LANGUAGE_GATE_ENABLED = prev;
  });

  it('can be enabled per tenant', () => {
    assert.equal(
      isLanguageGateEnabled({ ...business, booking_settings: { language_gate_enabled: true } }),
      true,
    );
  });

  it('welcome copy mentions GDPR/SMS and bilingual prompt', () => {
    const text = buildLanguageGateWelcome(business);
    assert.match(text, /inteligență artificială/i);
    assert.match(text, /SMS/i);
    assert.match(text, /Please choose your language/i);
  });

  it('resolves button taps and typed language names', () => {
    assert.equal(resolveLanguageChoice({ buttonPayload: LANGUAGE_BUTTONS.RO.id }), 'ro');
    assert.equal(resolveLanguageChoice({ buttonPayload: LANGUAGE_BUTTONS.EN.id }), 'en');
    assert.equal(resolveLanguageChoice({ textBody: 'English' }), 'en');
    assert.equal(resolveLanguageChoice({ textBody: 'Română' }), 'ro');
  });

  it('skips gate when language already confirmed', async () => {
    const conv = {
      current_step: CONVERSATION_STEPS.IDLE,
      context_data: { language_confirmed: true, client_language: 'en' },
    };
    assert.equal(hasConfirmedLanguage(conv), true);
    assert.equal(
      await shouldRunLanguageGate({
        business: { ...business, booking_settings: { language_gate_enabled: true } },
        convState: conv,
      }),
      false,
    );
  });

  it('runs gate on IDLE when enabled and not confirmed', async () => {
    assert.equal(
      await shouldRunLanguageGate({
        business: { ...business, booking_settings: { language_gate_enabled: true } },
        convState: { current_step: CONVERSATION_STEPS.IDLE, context_data: {} },
      }),
      true,
    );
  });

  it('preserves confirmed language across conversation reset', () => {
    assert.deepEqual(
      preservedLanguageContext({ language_confirmed: true, client_language: 'en' }),
      { client_language: 'en', language_confirmed: true, language_gate_pending: false },
    );
  });

  it('resolveLanguageChoice still works for mid-session language switch', () => {
    assert.equal(resolveLanguageChoice({ textBody: 'English' }), 'en');
    assert.equal(resolveLanguageChoice({ textBody: 'Română' }), 'ro');
    assert.equal(resolveLanguageChoice({ buttonPayload: LANGUAGE_BUTTONS.EN.id }), 'en');
  });

  it('resolveClientLanguage sticks after confirmation', () => {
    const ctx = { language_confirmed: true, client_language: 'en' };
    assert.equal(resolveClientLanguage('salut vreau programare', 'ro', ctx), 'en');
  });
});
