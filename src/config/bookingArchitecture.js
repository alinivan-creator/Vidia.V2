/**
 * VIDIA booking architecture — Dual-AI + backend SSOT (Twilio WhatsApp).
 *
 * Flow:
 *   POST /webhook/whatsapp
 *     → tenant by Twilio To → businesses.whatsapp_phone_number_id (Supabase)
 *     → ProfileName → clients.display_name (if empty)
 *     → sweepStalePendingForPhone (hold TTL) + conversation session TTL check
 *     → if session idle > session_ttl_minutes: greeting + hardReset, then process inbound
 *     → routeInboundTurn → turnPipeline
 *          1. Dialogue Agent — turnExtract (keywords first; Gemini JSON parse, OpenAI fallback)
 *          2. Execution Agent — turnExecute (catalog / hours / calendar_cache). No LLM.
 *          3. turnPresent — templates from Execution JSON only (optional Gemini polish)
 *
 * TTLs (independent):
 *   pending_ttl_minutes (default 5) — calendar hold for pending_confirmation only
 *   session_ttl_minutes (default 10) — idle booking/modify conversation; last client inbound
 *
 * Background:
 *   GET/POST /cron/expire-pending every minute (vercel.json)
 *     → expire pending_confirmation past Admin pending_ttl_minutes
 *
 * Date/time UX:
 *   Hybrid: Twilio list-picker / quick-reply + free-text NLP.
 *   Invented services rejected. Availability only from backend. No „Data de 0”.
 *   After successful booking: hardReset session.
 *
 * Confirm UX:
 *   Confirmation + Adaugă în calendar URL button.
 *   Name is never asked when Twilio ProfileName / display_name exists.
 */
export const BOOKING_ARCHITECTURE_VERSION = 'dual-ai-session-ttl-v6';
