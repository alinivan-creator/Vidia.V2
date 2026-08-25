/**
 * Short-TTL in-memory FreeBusy cache (per tenant + day window).
 * Invalidated immediately after successful calendar insert/patch.
 */

/** @type {Map<string, { expiresAt: number, payload: unknown }>} */
const STORE = new Map();

/** Spec: 2–5 minutes. */
export const FREEBUSY_CACHE_TTL_MS = 3 * 60_000;

/**
 * @param {string} businessId
 * @param {string} timeMinIso
 * @param {string} timeMaxIso
 * @param {string[]} calendarIds
 */
export function freeBusyCacheKey(businessId, timeMinIso, timeMaxIso, calendarIds) {
  const ids = [...calendarIds].map(String).sort().join(',');
  return `${businessId}|${timeMinIso}|${timeMaxIso}|${ids}`;
}

/**
 * @param {string} key
 * @returns {unknown | null}
 */
export function getCachedFreeBusy(key) {
  const row = STORE.get(key);
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    STORE.delete(key);
    return null;
  }
  return row.payload;
}

/**
 * @param {string} key
 * @param {unknown} payload
 * @param {number} [ttlMs]
 */
export function setCachedFreeBusy(key, payload, ttlMs = FREEBUSY_CACHE_TTL_MS) {
  STORE.set(key, { expiresAt: Date.now() + ttlMs, payload });
}

/**
 * Drop all FreeBusy entries for a tenant (after insert/patch on any staff calendar).
 * @param {string} businessId
 */
export function invalidateFreeBusyCacheForBusiness(businessId) {
  const prefix = `${businessId}|`;
  for (const key of STORE.keys()) {
    if (key.startsWith(prefix)) STORE.delete(key);
  }
}

/** @internal test helper */
export function clearFreeBusyCache() {
  STORE.clear();
}
