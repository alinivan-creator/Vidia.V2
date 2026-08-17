import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectTimeWindowFromText,
  looksLikeAvailabilityQuestion,
  slotMatchesTimeWindow,
  timeWindowBounds,
} from '../src/utils/timeWindow.js';
import { looksLikeBusinessFactQuestion } from '../src/utils/businessInfoLookup.js';
import {
  looksLikeDatetimeOrSlot,
  looksLikeNewBookingRequest,
} from '../src/services/intentTriageService.js';
import { parseExtractionResult } from '../src/schemas/extractionResult.js';
import { formatServiceAskMessage } from '../src/utils/serviceMatch.js';

describe('intent parsing: soft availability windows', () => {
  it('detects evening from “Mai pe seara aveți liber?”', () => {
    const q = 'Mai pe seara aveți liber?';
    assert.equal(detectTimeWindowFromText(q), 'evening');
    assert.equal(looksLikeAvailabilityQuestion(q), true);
    assert.equal(looksLikeDatetimeOrSlot(q), true);
    assert.equal(looksLikeNewBookingRequest(q), true);
    assert.equal(looksLikeBusinessFactQuestion(q), false);
  });

  it('detects morning / afternoon without requiring a clock digit', () => {
    assert.equal(detectTimeWindowFromText('aveți ceva dimineața?'), 'morning');
    assert.equal(detectTimeWindowFromText('mai pe după-amiază'), 'afternoon');
  });

  it('does not steal parking FAQ as availability', () => {
    assert.equal(looksLikeBusinessFactQuestion('Aveți parcare?'), true);
    assert.equal(looksLikeAvailabilityQuestion('Aveți parcare?'), false);
  });

  it('parses extraction JSON with time_window', () => {
    const parsed = parseExtractionResult({
      intent: 'book',
      extracted_service: null,
      extracted_date: null,
      extracted_time: null,
      time_window: 'evening',
      is_ambiguous: false,
      ambiguity_reason: null,
      confidence: 0.9,
    });
    assert.ok(parsed);
    assert.equal(parsed.time_window, 'evening');
    assert.equal(parsed.intent, 'book');
  });

  it('clears time_window when exact clock is present', () => {
    const parsed = parseExtractionResult({
      intent: 'book',
      extracted_service: 'Tuns',
      extracted_date: '2026-08-18',
      extracted_time: '18:00',
      time_window: 'evening',
      is_ambiguous: false,
      ambiguity_reason: null,
      confidence: 0.95,
    });
    assert.equal(parsed?.extracted_time, '18:00');
    assert.equal(parsed?.time_window, null);
  });

  it('slotMatchesTimeWindow filters evening hours', () => {
    const bounds = timeWindowBounds('evening');
    assert.equal(bounds?.startHour, 17);
    // 18:00 Bucharest summer ≈ 15:00 UTC
    const evening = new Date('2026-08-18T15:00:00.000Z');
    const morning = new Date('2026-08-18T07:00:00.000Z');
    assert.equal(slotMatchesTimeWindow(evening, 'Europe/Bucharest', 'evening'), true);
    assert.equal(slotMatchesTimeWindow(morning, 'Europe/Bucharest', 'evening'), false);
  });

  it('service ask points to the interactive list, not a numbered-menu CTA', () => {
    const text = formatServiceAskMessage([
      { name: 'Tuns', duration_minutes: 30 },
      { name: 'Tuns + Barba', duration_minutes: 60 },
    ]);
    assert.match(text, /Servicii/);
    assert.match(text, /numele/);
    assert.doesNotMatch(text, /numărul/);
    assert.doesNotMatch(text, /\*1\. Tuns\*/);
  });
});
