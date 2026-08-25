import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  looksLikeBusinessFactQuestion,
  looksLikeStaffRosterQuestion,
  lookupBusinessInfo,
  lookupOperationalInfo,
  formatBusinessInfoReply,
  missingBusinessInfoMessage,
} from '../src/utils/businessInfoLookup.js';

const employees = [
  { id: 'e1', name: 'Mihai', active: true, service_ids: [] },
  { id: 'e2', name: 'Stefan', active: true, service_ids: ['svc-tuns'] },
];
const services = [
  { id: 'svc-tuns', name: 'Tuns Clasic' },
  { id: 'svc-barba', name: 'Tuns + Barba' },
];

describe('grounded fallback — operational employees + services', () => {
  it('"Mihai lucrează la voi?" is a staff roster / business fact question', () => {
    const variants = [
      'Mihai lucrează la voi?',
      'Mihai lucreaza la voi?',
      'Lucrează Mihai la voi?',
      'Aveți pe Mihai?',
      'Does Mihai work here?',
    ];
    for (const text of variants) {
      assert.equal(looksLikeStaffRosterQuestion(text), true, text);
      assert.equal(looksLikeBusinessFactQuestion(text), true, text);
    }
  });

  it('Mihai on roster → yes from employees table, not "nu dețin"', () => {
    const text = 'Mihai lucrează la voi?';
    const looked = lookupBusinessInfo({ booking_settings: {} }, text, { employees, services });
    assert.equal(looked.found, true);
    assert.equal(looked.topic, 'staff');
    assert.equal(looked.polarity, 'yes');
    assert.equal(looked.entity_name, 'Mihai');
    const reply = formatBusinessInfoReply(looked, 'ro');
    assert.match(reply, /Mihai/i);
    assert.match(reply, /echipa|programat/i);
    assert.doesNotMatch(reply, /nu dețin/i);
  });

  it('unknown person on roster ask → explicit no (still grounded)', () => {
    const looked = lookupOperationalInfo({
      text: 'Andrei lucrează la voi?',
      employees,
      services,
    });
    assert.equal(looked.found, true);
    assert.equal(looked.polarity, 'no');
    assert.match(formatBusinessInfoReply(looked, 'ro'), /Andrei/);
  });

  it('without operational rows, same question stays missing', () => {
    const looked = lookupBusinessInfo({ booking_settings: {} }, 'Mihai lucrează la voi?', {});
    assert.equal(looked.found, false);
    assert.match(missingBusinessInfoMessage(null, 'ro'), /nu dețin/i);
  });

  it('service catalog question uses services list', () => {
    const looked = lookupBusinessInfo(
      { booking_settings: {} },
      'Aveți Tuns Clasic?',
      { employees, services },
    );
    assert.equal(looked.found, true);
    assert.equal(looked.topic, 'service_catalog');
    assert.match(formatBusinessInfoReply(looked, 'ro'), /Tuns Clasic/);
  });

  it('parking still works from business_info (static path intact)', () => {
    const looked = lookupBusinessInfo(
      { booking_settings: { business_info: { parking: { enabled: true } } } },
      'aveți parcare?',
      { employees, services },
    );
    assert.equal(looked.found, true);
    assert.equal(looked.topic, 'parking');
    assert.equal(looked.polarity, 'yes');
  });
});
