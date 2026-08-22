import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatBusinessInfoReply, looksMostlyRomanian } from '../src/utils/businessInfoLookup.js';
import { detectSessionLanguageFromText } from '../src/utils/uiI18n.js';
import { resolveClientLanguage } from '../src/utils/clientLanguage.js';

describe('EN session FAQ replies', () => {
  it('never returns raw Romanian FAQ text in EN sessions', () => {
    const looked = {
      found: true,
      topic: 'card',
      topicLabelRo: 'plata cu cardul',
      topicLabelEn: 'card payment',
      polarity: 'fact',
      text: 'Sigur, puteti plati si cu cardul!',
    };
    const en = formatBusinessInfoReply(looked, 'en');
    assert.match(en, /card/i);
    assert.doesNotMatch(en, /puteti|plati/i);
    assert.equal(looksMostlyRomanian(looked.text), true);
  });

  it('returns English unknown-info style for missing pet policy in EN', () => {
    const looked = {
      found: true,
      topic: 'pets',
      topicLabelRo: 'animale',
      topicLabelEn: 'pets',
      polarity: 'fact',
      text: 'Nu acceptam animale de companie.',
    };
    const en = formatBusinessInfoReply(looked, 'en');
    assert.match(en, /pet/i);
    assert.doesNotMatch(en, /acceptam|companie/i);
  });

  it('resolveClientLanguage prefers session_language then English free-text', () => {
    assert.equal(resolveClientLanguage('x', null, { session_language: 'en' }), 'en');
    assert.equal(resolveClientLanguage('I can come with my dog?', null, {}), 'en');
    assert.equal(detectSessionLanguageFromText('I can pay with card?'), 'en');
  });
});
