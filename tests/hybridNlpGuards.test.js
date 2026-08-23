import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clarificationPrompt } from '../src/services/bookingWaitState.js';
import { matchServiceMention } from '../src/utils/serviceMatch.js';
import { waServiceMeta } from '../src/utils/waCopy.js';
import { formatContactMessage } from '../src/services/contactService.js';

describe('hybrid NLP guards', () => {
  it('clarificationPrompt never renders Data de 0', () => {
    assert.match(clarificationPrompt(null), /Nu am înțeles|reformulează/i);
    assert.match(clarificationPrompt(0), /Nu am înțeles|reformulează/i);
    assert.match(clarificationPrompt(17), /17/);
  });

  it('catalog match rejects invented service names', () => {
    const services = [
      { id: 's1', name: 'Tuns' },
      { id: 's2', name: 'Vopsit' },
    ];
    assert.equal(matchServiceMention('tuns', services)?.id, 's1');
    assert.equal(matchServiceMention('masaj thai exotic', services), null);
    assert.equal(matchServiceMention('teeth whitening', services), null);
    assert.equal(matchServiceMention('invented nonsense service xyz', services), null);
  });

  it('service list rows include duration and price', () => {
    const meta = waServiceMeta({ duration_minutes: 30, price_ron: 50 });
    assert.match(meta, /30 min/);
    assert.match(meta, /50 LEI/);
  });

  it('contact body has no maps markdown that would unfurl a preview', () => {
    const text = formatContactMessage({
      name: 'Salon Test',
      booking_settings: {
        contact: {
          phone: '0722000000',
          address: 'Strada Test 1',
          maps_url: 'https://maps.google.com/?q=Salon+Test',
        },
      },
    });
    assert.match(text, /Strada Test 1/);
    assert.doesNotMatch(text, /Indicații către locație/);
    assert.doesNotMatch(text, /maps\.google/);
    assert.doesNotMatch(text, /\]\(/);
  });
});

describe('tenant FAQ lookup', () => {
  it('answers from business_faqs instead of inventing', async () => {
    const { lookupBusinessInfo, formatBusinessInfoReply, matchBusinessFaq } = await import(
      '../src/utils/businessInfoLookup.js'
    );
    const faqs = [
      { question: 'Acceptați plata cu cardul?', answer: 'Da, POS la recepție.' },
      { question: 'Sunt permise animalele?', answer: 'Nu, fără animale în salon.' },
    ];
    assert.equal(matchBusinessFaq(faqs, 'pot plăti cu cardul?')?.answer, 'Da, POS la recepție.');
    const looked = lookupBusinessInfo(
      { booking_settings: {}, faqs },
      'Aveți POS / card?',
    );
    assert.equal(looked.found, true);
    assert.equal(formatBusinessInfoReply(looked), 'Da, POS la recepție.');
    const unknown = lookupBusinessInfo(
      { booking_settings: {}, faqs },
      'Aveți saună?',
    );
    assert.equal(unknown.found, false);
  });
});
