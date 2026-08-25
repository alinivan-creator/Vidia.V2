import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  employeeOffersService,
  normalizeServiceIds,
} from '../src/db/employeeService.js';
import {
  freeBusyCacheKey,
  getCachedFreeBusy,
  setCachedFreeBusy,
  invalidateFreeBusyCacheForBusiness,
  clearFreeBusyCache,
} from '../src/services/freeBusyCache.js';
import {
  encodeStaffSlotChoiceId,
  decodeStaffSlotChoiceId,
  formatColleagueFallbackMessage,
} from '../src/services/colleagueFallbackService.js';
import { isIntervalFreeInBusyBlocks } from '../src/services/googleCalendarService.js';
import { BOOKING_PREFIXES } from '../src/services/flowIds.js';

describe('employee service association', () => {
  it('empty service_ids means all services', () => {
    assert.equal(employeeOffersService({ service_ids: [] }, 'svc-tuns'), true);
    assert.equal(employeeOffersService({ service_ids: undefined }, 'svc-tuns'), true);
  });

  it('filters by configured service_ids', () => {
    const emp = { service_ids: ['svc-tuns'] };
    assert.equal(employeeOffersService(emp, 'svc-tuns'), true);
    assert.equal(employeeOffersService(emp, 'svc-barba'), false);
  });

  it('normalizeServiceIds drops empties', () => {
    assert.deepEqual(normalizeServiceIds(['a', '', null, 'b']), ['a', 'b']);
  });
});

describe('FreeBusy cache', () => {
  it('stores and invalidates per business', () => {
    clearFreeBusyCache();
    const key = freeBusyCacheKey('biz-1', 't0', 't1', ['cal-a', 'cal-b']);
    setCachedFreeBusy(key, { ok: true, calendars: { 'cal-a': { busy: [] } } });
    assert.ok(getCachedFreeBusy(key));
    invalidateFreeBusyCacheForBusiness('biz-1');
    assert.equal(getCachedFreeBusy(key), null);
  });
});

describe('colleague fallback UX', () => {
  const preferred = { id: '11111111-1111-4111-8111-111111111111', name: 'Andrei' };
  const colleague = { id: '22222222-2222-4222-8222-222222222222', name: 'Maria' };
  const requested = new Date('2026-08-26T12:00:00.000Z'); // 15:00 Bucharest summer
  const alt1 = new Date('2026-08-26T13:00:00.000Z');
  const alt2 = new Date('2026-08-26T14:00:00.000Z');

  it('encodes and decodes staffslot choice ids', () => {
    const id = encodeStaffSlotChoiceId(preferred.id, requested, 'Europe/Bucharest');
    assert.ok(id.startsWith(BOOKING_PREFIXES.STAFF_SLOT));
    const decoded = decodeStaffSlotChoiceId(id);
    assert.equal(decoded?.employeeId, preferred.id);
    assert.ok(decoded?.slotId.startsWith('slot_'));
  });

  it('includes colleague option when available', () => {
    const { text, options } = formatColleagueFallbackMessage({
      preferred,
      preferredAlts: [alt1, alt2],
      colleague,
      requestedStart: requested,
      timezone: 'Europe/Bucharest',
      lang: 'ro',
    });
    assert.ok(text.includes('Andrei'));
    assert.ok(text.includes('Maria'));
    assert.equal(options.length, 3);
    assert.equal(options[0].kind, 'preferred_alt');
    assert.equal(options[2].kind, 'colleague_exact');
    assert.equal(options[2].employee_name, 'Maria');
  });

  it('single-employee guard: no colleague section when list empty', () => {
    const { text, options } = formatColleagueFallbackMessage({
      preferred,
      preferredAlts: [alt1],
      colleague: null,
      requestedStart: requested,
      timezone: 'Europe/Bucharest',
      lang: 'ro',
    });
    assert.ok(text.includes('Andrei'));
    assert.doesNotMatch(text, /Alternativ/);
    assert.equal(options.length, 1);
    assert.equal(options[0].kind, 'preferred_alt');
  });
});

describe('FreeBusy busy interval math', () => {
  it('detects overlap and free gaps', () => {
    const start = new Date('2026-08-26T12:00:00.000Z');
    const end = new Date('2026-08-26T12:30:00.000Z');
    assert.equal(
      isIntervalFreeInBusyBlocks(start, end, [
        { start: '2026-08-26T11:00:00.000Z', end: '2026-08-26T11:30:00.000Z' },
      ]),
      true,
    );
    assert.equal(
      isIntervalFreeInBusyBlocks(start, end, [
        { start: '2026-08-26T12:00:00.000Z', end: '2026-08-26T13:00:00.000Z' },
      ]),
      false,
    );
  });
});
