import { safeQuery } from './safeQuery.js';
import { isTableAvailable } from './schemaHealth.js';

/**
 * @typedef {Object} BusinessFaq
 * @property {string} id
 * @property {string} business_id
 * @property {string} question
 * @property {string} answer
 * @property {number} sort_order
 */

const COLUMNS = 'id, business_id, question, answer, sort_order, created_at, updated_at';

/**
 * Tenant-scoped FAQ rows. Always filtered by business_id.
 * @param {string} businessId
 * @returns {Promise<BusinessFaq[]>}
 */
export async function listFaqsForBusiness(businessId) {
  if (!businessId) return [];
  const { data } = await safeQuery(
    'business_faqs',
    (from) =>
      from
        .select(COLUMNS)
        .eq('business_id', businessId)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true }),
    { fallback: [], businessId, op: 'listFaqsForBusiness', critical: true },
  );
  return /** @type {BusinessFaq[]} */ (data ?? []);
}

/**
 * @param {Object} input
 * @returns {Promise<{ faq: BusinessFaq | null; error: string | null }>}
 */
export async function upsertFaqAdmin(input) {
  if (!(await isTableAvailable('business_faqs'))) {
    return {
      faq: null,
      error: 'Eroare: Tabelă lipsă — public.business_faqs. Rulează 018_business_faqs.sql în SQL Editor.',
    };
  }

  const businessId = String(input.business_id ?? '').trim();
  const question = String(input.question ?? '').trim();
  const answer = String(input.answer ?? '').trim();
  if (!businessId || !question || !answer) {
    return { faq: null, error: 'Întrebarea și răspunsul sunt obligatorii' };
  }

  const payload = {
    business_id: businessId,
    question: question.slice(0, 240),
    answer: answer.slice(0, 2000),
    sort_order: Number(input.sort_order ?? 0) || 0,
  };

  if (input.id) {
    const { data, error } = await safeQuery(
      'business_faqs',
      (from) =>
        from
          .update(payload)
          .eq('id', input.id)
          .eq('business_id', businessId)
          .select(COLUMNS)
          .single(),
      { fallback: null, businessId, op: 'upsertFaqAdmin:update' },
    );
    if (error) return { faq: null, error: error.message || 'Actualizare eșuată' };
    return { faq: /** @type {BusinessFaq} */ (data), error: null };
  }

  const { data, error } = await safeQuery(
    'business_faqs',
    (from) => from.insert(payload).select(COLUMNS).single(),
    { fallback: null, businessId, op: 'upsertFaqAdmin:insert' },
  );
  if (error) return { faq: null, error: error.message || 'Inserare eșuată' };
  return { faq: /** @type {BusinessFaq} */ (data), error: null };
}

/**
 * @param {string} businessId
 * @param {string} faqId
 */
export async function deleteFaqAdmin(businessId, faqId) {
  if (!(await isTableAvailable('business_faqs'))) {
    return { ok: false, error: 'Eroare: Tabelă lipsă — public.business_faqs' };
  }
  if (!businessId || !faqId) return { ok: false, error: 'ID lipsă' };
  const { error } = await safeQuery(
    'business_faqs',
    (from) => from.delete().eq('id', faqId).eq('business_id', businessId),
    { fallback: null, businessId, op: 'deleteFaqAdmin' },
  );
  if (error) return { ok: false, error: error.message || 'Ștergere eșuată' };
  return { ok: true, error: null };
}
