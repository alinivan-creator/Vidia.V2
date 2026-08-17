/**
 * VIDIA booking architecture — live WhatsApp path (Twilio).
 *
 * Flow (SSOT):
 *   POST /webhook/whatsapp
 *     → tenant by Twilio To → businesses.whatsapp_phone_number_id (Supabase)
 *     → ProfileName → clients.display_name (if empty)
 *     → sweepStalePendingForPhone / resetExpiredSessionForRestart
 *     → routeInboundTurn → turnPipeline
 *          1. turnExtract  (keyword + LLM JSON Mode parser with tenant RAG)
 *          2. turnExecute  (validate slots from calendar_cache + Admin hours)
 *          3. turnPresent  (templates only — never invent availability)
 *
 * Background:
 *   GET/POST /cron/expire-pending every minute (vercel.json)
 *     → expire pending_confirmation past Admin pending_ttl_minutes (default 5)
 *
 * Date/time UX:
 *   Hybrid: Twilio list-picker / quick-reply + free-text NLP (Intent Classifier).
 *   Parser system prompt injects per-tenant SSOT (services, hours, employees, Admin facts).
 *   Invented services rejected → „Din păcate nu oferim…”. Availability only from backend.
 *   Unclear input → friendly guidance (menu or example phrase). No „Data de 0”.
 *   After successful booking: hardReset session (no leftover pending/turns).
 *
 * Confirm UX:
 *   Confirmation + Adaugă în calendar URL button; no duplicate Maps markdown line.
 *   Name is never asked when Twilio ProfileName / display_name exists.
 */
export const BOOKING_ARCHITECTURE_VERSION = 'hybrid-nlp-ssot-v5';
