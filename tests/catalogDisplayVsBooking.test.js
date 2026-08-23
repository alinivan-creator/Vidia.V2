import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  staticTranslateServiceNameExact,
  svcDisplay,
  localizeServicesList,
  runWithServiceDisplay,
  _clearServiceDisplayCacheForTests,
  buildServiceDisplayMap,
} from '../src/services/serviceDisplayI18n.js';
import { matchServiceMention } from '../src/utils/serviceMatch.js';
import { finalizeGroundedExtract } from '../src/services/turnExtract.js';

const PET_CATALOG = [
  { id: 'svc-groom-1', name: 'Tuns + Spalat', duration_minutes: 60, price_ron: 120 },
  { id: 'svc-groom-2', name: 'Tuns Clasic', duration_minutes: 30, price_ron: 50 },
];

const petBusiness = {
  id: '00000000-0000-4000-8000-000000000101',
  name: 'Canine Spa',
  timezone: 'Europe/Bucharest',
  booking_settings: { services: PET_CATALOG },
};

describe('catalog display vs booking separation', () => {
  beforeEach(() => {
    _clearServiceDisplayCacheForTests();
  });

  it('niche catalog names are not partially mistranslated by fuzzy glossary', () => {
    assert.equal(staticTranslateServiceNameExact('Tuns + Spalat'), 'Tuns + Spalat');
    assert.equal(staticTranslateServiceNameExact('ITP Autoturism'), 'ITP Autoturism');
  });

  it('svcDisplay uses cached catalog map by id (display only)', async () => {
    const map = await buildServiceDisplayMap({
      business: petBusiness,
      lang: 'en',
      requestId: 'test-display-map',
    });
    await runWithServiceDisplay({
      business: petBusiness,
      lang: 'en',
      run: async () => {
        assert.equal(svcDisplay('Tuns + Spalat', 'svc-groom-1', 'en', map), map['svc-groom-1']);
        assert.equal(svcDisplay('Tuns + Spalat', null, 'en', map), 'Tuns + Spalat');
        assert.equal(svcDisplay('cut nails', null, 'en', map), 'cut nails');
      },
    });
  });

  it('localizeServicesList keeps catalog ids unchanged', async () => {
    await runWithServiceDisplay({
      business: petBusiness,
      lang: 'en',
      run: async () => {
        const list = localizeServicesList(PET_CATALOG, 'en');
        assert.equal(list[0].id, 'svc-groom-1');
        assert.equal(list[1].id, 'svc-groom-2');
        assert.ok(typeof list[0].name === 'string' && list[0].name.length > 0);
      },
    });
  });

  it('unlisted client request is rejected — never gets a catalog service_id', () => {
    assert.equal(matchServiceMention('cut nails', PET_CATALOG), null);
    assert.equal(matchServiceMention('taiat unghii', PET_CATALOG), null);

    const grounded = finalizeGroundedExtract({
      action: 'book',
      service_name: null,
      service_id: null,
      unknown_service_name: 'cut nails',
      confidence: 'high',
      source: 'nlu',
    });
    assert.equal(grounded.action, 'unknown_service');
    assert.equal(grounded.service_id, null);
  });

  it('listed catalog service still resolves by id for booking', () => {
    const hit = matchServiceMention('tuns + spalat', PET_CATALOG);
    assert.equal(hit?.id, 'svc-groom-1');
  });
});
