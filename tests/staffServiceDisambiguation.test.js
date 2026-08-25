import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractLikelyEmployeeName,
  resolveStaffMentionFromText,
} from '../src/db/employeeService.js';
import { isIntervalFreeInBusyBlocks } from '../src/services/googleCalendarService.js';

const services = [
  { id: 's1', name: 'Tuns Clasic' },
  { id: 's2', name: 'Tuns + Barba' },
];

const employees = [
  { id: 'e1', name: 'Mihai', google_calendar_id: 'm@x.com', active: true, sort_order: 0 },
];

describe('staff vs service disambiguation', () => {
  it('„vreau un tuns la Andrei” → unknown person Andrei, not a service', () => {
    const staff = resolveStaffMentionFromText('vreau un tuns la Andrei', employees, services);
    assert.equal(staff.employee_id, null);
    assert.equal(staff.employee_name, 'Andrei');
  });

  it('full sentence with pentru tuns still extracts Andrei', () => {
    const staff = resolveStaffMentionFromText(
      'Vreau sa fac o programare la Andrei pentru tuns',
      employees,
      services,
    );
    assert.equal(staff.employee_id, null);
    assert.equal(staff.employee_name, 'Andrei');
  });

  it('„tuns cu Andrei” extracts Andrei', () => {
    const staff = resolveStaffMentionFromText(
      'vreau sa fac o programare la tuns cu Andrei',
      employees,
      services,
    );
    assert.equal(staff.employee_name, 'Andrei');
    assert.equal(staff.employee_id, null);
  });

  it('„vreau o programare la tuns” → no fake employee named Tuns', () => {
    assert.equal(extractLikelyEmployeeName('vreau o programare la tuns', { services }), null);
    const staff = resolveStaffMentionFromText('vreau o programare la tuns', employees, services);
    assert.equal(staff.employee_id, null);
    assert.equal(staff.employee_name, null);
  });

  it('„vreau la Mihai” matches catalog employee', () => {
    const staff = resolveStaffMentionFromText('vreau la Mihai un tuns', employees, services);
    assert.equal(staff.employee_id, 'e1');
    assert.equal(staff.employee_name, 'Mihai');
  });

  it('extractLikelyEmployeeName ignores day/month after la', () => {
    assert.equal(extractLikelyEmployeeName('programare la miercuri', { services }), null);
    assert.equal(extractLikelyEmployeeName('tuns la septembrie', { services }), null);
  });
});

describe('FreeBusy filters occupied template slots', () => {
  it('drops a slot that overlaps a busy block', () => {
    const start = new Date('2026-09-02T07:00:00.000Z');
    const end = new Date('2026-09-02T07:45:00.000Z');
    const busy = [{ start: '2026-09-02T07:00:00.000Z', end: '2026-09-02T08:00:00.000Z' }];
    assert.equal(isIntervalFreeInBusyBlocks(start, end, busy), false);
  });

  it('keeps a free slot', () => {
    const start = new Date('2026-09-02T09:00:00.000Z');
    const end = new Date('2026-09-02T09:45:00.000Z');
    const busy = [{ start: '2026-09-02T07:00:00.000Z', end: '2026-09-02T08:00:00.000Z' }];
    assert.equal(isIntervalFreeInBusyBlocks(start, end, busy), true);
  });
});
