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
 *   Default: Twilio list-picker for days ("Luni, 17 Aug") over 14 days with free slots;
 *   fully booked days omitted. Times: all free slots for the day (list or ≤3 quick-replies).
 *   Free-text NLP still works during date/time wait (e.g. "mâine la 10").
 *   Optional: WhatsApp Flows when booking_settings.whatsapp_flow_id is set.
 *   Occupied slots omitted from menus.
 *
 * Confirm UX:
 *   Confirmation + Adaugă în calendar URL button; no duplicate Maps markdown line.
 *   Name is never asked when Twilio ProfileName / display_name exists.
 */
export const BOOKING_ARCHITECTURE_VERSION = 'list-picker-v4';
