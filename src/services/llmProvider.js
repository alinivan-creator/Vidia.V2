/**
 * Dialogue Agent LLM transport.
 * Gemini is primary for conversational parse + polish; OpenAI is fallback.
 */

import { logError } from '../db/loggerService.js';
import { isCircuitOpen, recordFailure, recordSuccess } from './circuitBreaker.js';

/** Default after Google retired gemini-2.0-flash (Jun 2026). */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';

/** Tried in order when the configured model returns 404 (retired / unavailable). */
export const GEMINI_MODEL_FALLBACKS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-1.5-flash',
];

/**
 * Ordered unique Gemini model ids for this deployment.
 * @returns {string[]}
 */
export function resolveGeminiModelCandidates() {
  const configured = String(process.env.GEMINI_MODEL || '').trim();
  const ordered = configured
    ? [configured, ...GEMINI_MODEL_FALLBACKS]
    : [...GEMINI_MODEL_FALLBACKS];
  return [...new Set(ordered.filter(Boolean))];
}

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
 * @param {string} model
 * @param {string} apiKey
 * @param {Object} body
 * @param {AbortSignal} signal
 */
async function postGeminiGenerate(model, apiKey, body, signal) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
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
  const body = {
    systemInstruction: { parts: [{ text: String(system || '') }] },
    contents: toGeminiContents(messages),
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
    },
  };

  const candidates = resolveGeminiModelCandidates();
  /** @type {{ model: string, status: number, message?: string }[]} */
  const attempts = [];

  try {
    for (const model of candidates) {
      let result;
      try {
        result = await postGeminiGenerate(model, apiKey, body, controller.signal);
      } catch (error) {
        if (error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message))) {
          recordFailure('gemini');
          await logError({
            message: `Eroare: Gemini nu a răspuns (timeout ${timeoutMs / 1000}s)`,
            source: 'ai',
            severity: 'warning',
            businessId,
            requestId,
            details: { alertKind: 'gemini', model },
          });
          return { ok: false, error: 'gemini_timeout', text: null };
        }
        recordFailure('gemini');
        await logError({
          message: 'Eroare: Gemini — eroare de rețea',
          source: 'ai',
          severity: 'warning',
          businessId,
          requestId,
          error,
          details: { alertKind: 'gemini', model },
        });
        return { ok: false, error: 'gemini_network', text: null };
      }

      const { response, data } = result;
      if (response.ok) {
        recordSuccess('gemini');
        const text = extractGeminiText(data);
        if (text) {
          return { ok: true, error: null, text, model };
        }
        attempts.push({ model, status: response.status, message: 'empty_response' });
        continue;
      }

      const errMsg = typeof data?.error?.message === 'string' ? data.error.message : '';
      attempts.push({ model, status: response.status, message: errMsg.slice(0, 160) });

      // Wrong model name — try next candidate without spamming error_logs.
      if (response.status === 404) continue;

      if (response.status === 429 || response.status >= 500) recordFailure('gemini');

      await logError({
        message: `Eroare: Gemini a eșuat (HTTP ${response.status})`,
        source: 'ai',
        severity: response.status === 401 || response.status === 403 ? 'error' : 'warning',
        businessId,
        requestId,
        httpStatus: response.status,
        details: { alertKind: 'gemini', model, message: errMsg.slice(0, 200) },
      });
      return { ok: false, error: `gemini_http_${response.status}`, text: null };
    }

    recordFailure('gemini');
    const retired = attempts.every((a) => a.status === 404);
    await logError({
      message: retired
        ? 'Gemini: modelul configurat nu mai este disponibil — s-a încercat fallback OpenAI.'
        : `Gemini: toate modelele au eșuat (${attempts.map((a) => a.model).join(', ')})`,
      source: 'ai',
      severity: 'warning',
      businessId,
      requestId,
      details: {
        alertKind: 'gemini',
        attempts,
        hint: retired
          ? 'Setează GEMINI_MODEL=gemini-2.5-flash în Vercel sau elimină variabila veche gemini-2.0-flash.'
          : null,
      },
    });
    return { ok: false, error: retired ? 'gemini_model_retired' : 'gemini_all_models_failed', text: null };
  } finally {
    clearTimeout(timer);
  }
}
