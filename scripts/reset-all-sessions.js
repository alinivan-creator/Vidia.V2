/**
 * Force-close all WhatsApp conversation sessions + cancel in-flight drafts.
 * Usage: node scripts/reset-all-sessions.js
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });
const now = new Date().toISOString();

const { data: businesses, error: bizErr } = await supabase
  .from('businesses')
  .select('id, slug, name');
if (bizErr) {
  console.error(bizErr);
  process.exit(1);
}

let convReset = 0;
let draftsCancelled = 0;
let holdsCleared = 0;

for (const biz of businesses || []) {
  const { data: convs, error: cErr } = await supabase
    .from('conversation_states')
    .select('id, client_phone, current_step')
    .eq('business_id', biz.id);
  if (cErr) {
    console.error(biz.slug, 'conversation_states', cErr.message);
    continue;
  }

  for (const row of convs || []) {
    const { error } = await supabase
      .from('conversation_states')
      .update({
        current_step: 'idle',
        context_data: {
          last_menu: null,
          draft_booking: null,
          draft_id: null,
          pending_offer: null,
          colleague_fallback: null,
          booking_wait: null,
          forced_reset_at: now,
          forced_reset_reason: 'manual_reset_all_sessions',
        },
        updated_at: now,
      })
      .eq('id', row.id)
      .eq('business_id', biz.id);
    if (!error) {
      convReset += 1;
      console.log(`  conv reset ${biz.slug} ${row.client_phone} (${row.current_step} → idle)`);
    } else {
      console.error('  conv fail', row.id, error.message);
    }
  }

  const { data: drafts, error: dErr } = await supabase
    .from('draft_bookings')
    .select('id, state, phone_number, google_event_id')
    .eq('business_id', biz.id)
    .in('state', ['browsing', 'pending_confirmation']);
  if (dErr) {
    console.error(biz.slug, 'drafts', dErr.message);
    continue;
  }

  for (const draft of drafts || []) {
    const { error } = await supabase
      .from('draft_bookings')
      .update({
        state: 'cancelled',
        locked_until: null,
        selected_slot_start: null,
        selected_slot_end: null,
        conversation_context: {
          step: 'forced_session_reset',
          reset_at: now,
        },
      })
      .eq('id', draft.id)
      .eq('business_id', biz.id);
    if (!error) {
      draftsCancelled += 1;
      console.log(`  draft cancelled ${biz.slug} ${draft.phone_number} ${draft.state} → cancelled`);
    }
  }

  // Clear synthetic + soft-lock cache rows for this business (pending holds).
  const { data: holdRows } = await supabase
    .from('calendar_cache')
    .select('id, google_event_id')
    .eq('business_id', biz.id)
    .or('google_event_id.like.vidia_hold_%,title.ilike.%HOLD%');

  if (holdRows?.length) {
    const ids = holdRows.map((r) => r.id);
    const { error: delErr } = await supabase.from('calendar_cache').delete().in('id', ids);
    if (!delErr) {
      holdsCleared += ids.length;
      console.log(`  cleared ${ids.length} hold cache rows for ${biz.slug}`);
    }
  }
}

console.log(JSON.stringify({
  ok: true,
  businesses: (businesses || []).length,
  conversations_reset: convReset,
  drafts_cancelled: draftsCancelled,
  hold_cache_cleared: holdsCleared,
}, null, 2));
