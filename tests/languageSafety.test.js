import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeClientLanguage,
  resolveClientLanguage,
  languageScrubPatch,
  needsLanguageScrub,
} from '../src/utils/clientLanguage.js';
import {
  t,
  parseLanguageChoice,
  readSessionLanguage,
  localizeMenuOptions,
  detectSessionLanguageFromText,
  isRestartSessionCommand,
  hasExplicitSessionLanguage,
  entryMenuBodyText,
  withEnglishSwitchOption,
} from '../src/utils/uiI18n.js';
import { renderHandlerResult } from '../src/services/turnPresent.js';
import { isConversationSessionExpired } from '../src/services/sessionValidator.js';

describe('minimal bilingual UI layer', () => {
  it('defaults corrupt / null language to ro', () => {
    assert.equal(normalizeClientLanguage(null), 'ro');
    assert.equal(normalizeClientLanguage('xyz'), 'ro');
    assert.equal(normalizeClientLanguage('en'), 'en');
  });

  it('reads ephemeral session_language only', () => {
    assert.equal(readSessionLanguage({}), 'ro');
    assert.equal(readSessionLanguage({ session_language: 'en' }), 'en');
    assert.equal(resolveClientLanguage('', null, { language_confirmed: true, client_language: 'en' }), 'ro');
    assert.equal(resolveClientLanguage('', null, { session_language: 'en' }), 'en');
  });

  it('t() returns RO by default and EN when requested', () => {
    assert.equal(t('confirmBtn'), 'Confirmă');
    assert.equal(t('confirmBtn', 'en'), 'Confirm');
    assert.equal(t('menuFooter', 'ro'), 'Cu ce te putem ajuta?');
  });

  it('parses language choice from typed words', () => {
    assert.equal(parseLanguageChoice({ textBody: 'English' }), 'en');
    assert.equal(parseLanguageChoice({ textBody: 'Română' }), 'ro');
    assert.equal(parseLanguageChoice({ textBody: 'Switch to English' }), 'en');
    assert.equal(parseLanguageChoice({ buttonPayload: 'lang_en' }), 'en');
    assert.equal(parseLanguageChoice({ textBody: 'programare' }), null);
  });

  it('detects English from first free-text without locking Romanian phrases', () => {
    assert.equal(detectSessionLanguageFromText('Hello, I want an appointment'), 'en');
    assert.equal(detectSessionLanguageFromText('Hi'), 'en');
    assert.equal(detectSessionLanguageFromText('Vreau o programare mâine'), null);
    assert.equal(detectSessionLanguageFromText('salut'), null);
    assert.equal(detectSessionLanguageFromText('English'), null);
  });

  it('recognizes restart session and English switch helpers', () => {
    assert.equal(isRestartSessionCommand('restart session'), true);
    assert.equal(isRestartSessionCommand('Restart Session'), true);
    assert.equal(isRestartSessionCommand('hello'), false);
    assert.equal(hasExplicitSessionLanguage({}), false);
    assert.equal(hasExplicitSessionLanguage({ session_language: 'en' }), true);
    assert.match(entryMenuBodyText('ro'), /Cu ce te putem ajuta/);
    assert.match(entryMenuBodyText('ro'), /Switch to English/);
    assert.equal(entryMenuBodyText('en'), 'How can we help you?');
    const withBtn = withEnglishSwitchOption([{ id: 'book', title: 'Programare' }], 'ro');
    assert.equal(withBtn.length, 2);
    assert.equal(withBtn[1].id, 'lang_en');
    const full = withEnglishSwitchOption([
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
    ], 'ro');
    assert.equal(full.length, 3);
  });

  it('localizes confirm buttons for EN without changing ids', () => {
    const opts = localizeMenuOptions([
      { id: 'confirm_booking', title: 'Confirmă' },
      { id: 'cancel_pending', title: 'Anulează' },
    ], 'en');
    assert.equal(opts[0].id, 'confirm_booking');
    assert.equal(opts[0].title, 'Confirm');
    assert.equal(opts[1].title, 'Cancel');
  });

  it('ASK_CONFIRM stays Romanian when ui_language is absent', () => {
    const text = renderHandlerResult(
      { id: 'b1', name: 'Salon', timezone: 'Europe/Bucharest' },
      {
        user_message_template_key: 'ASK_CONFIRM',
        data: {
          client_name: 'Ana',
          service_name: 'Tuns',
          slot_label: 'Luni 10:00',
        },
      },
    );
    assert.match(text, /Confirmi programarea/);
    assert.doesNotMatch(text, /Confirm this booking/);
  });

  it('ASK_CONFIRM uses English date in summary when ui_language is en', () => {
    const text = renderHandlerResult(
      { id: 'b1', name: 'Salon', timezone: 'Europe/Bucharest' },
      {
        user_message_template_key: 'ASK_CONFIRM',
        data: {
          ui_language: 'en',
          client_name: 'Ana',
          service_name: 'Tuns',
          date_key: '2026-08-24',
          time_hhmm: '10:00',
          slot_label: 'Luni, 24 Aug. — Ora 10:00',
        },
      },
    );
    assert.match(text, /Confirm this booking/);
    assert.match(text, /Monday/i);
    assert.doesNotMatch(text, /\bLuni\b/);
  });

  it('CONFIRMATION_BOOKED renders English success copy', () => {
    const text = renderHandlerResult(
      { id: 'b1', name: 'Salon', timezone: 'Europe/Bucharest', booking_settings: {} },
      {
        user_message_template_key: 'CONFIRMATION_BOOKED',
        data: {
          ui_language: 'en',
          client_name: 'Ana',
          service_name: 'Tuns',
          date_key: '2026-08-24',
          time_hhmm: '10:00',
          slot_label: 'Luni, 24 Aug. — Ora 10:00',
        },
      },
    );
    assert.match(text, /Booking confirmed/);
    assert.match(text, /See you soon/);
    assert.match(text, /Monday/i);
    assert.doesNotMatch(text, /Programare confirmată/);
  });

  it('scrubs legacy gate fields without requiring session_language clear', () => {
    const patch = languageScrubPatch({
      language_confirmed: true,
      client_language: 'weird',
      deferred_inbound: 'x',
    });
    assert.equal(needsLanguageScrub({ language_confirmed: true }), true);
    assert.equal(patch.language_confirmed, null);
    assert.equal(needsLanguageScrub({ session_language: 'en' }), false);
  });

  it('session TTL expires idle sessions that only hold language choice', () => {
    const now = Date.parse('2026-08-22T20:50:00.000Z');
    const conv = {
      current_step: 'IDLE',
      context_data: {
        session_timestamp: '2026-08-22T20:00:00.000Z',
        session_language: 'en',
      },
    };
    assert.equal(isConversationSessionExpired(conv, 45, now), true);
    assert.equal(
      isConversationSessionExpired(conv, 45, Date.parse('2026-08-22T20:40:00.000Z')),
      false,
    );
  });
});
