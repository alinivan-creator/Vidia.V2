import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractLikelyEmployeeName,
  resolveStaffMentionFromText,
} from '../src/db/employeeService.js';
import { finalizeGroundedExtract } from '../src/services/turnExtract.js';
import { bm } from '../src/utils/bookingI18n.js';
import { DEFAULT_SYSTEM_PROMPT } from '../src/config/defaultSystemPrompt.js';
import { resolveAcceptedOffer } from '../src/services/pendingOfferService.js';
import { CONVERSATION_STEPS } from '../src/db/conversationStateService.js';
import { addCalendarDays, formatDateKey } from '../src/utils/datetime.js';

const services = [
  { id: 's1', name: 'Tuns Clasic' },
  { id: 's2', name: 'Tuns + Barba' },
];

describe('entity grounding (prompt validation)', () => {
  it('1. unknown Andrei with 1 staff → extract name without id (execute must wait)', () => {
    const staff = resolveStaffMentionFromText('Vreau la Andrei', [
      { id: 'e1', name: 'Mihai', google_calendar_id: 'm@x.com', active: true, sort_order: 0 },
    ], services);
    assert.equal(staff.employee_id, null);
    assert.equal(staff.employee_name, 'Andrei');
    const msg = bm('errEmployeeNotFound', 'ro', {
      name: 'Andrei',
      staffOffer: bm('errEmployeeOfferOne', 'ro', { staff: 'Mihai' }),
    });
    assert.match(msg, /Andrei/);
    assert.match(msg, /Mihai/);
    assert.doesNotMatch(msg, /nu am găsit|nu există|invalid/i);
  });

  it('2. unknown Andrei with 3 staff → list copy without auto-pick', () => {
    const employees = [
      { id: '1', name: 'Mihai' },
      { id: '2', name: 'Ioana' },
      { id: '3', name: 'Radu' },
    ];
    const staff = resolveStaffMentionFromText('Vreau la Andrei', employees, services);
    assert.equal(staff.employee_id, null);
    const msg = bm('errEmployeeNotFound', 'ro', {
      name: 'Andrei',
      staffOffer: bm('errEmployeeOfferMany', 'ro'),
    });
    assert.match(msg, /colegilor|listă/i);
    const resolved = resolveAcceptedOffer({
      convState: { current_step: CONVERSATION_STEPS.CHOOSING_EMPLOYEE, context_data: {} },
      employees,
    });
    assert.equal(resolved, null);
  });

  it('3. unknown service → finalizeGroundedExtract marks unknown_service', () => {
    const extract = finalizeGroundedExtract({
      action: 'book',
      service_id: null,
      service_name: null,
      unknown_service_name: 'highlights',
      employee_id: null,
      employee_name: null,
    });
    assert.equal(extract.action, 'unknown_service');
    assert.equal(extract.unknown_service_name, 'highlights');
  });

  it('4. outside-hours copy is warm (no system jargon)', () => {
    const msg = bm('errTimeOutsideHours', 'ro', {
      when: 'Mâine la 23:00',
      open: '09:00',
      close: '18:00',
    });
    assert.match(msg, /afara programului|09:00/);
    assert.doesNotMatch(msg, /invalid|nu am găsit/i);
  });

  it('5. date beyond horizon helper', () => {
    const today = formatDateKey(new Date(), 'Europe/Bucharest');
    const horizonDays = 7;
    const maxKey = addCalendarDays(today, horizonDays);
    const far = addCalendarDays(today, 90);
    assert.equal(far > maxKey, true);
    const msg = bm('errDateBeyondHorizon', 'ro', { days: '7' });
    assert.match(msg, /7/);
  });

  it('6. control — known Mihai + known service tokens', () => {
    const employees = [
      { id: 'e1', name: 'Mihai', google_calendar_id: 'm@x.com', active: true, sort_order: 0 },
    ];
    const staff = resolveStaffMentionFromText('vreau tuns la Mihai', employees, services);
    assert.equal(staff.employee_id, 'e1');
    assert.equal(extractLikelyEmployeeName('vreau o programare la tuns', { services }), null);
  });

  it('system prompt includes warm receptionist personality', () => {
    assert.match(DEFAULT_SYSTEM_PROMPT, /recepționer|cald/i);
    assert.match(DEFAULT_SYSTEM_PROMPT, /agresiv/i);
  });

  it('7. executeTurnBody refuses unknown staff BEFORE booking machine (Darius rupture)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/services/turnExecute.js', import.meta.url),
      'utf8',
    );
    const fnStart = src.indexOf('async function executeTurnBody(params)');
    assert.ok(fnStart > 0, 'executeTurnBody exists');
    const body = src.slice(fnStart, fnStart + 2500);
    const refuseCall = body.indexOf('await refuseUnknownEmployeeGrounding(');
    const machineCall = body.indexOf('await runBookingMachine(');
    assert.ok(refuseCall > 0, 'must await refuseUnknownEmployeeGrounding');
    assert.ok(machineCall > refuseCall, 'employee grounding must run before runBookingMachine');
  });

  it('8. book + Darius (no service) → MISSING_EMPLOYEE, not MISSING_SERVICE', async () => {
    const { executeTurn } = await import('../src/services/turnExecute.js');
    const result = await executeTurn({
      business: {
        id: 'biz-darius-grounding',
        name: 'Barber Test',
        timezone: 'Europe/Bucharest',
        booking_settings: {
          services: [
            { id: 'svc-tuns', name: 'Tuns Clasic', duration_minutes: 30, price_ron: 50 },
          ],
        },
      },
      recipientPhone: '+40700000111',
      extract: {
        action: 'book',
        employee_name: 'Darius',
        employee_id: null,
        service_id: null,
        confidence: 'high',
        source: 'nlu',
      },
      convState: {
        current_step: 'IDLE',
        context_data: { session_language: 'ro' },
      },
      textBody: 'Salut, vreau sa fac si eu o programare la Darius',
      requestId: 'test-darius-before-machine',
    });
    assert.equal(result.user_message_template_key, 'MISSING_EMPLOYEE');
    assert.notEqual(result.user_message_template_key, 'MISSING_SERVICE');
    assert.match(result.data?.client_message || '', /Darius/i);
  });
});
