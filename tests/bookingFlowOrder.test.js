import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hydrateExtract,
  isFreshMenuStart,
  isCleanSlateBooking,
} from '../src/services/turnExecute.js';
import { CONVERSATION_STEPS } from '../src/db/conversationStateService.js';
import { resolveDeterministicInbound } from '../src/services/turnExtract.js';
import { BOOKING_WAIT } from '../src/services/bookingWaitState.js';
import { bm } from '../src/utils/bookingI18n.js';

/**
 * Definitive booking order: Service → Specialist → Date → Time → Confirm.
 */
describe('booking flow order — Service → Specialist → Date → Time → Confirm', () => {
  it('1. employee menu: Oricine disponibil is first option', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/services/turnExecute.js', import.meta.url),
      'utf8',
    );
    const menuStart = src.indexOf('function employeeMenu(');
    const menuBlock = src.slice(menuStart, menuStart + 400);
    const anyIdx = menuBlock.indexOf('PREFIX.ANY_EMPLOYEE');
    const empMapIdx = menuBlock.indexOf('employees.slice');
    assert.ok(anyIdx > 0 && empMapIdx > anyIdx, 'ANY_EMPLOYEE must be first');
    assert.match(menuBlock, /anyAvailable/);
  });

  it('2. after service, ensureEmployee runs before any day grid (source guard)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/services/turnExecute.js', import.meta.url),
      'utf8',
    );
    const bookStart = src.indexOf('async function executeBook(');
    const bookEnd = src.indexOf('async function executeConfirm(', bookStart);
    const book = src.slice(bookStart, bookEnd);
    const ensureIdx = book.indexOf('ensureEmployeeForBooking');
    const askDateIdx = book.indexOf('askDateGridResult');
    const missingSlotsIdx = book.indexOf('missingSlotsResult');
    assert.ok(ensureIdx > 0, 'executeBook must gate specialist');
    assert.ok(askDateIdx > ensureIdx, 'Specialist before Date');
    assert.ok(missingSlotsIdx > ensureIdx, 'Specialist before Time');
  });

  it('3. runBookingMachine gates specialist before askDateGridResult', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/services/turnExecute.js', import.meta.url),
      'utf8',
    );
    const fnStart = src.indexOf('async function runBookingMachine(');
    const fnEnd = src.indexOf('async function executeTurn(', fnStart);
    const fnBlock = src.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 12000);
    const ensureIdx = fnBlock.indexOf('ensureEmployeeForBooking');
    const dateGridIdx = fnBlock.indexOf('askDateGridResult');
    assert.ok(ensureIdx > 0 && dateGridIdx > ensureIdx);
  });

  it('4. askEmployeeChoiceResult clears premature pending_date (Specialist → Date)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/services/turnExecute.js', import.meta.url),
      'utf8',
    );
    const fnStart = src.indexOf('async function askEmployeeChoiceResult(');
    const fnBlock = src.slice(fnStart, fnStart + 2200);
    assert.match(fnBlock, /pending_date_text: null/);
    assert.match(fnBlock, /date: null/);
    assert.doesNotMatch(fnBlock, /pendingDateText/);
    assert.doesNotMatch(fnBlock, /keptDate/);
  });

  it('5. executeBook does not revive pending day after specialist (no Day→Specialist patch)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/services/turnExecute.js', import.meta.url),
      'utf8',
    );
    const bookStart = src.indexOf('async function executeBook(');
    const bookEnd = src.indexOf('async function executeConfirm(', bookStart);
    const book = src.slice(bookStart, bookEnd);
    assert.doesNotMatch(book, /Revive day chosen before Specialist/);
    assert.doesNotMatch(book, /resolvePendingDateText\(convState/);
  });

  it('6. select_employee does NOT restore premature pending day → next step is Date', () => {
    const extract = {
      action: 'select_employee',
      employee_id: 'e-mihai',
      employee_name: 'Mihai',
      date_text: null,
      time_text: null,
      source: 'menu',
      confidence: 'high',
    };
    const convState = {
      current_step: CONVERSATION_STEPS.CHOOSING_EMPLOYEE,
      context_data: {
        pending_date_text: '2026-08-26',
        pending_service_id: 'svc-tuns',
        draft_booking: { service_id: 'svc-tuns', date: '2026-08-26', time: null },
      },
    };
    const hydrated = hydrateExtract(extract, convState, 'Europe/Bucharest');
    assert.equal(hydrated.employee_id, 'e-mihai');
    assert.equal(hydrated.date_text, null, 'must not revive day — show FreeBusy days next');
    assert.equal(hydrated.service_id, 'svc-tuns');
  });

  it('7. select_employee from IDLE with stale pending day still drops the day', () => {
    const hydrated = hydrateExtract(
      {
        action: 'select_employee',
        employee_id: 'e-mihai',
        source: 'menu',
        date_text: null,
      },
      {
        current_step: CONVERSATION_STEPS.IDLE,
        context_data: { pending_date_text: '2026-08-26', pending_service_id: 'svc-tuns' },
      },
      'Europe/Bucharest',
    );
    assert.equal(hydrated.date_text, null);
    assert.equal(hydrated.service_id, 'svc-tuns');
  });

  it('8. isFreshMenuStart does not wipe select_employee (keeps service path)', () => {
    const extract = {
      action: 'select_employee',
      employee_id: 'e-mihai',
      source: 'menu',
      date_text: null,
      service_id: null,
    };
    assert.equal(isFreshMenuStart(extract), false);
    assert.equal(isCleanSlateBooking(extract), false);
  });

  it('9. while CHOOSING_EMPLOYEE, date free-text is blocked (reprompt specialist)', () => {
    const out = resolveDeterministicInbound({
      textBody: 'mâine',
      lastMenu: {
        kind: 'employee',
        options: [
          { id: 'emp_any', title: 'Oricine disponibil' },
          { id: 'emp_e1', title: 'Mihai' },
        ],
      },
      wait: BOOKING_WAIT.EMPLOYEE,
      timezone: 'Europe/Bucharest',
      business: {
        id: '00000000-0000-4000-8000-000000000088',
        timezone: 'Europe/Bucharest',
        booking_settings: { services: [{ id: 'svc-tuns', name: 'Tuns Clasic' }] },
      },
    });
    assert.equal(out?.action, 'reprompt_employee');
  });

  it('10. day grid + FreeBusy aggregation helpers exist for after-specialist step', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/services/turnExecute.js', import.meta.url),
      'utf8',
    );
    assert.match(src, /anyEmployee/);
    assert.match(src, /bookableEmployees/);
    assert.match(src, /queryFreeBusyBatch/);
    assert.match(src, /listBookableDayWindows/);
    assert.match(src, /missingSlotsResult/);
    assert.match(src, /holdRequestedSlot/);
  });

  it('11. sequence markers: Specialist → Date → Time → hold/confirm (source)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/services/turnExecute.js', import.meta.url),
      'utf8',
    );
    const askEmp = src.indexOf('async function askEmployeeChoiceResult(');
    const askDate = src.indexOf('async function askDateGridResult(');
    const askTime = src.indexOf('async function missingSlotsResult(');
    const hold = src.indexOf('async function holdRequestedSlot(');
    const confirm = src.indexOf('async function executeConfirm(');
    assert.ok(askEmp > 0 && askDate > askEmp, 'Specialist before Date helpers');
    assert.ok(askTime > askDate, 'Date before Time helpers');
    assert.ok(hold > askTime && confirm > hold, 'Time → hold → confirm');
  });

  it('12. empty slots for specialist use explicit copy, not silent blank day ask', () => {
    const msg = bm('employeeNoSlotsOnDay', 'ro', {
      staff: 'Mihai',
      date: 'Astăzi',
      service: 'Tuns Clasic',
    });
    assert.match(msg, /Mihai/);
    assert.doesNotMatch(msg, /^Alege ziua/i);
  });
});
