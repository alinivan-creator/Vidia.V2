/**
 * Maintenance: force PostgREST schema cache reload + re-probe critical tables.
 *
 *   npm run schema:refresh
 *
 * Uses SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env (never prints secrets).
 * If the RPC is missing, apply supabase/migrations/013_refresh_schema_cache.sql first.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Lipsa SUPABASE_URL sau SUPABASE_SERVICE_ROLE_KEY în .env');
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TABLES = ['businesses', 'services', 'employees', 'appointments', 'draft_bookings'];

async function probe(name) {
  const { error } = await supabase.from(name).select('*').limit(1);
  if (!error) return { name, status: 'OK' };
  const missing = /PGRST205|42P01|does not exist|schema cache/i.test(error.message ?? '')
    || error.code === 'PGRST205'
    || error.code === '42P01';
  return { name, status: missing ? 'MISSING' : 'ERROR', detail: (error.message || '').slice(0, 160) };
}

async function main() {
  console.log('[schema:refresh] Calling refresh_postgrest_schema()…');
  const { data, error } = await supabase.rpc('refresh_postgrest_schema');
  if (error) {
    console.error('[schema:refresh] RPC failed:', error.message);
    console.error('  → Rulează supabase/migrations/013_refresh_schema_cache.sql în SQL Editor, apoi reîncearcă.');
    console.error("  → Alternativ: NOTIFY pgrst, 'reload schema';");
  } else {
    console.log('[schema:refresh] RPC:', data ?? 'ok');
  }

  // Give PostgREST a moment to reload
  await new Promise((r) => setTimeout(r, 800));

  console.log('[schema:refresh] Probing tables:');
  let failed = 0;
  for (const table of TABLES) {
    const row = await probe(table);
    if (row.status !== 'OK') failed += 1;
    console.log(`  ${row.name.padEnd(18)} ${row.status}${row.detail ? `  (${row.detail})` : ''}`);
  }

  process.exit(failed ? 2 : 0);
}

main().catch((error) => {
  console.error('[schema:refresh] Unexpected:', error instanceof Error ? error.message : error);
  process.exit(1);
});
