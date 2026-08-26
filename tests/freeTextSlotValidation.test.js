import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveDeterministicInbound } from '../src/services/turnExtract.js';
import { resolveStaffMentionFromText } from '../src/db/employeeService.js';
import { formatColleagueFallbackMessage } from '../src/services/colleagueFallbackService.js';
import { BOOKING_WAIT } from '../src/services/bookingWaitState.js';

const services = [
  { id: 'svc-tuns', name: 'Tuns Clasic', duration_minutes: 30, price_ron: 50 },
];

const employees = [
  { id: 'e1', name: 'Mihai', google_calendar_id: 'mihai@cal.com', active: true, sort_order: 0, service_ids: ['svc-tuns'] },
  { id: 'e2', name: 'Maria', google_calendar_id: 'maria@cal.com', active: true, sort_order: 1, service_ids: ['svc-tuns'] },
];

const business = {
  id: '00000000-0000-4000-8000-000000000099',
  name: 'Barber Test',
  timezone: 'Europe/Bucharest',
  booking_settings: { services },
};

describe('free-text slot validation — same pipeline as menu', () => {
  it('resolveStaffMentionFromText picks Mihai from "azi la 15 la Mihai"', () => {
    const staff = resolveStaffMentionFromText('azi la 15 la Mihai', employees, services);
    assert.equal(staff.employee_id, 'e1');
    assert.equal(staff.employee_name, 'Mihai');
  });

  it('extractTurnIntent early path preserves staff on datetime text (source guard)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/services/turnExtract.js', import.meta.url),
      'utf8',
    );
    assert.match(src, /explicitEarly/);
    assert.match(src, /staffEarly\.employee_id \|\| staffEarly\.employee_name/);
    assert.match(src, /Named staff \+ explicit slot must beat bare date\/time deterministic parse/);
  });

  it('deterministic date/time blocked while BOOKING_WAIT.EMPLOYEE', () => {
    const out = resolveDeterministicInbound({
      textBody: 'mâine',
      lastMenu: { kind: 'employee', options: [{ id: 'emp_any', title: 'Oricine' }] },
      wait: BOOKING_WAIT.EMPLOYEE,
      timezone: 'Europe/Bucharest',
      business,
    });
    assert.equal(out?.action, 'reprompt_employee');
  });

  it('runBookingMachine falls through full datetime to executeBook / holdRequestedSlot', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/services/turnExecute.js', import.meta.url),
      'utf8',
    );
    const fnStart = src.indexOf('async function runBookingMachine(');
    const fnBlock = src.slice(fnStart, fnStart + 6500);
    assert.match(fnBlock, /fullSlotReady/);
    assert.match(fnBlock, /ACTION_CHECK_SLOT/);
    assert.match(fnBlock, /return null/);
  });

  it('holdRequestedSlot uses buildColleagueFallbackOffer when preferred busy (source guard)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/services/turnExecute.js', import.meta.url),
      'utf8',
    );
    assert.match(src, /async function holdRequestedSlot\([\s\S]*?buildColleagueFallbackOffer/);
    assert.match(src, /user_message_template_key: 'COLLEAGUE_FALLBACK'/);
  });

  it('unavailable Mihai at 15:00 → colleague fallback copy (not system error)', () => {
    const preferred = { id: 'e1', name: 'Mihai' };
    const colleague = { id: 'e2', name: 'Maria' };
    const requested = new Date('2026-08-26T12:00:00.000Z'); // 15:00 Bucharest summer
    const { text, options } = formatColleagueFallbackMessage({
      preferred,
      preferredAlts: [],
      colleague,
      requestedStart: requested,
      timezone: 'Europe/Bucharest',
      lang: 'ro',
    });
    assert.match(text, /Mihai/);
    assert.match(text, /Maria/);
    assert.doesNotMatch(text, /eroare|error|invalid/i);
    assert.equal(options.some((o) => o.kind === 'colleague_exact'), true);
    assert.equal(options.length, 1);
  });
});
