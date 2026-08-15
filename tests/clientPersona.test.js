/**
 * I am the client. I write like a person, I read the reply, I check
 * the catalog, the day, the hour, and that tenant A never answers for tenant B.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createChat, makeTenant, ROBOT, MACHINE_ACTIONS } from './helpers/whatsappSim.js';

const DENTAL = makeTenant({
  name: 'Clinica Dentară Nord',
  services: [
    { id: 'svc-consult', name: 'Consultație', duration_minutes: 20, price_ron: 150 },
    { id: 'svc-detartraj', name: 'Detartraj', duration_minutes: 40, price_ron: 250 },
    { id: 'svc-albire', name: 'Albire', duration_minutes: 60, price_ron: 800 },
  ],
  businessInfo: { parking: true, parking_note: 'Parcare în curtea clinicii, 4 locuri.' },
  aiFacts: 'Lucrăm cu copii de la 4 ani, cu medic pedodont.',
});

const DENTAL_B = makeTenant({
  name: 'Clinica Dentară Sud',
  services: [
    { id: 'svc-consult', name: 'Consultație', duration_minutes: 20, price_ron: 120 },
    { id: 'svc-detartraj', name: 'Detartraj', duration_minutes: 40, price_ron: 200 },
  ],
  businessInfo: { parking: null },
  aiFacts: '',
});

const DOG = makeTenant({
  name: 'Paw Spa',
  services: [
    { id: 'svc-spalare', name: 'Spălare', duration_minutes: 45, price_ron: 80 },
    { id: 'svc-tuns-caine', name: 'Tuns câine', duration_minutes: 60, price_ron: 120 },
    { id: 'svc-unghii', name: 'Tăiere unghii', duration_minutes: 15, price_ron: 40 },
  ],
  businessInfo: { parking: false },
  aiFacts: 'Primim toate rasele, inclusiv metiși.',
});

const BARBER_PARK = makeTenant({
  name: 'Salon Park',
  hours: {
    '0': null,
    '1': { open: '09:00', close: '18:00' },
    '2': { open: '09:00', close: '18:00' },
    '3': { open: '09:00', close: '18:00' },
    '4': { open: '09:00', close: '18:00' },
    '5': { open: '09:00', close: '18:00' },
    '6': { open: '10:00', close: '14:00' },
  },
  services: [
    { id: 'svc-clasic', name: 'Tuns Clasic', duration_minutes: 30, price_ron: 70 },
    { id: 'svc-combo', name: 'Tuns + Barba', duration_minutes: 45, price_ron: 100 },
    { id: 'svc-aranjat', name: 'Aranjat Barba', duration_minutes: 20, price_ron: 40 },
  ],
  businessInfo: {
    parking: true,
    parking_note: 'Avem parcare proprie chiar în fața salonului.',
    women: true,
    women_note: 'Da, tundem și doamne.',
  },
});

function assertHuman(text) {
  assert.ok(String(text || '').length > 8, 'empty reply');
  assert.equal(ROBOT.test(text), false, text);
}

describe('client: dental clinic', () => {
  it('books Consultație luni la 10 and never mentions tuns', () => {
    const me = createChat(DENTAL);
    const hello = me.say('Salut');
    assertHuman(hello.text);
    assert.match(hello.text, /Clinica Dentară Nord|programăr/i);

    const start = me.say('1');
    assert.equal(start.action, MACHINE_ACTIONS.ACTION_ASK_SERVICE);
    assert.match(start.text, /Consultație/);
    assert.match(start.text, /20 min/);
    assert.match(start.text, /Detartraj/);
    assert.match(start.text, /40 min/);
    assert.doesNotMatch(start.text, /Tuns Clasic|ex: \*tuns\*/i);

    const pick = me.say('1');
    assert.equal(pick.draft.service_name, 'Consultație');
    assert.equal(pick.action, MACHINE_ACTIONS.ACTION_ASK_DATE_TIME);

    const slot = me.say('luni la 10');
    assert.equal(slot.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION, slot.text);
    assert.equal(slot.draft.service_name, 'Consultație');
    assert.equal(slot.draft.date, '2026-08-17');
    assert.equal(slot.draft.time, '10:00');
    assert.match(slot.text, /Consultație/);
    assert.match(slot.text, /10:00/);
    assert.doesNotMatch(slot.text, /Tuns|Barba/);

    const done = me.say('da');
    assert.equal(done.action, 'CONFIRMED');
  });

  it('Detartraj maine la 12 is Sunday closed, not Saturday', () => {
    const me = createChat(DENTAL);
    const out = me.say('Detartraj maine la 12');
    assert.equal(out.draft.service_name, 'Detartraj');
    assert.equal(out.draft.date, '2026-08-16');
    assert.equal(out.draft.time, '12:00');
    assert.equal(out.action, 'CLOSED');
    assert.match(out.text, /Duminică/);
    assert.doesNotMatch(out.text, /Sâmbătă/);
  });

  it('does not book a barber service at the dental clinic', () => {
    const me = createChat(DENTAL);
    const out = me.say('tuns clasic luni la 10');
    assert.notEqual(out.draft.service_name, 'Tuns Clasic');
    assert.doesNotMatch(out.text, /Tuns Clasic/);
    assert.match(out.text, /Consultație|Detartraj|serviciu/i);
  });
});

describe('client: dog grooming', () => {
  it('books Spălare from the dog catalog, not a human haircut', () => {
    const me = createChat(DOG);
    const out = me.say('Spalare luni la 11');
    assert.equal(out.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION, out.text);
    assert.equal(out.draft.service_name, 'Spălare');
    assert.equal(out.draft.date, '2026-08-17');
    assert.equal(out.draft.time, '11:00');
    assert.match(out.text, /Spălare/);
    assert.doesNotMatch(out.text, /Tuns Clasic|Consultație/);
  });

  it('numbered 2 is Tuns câine from this tenant', () => {
    const me = createChat(DOG);
    me.say('programare');
    const pick = me.say('2');
    assert.equal(pick.draft.service_name, 'Tuns câine');
    const slot = me.say('luni 12 30');
    assert.equal(slot.draft.time, '12:30');
    assert.equal(slot.draft.service_name, 'Tuns câine');
  });

  it('answers parking from Admin: this shop has none', () => {
    const me = createChat(DOG);
    const out = me.say('aveti parcare?');
    assert.equal(out.action, 'ADMIN_FACT');
    assert.match(out.text, /nu avem parcare|Din păcate/i);
    assert.doesNotMatch(out.text, /fața salonului|clinicii/);
  });
});

describe('client: two clinics with the same services must not leak facts', () => {
  it('Nord has parking; Sud does not invent it', () => {
    const nord = createChat(DENTAL);
    const sud = createChat(DENTAL_B);
    const a = nord.say('aveti parcare?');
    const b = sud.say('aveti parcare?');
    assert.equal(a.action, 'ADMIN_FACT');
    assert.match(a.text, /curtea clinicii/);
    assert.equal(b.action, 'MISSING_INFO');
    assert.match(b.text, /parcare/);
    assert.doesNotMatch(b.text, /curtea clinicii|fața salonului/);
    assert.doesNotMatch(b.text, /Avem parcare/);
  });
});

describe('client: I try to confuse the bot mid-booking', () => {
  it('weather tomorrow does not steal Maine as a booking, then luni la 10 still works', () => {
    const me = createChat(DENTAL);
    me.say('Consultație');
    const weather = me.say('ce vreme e maine?');
    assert.equal(weather.action, 'OFF_TOPIC');
    assert.doesNotMatch(weather.text, /Duminică|Confirmi/);
    const slot = me.say('luni la 10');
    assert.equal(slot.draft.service_name, 'Consultație');
    assert.equal(slot.draft.date, '2026-08-17');
    assert.equal(slot.draft.time, '10:00');
    assert.equal(slot.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION, slot.text);
  });

  it('wifi is unknown, not invented, and booking continues', () => {
    const me = createChat(BARBER_PARK);
    me.say('tuns clasic');
    const wifi = me.say('aveti wifi?');
    assert.equal(wifi.action, 'MISSING_INFO');
    assert.match(wifi.text, /nu dețin|don't have|nu vă pot răspunde/i);
    assert.doesNotMatch(wifi.text, /da, avem wifi|we have wifi/i);
    const slot = me.say('luni la 11');
    assert.equal(slot.draft.service_name, 'Tuns Clasic');
    assert.equal(slot.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION, slot.text);
  });

  it('bitcoin and pizza stay off-topic and name this business', () => {
    const me = createChat(DOG);
    const coin = me.say('cat e bitcoinul azi?');
    assert.equal(coin.action, 'OFF_TOPIC');
    assert.match(coin.text, /Paw Spa/);
    assert.doesNotMatch(coin.text, /70 LEI|Consultație/);
    const pizza = me.say('vreau o pizza');
    assert.equal(pizza.action, 'OFF_TOPIC');
    assert.match(pizza.text, /programare|orar|contact/i);
  });

  it('screenshot flow: 1 → 2 → Maine la 12 at a weekend-closed shop is Sunday', () => {
    const me = createChat(DENTAL);
    me.say('1');
    const svc = me.say('2');
    assert.equal(svc.draft.service_name, 'Detartraj');
    const maine = me.say('Maine la 12');
    assert.equal(maine.draft.date, '2026-08-16');
    assert.equal(maine.draft.time, '12:00');
    assert.equal(maine.action, 'CLOSED');
    assert.match(maine.text, /Duminică/);
    const luni = me.say('Luni la 12 30');
    assert.equal(luni.draft.date, '2026-08-17');
    assert.equal(luni.draft.time, '12:30');
    assert.equal(luni.draft.service_name, 'Detartraj');
    assert.equal(luni.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION, luni.text);
  });

  it('azi la 10 is in the past at 16:00', () => {
    const me = createChat(BARBER_PARK);
    me.say('tuns clasic');
    const past = me.say('azi la 10');
    assert.equal(past.action, 'CLOSED');
    assert.match(past.text, /trecut|viitor/i);
  });
});

describe('client: catalog copy is the tenant catalog', () => {
  it('prices list uses Detartraj as the booking example, not tuns', () => {
    const me = createChat(DENTAL);
    const out = me.say('ce servicii aveti');
    assert.equal(out.action, 'SERVICES');
    assert.match(out.text, /Consultație/);
    assert.match(out.text, /Detartraj/);
    assert.match(out.text, /Consultație luni la 10/);
    assert.doesNotMatch(out.text, /tuns mâine la 10/i);
  });
});
