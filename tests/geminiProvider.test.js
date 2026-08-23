import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_MODEL_FALLBACKS,
  resolveGeminiModelCandidates,
  toGeminiContents,
} from '../src/services/llmProvider.js';

describe('Gemini provider', () => {
  it('defaults to gemini-3.5-flash-lite', () => {
    assert.equal(DEFAULT_GEMINI_MODEL, 'gemini-3.5-flash-lite');
    assert.ok(GEMINI_MODEL_FALLBACKS.includes('gemini-3.5-flash-lite'));
    assert.ok(!GEMINI_MODEL_FALLBACKS.includes('gemini-2.0-flash'));
    assert.ok(!GEMINI_MODEL_FALLBACKS.includes('gemini-2.5-flash'));
  });

  it('resolveGeminiModelCandidates dedupes configured model with fallbacks', () => {
    const prev = process.env.GEMINI_MODEL;
    process.env.GEMINI_MODEL = 'gemini-2.0-flash';
    try {
      const list = resolveGeminiModelCandidates();
      assert.equal(list[0], 'gemini-2.0-flash');
      assert.ok(list.includes('gemini-3.5-flash-lite'));
      assert.equal(new Set(list).size, list.length);
    } finally {
      if (prev === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = prev;
    }
  });

  it('toGeminiContents still maps roles', () => {
    const contents = toGeminiContents([
      { role: 'user', content: 'salut' },
      { role: 'assistant', content: 'buna' },
    ]);
    assert.equal(contents.length, 2);
    assert.equal(contents[0].role, 'user');
    assert.equal(contents[1].role, 'model');
  });
});
