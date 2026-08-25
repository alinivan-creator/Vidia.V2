import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveEmployeeCalendarId } from '../src/db/employeeService.js';
import { formatColleagueFallbackMessage } from '../src/services/colleagueFallbackService.js';
import { bm } from '../src/utils/bookingI18n.js';

describe('multi-employee calendar gating', () => {
  it('missing calendar is not a FreeBusy miss — resolveEmployeeCalendarId is null', () => {
    const business = { id: 'b1' };
    const mihai = { id: 'e1', name: 'Mihai', google_calendar_id: 'mihai@cal.com' };
    const test = { id: 'e2', name: 'Test', google_calendar_id: null };
    assert.equal(resolveEmployeeCalendarId(business, mihai), 'mihai@cal.com');
    assert.equal(resolveEmployeeCalendarId(business, test), null);
  });

  it('bookable pool keeps only staff with calendars (spec: ask who when ≥2 bookable)', () => {
    const business = { id: 'b1' };
    const staff = [
      { id: 'e1', name: 'Mihai', google_calendar_id: 'mihai@cal.com', active: true },
      { id: 'e2', name: 'Test', google_calendar_id: null, active: true },
    ];
    const bookable = staff.filter((e) => Boolean(resolveEmployeeCalendarId(business, e)));
    assert.equal(bookable.length, 1);
    assert.equal(bookable[0].name, 'Mihai');
    // With only one bookable calendar, product may auto-assign — no empty „la cine?” list.
    // When Test gets a calendar too, both are bookable → ask who.
    const both = [
      ...bookable,
      { id: 'e2', name: 'Test', google_calendar_id: 'test@cal.com', active: true },
    ].filter((e) => Boolean(resolveEmployeeCalendarId(business, e)));
    assert.equal(both.length, 2);
  });

  it('askEmployeeWho copy is explicit (not silent assign)', () => {
    const msg = bm('askEmployeeWho', 'ro', { service: 'Tuns Clasic' });
    assert.match(msg, /La cine|Tuns Clasic/i);
  });

  it('preferred without calendar offers colleague explicitly (never silent)', () => {
    const msg = bm('errEmployeeCalendarMissingOffer', 'ro', {
      name: 'Test',
      staff: 'Mihai',
    });
    assert.match(msg, /Test/);
    assert.match(msg, /Mihai/);
    assert.match(msg, /calendar|agenda/i);
  });

  it('colleague fallback when preferred busy is explicit to the client', () => {
    const preferred = { id: 'e1', name: 'Test' };
    const colleague = { id: 'e2', name: 'Mihai' };
    const start = new Date('2026-09-02T12:00:00.000Z');
    const formatted = formatColleagueFallbackMessage({
      preferred,
      preferredAlts: [],
      colleague,
      requestedStart: start,
      timezone: 'Europe/Bucharest',
      lang: 'ro',
    });
    assert.ok(formatted.text);
    assert.match(formatted.text, /Test/);
    assert.match(formatted.text, /nu are loc/i);
    assert.match(formatted.text, /Mihai/);
    assert.equal(formatted.options.some((o) => o.kind === 'colleague_exact'), true);
  });

  it('executeBook asks employee when multiple bookable (source guard)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/services/turnExecute.js', import.meta.url),
      'utf8',
    );
    assert.match(src, /listBookableEmployeesForService/);
    assert.match(src, /askEmployeeChoiceResult/);
    assert.match(src, /refusePreferredWithoutCalendar/);
    const askIdx = src.indexOf('if (bookable.length > 1)');
    const askCall = src.indexOf('askEmployeeChoiceResult', askIdx);
    assert.ok(askIdx > 0 && askCall > askIdx);
  });
});
