import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

/**
 * Supabase client using the service role key.
 * Bypasses RLS — use exclusively in backend services.
 * @type {import('@supabase/supabase-js').SupabaseClient}
 */
export const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
