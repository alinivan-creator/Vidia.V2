/**
 * Process-local circuit breakers for OpenAI, Twilio, and Supabase.
 * Open circuit = skip/fail fast for a short cooldown after repeated errors.
 */

const THRESHOLD = 3;
const OPEN_MS = 30_000;

/** @typedef {'openai' | 'twilio' | 'supabase'} CircuitName */

/** @type {Record<CircuitName, { failures: number, openUntil: number }>} */
const circuits = {
  openai: { failures: 0, openUntil: 0 },
  twilio: { failures: 0, openUntil: 0 },
  supabase: { failures: 0, openUntil: 0 },
};

/**
 * @param {CircuitName} name
 */
export function isCircuitOpen(name) {
  const c = circuits[name];
  if (!c) return false;
  return Date.now() < c.openUntil;
}

/**
 * @param {CircuitName} name
 */
export function recordSuccess(name) {
  const c = circuits[name];
  if (!c) return;
  c.failures = 0;
  c.openUntil = 0;
}

/**
 * @param {CircuitName} name
 */
export function recordFailure(name) {
  const c = circuits[name];
  if (!c) return;
  c.failures += 1;
  if (c.failures >= THRESHOLD) {
    c.openUntil = Date.now() + OPEN_MS;
  }
}

/**
 * @template T
 * @param {CircuitName} name
 * @param {() => Promise<T>} fn
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
export async function withCircuit(name, fn, timeoutMs = 10000) {
  if (isCircuitOpen(name)) {
    const err = new Error(`circuit_open:${name}`);
    err.name = 'CircuitOpenError';
    throw err;
  }

  try {
    const result = await Promise.race([
      fn(),
      new Promise((_, reject) => {
        setTimeout(() => reject(Object.assign(new Error(`timeout:${name}`), { name: 'TimeoutError' })), timeoutMs);
      }),
    ]);
    recordSuccess(name);
    return /** @type {T} */ (result);
  } catch (error) {
    recordFailure(name);
    throw error;
  }
}

export const TECHNICAL_FALLBACK_MESSAGE =
  'Sistemul întâmpină o scurtă problemă tehnică momentan. Revenim noi în cel mai scurt timp!';
