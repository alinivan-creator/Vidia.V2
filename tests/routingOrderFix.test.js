import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractTurnIntent } from '../src/services/turnExtract.js';
import {
  looksLikeDatetimeOrSlot,
  looksLikeNewBookingRequest,
  looksLikeOpeningHoursQuestion,
  triageUserIntent,
} from '../src/services/intentTriageService.js';
import { matchServiceMention } from '../src/utils/serviceMatch.js';
import { CONVERSATION_STEPS } from '../src/db/conversationStateService.js';

const SALON = [{ id: 'svc-tuns', name: 'Tuns Clasic', duration_minutes: 30 }];

const salonBusiness = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Salon Test',
  timezone: 'Europe/Bucharest',
  business_type: 'salon',
  booking_settings: {
    services: SALON,
    business_hours: {
      '0': null,
      '1': { open: '09:00', close: '18:00' },
      '2': { open: '09:00', close: '18:00' },
      '3': { open: '09:00', close: '18:00' },
      '4': { open: '09:00', close: '18:00' },
      '5': { open: '09:00', close: '18:00' },
      '6': null,
    },
  },
  menu_buttons: [],
};

const idle = { current_step: CONVERSATION_STEPS.IDLE, context_data: {} };

async function extract(text) {
  return extractTurnIntent({
    business: salonBusiness,
    textBody: text,
    typedText: text,
    convState: idle,
    requestId: 'routing-order-fix',
  });
}

describe('routing order fix — FAQ before deterministic / service match', () => {
  it('"Ce program aveti maine?" → hours (not book)', async () => {
    assert.equal(looksLikeOpeningHoursQuestion('Ce program aveti maine?'), true);
    assert.equal(triageUserIntent('Ce program aveti maine?', { services: SALON }).intent, 'faq');
    assert.equal(looksLikeDatetimeOrSlot('Ce program aveti maine?'), false);
    assert.equal(looksLikeNewBookingRequest('Ce program aveti maine?', { services: SALON }), false);

    const out = await extract('Ce program aveti maine?');
    assert.equal(out.action, 'hours');
    assert.notEqual(out.action, 'book');
  });

  it('"Maine pana la cat aveti deschis?" → hours (not book)', async () => {
    assert.equal(looksLikeOpeningHoursQuestion('Maine pana la cat aveti deschis?'), true);
    assert.equal(triageUserIntent('Maine pana la cat aveti deschis?', { services: SALON }).intent, 'faq');
    assert.equal(looksLikeNewBookingRequest('Maine pana la cat aveti deschis?', { services: SALON }), false);

    const out = await extract('Maine pana la cat aveti deschis?');
    assert.equal(out.action, 'hours');
  });

  it('"vreau tuns" resolves Tuns Clasic', async () => {
    assert.equal(matchServiceMention('vreau tuns', SALON)?.name, 'Tuns Clasic');
    const out = await extract('vreau tuns');
    assert.equal(out.action, 'book');
    assert.equal(out.service_id, 'svc-tuns');
    assert.equal(out.service_name, 'Tuns Clasic');
  });

  it('"buna, ce mai faceti?" is not booking', async () => {
    const out = await extract('buna, ce mai faceti?');
    assert.notEqual(out.action, 'book');
    assert.ok(['chat', 'off_topic', 'menu'].includes(out.action), out.action);
  });

  it('real booking with day+time stays book', async () => {
    const text = 'vreau o programare maine la ora 10';
    assert.equal(looksLikeOpeningHoursQuestion(text), false);
    assert.equal(looksLikeNewBookingRequest(text, { services: SALON }), true);
    assert.equal(looksLikeDatetimeOrSlot(text), true);

    const out = await extract(text);
    assert.equal(out.action, 'book');
    assert.ok(out.date_text || out.datetime || out.time_text, JSON.stringify(out));
  });

  it('reschedule with HH:MM still extracts as reschedule', async () => {
    const text = 'am si eu o programare vineri la 9:30, se poate mutam la ora 15:00';
    const out = await extract(text);
    assert.equal(out.action, 'reschedule');
  });
});
