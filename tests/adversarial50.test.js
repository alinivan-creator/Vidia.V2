/**
 * 50+ adversarial client scenarios across business types.
 * Each case asserts understanding (service/date/time), professionalism,
 * no hallucination, no tenant leak, and context retention — not reply length.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createChat, makeTenant, ROBOT, MACHINE_ACTIONS, NOW } from './helpers/whatsappSim.js';

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

const BARBER = makeTenant({
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

const NAILS = makeTenant({
  name: 'Nail Studio Bloom',
  services: [
    { id: 'svc-manichiura', name: 'Manichiură', duration_minutes: 45, price_ron: 90 },
    { id: 'svc-pedichiura', name: 'Pedichiură', duration_minutes: 50, price_ron: 110 },
    { id: 'svc-gel', name: 'Construcție gel', duration_minutes: 90, price_ron: 180 },
  ],
  businessInfo: { parking: null, children: false },
  aiFacts: 'Lucrăm doar cu programare.',
});

const CONSULTING = makeTenant({
  name: 'Legal Advice Pro',
  businessType: 'consulting',
  services: [
    { id: 'svc-consult-legal', name: 'Consultație juridică', duration_minutes: 60, price_ron: 300 },
  ],
  businessInfo: { parking: true, parking_note: 'Parcare subterană.' },
  aiFacts: '',
});

const TENANTS = { DENTAL, DENTAL_B, DOG, BARBER, NAILS, CONSULTING };

function assertHuman(text, label = '') {
  assert.ok(String(text || '').length > 5, `empty reply ${label}`);
  assert.equal(ROBOT.test(text), false, `robot leak ${label}: ${text}`);
}

function bookOneShot(business, line) {
  const me = createChat(business);
  return me.say(line);
}

function expectConfirm(out, { service, date, time, forbid = [] }) {
  assertHuman(out.text);
  assert.equal(out.action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION, out.text);
  if (service) assert.equal(out.draft.service_name, service, out.text);
  if (date) assert.equal(out.draft.date, date, out.text);
  if (time) assert.equal(out.draft.time, time, out.text);
  for (const bad of forbid) {
    assert.doesNotMatch(out.text, bad);
  }
}

function expectClosed(out, dayRe) {
  assert.equal(out.action, 'CLOSED', out.text);
  assertHuman(out.text);
  if (dayRe) assert.match(out.text, dayRe);
}

/** @type {{ id: string, tenant: keyof typeof TENANTS, lines: string[], check: (turns: any[], chat: any) => void }[]} */
const CASES = [
  // --- dental happy / relative ---
  {
    id: 'D01-dental-oneshot',
    tenant: 'DENTAL',
    lines: ['Consultație luni la 10'],
    check: (t) => expectConfirm(t[0], { service: 'Consultație', date: '2026-08-17', time: '10:00', forbid: [/Tuns|Barba|Spălare/] }),
  },
  {
    id: 'D02-dental-maine-sunday',
    tenant: 'DENTAL',
    lines: ['Detartraj Maine la 12'],
    check: (t) => {
      assert.equal(t[0].draft.date, '2026-08-16');
      assert.equal(t[0].draft.time, '12:00');
      expectClosed(t[0], /Duminică/);
      assert.doesNotMatch(t[0].text, /Sâmbătă/);
    },
  },
  {
    id: 'D03-dental-screenshot',
    tenant: 'DENTAL',
    lines: ['1', '2', 'Maine la 12', 'Luni la 12 30'],
    check: (t) => {
      assert.equal(t[1].draft.service_name, 'Detartraj');
      expectClosed(t[2], /Duminică/);
      expectConfirm(t[3], { service: 'Detartraj', date: '2026-08-17', time: '12:30' });
    },
  },
  {
    id: 'D04-dental-accents',
    tenant: 'DENTAL',
    lines: ['mâine la 11'],
    check: (t) => {
      assert.equal(t[0].draft.date, '2026-08-16');
      assert.equal(t[0].draft.time, '11:00');
    },
  },
  {
    id: 'D05-dental-astazi-past',
    tenant: 'DENTAL',
    lines: ['Albire', 'astăzi la 10'],
    check: (t) => {
      assert.equal(t[0].draft.service_name, 'Albire');
      expectClosed(t[1], /trecut|viitor/i);
    },
  },
  {
    id: 'D06-dental-poimaine',
    tenant: 'DENTAL',
    lines: ['Consultație poimâine la 9'],
    check: (t) => expectConfirm(t[0], { service: 'Consultație', date: '2026-08-17', time: '09:00' }),
  },
  {
    id: 'D07-dental-no-barber',
    tenant: 'DENTAL',
    lines: ['tuns clasic luni la 10'],
    check: (t) => {
      assert.notEqual(t[0].draft.service_name, 'Tuns Clasic');
      assert.doesNotMatch(t[0].text, /Tuns Clasic/);
    },
  },
  {
    id: 'D08-dental-parking-yes',
    tenant: 'DENTAL',
    lines: ['aveti parcare?'],
    check: (t) => {
      assert.equal(t[0].action, 'ADMIN_FACT');
      assert.match(t[0].text, /curtea clinicii/);
    },
  },
  {
    id: 'D09-dental-children-fact',
    tenant: 'DENTAL',
    lines: ['primiti copii?'],
    check: (t) => {
      assert.equal(t[0].action, 'ADMIN_FACT');
      assert.match(t[0].text, /4 ani|pedodont/i);
    },
  },
  {
    id: 'D10-dental-wifi-unknown',
    tenant: 'DENTAL',
    lines: ['aveti wifi?'],
    check: (t) => {
      assert.equal(t[0].action, 'MISSING_INFO');
      assert.doesNotMatch(t[0].text, /da, avem wifi|we have wifi/i);
    },
  },
  {
    id: 'D11-dental-prices-example',
    tenant: 'DENTAL',
    lines: ['ce preturi aveti'],
    check: (t) => {
      assert.equal(t[0].action, 'SERVICES');
      assert.match(t[0].text, /Consultație/);
      assert.doesNotMatch(t[0].text, /tuns mâine/i);
    },
  },
  {
    id: 'D12-dental-hours',
    tenant: 'DENTAL',
    lines: ['ce program aveti'],
    check: (t) => {
      assert.equal(t[0].action, 'HOURS');
      assert.match(t[0].text, /09:00|Program/i);
    },
  },
  {
    id: 'D13-dental-correction',
    tenant: 'DENTAL',
    lines: ['Consultație miercuri la 14', 'nu 14, 16'],
    check: (t) => {
      expectConfirm(t[0], { service: 'Consultație', date: '2026-08-19', time: '14:00' });
      expectConfirm(t[1], { service: 'Consultație', date: '2026-08-19', time: '16:00' });
    },
  },
  {
    id: 'D14-dental-cancel-mid',
    tenant: 'DENTAL',
    lines: ['Detartraj', 'luni la 11', 'anuleaza'],
    check: (t) => {
      assert.equal(t[1].action, MACHINE_ACTIONS.ACTION_SHOW_CONFIRMATION);
      assert.equal(t[2].action, 'CANCELLED');
    },
  },
  {
    id: 'D15-dental-confirm-da',
    tenant: 'DENTAL',
    lines: ['Albire luni la 15', 'da'],
    check: (t) => {
      expectConfirm(t[0], { service: 'Albire', time: '15:00' });
      assert.equal(t[1].action, 'CONFIRMED');
    },
  },

  // --- twin clinics isolation ---
  {
    id: 'T01-sud-no-parking-invent',
    tenant: 'DENTAL_B',
    lines: ['aveti parcare?'],
    check: (t) => {
      assert.equal(t[0].action, 'MISSING_INFO');
      assert.doesNotMatch(t[0].text, /curtea clinicii|fața salonului/);
    },
  },
  {
    id: 'T02-sud-book-same-name',
    tenant: 'DENTAL_B',
    lines: ['Consultație luni la 11'],
    check: (t) => expectConfirm(t[0], { service: 'Consultație', date: '2026-08-17', time: '11:00' }),
  },
  {
    id: 'T03-sud-prices-not-nord',
    tenant: 'DENTAL_B',
    lines: ['ce servicii aveti'],
    check: (t) => {
      assert.match(t[0].text, /120|200|Consultație/);
      assert.doesNotMatch(t[0].text, /800|Albire|150 LEI/);
    },
  },

  // --- dog grooming ---
  {
    id: 'G01-dog-spalare',
    tenant: 'DOG',
    lines: ['Spalare luni la 11'],
    check: (t) => expectConfirm(t[0], { service: 'Spălare', date: '2026-08-17', time: '11:00', forbid: [/Tuns Clasic|Consultație/] }),
  },
  {
    id: 'G02-dog-numbered',
    tenant: 'DOG',
    lines: ['programare', '2', 'luni 12 30'],
    check: (t) => expectConfirm(t[2], { service: 'Tuns câine', date: '2026-08-17', time: '12:30' }),
  },
  {
    id: 'G03-dog-parking-no',
    tenant: 'DOG',
    lines: ['aveti parcare?'],
    check: (t) => {
      assert.equal(t[0].action, 'ADMIN_FACT');
      assert.match(t[0].text, /nu avem parcare|Din păcate/i);
    },
  },
  {
    id: 'G04-dog-breeds-fact',
    tenant: 'DOG',
    lines: ['primiti metisi?'],
    check: (t) => {
      assert.equal(t[0].action, 'ADMIN_FACT', t[0].text);
      assert.match(t[0].text, /rase|metiș|metisi/i);
    },
  },
  {
    id: 'G05-dog-maine',
    tenant: 'DOG',
    lines: ['Tăiere unghii maine la 10'],
    check: (t) => {
      assert.equal(t[0].draft.service_name, 'Tăiere unghii');
      assert.equal(t[0].draft.date, '2026-08-16');
      expectClosed(t[0], /Duminică/);
    },
  },
  {
    id: 'G06-dog-no-dental',
    tenant: 'DOG',
    lines: ['Detartraj luni la 10'],
    check: (t) => {
      assert.notEqual(t[0].draft.service_name, 'Detartraj');
      assert.doesNotMatch(t[0].text, /Detartraj|Consultație/);
    },
  },
  {
    id: 'G07-dog-jumate',
    tenant: 'DOG',
    lines: ['Spălare luni la 11 jumate'],
    check: (t) => expectConfirm(t[0], { service: 'Spălare', time: '11:30' }),
  },
  {
    id: 'G08-dog-comma-time',
    tenant: 'DOG',
    lines: ['Spălare luni la 11,20'],
    check: (t) => expectConfirm(t[0], { service: 'Spălare', time: '11:20' }),
  },
  {
    id: 'G09-dog-bitcoin',
    tenant: 'DOG',
    lines: ['cat e bitcoinul azi?'],
    check: (t) => {
      assert.equal(t[0].action, 'OFF_TOPIC');
      assert.match(t[0].text, /Paw Spa/);
    },
  },
  {
    id: 'G10-dog-pizza',
    tenant: 'DOG',
    lines: ['vreau o pizza'],
    check: (t) => assert.equal(t[0].action, 'OFF_TOPIC'),
  },

  // --- barber ---
  {
    id: 'B01-barber-combo',
    tenant: 'BARBER',
    lines: ['tuns + barba luni la 10'],
    check: (t) => expectConfirm(t[0], { service: 'Tuns + Barba', date: '2026-08-17', time: '10:00' }),
  },
  {
    id: 'B02-barber-sat-past-jumps-next-week',
    tenant: 'BARBER',
    lines: ['tuns clasic sambata la 11'],
    check: (t) => {
      // Frozen clock is Saturday 16:00 — 11:00 today already passed → next Saturday.
      expectConfirm(t[0], { service: 'Tuns Clasic', date: '2026-08-22', time: '11:00' });
    },
  },
  {
    id: 'B02b-barber-sat-still-open-is-today',
    tenant: 'BARBER',
    lines: ['tuns clasic sambata la 12'],
    check: (t) => {
      const morning = createChat(TENANTS.BARBER, [], new Date('2026-08-15T07:00:00.000Z'));
      const out = morning.say('tuns clasic sambata la 12');
      expectConfirm(out, { service: 'Tuns Clasic', date: '2026-08-15', time: '12:00' });
    },
  },
  {
    id: 'B03-barber-sat-closed-hour',
    tenant: 'BARBER',
    lines: ['tuns clasic sambata la 15'],
    check: (t) => expectClosed(t[0], /Sâmbătă|programului|14:00|închis/i),
  },
  {
    id: 'B04-barber-sun-closed',
    tenant: 'BARBER',
    lines: ['tuns clasic duminica la 12'],
    check: (t) => expectClosed(t[0], /Duminică/),
  },
  {
    id: 'B05-barber-women',
    tenant: 'BARBER',
    lines: ['tundeti doamne?'],
    check: (t) => {
      assert.equal(t[0].action, 'ADMIN_FACT');
      assert.match(t[0].text, /doamne|femei/i);
    },
  },
  {
    id: 'B06-barber-parking',
    tenant: 'BARBER',
    lines: ['aveti parcare?'],
    check: (t) => {
      assert.equal(t[0].action, 'ADMIN_FACT');
      assert.match(t[0].text, /fața salonului/);
    },
  },
  {
    id: 'B07-barber-marti-3',
    tenant: 'BARBER',
    lines: ['Aranjat Barba marti la 3'],
    check: (t) => expectConfirm(t[0], { service: 'Aranjat Barba', date: '2026-08-18', time: '15:00' }),
  },
  {
    id: 'B08-barber-numbered-steal',
    tenant: 'BARBER',
    lines: ['1', '1', '3'],
    check: (t) => {
      assert.equal(t[1].draft.service_name, 'Tuns Clasic');
      assert.equal(t[2].time_text || t[2].draft.time, '15:00');
      assert.notEqual(t[2].draft.service_name, 'Aranjat Barba');
    },
  },
  {
    id: 'B09-barber-en-monday',
    tenant: 'BARBER',
    lines: ['Tuns Clasic Monday at 4 PM'],
    check: (t) => expectConfirm(t[0], { service: 'Tuns Clasic', date: '2026-08-17', time: '16:00' }),
  },
  {
    id: 'B10-barber-tomorrow-en',
    tenant: 'BARBER',
    lines: ['Tuns Clasic tomorrow at 11'],
    check: (t) => {
      assert.equal(t[0].draft.date, '2026-08-16');
      expectClosed(t[0], /Duminică|Sunday|closed|închiși/i);
    },
  },

  // --- nails ---
  {
    id: 'N01-nails-mani',
    tenant: 'NAILS',
    lines: ['Manichiură luni la 10'],
    check: (t) => expectConfirm(t[0], { service: 'Manichiură', date: '2026-08-17', time: '10:00', forbid: [/Tuns|Detartraj|Spălare/] }),
  },
  {
    id: 'N02-nails-gel-space',
    tenant: 'NAILS',
    lines: ['Constructie gel luni la 12 30'],
    check: (t) => expectConfirm(t[0], { service: 'Construcție gel', time: '12:30' }),
  },
  {
    id: 'N03-nails-no-children',
    tenant: 'NAILS',
    lines: ['primiti copii?'],
    check: (t) => {
      assert.equal(t[0].action, 'ADMIN_FACT');
      assert.match(t[0].text, /nu|Din păcate|do not/i);
    },
  },
  {
    id: 'N04-nails-parking-unknown',
    tenant: 'NAILS',
    lines: ['aveti parcare?'],
    check: (t) => {
      assert.equal(t[0].action, 'MISSING_INFO');
      assert.doesNotMatch(t[0].text, /Avem parcare|fața salonului/);
    },
  },
  {
    id: 'N05-nails-catalog-example',
    tenant: 'NAILS',
    lines: ['ce servicii aveti'],
    check: (t) => {
      assert.match(t[0].text, /Manichiură/);
      assert.match(t[0].text, /Manichiură luni la 10/);
      assert.doesNotMatch(t[0].text, /tuns mâine/i);
    },
  },
  {
    id: 'N06-nails-pedi-pranz',
    tenant: 'NAILS',
    lines: ['Pedichiură luni la pranz'],
    check: (t) => expectConfirm(t[0], { service: 'Pedichiură', time: '12:00' }),
  },

  // --- memory / confuse mid-flow ---
  {
    id: 'M01-weather-then-slot',
    tenant: 'DENTAL',
    lines: ['Consultație', 'ce vreme e maine?', 'luni la 10'],
    check: (t) => {
      assert.equal(t[1].action, 'OFF_TOPIC');
      expectConfirm(t[2], { service: 'Consultație', date: '2026-08-17', time: '10:00' });
    },
  },
  {
    id: 'M02-wifi-then-slot',
    tenant: 'BARBER',
    lines: ['tuns clasic', 'aveti wifi?', 'luni la 11'],
    check: (t) => {
      assert.equal(t[1].action, 'MISSING_INFO');
      expectConfirm(t[2], { service: 'Tuns Clasic', time: '11:00' });
    },
  },
  {
    id: 'M03-hours-mid-booking',
    tenant: 'DOG',
    lines: ['Spălare', 'ce program aveti', 'luni la 10'],
    check: (t) => {
      assert.equal(t[1].action, 'HOURS');
      expectConfirm(t[2], { service: 'Spălare', time: '10:00' });
    },
  },
  {
    id: 'M04-change-service-after-slot',
    tenant: 'BARBER',
    lines: ['tuns clasic miercuri la 2', 'tuns + barba'],
    check: (t) => {
      expectConfirm(t[0], { service: 'Tuns Clasic', time: '14:00' });
      assert.equal(t[1].draft.service_name, 'Tuns + Barba');
      assert.equal(t[1].draft.date, '2026-08-19');
      assert.equal(t[1].draft.time, '14:00');
    },
  },
  {
    id: 'M05-list-empty',
    tenant: 'DENTAL',
    lines: ['ce programari am'],
    check: (t) => {
      assert.equal(t[0].action, 'LIST_APPOINTMENTS');
      assert.match(t[0].text, /Nicio programare|no appointment|nouă/i);
    },
  },
  {
    id: 'M06-list-after-confirm',
    tenant: 'DENTAL',
    lines: ['Consultație luni la 10', 'da', 'ce programari am'],
    check: (t) => {
      assert.equal(t[1].action, 'CONFIRMED');
      assert.equal(t[2].action, 'LIST_APPOINTMENTS');
      assert.match(t[2].text, /Consultație/);
    },
  },
  {
    id: 'M07-callback-human',
    tenant: 'DENTAL',
    lines: ['vreau sa vorbesc cu un om'],
    check: (t) => {
      assert.equal(t[0].action, 'CALLBACK');
      assert.match(t[0].text, /Clinica Dentară Nord|sună|notat/i);
    },
  },
  {
    id: 'M08-ieri-past',
    tenant: 'BARBER',
    lines: ['tuns clasic ieri la 12'],
    check: (t) => {
      assert.equal(t[0].draft.date, '2026-08-14');
      expectClosed(t[0], /trecut|viitor/i);
    },
  },
  {
    id: 'M09-alaltaieri-past',
    tenant: 'NAILS',
    lines: ['Manichiură alaltaieri la 10'],
    check: (t) => {
      assert.equal(t[0].draft.date, '2026-08-13');
      expectClosed(t[0], /trecut|viitor/i);
    },
  },
  {
    id: 'M10-contact',
    tenant: 'DOG',
    lines: ['unde sunteti'],
    check: (t) => assert.equal(t[0].action, 'CONTACT'),
  },
  {
    id: 'M11-greeting-keeps-tenant',
    tenant: 'NAILS',
    lines: ['Salut'],
    check: (t) => {
      assert.equal(t[0].action, 'MENU');
      assert.match(t[0].text, /Nail Studio Bloom|programăr/i);
      assert.doesNotMatch(t[0].text, /Tuns Clasic|Consultație/);
    },
  },
  {
    id: 'M12-outside-hours-evening',
    tenant: 'DENTAL',
    lines: ['Consultație luni seara la 7'],
    check: (t) => {
      assert.equal(t[0].draft.time, '19:00');
      expectClosed(t[0], /Luni|programului|18:00/i);
    },
  },
  {
    id: 'M13-pe-18-aug',
    tenant: 'BARBER',
    lines: ['tuns clasic 18 aug la 11'],
    check: (t) => expectConfirm(t[0], { service: 'Tuns Clasic', date: '2026-08-18', time: '11:00' }),
  },
  {
    id: 'M14-18-dot-08',
    tenant: 'DOG',
    lines: ['Spălare 18.08 la 11'],
    check: (t) => expectConfirm(t[0], { service: 'Spălare', date: '2026-08-18', time: '11:00' }),
  },
  {
    id: 'M15-filler-daca-se-poate',
    tenant: 'NAILS',
    lines: ['daca se poate Manichiură luni la 10'],
    check: (t) => expectConfirm(t[0], { service: 'Manichiură', date: '2026-08-17', time: '10:00' }),
  },
  {
    id: 'M16-caps-maine',
    tenant: 'DENTAL',
    lines: ['DETARTRAJ MÂINE LA 12'],
    check: (t) => {
      assert.equal(t[0].draft.service_name, 'Detartraj');
      assert.equal(t[0].draft.date, '2026-08-16');
      expectClosed(t[0], /Duminică/);
    },
  },
  {
    id: 'M17-no-diacritics',
    tenant: 'NAILS',
    lines: ['manichiura luni la 10'],
    check: (t) => expectConfirm(t[0], { service: 'Manichiură', time: '10:00' }),
  },
  {
    id: 'M18-cancel-then-new',
    tenant: 'BARBER',
    lines: ['tuns clasic miercuri la 2', '2', 'Aranjat Barba joi la 10'],
    check: (t) => {
      assert.equal(t[1].action, 'CANCELLED');
      expectConfirm(t[2], { service: 'Aranjat Barba', date: '2026-08-20', time: '10:00' });
      assert.notEqual(t[2].draft.service_name, 'Tuns Clasic');
    },
  },
  {
    id: 'M19-consulting-callback',
    tenant: 'CONSULTING',
    lines: ['vreau o programare'],
    check: (t) => {
      assert.ok(['CALLBACK', 'MENU', MACHINE_ACTIONS.ACTION_ASK_SERVICE].includes(t[0].action), t[0].action);
      if (t[0].action === 'CALLBACK') assert.match(t[0].text, /Legal Advice Pro|sună|notat/i);
    },
  },
  {
    id: 'M20-reclamatie-callback',
    tenant: 'BARBER',
    lines: ['am o reclamatie'],
    check: (t) => assert.equal(t[0].action, 'CALLBACK'),
  },
];

describe('50+ adversarial client scenarios across tenants', () => {
  it(`runs ${CASES.length} distinct cases with strict assertions`, () => {
    assert.ok(CASES.length >= 50, `need ≥50 cases, got ${CASES.length}`);
    /** @type {string[]} */
    const failures = [];
    for (const c of CASES) {
      const business = TENANTS[c.tenant];
      assert.ok(business, `missing tenant ${c.tenant}`);
      const chat = createChat(business);
      const turns = [];
      try {
        for (const line of c.lines) {
          const out = chat.say(line);
          turns.push({ user: line, ...out });
          assertHuman(out.text, `${c.id} after "${line}"`);
        }
        c.check(turns, chat);
      } catch (err) {
        failures.push(`${c.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    assert.equal(failures.length, 0, failures.join('\n'));
  });
});

describe('cross-tenant contamination probe', () => {
  it('Nord parking fact never appears on Sud, Dog, or Nails', () => {
    for (const key of /** @type {const} */ (['DENTAL_B', 'DOG', 'NAILS'])) {
      const out = bookOneShot(TENANTS[key], 'aveti parcare?');
      assert.doesNotMatch(out.text, /curtea clinicii/);
      assert.doesNotMatch(out.text, /fața salonului/);
    }
  });

  it('barber women note never leaks to dental or nails', () => {
    for (const key of /** @type {const} */ (['DENTAL', 'NAILS', 'DOG'])) {
      const out = bookOneShot(TENANTS[key], 'tundeti doamne?');
      assert.doesNotMatch(out.text, /tundem și doamne/i);
    }
  });
});

describe('frozen clock sanity', () => {
  it('NOW is Saturday afternoon Bucharest', () => {
    assert.equal(NOW.toISOString(), '2026-08-15T13:00:00.000Z');
  });
});
