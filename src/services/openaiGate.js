/**
 * OpenAI availability gate. Tracks outages only — never stores prompts or logic.
 */

import { recordFailure, isCircuitOpen } from './circuitBreaker.js';

let openaiUnavailableUntil = 0;

export function markOpenAiUnavailable() {
  openaiUnavailableUntil = Date.now() + 30_000;
  recordFailure('openai');
}

export function isOpenAiTemporarilyDown() {
  return Date.now() < openaiUnavailableUntil || isCircuitOpen('openai');
}
