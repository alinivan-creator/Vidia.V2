import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  pendingHoldCacheEventId,
  softLockAppliesToEmployee,
} from '../src/db/cacheService.js';

describe('pendingHoldCacheEventId', () => {
  it('builds a stable synthetic google_event_id per draft', () => {
    assert.equal(pendingHoldCacheEventId('abc-123'), 'vidia_hold_abc-123');
    assert.equal(pendingHoldCacheEventId('  xyz  '), 'vidia_hold_xyz');
  });
});

describe('softLockAppliesToEmployee (wall-clock pending)', () => {
  it('any-staff query sees every pending hold', () => {
    assert.equal(softLockAppliesToEmployee(null, null), true);
    assert.equal(softLockAppliesToEmployee('emp-1', null), true);
    assert.equal(softLockAppliesToEmployee('emp-2', null), true);
  });

  it('staff-scoped query sees that staff plus unassigned holds', () => {
    assert.equal(softLockAppliesToEmployee(null, 'emp-1'), true);
    assert.equal(softLockAppliesToEmployee('emp-1', 'emp-1'), true);
    assert.equal(softLockAppliesToEmployee('emp-2', 'emp-1'), false);
  });
});

describe('pending hold flow contract', () => {
  it('documents the required state transitions for a time selection', () => {
    // Time pick → claim → pending_confirmation + calendar_cache hold
    // Confirm → Google event + confirmed + hold cleared
    // Cancel / TTL → expired/cancelled + hold cleared
    const requiredStates = [
      'browsing',
      'pending_confirmation',
      'confirmed',
      'cancelled',
      'expired',
    ];
    assert.ok(requiredStates.includes('pending_confirmation'));
    assert.equal(pendingHoldCacheEventId('d1').startsWith('vidia_hold_'), true);
  });
});
