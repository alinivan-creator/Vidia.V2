/**
 * One-shot: wipe WhatsApp conversation memory + cancel in-flight drafts
 * so production tests start on a clean slate.
 *
 * Usage: node scripts/reset-sessions.js
 */
import { supabase } from '../src/config/supabase.js';

async function main() {
  const now = new Date().toISOString();

  const { data: states, error: stateErr } = await supabase
    .from('conversation_states')
    .update({
      current_step: 'IDLE',
      context_data: {},
      updated_at: now,
    })
    .gte('created_at', '1970-01-01T00:00:00.000Z')
    .select('id, client_phone, business_id');

  if (stateErr) {
    console.error('conversation_states reset failed', stateErr);
    process.exit(1);
  }

  const { data: drafts, error: draftErr } = await supabase
    .from('draft_bookings')
    .update({
      state: 'cancelled',
      locked_until: null,
      pending_expires_at: null,
      cancelled_at: now,
      google_event_id: null,
      google_event_link: null,
      conversation_context: { step: 'cancelled_admin_session_reset' },
    })
    .in('state', ['browsing', 'pending_confirmation'])
    .select('id, phone_number, business_id, google_event_id');

  if (draftErr) {
    // pending_expires_at may be missing on older schemas
    const { data: drafts2, error: draftErr2 } = await supabase
      .from('draft_bookings')
      .update({
        state: 'cancelled',
        locked_until: null,
        cancelled_at: now,
        google_event_id: null,
        google_event_link: null,
        conversation_context: { step: 'cancelled_admin_session_reset' },
      })
      .in('state', ['browsing', 'pending_confirmation'])
      .select('id, phone_number, business_id');

    if (draftErr2) {
      console.error('draft_bookings cancel failed', draftErr, draftErr2);
      process.exit(1);
    }
    console.log(`Cancelled active drafts: ${(drafts2 || []).length}`);
  } else {
    console.log(`Cancelled active drafts: ${(drafts || []).length}`);
  }

  // Synthetic HOLD rows in calendar_cache (vidia_hold_*)
  const { data: holds, error: holdErr } = await supabase
    .from('calendar_cache')
    .delete()
    .like('google_event_id', 'vidia_hold_%')
    .select('id');

  if (holdErr) {
    console.warn('calendar_cache hold clear skipped/failed', holdErr.message || holdErr);
  } else {
    console.log(`Cleared cache HOLDs: ${(holds || []).length}`);
  }

  console.log(`Reset conversation sessions: ${(states || []).length}`);
  console.log('Done — next WhatsApp message starts a fresh session.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
