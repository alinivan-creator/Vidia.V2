import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  reduceBookingTurn,
  SESSION_STATES,
  MACHINE_ACTIONS,
  emptyDraft,
  mapSessionState,
  sessionKeepsChosenService,
} from '../src/lib/booking/stateMachine.js';
import { hydrateExtract } from '../src/services/turnExecute.js';
import {
  isConversationSessionExpired,
  getSessionTtlMinutes,
} from '../src/services/sessionValidator.js';
import { classifyInboundMessage } from '../src/utils/inboundPayload.js';
import { CONVERSATION_STEPS } from '../src/db/conversationStateService.js';
import { BOOKING_ARCHITECTURE_VERSION } from '../src/config/bookingArchitecture.js';
describe('State Machine & Atomic Context Pivots', () => {
  const SATURDAY = new Date('2026-08-15T12:00:00.000Z');

  it('Date Pivot in-flight: changing date clears old time and transitions to WAITING_FOR_TIME', () => {
    const initialDraft = {
      service_id: 'srv_1',
      service_name: 'Tuns',
      date: '2026-08-17', // Monday
      time: '10:00',
      duration: 30,
    };

    // User pivots: "vreau de fapt miercuri"
    const reduced = reduceBookingTurn({
      state: SESSION_STATES.WAITING_FOR_CONFIRMATION,
      draft: initialDraft,
      text: 'vreau de fapt miercuri',
      timezone: 'Europe/Bucharest',
      extractDate: '2026-08-19', // Wednesday
      extractTime: null,
      now: SATURDAY,
    });

    assert.equal(reduced.draft.service_id, 'srv_1');
    assert.equal(reduced.draft.date, '2026-08-19');
    assert.equal(reduced.draft.time, null); // Old time was cleanly reset
    assert.equal(reduced.state, SESSION_STATES.WAITING_FOR_TIME);
    assert.equal(reduced.action, MACHINE_ACTIONS.ACTION_ASK_TIME);
  });

  it('Time Pivot in-flight: changing time preserves active date and transitions to CHECK_SLOT', () => {
    const initialDraft = {
      service_id: 'srv_1',
      service_name: 'Tuns',
      date: '2026-08-19',
      time: '10:00',
      duration: 30,
    };

    // User pivots: "vreau la 15:00"
    const reduced = reduceBookingTurn({
      state: SESSION_STATES.WAITING_FOR_CONFIRMATION,
      draft: initialDraft,
      text: 'vreau la 15:00',
      timezone: 'Europe/Bucharest',
      extractDate: null,
      extractTime: '15:00',
      now: SATURDAY,
    });

    assert.equal(reduced.draft.service_id, 'srv_1');
    assert.equal(reduced.draft.date, '2026-08-19');
    assert.equal(reduced.draft.time, '15:00');
    assert.equal(reduced.state, SESSION_STATES.WAITING_FOR_CONFIRMATION);
    assert.equal(reduced.action, MACHINE_ACTIONS.ACTION_CHECK_SLOT);
  });

  it('Service Pivot in-flight: changing service preserves active date', () => {
    const initialDraft = {
      service_id: 'srv_1',
      service_name: 'Tuns',
      date: '2026-08-19',
      time: null,
      duration: 30,
    };

    // User pivots: "vreau tuns si barba"
    const reduced = reduceBookingTurn({
      state: SESSION_STATES.WAITING_FOR_TIME,
      draft: initialDraft,
      text: 'vreau tuns si barba',
      timezone: 'Europe/Bucharest',
      extractServiceId: 'srv_2',
      extractServiceName: 'Tuns + Barbă',
      now: SATURDAY,
    });

    assert.equal(reduced.draft.service_id, 'srv_2');
    assert.equal(reduced.draft.service_name, 'Tuns + Barbă');
    assert.equal(reduced.draft.date, '2026-08-19');
    assert.equal(reduced.state, SESSION_STATES.WAITING_FOR_TIME);
    assert.equal(reduced.action, MACHINE_ACTIONS.ACTION_ASK_TIME);
  });

  it('hydrateExtract does not inherit old time on explicit date pivot', () => {
    const convState = {
      current_step: CONVERSATION_STEPS.WAITING_FOR_TIME,
      context_data: {
        pending_service_id: 'srv_1',
        pending_date_text: '2026-08-17',
        pending_time_text: '10:00',
      },
    };

    const extract = {
      action: 'book',
      date_text: '2026-08-19',
      time_text: null,
      service_id: null,
    };

    const hydrated = hydrateExtract(extract, convState, 'Europe/Bucharest');
    assert.equal(hydrated.date_text, '2026-08-19');
    assert.equal(hydrated.time_text, null); // Old time not inherited across different dates
    assert.equal(hydrated.service_id, 'srv_1'); // Kept active service
  });

  it('hydrateExtract preserves time if date is unchanged or not mentioned', () => {
    const convState = {
      current_step: CONVERSATION_STEPS.WAITING_FOR_CONFIRMATION,
      context_data: {
        pending_service_id: 'srv_1',
        pending_date_text: '2026-08-17',
        pending_time_text: '10:00',
      },
    };

    const extract = {
      action: 'confirm',
      date_text: null,
      time_text: null,
      service_id: null,
    };

    const hydrated = hydrateExtract(extract, convState, 'Europe/Bucharest');
    assert.equal(hydrated.date_text, '2026-08-17');
    assert.equal(hydrated.time_text, '10:00');
    assert.equal(hydrated.service_id, 'srv_1');
  });
});

describe('Silent Session TTL Check & NLU Classification', () => {
  it('session TTL resets idle conversation past 10 minutes silently', () => {
    const now = Date.parse('2026-08-19T10:15:00.000Z');
    const conv = {
      current_step: CONVERSATION_STEPS.SELECTING_SLOT,
      context_data: {
        session_timestamp: '2026-08-19T10:00:00.000Z',
        pending_service_id: 'srv_1',
      },
    };

    assert.equal(isConversationSessionExpired(conv, 10, now), true);
  });

  it('session TTL does not expire recent conversation within 10 minutes', () => {
    const now = Date.parse('2026-08-19T10:08:00.000Z');
    const conv = {
      current_step: CONVERSATION_STEPS.SELECTING_SLOT,
      context_data: {
        session_timestamp: '2026-08-19T10:00:00.000Z',
      },
    };

    assert.equal(isConversationSessionExpired(conv, 10, now), false);
  });

  it('classifyInboundMessage passes free-text directly to NLU without treating as stale button', () => {
    const inbound = classifyInboundMessage({
      body: 'Aveti liber maine seara dupa 18?',
      buttonPayload: 'slot_2026-08-19_10:00', // stray payload attached by WhatsApp
      buttonText: '10:00',
    });

    assert.equal(inbound.kind, 'text');
    assert.equal(inbound.textBody, 'Aveti liber maine seara dupa 18?');
    assert.equal(inbound.buttonPayload, null);
    assert.equal(inbound.isInteractive, false);
  });

  it('RESCHEDULING maps to WAITING_FOR_DATE and keeps chosen service (never ASK_SERVICE)', () => {
    assert.equal(mapSessionState(CONVERSATION_STEPS.RESCHEDULING), SESSION_STATES.WAITING_FOR_DATE);
    assert.equal(mapSessionState(CONVERSATION_STEPS.MODIFYING), SESSION_STATES.WAITING_FOR_DATE);
    assert.equal(mapSessionState(CONVERSATION_STEPS.MODIFIED), SESSION_STATES.CONFIRMED);
    assert.equal(sessionKeepsChosenService(mapSessionState(CONVERSATION_STEPS.RESCHEDULING)), true);

    // Mid-reschedule free-text date must not drop service or ask for catalog again.
    const now = new Date('2026-08-15T12:00:00.000Z');
    const reduced = reduceBookingTurn({
      state: mapSessionState(CONVERSATION_STEPS.RESCHEDULING),
      draft: {
        service_id: 'srv_cut',
        service_name: 'Tuns',
        date: null,
        time: null,
        duration: 30,
      },
      text: 'mâine la 11',
      timezone: 'Europe/Bucharest',
      extractDate: '2026-08-20',
      extractTime: '11:00',
      now,
    });
    assert.equal(reduced.draft.service_id, 'srv_cut');
    assert.equal(reduced.draft.service_name, 'Tuns');
    assert.notEqual(reduced.action, MACHINE_ACTIONS.ACTION_ASK_SERVICE);
  });

  it('architecture version is bumped for deploy verification', () => {
    assert.match(BOOKING_ARCHITECTURE_VERSION, /^dual-ai-text-first-nlu-v1[3-9]/);
  });
});
