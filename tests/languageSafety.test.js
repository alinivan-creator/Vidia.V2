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
  resolveTurnLanguage,
  tf,
  isLanguageCapabilityQuestion,
  twilioContentLocale,
} from '../src/utils/uiI18n.js';
import { formatBusinessHoursText, DEFAULT_BUSINESS_HOURS } from '../src/utils/datetime.js';
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

  it('detects English FAQ questions like I can come with my pet', () => {
    assert.equal(detectSessionLanguageFromText('I can come with my pet?'), 'en');
    assert.equal(detectSessionLanguageFromText('I can pay with card?'), 'en');
    assert.equal(detectSessionLanguageFromText('you have eat for free?'), 'en');
  });

  it('detects Romanian free text', () => {
    assert.equal(detectSessionLanguageFromText('Salut, vreau o programare'), 'ro');
    assert.equal(detectSessionLanguageFromText('Bună ziua'), 'ro');
    assert.equal(detectSessionLanguageFromText('Salut'), 'ro');
  });

  it('ignores courtesy greetings and reads the request half (mixed RO opener + EN body)', () => {
    assert.equal(
      detectSessionLanguageFromText('Salut, i want to make an appointment'),
      'en',
    );
    assert.equal(
      detectSessionLanguageFromText('Buna, can I book for tomorrow?'),
      'en',
    );
    assert.equal(
      detectSessionLanguageFromText('Hello, vreau o programare maine'),
      'ro',
    );
    assert.equal(detectSessionLanguageFromText('Hi'), 'en');
  });

  it('resolveTurnLanguage locks session language once established', () => {
    assert.equal(
      resolveTurnLanguage('you have eat for free?', { session_language: 'en' }),
      'en',
    );
    assert.equal(
      resolveTurnLanguage('Salut, vreau programare', { session_language: 'en' }),
      'en',
    );
    assert.equal(
      resolveTurnLanguage('Salut, vreau programare', { session_language: 'ro' }),
      'ro',
    );
  });

  it('resolveClientLanguage respects session lock', () => {
    assert.equal(
      resolveClientLanguage('Salut', null, { session_language: 'en' }),
      'en',
    );
  });

  it('unknown service copy is localized via tf()', () => {
    assert.match(t('unknownServiceNotInList', 'en'), /not in our list/i);
    assert.match(t('unknownServiceNotInList', 'ro'), /lista noastră/i);
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

  it('MISSING_SERVICE renders English when ui_language is en (machine action path)', () => {
    const text = renderHandlerResult(
      { id: 'b1', name: 'Salon', timezone: 'Europe/Bucharest' },
      {
        user_message_template_key: 'MISSING_SERVICE',
        machine_action: 'ACTION_ASK_SERVICE',
        data: {
          ui_language: 'en',
          services: [{ id: 's1', name: 'Tuns Clasic', duration_minutes: 30 }],
        },
      },
    );
    assert.match(text, /Which service would you like/i);
    assert.doesNotMatch(text, /Ce serviciu dorești/);
  });

  it('localizes Details & prices menu label for EN', () => {
    const opts = localizeMenuOptions([
      { id: 'book', title: '📅 Programare' },
      { id: 'info', title: 'ℹ️ Detalii & Prețuri' },
      { id: 'contact', title: 'Contact' },
    ], 'en');
    assert.equal(opts[0].title, 'Booking');
    assert.equal(opts[1].title, 'Details & prices');
    assert.equal(opts[2].title, 'Contact');
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

  it('CONTACT renders English labels when ui_language is en', () => {
    const text = renderHandlerResult(
      {
        id: 'b1',
        name: 'Salon',
        timezone: 'Europe/Bucharest',
        booking_settings: {
          contact: { phone: '+40123456789', email: 'a@b.ro' },
          business_hours: DEFAULT_BUSINESS_HOURS,
        },
      },
      {
        user_message_template_key: 'CONTACT',
        data: { ui_language: 'en' },
      },
    );
    assert.match(text, /Phone/i);
    assert.doesNotMatch(text, /Telefon/);
    assert.match(text, /We are at your service/i);
    assert.match(text, /Monday/i);
    assert.doesNotMatch(text, /\bLuni\b/);
    assert.doesNotMatch(text, /închis/);
  });

  it('language capability questions are detected without switching alone', () => {
    assert.equal(isLanguageCapabilityQuestion('Do you speak English?'), true);
    assert.equal(isLanguageCapabilityQuestion('vorbesti engleza?'), true);
    assert.equal(isLanguageCapabilityQuestion('book tomorrow'), false);
  });

  it('twilioContentLocale maps session language for list-picker hints', () => {
    assert.equal(twilioContentLocale('en'), 'en');
    assert.equal(twilioContentLocale('ro'), 'ro');
  });

  it('formatBusinessHoursText never leaks RO weekdays in EN', () => {
    const text = formatBusinessHoursText(DEFAULT_BUSINESS_HOURS, 'en');
    assert.match(text, /Sunday/);
    assert.doesNotMatch(text, /Duminică/);
  });

  it('CHAT_FALLBACK renders English when ui_language is en', () => {
    const text = renderHandlerResult(
      { id: 'b1', name: 'VIDIA', timezone: 'Europe/Bucharest' },
      {
        user_message_template_key: 'CHAT_FALLBACK',
        data: { ui_language: 'en', business_name: 'VIDIA' },
      },
    );
    assert.match(text, /could not be understood/i);
    assert.doesNotMatch(text, /Nu am înțeles/);
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
