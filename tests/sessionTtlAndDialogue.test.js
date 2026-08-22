import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SESSION_TTL_MINUTES,
  getSessionTtlMinutes,
  isConversationSessionExpired,
  readSessionTimestamp,
  buildFreshSessionGreeting,
} from '../src/services/sessionValidator.js';
import { toGeminiContents } from '../src/services/llmProvider.js';
import { toExecutionEnvelope } from '../src/services/executionAgent.js';

describe('session TTL', () => {
  it('defaults to 10 minutes and clamps Admin values', () => {
    assert.equal(DEFAULT_SESSION_TTL_MINUTES, 10);
    assert.equal(getSessionTtlMinutes(null), 10);
    assert.equal(getSessionTtlMinutes({ booking_settings: {} }), 10);
    assert.equal(getSessionTtlMinutes({ booking_settings: { session_ttl_minutes: 15 } }), 15);
    assert.equal(getSessionTtlMinutes({ booking_settings: { session_ttl_minutes: 1 } }), 2);
    assert.equal(getSessionTtlMinutes({ booking_settings: { session_ttl_minutes: 999 } }), 120);
  });

  it('reads last client inbound, not assistant writes', () => {
    const ts = '2026-08-18T18:00:00.000Z';
    assert.equal(
      readSessionTimestamp({
        updated_at: '2026-08-18T18:30:00.000Z',
        context_data: { session_timestamp: ts },
      }),
      Date.parse(ts),
    );
  });

  it('IDLE without sticky state is not expired', () => {
    const now = Date.parse('2026-08-18T18:20:00.000Z');
    const conv = {
      current_step: 'IDLE',
      context_data: { session_timestamp: '2026-08-18T18:00:00.000Z' },
    };
    assert.equal(isConversationSessionExpired(conv, 10, now), false);
  });

  it('IDLE with confirmed language expires after session TTL', () => {
    const now = Date.parse('2026-08-18T18:20:00.000Z');
    const conv = {
      current_step: 'IDLE',
      context_data: {
        session_timestamp: '2026-08-18T18:00:00.000Z',
        language_confirmed: true,
        client_language: 'en',
      },
    };
    assert.equal(isConversationSessionExpired(conv, 10, now), true);
    assert.equal(
      isConversationSessionExpired(conv, 10, Date.parse('2026-08-18T18:05:00.000Z')),
      false,
    );
  });

  it('active booking step expires after session TTL', () => {
    const now = Date.parse('2026-08-18T18:11:00.000Z');
    const conv = {
      current_step: 'SELECTING_SLOT',
      context_data: { session_timestamp: '2026-08-18T18:00:00.000Z' },
    };
    assert.equal(isConversationSessionExpired(conv, 10, now), true);
    assert.equal(
      isConversationSessionExpired(conv, 10, Date.parse('2026-08-18T18:09:00.000Z')),
      false,
    );
  });

  it('fresh greeting does not mention leftover bookings', () => {
    assert.equal(
      buildFreshSessionGreeting({ name: 'Salon Test' }),
      'Asistent Vidia — cu ce te pot ajuta la *Salon Test*?',
    );
    assert.equal(buildFreshSessionGreeting(null), 'Asistent Vidia — cu ce te pot ajuta?');
  });
});

describe('Dialogue Agent Gemini mapping', () => {
  it('drops system messages and maps assistant → model', () => {
    const contents = toGeminiContents([
      { role: 'system', content: 'secret prompt' },
      { role: 'user', content: 'vreau tuns' },
      { role: 'assistant', content: 'ce zi?' },
      { role: 'user', content: 'maine' },
    ]);
    assert.deepEqual(contents, [
      { role: 'user', parts: [{ text: 'vreau tuns' }] },
      { role: 'model', parts: [{ text: 'ce zi?' }] },
      { role: 'user', parts: [{ text: 'maine' }] },
    ]);
  });

  it('never starts with a model turn', () => {
    const contents = toGeminiContents([{ role: 'assistant', content: 'salut' }]);
    assert.equal(contents[0].role, 'user');
    assert.equal(contents[1].role, 'model');
  });
});

describe('Execution Agent envelope', () => {
  it('maps HandlerResult to structured JSON without inventing slots', () => {
    const envelope = toExecutionEnvelope({
      status: 'MISSING_INFO',
      next_required_step: 'ASK_DATE',
      action_performed: null,
      data: { client_message: 'Alege ziua' },
    });
    assert.deepEqual(envelope, {
      status: 'missing_info',
      next_step: 'ASK_DATE',
      action: null,
      message: 'Alege ziua',
      data: { client_message: 'Alege ziua' },
    });
  });
});
