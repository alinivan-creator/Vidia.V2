import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  employeeOffersService,
  extractLikelyEmployeeName,
  resolveEmployeeCalendarId,
} from '../src/db/employeeService.js';

describe('spec v2 multi-employee gaps', () => {
  it('extractLikelyEmployeeName parses „vreau la Andrei”', () => {
    assert.equal(extractLikelyEmployeeName('vreau la Andrei'), 'Andrei');
    assert.equal(extractLikelyEmployeeName('cu Maria maine'), 'Maria');
    assert.equal(extractLikelyEmployeeName('vreau tuns maine'), null);
  });

  it('resolveEmployeeCalendarId does not fall back when disabled', () => {
    const business = { google_calendar_id: 'biz@cal.com' };
    const emp = { id: '1', name: 'Mihai', google_calendar_id: null };
    assert.equal(resolveEmployeeCalendarId(business, emp), 'biz@cal.com');
    assert.equal(resolveEmployeeCalendarId(business, emp, { allowBusinessFallback: false }), null);
  });

  it('empty service_ids still means all services; explicit list filters', () => {
    assert.equal(employeeOffersService({ service_ids: [] }, 'svc-x'), true);
    assert.equal(employeeOffersService({ service_ids: ['svc-a'] }, 'svc-x'), false);
    assert.equal(employeeOffersService({ service_ids: ['svc-a'] }, 'svc-a'), true);
  });

  it('saving rule: all services checked → empty array semantics', () => {
    const catalog = ['a', 'b', 'c'];
    const checked = ['a', 'b', 'c'];
    const allOn = catalog.length > 0 && checked.length === catalog.length;
    const service_ids = allOn ? [] : checked;
    assert.deepEqual(service_ids, []);
    assert.equal(employeeOffersService({ service_ids }, 'a'), true);
  });
});
