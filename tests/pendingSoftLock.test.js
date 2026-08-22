import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { softLockAppliesToEmployee } from '../src/db/cacheService.js';

describe('pending soft-locks block availability', () => {
  it('any-staff grid includes every pending hold (with or without employee_id)', () => {
    assert.equal(softLockAppliesToEmployee(null, null), true);
    assert.equal(softLockAppliesToEmployee('emp-1', null), true);
  });

  it('staff-scoped grid includes that employee and unassigned holds only', () => {
    assert.equal(softLockAppliesToEmployee(null, 'emp-1'), true);
    assert.equal(softLockAppliesToEmployee('emp-1', 'emp-1'), true);
    assert.equal(softLockAppliesToEmployee('emp-2', 'emp-1'), false);
  });
});
