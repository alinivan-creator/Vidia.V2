import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatWindowGrid,
  buildQuickReplyPage,
  listOpenDayWindows,
  listTimeWindows,
  GRID_PREFIX,
} from '../src/utils/bookingGrid.js';
import { resolveInteractiveChoice } from '../src/services/whatsappService.js';

describe('booking grid windows', () => {
  it('formats a multi-column window grid', () => {
    const text = formatWindowGrid(
      [{ title: 'Lun 24' }, { title: 'Mar 25' }, { title: 'Mie 26' }, { title: 'Joi 27' }],
      { caption: 'Atinge o fereastră.' },
    );
    assert.match(text, /┌────────┐/);
    assert.match(text, /Lun 24| 24/);
    assert.match(text, /Atinge o fereastră/);
  });

  it('renders a month calendar board with open-day markers', async () => {
    const { formatMonthCalendarBoard } = await import('../src/utils/bookingGrid.js');
    const board = formatMonthCalendarBoard(
      [
        { dateKey: '2026-08-17' },
        { dateKey: '2026-08-18' },
        { dateKey: '2026-08-24' },
      ],
      'Europe/Bucharest',
      new Date('2026-08-17T05:52:00.000Z'),
    );
    assert.match(board, /August 2026/i);
    assert.match(board, /▢/);
    assert.match(board, /Lu/);
  });

  it('pages quick-replies with Alte › when more than 3 windows', () => {
    const all = [
      { id: 'day_1', title: 'Lun 1' },
      { id: 'day_2', title: 'Mar 2' },
      { id: 'day_3', title: 'Mie 3' },
      { id: 'day_4', title: 'Joi 4' },
    ];
    const page0 = buildQuickReplyPage(all, 0);
    assert.equal(page0.actions.length, 3);
    assert.equal(page0.actions[2].id, GRID_PREFIX.NEXT);
    assert.ok(page0.actions.every((a) => a.title.length <= 20));

    const page1 = buildQuickReplyPage(all, 1);
    assert.ok(page1.actions.some((a) => a.id === 'day_4' || a.id === 'day_3'));
  });

  it('lists only open Admin days', () => {
    const business = {
      timezone: 'Europe/Bucharest',
      booking_settings: {
        booking_horizon_days: 10,
        slot_interval_minutes: 30,
        business_hours: {
          1: { open: '09:00', close: '18:00' },
          2: { open: '09:00', close: '18:00' },
          3: { open: '09:00', close: '18:00' },
          4: { open: '09:00', close: '18:00' },
          5: { open: '09:00', close: '18:00' },
          0: null,
          6: null,
        },
      },
    };
    // Monday 17 Aug 2026
    const days = listOpenDayWindows(business, { now: new Date('2026-08-17T05:52:00.000Z'), limit: 7 });
    assert.ok(days.length >= 5);
    assert.ok(days.every((d) => d.id.startsWith('day_')));
    assert.ok(!days.some((d) => d.title.startsWith('Sâm') || d.title.startsWith('Dum')));
  });

  it('maps free slots to time windows only', () => {
    const times = listTimeWindows(
      [
        { id: 'slot_20260824_0900', start: new Date('2026-08-24T06:00:00.000Z') },
        { id: 'slot_20260824_0930', start: new Date('2026-08-24T06:30:00.000Z') },
      ],
      'Europe/Bucharest',
    );
    assert.equal(times.length, 2);
    assert.equal(times[0].title, '09:00');
  });

  it('resolves ButtonPayload over typed body', () => {
    const options = [
      { id: 'day_2026-08-24', title: 'Lun 24' },
      { id: 'grid_next', title: 'Alte ›' },
    ];
    assert.equal(resolveInteractiveChoice('Lun 24', 'day_2026-08-24', options), 'day_2026-08-24');
    assert.equal(resolveInteractiveChoice('Lun 24', null, options), 'day_2026-08-24');
  });
});
