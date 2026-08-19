/**
 * VIDIA booking architecture — Dual-AI + backend SSOT (Twilio WhatsApp).
 *
 * Flow:
 *   POST /webhook/whatsapp
 *     → tenant by Twilio To → businesses.whatsapp_phone_number_id (Supabase strict isolation)
 *     → ProfileName → clients.display_name (if empty)
 *     → sweepStalePendingForPhone (hold TTL) + conversation session TTL check
 *     → if session idle > session_ttl_minutes: silently purge active draft and reset to IDLE,
 *       then process inbound message on a clean slate
 *     → classifyInboundMessage: free-text Body always wins over a stray ButtonPayload;
 *       only a real option id (ButtonPayload / ListId) that matches the tap title counts
 *       as interactive — typed sentences go straight to NLU
 *     → routeInboundTurn → turnPipeline
 *          1. Dialogue Agent — turnExtract (free-text intents FIRST; Gemini JSON; taps secondary)
 *          2. Execution Agent — State Machine Engine (turnExecute + stateMachine.js):
 *             - Atomic context pivots: date/time/service updates in-place without flow drop
 *             - Out-of-bounds handling: polite recovery keeping active date/service
 *             - Rescheduling integrity: Target Booking → New Date → New Slot → Confirmation
 *             - Atomic DB mutations: reschedule UPDATEs the same row; cancel marks cancelled
 *               before any WhatsApp success copy (no ghost duplicate bookings)
 *          3. turnPresent — templates from Execution JSON; Gemini soft-polish for
 *             confirm / reschedule / cancel / chat (facts unchanged)
 *
 * Cold-start:
 *   First inbound text is parsed for NEW_BOOKING / RESCHEDULE / CANCEL / FAQ immediately.
 *   No greeting gate — "vreau să fac o programare" / "vreau să reprogramez" run without "Salut".
 *   Stale button walls never intercept free-text mid-flow.
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
 *   Day-parts („mâine seara”) are clipped to that date's Admin hours, then filter slots;
 *   an empty window widens to the whole day with a notice instead of a dead end.
 *   Context Pivots: changing date or service in-flight updates draft and presents matching slots.
 *   After successful booking: hardReset session.
 *
 * Confirm UX:
 *   Confirmation + Adaugă în calendar URL button.
 *   Name is never asked when Twilio ProfileName / display_name exists.
 */
export const BOOKING_ARCHITECTURE_VERSION = 'dual-ai-text-first-nlu-v11';
