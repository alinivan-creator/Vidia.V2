import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTypedServiceAttempt,
  matchServiceMention,
} from '../src/utils/serviceMatch.js';

describe('service match pivots and aliases', () => {
  it('contact/orar/meniu are not typed service attempts', () => {
    assert.equal(isTypedServiceAttempt('Contact'), false);
    assert.equal(isTypedServiceAttempt('orar'), false);
    assert.equal(isTypedServiceAttempt('meniu'), false);
    assert.equal(isTypedServiceAttempt('Tuns clasic'), true);
  });

  it('matches exact and reordered service names', () => {
    const catalog = [{ id: '1', name: 'Tuns Clasic' }];
    assert.equal(matchServiceMention('Tuns clasic', catalog)?.id, '1');
    assert.equal(matchServiceMention('clasic tuns', catalog)?.id, '1');
  });

  it('rejects services not in catalog', () => {
    const dental = [{ id: 'd1', name: 'Obturatie compozit' }];
    assert.equal(matchServiceMention('Tuns clasic', dental), null);
  });
});
