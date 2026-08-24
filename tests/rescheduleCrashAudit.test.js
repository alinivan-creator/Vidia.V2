import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractTurnIntent } from '../src/services/turnExtract.js';
import { mapBookingIntentToExtraction } from '../src/services/bookingIntentMapper.js';
import { CONVERSATION_STEPS } from '../src/db/conversationStateService.js';

const salonBusiness = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Salon Test',
  timezone: 'Europe/Bucharest',
  booking_settings: {
    services: [{ id: 'svc-tuns', name: 'Tuns Clasic', duration_minutes: 30 }],
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

describe('reschedule HH:MM crash audit', () => {
  it('extractTurnIntent does not throw on "vineri 9:30 … muta la 15:00"', async () => {
    const text = 'Am si eu o programare vineri la 9:30 o pot muta la 15:00?';
    const extract = await extractTurnIntent({
      business: salonBusiness,
      textBody: text,
      typedText: text,
      convState: { current_step: CONVERSATION_STEPS.IDLE, context_data: {} },
      requestId: 'audit-reschedule-hhmm',
    });

    assert.equal(extract.action, 'reschedule');
    assert.equal(extract.time_text, '09:30');
    assert.equal(extract.reschedule_new_time, '15:00');
    assert.equal(extract.vague_choice, false);
  });

  it('extractTurnIntent splits existing vs new time for "ora 15" variant', async () => {
    const text = 'am si eu o programare vineri la 9:30, se poate sa o mutam la ora 15?';
    const extract = await extractTurnIntent({
      business: salonBusiness,
      textBody: text,
      typedText: text,
      convState: { current_step: CONVERSATION_STEPS.IDLE, context_data: {} },
      requestId: 'audit-reschedule-ora15',
    });

    assert.equal(extract.action, 'reschedule');
    assert.equal(extract.time_text, '09:30');
    assert.equal(extract.reschedule_new_time, '15:00');
  });

  it('NLU reschedule_request keeps slot fields even when keyword mod also matches', () => {
    const text = 'am si eu o programare vineri la 9:30, se poate sa o mutam la ora 15?';
    const extraction = mapBookingIntentToExtraction({
      intent: 'reschedule_request',
      service_mentioned: null,
      existing_appointment_time: 'vineri 9:30',
      requested_new_time: '15:00',
      confidence: 'high',
    }, text, salonBusiness.timezone, salonBusiness);

    assert.equal(extraction?.existing_appointment_time_hhmm, '09:30');
    assert.equal(extraction?.requested_reschedule_time_hhmm, '15:00');
  });

  it('mapBookingIntentToExtraction resolves 15:00 HH:MM new time', () => {
    const extraction = mapBookingIntentToExtraction({
      intent: 'reschedule_request',
      service_mentioned: null,
      existing_appointment_time: 'vineri 9:30',
      requested_new_time: '15:00',
      confidence: 'high',
    }, 'mut la 15:00', salonBusiness.timezone, salonBusiness);

    assert.equal(extraction?.requested_reschedule_time_hhmm, '15:00');
  });
});

describe('post-flow courtesy after idle reset', () => {
  const idleAfterFlow = {
    current_step: CONVERSATION_STEPS.IDLE,
    context_data: {
      session_language: 'ro',
      ai_disclosed: true,
      recent_turns: [],
      last_menu: null,
      intent: null,
      booking_wait: null,
    },
  };

  for (const text of [
    'In regula multumesc',
    'in regula, multumesc',
    'ok multumesc',
    'este in regula',
  ]) {
    it(`extractTurnIntent handles post-flow courtesy: "${text}"`, async () => {
      const extract = await extractTurnIntent({
        business: salonBusiness,
        textBody: text,
        typedText: text,
        convState: idleAfterFlow,
        requestId: 'post-flow-courtesy',
      });
      assert.equal(extract.action, 'thanks');
      assert.equal(extract.source, 'keyword');
    });
  }
});
