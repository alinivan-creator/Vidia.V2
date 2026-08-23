import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  staticTranslateServiceNameExact,
  svcDisplay,
  localizeServicesList,
  runWithServiceDisplay,
  _clearServiceDisplayCacheForTests,
} from '../src/services/serviceDisplayI18n.js';
import { BOOKING_MSG, bm } from '../src/utils/bookingI18n.js';
import { t } from '../src/utils/uiI18n.js';
import { clarificationPrompt } from '../src/services/bookingWaitState.js';

const COLOQUIAL_PATTERNS = [
  /\baia\b/i,
  /\bnu mai e\b/i,
  /\bOk,\b/,
  /\bGata[,\s—]/i,
  /\bGot it\b/i,
  /didn't catch/i,
  /\bTe rog\b/i,
  /\bCu plăcere!/i,
  /\bHai să\b/i,
  /\bintervalul ăsta\b/i,
  /\bPoți alege\b/i,
];

describe('professional tone — booking and UI copy', () => {
  it('BOOKING_MSG has no colloquial Romanian/English phrasing', () => {
    for (const row of Object.values(BOOKING_MSG)) {
      for (const text of [row.ro, row.en]) {
        for (const pattern of COLOQUIAL_PATTERNS) {
          assert.doesNotMatch(text, pattern, `Colloquial copy: ${text}`);
        }
      }
    }
  });

  it('stale choice uses formal corporate wording', () => {
    assert.match(t('staleChoiceBody', 'ro'), /Opțiunea selectată/i);
    assert.doesNotMatch(t('staleChoiceBody', 'ro'), /Opțiunea aia/i);
    assert.match(t('staleChoiceBody', 'en'), /no longer available/i);
  });

  it('clarificationPrompt is formal in both languages', () => {
    assert.match(clarificationPrompt(null, 'en'), /could not be understood/i);
    assert.match(clarificationPrompt(null, 'ro'), /nu a putut fi interpretat/i);
    assert.doesNotMatch(clarificationPrompt(5, 'en'), /Is \*5\*/);
    assert.match(clarificationPrompt(5, 'en'), /Please confirm/i);
  });

  it('critical EN errors stay professional', () => {
    assert.match(bm('rescheduleDone', 'en'), /has been rescheduled/i);
    assert.match(bm('clarifyNotUnderstood', 'en'), /could not be understood/i);
    assert.doesNotMatch(bm('slotTakenReschedule', 'en'), /Got it/i);
  });
});

describe('service display i18n', () => {
  beforeEach(() => {
    _clearServiceDisplayCacheForTests();
  });

  it('staticTranslateServiceName maps common salon/dental RO labels (exact only)', () => {
    assert.equal(staticTranslateServiceNameExact('Tuns Clasic'), 'Classic Haircut');
    assert.equal(staticTranslateServiceNameExact('Tuns + Spalat'), 'Tuns + Spalat');
  });

  it('svcDisplay returns RO catalog name for RO sessions', () => {
    assert.equal(svcDisplay('Tuns Clasic', 's1', 'ro'), 'Tuns Clasic');
  });

  it('svcDisplay translates via display map for EN catalog ids', async () => {
    await runWithServiceDisplay({
      business: { id: 'b-svc', booking_settings: { services: [{ id: 's1', name: 'Tuns Clasic' }] } },
      lang: 'en',
      run: async () => {
        const map = { s1: 'Classic Haircut' };
        assert.equal(svcDisplay('Tuns Clasic', 's1', 'en', map), 'Classic Haircut');
        const list = localizeServicesList([
          { id: 's1', name: 'Tuns Clasic', duration_minutes: 30 },
          { id: 's2', name: 'Detartraj', duration_minutes: 45 },
        ], 'en');
        assert.equal(list[0].id, 's1');
      },
    });
  });
});
