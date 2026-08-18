import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDayListLabel,
  formatDayGridMessage,
  formatTimeGridMessage,
  formatWindowGrid,
  formatMonthCalendarBoard,
  buildListPickerPage,
  buildQuickReplyPage,
  listOpenDayWindows,
  listTimeWindows,
  GRID_PREFIX,
  LIST_PAGE_SIZE,
} from '../src/utils/bookingGrid.js';
import { resolveInteractiveChoice } from '../src/services/whatsappService.js';

describe('booking grid list picker', () => {
  it('formats day labels like "Luni, 17 Aug"', () => {
    assert.equal(formatDayListLabel('2026-08-17', 'Europe/Bucharest'), 'Luni, 17 Aug');
    assert.equal(formatDayListLabel('2026-08-18', 'Europe/Bucharest'), 'Marți, 18 Aug');
  });

  it('uses clean day/time body copy without ASCII art', () => {
    const dayMsg = formatDayGridMessage([], 'Europe/Bucharest', 'Tuns');
    assert.match(dayMsg, /Alege ziua/);
    assert.match(dayMsg, /Zile disponibile|14 zile/);
    assert.doesNotMatch(dayMsg, /[┌└│▢·]/);

    const timeMsg = formatTimeGridMessage(
      [{ title: '09:00', time: '09:00' }, { title: '10:00', time: '10:00' }],
      '2026-08-17',
      'Europe/Bucharest',
      'Tuns',
    );
    assert.match(timeMsg, /Alege ora/);
    assert.doesNotMatch(timeMsg, /[┌└│▢·]/);

    assert.equal(formatWindowGrid(), '');
    assert.equal(formatMonthCalendarBoard(), '');
  });

  it('pages list-picker with max 10 rows and Alte / Înapoi', () => {
    const all = Array.from({ length: 12 }, (_, i) => ({
      id: `day_${i + 1}`,
      title: `Zi ${i + 1}`,
      description: 'Disponibil',
    }));
    const page0 = buildListPickerPage(all, 0);
    assert.ok(page0.items.length <= LIST_PAGE_SIZE);
    assert.equal(page0.items.at(-1)?.id, GRID_PREFIX.NEXT);
    assert.ok(page0.items.every((a) => a.title.length <= 24));

    const page1 = buildListPickerPage(all, 1);
    assert.ok(page1.items.some((a) => a.id === GRID_PREFIX.PREV));
    assert.ok(page1.items.some((a) => a.id.startsWith('day_')));
  });

  it('pages quick-replies with Alte › when more than 3 windows', () => {
    const all = [
      { id: 'day_1', title: 'Lun 1' },
      { id: 'day_2', title: 'Mar 2' },
      { id: 'day_3', title: 'Mie 3' },
      { id: 'day_4', title: 'Joi 4' },
    ];
    const page0 = buildQuickReplyPage(all, 0);
    assert.ok(page0.actions.length <= 3);
    assert.equal(page0.actions.at(-1)?.id, GRID_PREFIX.NEXT);
    assert.ok(page0.actions.every((a) => a.title.length <= 20));

    const page1 = buildQuickReplyPage(all, 1);
    assert.ok(page1.actions.some((a) => a.id === GRID_PREFIX.PREV || a.id.startsWith('day_')));
  });

  it('lists open Admin days across a 14-day horizon with list labels', () => {
    const business = {
      timezone: 'Europe/Bucharest',
      booking_settings: {
        booking_horizon_days: 7, // legacy Admin value — picker still spans 14 calendar days
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
    const days = listOpenDayWindows(business, { now: new Date('2026-08-17T05:52:00.000Z'), limit: 14 });
    assert.ok(days.length >= 10, `expected ≥10 weekday opens in 14 days, got ${days.length}`);
    assert.ok(days.every((d) => d.id.startsWith('day_')));
    assert.ok(days[0].title.includes('Luni') || days[0].title.includes('Aug'));
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

  it('resolves ButtonPayload / ListId over typed body', () => {
    const options = [
      { id: 'day_2026-08-24', title: 'Luni, 24 Aug' },
      { id: 'grid_next', title: 'Alte opțiuni ›' },
    ];
    assert.equal(resolveInteractiveChoice('Luni, 24 Aug', 'day_2026-08-24', options), 'day_2026-08-24');
    assert.equal(resolveInteractiveChoice('Luni, 24 Aug', null, options), 'day_2026-08-24');
    assert.equal(resolveInteractiveChoice('09:00', 'slot_old_from_history', options), null);
  });
});
