import { supabase } from '../config/supabase.js';

/** @typedef {'ok' | 'error'} ConnectionStatus */

/**
 * @typedef {Object} TestConnectionResult
 * @property {ConnectionStatus} status
 * @property {string} message
 * @property {boolean} seeded
 * @property {Record<string, unknown> | null} testBusiness
 * @property {string | null} error
 */

/** @type {import('./businessService.js').MenuButton[]} */
const TEST_MENU_BUTTONS = [
  { id: 'book', label: '📅 Programare', action: 'start_booking' },
  { id: 'info', label: 'ℹ️ Detalii & Prețuri', action: 'show_info' },
  { id: 'contact', label: '📞 Contact & Locație', action: 'show_contact' },
];

/** Seed row — inserted when the test business is missing. */
export const TEST_BUSINESS_SEED = {
  name: 'Salon Test Vidia',
  slug: 'salon-test-vidia',
  business_type: 'booking',
  status: 'active',
  welcome_message: 'Bun venit la Salon Test Vidia! Cu ce te putem ajuta?',
  menu_buttons: TEST_MENU_BUTTONS,
  whatsapp_phone_number_id: '123456789',
  whatsapp_access_token: 'TEST_TOKEN_REPLACE_IN_DB',
  timezone: 'Europe/Bucharest',
  ai_system_prompt:
    'Ești consultantul frizeriei. Răspunde clar despre servicii, prețuri (LEI) și durate. Încurajează programarea pe WhatsApp.',
  google_calendar_mock_mode: true,
  booking_settings: {
    slot_interval_minutes: 30,
    booking_horizon_days: 7,
    business_hours: {
      '0': null,
      '1': { open: '09:00', close: '18:00' },
      '2': { open: '09:00', close: '18:00' },
      '3': { open: '09:00', close: '18:00' },
      '4': { open: '09:00', close: '18:00' },
      '5': { open: '09:00', close: '18:00' },
      '6': { open: '10:00', close: '14:00' },
    },
    contact: {
      phone: '+40 721 000 000',
      email: 'contact@salon-test-vidia.ro',
      address: 'Str. Exemplu nr. 1, București',
      hours: 'Luni–Vineri 09:00–18:00, Sâmbătă 10:00–14:00',
      maps_url: 'https://maps.google.com',
    },
    services: [
      { id: 'tuns-clasic', name: 'Tuns Clasic', price_ron: 50, duration_minutes: 30 },
      { id: 'tuns-barba', name: 'Tuns + Barba', price_ron: 80, duration_minutes: 45 },
      { id: 'aranjat-barba', name: 'Aranjat Barba', price_ron: 30, duration_minutes: 20 },
    ],
  },
};

const TEST_BUSINESS_COLUMNS =
  'id, name, slug, business_type, status, whatsapp_phone_number_id, created_at';

/**
 * Prints the startup connection report to console.
 * @param {TestConnectionResult} result
 */
export function printConnectionReport(result) {
  if (result.status === 'ok') {
    console.log('🟢 Conexiune Supabase reușită! Afacerea de test este prezentă.');
    if (result.testBusiness) {
      console.log(
        `   → ${result.testBusiness.name} | tip: ${result.testBusiness.business_type} | phone_number_id: ${result.testBusiness.whatsapp_phone_number_id}`,
      );
    }
    if (result.seeded) {
      console.log('   → Afacerea de test a fost inserată acum (seed).');
    }
    return;
  }

  console.error('🔴 Eroare conexiune Supabase:', result.message);
  if (result.error) {
    console.error(`   → ${result.error}`);
  }
}

/**
 * Reads `businesses`, ensures the test row exists, returns structured result.
 * @returns {Promise<TestConnectionResult>}
 */
export async function testSupabaseConnection() {
  try {
    const { data: testBusiness, error: readError } = await supabase
      .from('businesses')
      .select(TEST_BUSINESS_COLUMNS)
      .eq('whatsapp_phone_number_id', TEST_BUSINESS_SEED.whatsapp_phone_number_id)
      .maybeSingle();

    if (readError) {
      return {
        status: 'error',
        message: 'Nu s-a putut citi din tabela businesses',
        seeded: false,
        testBusiness: null,
        error: readError.message,
      };
    }

    if (testBusiness) {
      // Keep catalog in sync for local/dev test tenant (ignore if migration 002 not applied yet)
      const { error: syncError } = await supabase
        .from('businesses')
        .update({
          booking_settings: TEST_BUSINESS_SEED.booking_settings,
          ai_system_prompt: TEST_BUSINESS_SEED.ai_system_prompt,
        })
        .eq('id', testBusiness.id);

      if (syncError) {
        console.warn('[test:db] Nu am putut sincroniza serviciile JSON:', syncError.message);
      }

      // Best-effort: dedicated services table (migration 003)
      try {
        const { replaceServicesForBusiness } = await import('./serviceCatalog.js');
        await replaceServicesForBusiness(
          testBusiness.id,
          TEST_BUSINESS_SEED.booking_settings.services,
        );
      } catch (e) {
        console.warn('[test:db] services table sync skipped');
      }

      // Best-effort mock flag (requires migration 002/003)
      await supabase
        .from('businesses')
        .update({ google_calendar_mock_mode: true })
        .eq('id', testBusiness.id);

      return {
        status: 'ok',
        message: 'Conexiune Supabase reușită! Afacerea de test este prezentă.',
        seeded: false,
        testBusiness,
        error: null,
      };
    }

    const { data: inserted, error: insertError } = await supabase
      .from('businesses')
      .insert(TEST_BUSINESS_SEED)
      .select(TEST_BUSINESS_COLUMNS)
      .single();

    if (insertError) {
      return {
        status: 'error',
        message: 'Conexiunea a eșuat la inserția afacerii de test',
        seeded: false,
        testBusiness: null,
        error: insertError.message,
      };
    }

    return {
      status: 'ok',
      message: 'Conexiune Supabase reușită! Afacerea de test este prezentă.',
      seeded: true,
      testBusiness: inserted,
      error: null,
    };
  } catch (unexpected) {
    const message = unexpected instanceof Error ? unexpected.message : String(unexpected);
    return {
      status: 'error',
      message: 'Eroare neașteptată la testul de conexiune',
      seeded: false,
      testBusiness: null,
      error: message,
    };
  }
}

/**
 * Runs the test and prints the report. Used at startup and via CLI.
 * @returns {Promise<TestConnectionResult>}
 */
export async function runConnectionTest() {
  const result = await testSupabaseConnection();
  printConnectionReport(result);
  return result;
}

// Standalone: npm run test:db
const isDirectRun = process.argv[1]?.endsWith('testConnection.js');
if (isDirectRun) {
  runConnectionTest().then((result) => {
    process.exit(result.status === 'ok' ? 0 : 1);
  });
}
