-- =============================================================================
-- VIDIA V2 — Messaging / GDPR settings
-- Stored in booking_settings JSON (no new columns required):
--   confirmation_message, terms_url, gdpr_url
-- welcome_message already exists on businesses.
-- This migration is a documentation marker for operators.
-- =============================================================================

COMMENT ON COLUMN public.businesses.welcome_message IS
  'WhatsApp first-touch welcome; AI disclosure is prepended by the bot when missing.';

COMMENT ON COLUMN public.businesses.booking_settings IS
  'JSON settings including services, hours, contact, ai_facts, confirmation_message, terms_url, gdpr_url.';
