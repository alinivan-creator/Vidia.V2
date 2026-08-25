import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractLikelyEmployeeName,
  resolveStaffMentionFromText,
} from '../src/db/employeeService.js';

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
