/**
 * Dialogue Agent LLM transport.
 * Gemini is primary for conversational parse + polish; OpenAI is fallback.
 */

import { logError } from '../db/loggerService.js';
import { isCircuitOpen, recordFailure, recordSuccess } from './circuitBreaker.js';

const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';

export function getGeminiApiKey() {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || '';
  return key.trim();
}

export function getOpenAiApiKey() {
  return String(process.env.OPENAI_API_KEY || '').trim();
}

export function getGeminiModel() {
  const raw = String(process.env.GEMINI_MODEL || '').trim();
  return raw || DEFAULT_GEMINI_MODEL;
}

export function isGeminiConfigured() {
  return Boolean(getGeminiApiKey()) && !isCircuitOpen('gemini');
}

export function isOpenAiConfigured() {
  return Boolean(getOpenAiApiKey()) && !isCircuitOpen('openai');
}

/**
 * @param {Array<{ role?: string, content?: unknown }>} messages
 */
export function toGeminiContents(messages) {
  const contents = [];
  for (const m of messages || []) {
    if (!m || m.role === 'system') continue;
    const text = String(m.content ?? '').trim();
    if (!text) continue;
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text }],
    });
  }
  if (contents[0]?.role === 'model') {
    contents.unshift({ role: 'user', parts: [{ text: '.' }] });
  }
  if (!contents.length) {
    contents.push({ role: 'user', parts: [{ text: '.' }] });
  }
  return contents;
}

function extractGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
}

/**
 * @param {Object} params
 * @param {string} params.system
 * @param {Array<{ role: string, content: unknown }>} params.messages
 * @param {boolean} [params.jsonMode]
 * @param {number} [params.temperature]
 * @param {number} [params.maxTokens]
 * @param {number} [params.timeoutMs]
 * @param {string | null} [params.businessId]
 * @param {string | null} [params.requestId]
 */
export async function completeGeminiChat({
  system,
  messages,
  jsonMode = false,
  temperature = 0.2,
  maxTokens = 400,
  timeoutMs = 8000,
  businessId = null,
  requestId = null,
}) {
  const apiKey = getGeminiApiKey();
  if (!apiKey || isCircuitOpen('gemini')) {
    return { ok: false, error: 'gemini_unavailable', text: null };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const model = getGeminiModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: String(system || '') }] },
        contents: toGeminiContents(messages),
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
          ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
        },
      }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) recordFailure('gemini');
      await logError({
        message: `Eroare: Gemini a eșuat (HTTP ${response.status})`,
        source: 'ai',
        severity: 'error',
        businessId,
        requestId,
        httpStatus: response.status,
        details: { alert: true, alertKind: 'gemini' },
      });
      return { ok: false, error: `gemini_http_${response.status}`, text: null };
    }
    recordSuccess('gemini');
    const text = extractGeminiText(data);
    return { ok: Boolean(text), error: text ? null : 'gemini_empty', text: text || null };
  } catch (error) {
    recordFailure('gemini');
    const aborted = error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message));
    await logError({
      message: aborted
        ? `Eroare: Gemini nu a răspuns (timeout ${timeoutMs / 1000}s)`
        : 'Eroare: Gemini — eroare de rețea',
      source: 'ai',
      severity: 'error',
      businessId,
      requestId,
      error,
      details: { alert: true, alertKind: 'gemini' },
    });
    return { ok: false, error: aborted ? 'gemini_timeout' : 'gemini_network', text: null };
  } finally {
    clearTimeout(timer);
  }
}
