import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSessionLanguageFromText,
  resolveTurnLanguage,
  parseLanguageChoice,
  isLanguageCapabilityQuestion,
  twilioContentLocale,
  t,
  tf,
} from '../src/utils/uiI18n.js';
import { formatBusinessHoursText, DEFAULT_BUSINESS_HOURS } from '../src/utils/datetime.js';
import { formatContactMessage } from '../src/services/contactService.js';
import { renderHandlerResult } from '../src/services/turnPresent.js';
import { formatNumberedMenu } from '../src/services/whatsappService.js';

const business = {
  id: 'b-stress',
  name: 'Barber Shop',
  timezone: 'Europe/Bucharest',
  booking_settings: {
    business_hours: DEFAULT_BUSINESS_HOURS,
    contact: { phone: '+40123456789', address: 'Str. Test 1' },
  },
};

describe('language stress matrix (adversarial)', () => {
  const scenarios = [
    {
      name: 'RO opener + EN body → EN detect (no session yet)',
      text: 'Salut, can you help me with o programare please?',
      session: {},
      expectLang: 'en',
    },
    {
      name: 'session lock EN ignores mid-turn RO greeting',
      text: 'Salut, vreau programare',
      session: { session_language: 'en' },
      expectLang: 'en',
    },
    {
      name: 'session lock RO ignores mid-turn EN FAQ',
      text: 'Do you have parking?',
      session: { session_language: 'ro' },
      expectLang: 'ro',
    },
    {
      name: 'explicit English switch word',
      text: 'speak english?',
      session: { session_language: 'ro' },
      expectPick: 'en',
    },
    {
      name: 'explicit Romanian capability question does not flip alone',
      text: 'Do you speak Romanian?',
      session: { session_language: 'en' },
      expectCapability: true,
    },
    {
      name: 'empty message does not crash language detect',
      text: '',
      session: { session_language: 'en' },
      expectLang: 'en',
    },
    {
      name: 'emoji-only first step keeps session lock',
      text: '😀👍',
      session: { session_language: 'en' },
      expectLang: 'en',
    },
    {
      name: 'typo service mention still EN session',
      text: 'tuns clasic pls tomorow',
      session: { session_language: 'en' },
      expectLang: 'en',
    },
    {
      name: 'mixed EN+RO in one sentence before lock → RO body wins',
      text: 'Hello, vreau o programare maine',
      session: {},
      expectLang: 'ro',
    },
    {
      name: 'pure EN booking phrase',
      text: 'I want a haircut tomorrow at 10',
      session: {},
      expectLang: 'en',
    },
    {
      name: 'Restart session command does not change lock by itself',
      text: 'restart session',
      session: { session_language: 'en' },
      expectLang: 'en',
    },
  ];

  for (const s of scenarios) {
    it(s.name, () => {
      if (s.expectPick != null) {
        assert.equal(parseLanguageChoice({ textBody: s.text }), s.expectPick);
        return;
      }
      if (s.expectCapability) {
        assert.equal(isLanguageCapabilityQuestion(s.text), true);
        return;
      }
      const resolved = resolveTurnLanguage(s.text, s.session);
      assert.equal(resolved, s.expectLang, `resolveTurnLanguage for "${s.text}"`);
      if (!s.session.session_language) {
        const detected = detectSessionLanguageFromText(s.text);
        if (s.text.trim()) {
          assert.equal(detected, s.expectLang, `detectSessionLanguageFromText for "${s.text}"`);
        }
      }
    });
  }
});

describe('zero hardcoded RO leaks in EN UI shells', () => {
  it('contact hours use English weekday labels', () => {
    const hours = formatBusinessHoursText(DEFAULT_BUSINESS_HOURS, 'en');
    assert.match(hours, /Monday/);
    assert.match(hours, /closed/);
    assert.doesNotMatch(hours, /\bLuni\b/);
    assert.doesNotMatch(hours, /închis/);
  });

  it('CONTACT template is fully English including hours section', () => {
    const text = renderHandlerResult(business, {
      user_message_template_key: 'CONTACT',
      data: { ui_language: 'en' },
    });
    assert.match(text, /Hours/);
    assert.match(text, /Monday/);
    assert.match(text, /We are at your service/);
    assert.doesNotMatch(text, /\bLuni\b/);
    assert.doesNotMatch(text, /Program\b/);
    assert.doesNotMatch(text, /Suntem aici/);
  });

  it('Twilio content locale follows session language', () => {
    assert.equal(twilioContentLocale('en'), 'en');
    assert.equal(twilioContentLocale('ro'), 'ro');
    assert.equal(twilioContentLocale('EN'), 'en');
  });

  it('numbered menu fallback is English when lang=en', () => {
    const body = formatNumberedMenu('Pick one', [{ title: 'A' }], null, 'generic', 'en');
    assert.match(body, /Tap an option below/);
    assert.doesNotMatch(body, /Atinge o opțiune/);
  });

  it('LANGUAGE_INFO answers in locked session language', () => {
    const en = renderHandlerResult(business, {
      user_message_template_key: 'LANGUAGE_INFO',
      data: { ui_language: 'en', client_message: t('languageInfoEn', 'en') },
    });
    assert.match(en, /English/i);
    assert.doesNotMatch(en, /română/i);

    const ro = renderHandlerResult(business, {
      user_message_template_key: 'LANGUAGE_INFO',
      data: { ui_language: 'ro', client_message: t('languageInfoRo', 'ro') },
    });
    assert.match(ro, /română/i);
  });

  it('MISSING_SERVICE shell stays EN while admin service names pass through', () => {
    const text = renderHandlerResult(business, {
      user_message_template_key: 'MISSING_SERVICE',
      data: {
        ui_language: 'en',
        services: [{ id: 's1', name: 'Tuns Clasic', duration_minutes: 30 }],
      },
    });
    assert.match(text, /Which service would you like/i);
    assert.match(text, /Services/);
    assert.match(text, /Tuns Clasic/);
    assert.doesNotMatch(text, /Ce serviciu/);
    assert.doesNotMatch(text, /Servicii/);
  });

  it('unknown service copy localized via tf()', () => {
    const en = t('unknownServiceNotInList', 'en');
    assert.match(en, /not in our list/i);
    assert.doesNotMatch(en, /Din păcate/);
  });

  it('formatContactMessage direct helper matches EN labels', () => {
    const text = formatContactMessage(business, 'en');
    assert.match(text, /Phone/);
    assert.match(text, /Address/);
    assert.doesNotMatch(text, /Telefon/);
    assert.doesNotMatch(text, /Adresă/);
  });

  it('stale choice shell uses EN list labels when ui_language is en', () => {
    const text = renderHandlerResult(business, {
      user_message_template_key: 'STALE_CHOICE',
      data: { ui_language: 'en', client_message: t('staleChoiceBody', 'en') },
    });
    assert.match(text, /no longer available on the current list/i);
    assert.doesNotMatch(text, /Opțiunea aia/);
  });
});
