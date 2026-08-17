import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clarificationPrompt } from '../src/services/bookingWaitState.js';
import { matchServiceMention } from '../src/utils/serviceMatch.js';

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
  });
});
