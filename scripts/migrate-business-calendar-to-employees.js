/**
 * One-shot: move businesses.google_calendar_id → employees (prefer Mihai).
 * Usage: node scripts/migrate-business-calendar-to-employees.js
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

const { data: businesses, error } = await supabase
  .from('businesses')
  .select('id, name, slug, google_calendar_id');

if (error) {
  console.error(error);
  process.exit(1);
}

let migrated = 0;
for (const biz of businesses || []) {
  const cal = typeof biz.google_calendar_id === 'string' ? biz.google_calendar_id.trim() : '';
  if (!cal) {
    console.log(`skip ${biz.slug || biz.id}: no business calendar`);
    continue;
  }

  const { data: employees, error: empErr } = await supabase
    .from('employees')
    .select('id, name, google_calendar_id, active, sort_order')
    .eq('business_id', biz.id)
    .order('sort_order', { ascending: true });

  if (empErr) {
    console.error(biz.slug, empErr);
    continue;
  }

  const list = employees || [];
  let targetId = null;
  let action = '';

  if (!list.length) {
    const { data: created, error: insErr } = await supabase
      .from('employees')
      .insert({
        business_id: biz.id,
        name: 'Mihai',
        google_calendar_id: cal,
        active: true,
        sort_order: 0,
        metadata: {},
      })
      .select('id')
      .single();
    if (insErr) {
      console.error('create Mihai failed', biz.slug, insErr);
      continue;
    }
    targetId = created.id;
    action = 'created Mihai';
  } else {
    const mihai = list.find((e) => String(e.name || '').trim().toLowerCase() === 'mihai');
    const without = list.find((e) => !e.google_calendar_id);
    const target = mihai || (list.length === 1 ? list[0] : without) || list[0];
    targetId = target.id;
    if (!target.google_calendar_id) {
      const { error: updErr } = await supabase
        .from('employees')
        .update({ google_calendar_id: cal })
        .eq('id', target.id)
        .eq('business_id', biz.id);
      if (updErr) {
        console.error('update employee failed', biz.slug, updErr);
        continue;
      }
      action = `set calendar on ${target.name}`;
    } else {
      action = `kept ${target.name} calendar (${target.google_calendar_id}); cleared business`;
    }
  }

  const { error: clearErr } = await supabase
    .from('businesses')
    .update({ google_calendar_id: null })
    .eq('id', biz.id);

  if (clearErr) {
    console.error('clear business calendar failed', biz.slug, clearErr);
    continue;
  }

  migrated += 1;
  console.log(`OK ${biz.slug || biz.name}: ${action} → employee ${targetId}; business calendar cleared (${cal})`);
}

console.log(`Done. Migrated ${migrated} business(es).`);
