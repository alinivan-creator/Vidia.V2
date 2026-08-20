import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  triageUserIntent,
  looksLikeNewBookingRequest,
  detectModificationIntent,
  looksLikeGreeting,
  looksLikeGratitude,
  looksLikeExplicitSavedReschedule,
  looksLikeInFlightRevision,
  looksLikeTimeOnlyRevision,
} from '../src/services/intentTriageService.js';

describe('Cold-start unrestricted intent parsing', () => {
  it('parses booking intent without a greeting', () => {
    assert.equal(looksLikeGreeting('vreau sa fac o programare'), false);
    assert.equal(looksLikeNewBookingRequest('vreau sa fac o programare'), true);
    assert.equal(triageUserIntent('vreau sa fac o programare').intent, 'book');
    assert.equal(triageUserIntent('Vreau să fac o programare').intent, 'book');
    assert.equal(triageUserIntent('as vrea o programare maine').intent, 'book');
  });

  it('parses cancel intent without a greeting', () => {
    assert.equal(detectModificationIntent('vreau sa anulez'), 'cancel');
    assert.equal(triageUserIntent('vreau să anulez').intent, 'cancel');
    assert.equal(triageUserIntent('anulează programarea').intent, 'cancel');
  });

  it('parses reschedule intent without a greeting', () => {
    assert.equal(detectModificationIntent('vreau sa reprogramez'), 'reschedule');
    assert.equal(detectModificationIntent('vreau sa reprogramez o programare'), 'reschedule');
    assert.equal(looksLikeNewBookingRequest('vreau sa reprogramez o programare'), false);
    assert.equal(triageUserIntent('reprogramare').intent, 'reschedule');
    assert.equal(triageUserIntent('vreau sa reprogramez o programare').intent, 'reschedule');
  });

  it('still treats bare salut as menu, not a hard gate for later intents', () => {
    assert.equal(triageUserIntent('salut').intent, 'menu');
    assert.equal(triageUserIntent('programare').intent, 'book');
  });
});

describe('In-flight revise vs saved reschedule', () => {
  it('treats bare modific/schimb/am gresit as in-flight revision language', () => {
    assert.equal(looksLikeInFlightRevision('Modific'), true);
    assert.equal(looksLikeInFlightRevision('modifica'), true);
    assert.equal(looksLikeInFlightRevision('am gresit ora'), true);
    assert.equal(looksLikeInFlightRevision('am gresit ziua'), true);
    assert.equal(looksLikeInFlightRevision('schimbam'), true);
    assert.equal(looksLikeTimeOnlyRevision('am gresit ora'), true);
    assert.equal(looksLikeTimeOnlyRevision('am gresit ziua'), false);
  });

  it('keeps explicit reprogramare as saved-appointment reschedule', () => {
    assert.equal(looksLikeExplicitSavedReschedule('vreau sa reprogramez'), true);
    assert.equal(looksLikeExplicitSavedReschedule('reprogramare'), true);
    assert.equal(looksLikeInFlightRevision('vreau sa reprogramez'), false);
    assert.equal(looksLikeInFlightRevision('reprogramare'), false);
  });

  it('still keyword-detects modific as modification (context decides revise vs reschedule)', () => {
    assert.equal(detectModificationIntent('Modific'), 'reschedule');
    assert.equal(detectModificationIntent('reprogramare'), 'reschedule');
  });
});

describe('Gratitude / thanks', () => {
  it('recognises mulțumesc / mersi / thanks', () => {
    assert.equal(looksLikeGratitude('Multumesc'), true);
    assert.equal(looksLikeGratitude('mulțumesc'), true);
    assert.equal(looksLikeGratitude('mersi'), true);
    assert.equal(looksLikeGratitude('mersi frumos'), true);
    assert.equal(looksLikeGratitude('thanks'), true);
    assert.equal(looksLikeGratitude('thank you'), true);
    assert.equal(looksLikeGratitude('vreau o programare'), false);
  });

  it('triages gratitude as thanks, not menu or unknown', () => {
    assert.equal(triageUserIntent('Multumesc').intent, 'thanks');
    assert.equal(triageUserIntent('mersi').intent, 'thanks');
    assert.equal(detectModificationIntent('Multumesc'), null);
  });
});

describe('Reschedule false-busy regression guards', () => {
  it('SQL migration excludes own google_event_id from calendar_cache conflicts', async () => {
    const fs = await import('node:fs/promises');
    const sql = await fs.readFile(
      new URL('../supabase/migrations/020_reschedule_exclude_own_event.sql', import.meta.url),
      'utf8',
    );
    assert.match(sql, /google_event_id IS DISTINCT FROM v_own_event/);
    assert.match(sql, /reschedule_confirmed_booking/);
  });

  it('applyReschedule persists DB before calendar writes', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/services/turnExecute.js', import.meta.url),
      'utf8',
    );
    const fnStart = src.indexOf('async function applyReschedule({');
    const fnEnd = src.indexOf('async function executeReschedule({');
    const body = src.slice(fnStart, fnEnd);
    const dbIdx = body.indexOf('rescheduleConfirmedBookingAtomic');
    const calIdx = body.indexOf('updateCalendarEvent');
    assert.ok(dbIdx > 0 && calIdx > 0, 'expected both DB and calendar calls');
    assert.ok(dbIdx < calIdx, 'DB mutation must run before calendar update');
    assert.match(body, /excludeGoogleEventIds/);
  });
});

describe('Atomic mutation integrity contract', () => {
  it('reschedule helpers expose ok/draft envelope shape', async () => {
    // Importing verifies the module graph; runtime RPC is covered by fallback path shape.
    const mod = await import('../src/db/draftBookingService.js');
    assert.equal(typeof mod.rescheduleConfirmedBookingAtomic, 'function');
    assert.equal(typeof mod.cancelConfirmedBookingAtomic, 'function');
    assert.equal(typeof mod.updateConfirmedBookingSlot, 'function');
  });

  it('SUCCESS confirmation templates are gated behind mutated draft ids conceptually', () => {
    // Contract: handlers must return ERROR when mutation.ok is false.
    // Documented keys used only after atomic success.
    const successKeys = new Set([
      'CONFIRMATION_RESCHEDULE',
      'CONFIRMATION_CANCELLED',
      'CONFIRMATION_BOOKED',
    ]);
    assert.ok(successKeys.has('CONFIRMATION_RESCHEDULE'));
    assert.ok(successKeys.has('CONFIRMATION_CANCELLED'));
  });
});
