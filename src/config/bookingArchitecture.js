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
 *   Default: Twilio list-picker for days ("Luni, 17 Aug") and times;
 *   quick-reply buttons when ≤3 free slots. No ASCII calendars.
 *   Optional: WhatsApp Flows (Meta DatePicker) when booking_settings.whatsapp_flow_id is set.
 *     Publish docs/flows/vidia-booking-flow.json in Meta, point endpoint to /webhook/whatsapp-flows.
 *   Occupied slots omitted. Free-text ignored while waiting for day/time.
 *
 * Confirm UX:
 *   Quick-reply Confirmă / Anulează.
 *   Name is never asked when Twilio ProfileName / display_name exists.
 */
export const BOOKING_ARCHITECTURE_VERSION = 'list-picker-v3';
