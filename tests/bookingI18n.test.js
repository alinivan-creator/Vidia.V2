import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderHandlerResult } from '../src/services/turnPresent.js';
import { formatServiceAskMessage } from '../src/utils/serviceMatch.js';
import { buildEnglishTransparencyWelcome } from '../src/utils/businessMessages.js';
import { formatDayGridMessage, buildListPickerPage } from '../src/utils/bookingGrid.js';
import { bookingUi, localizeMenuOption } from '../src/utils/bookingI18n.js';
import { resolveClientLanguage } from '../src/utils/clientLanguage.js';
import { stampResultLanguage } from '../src/utils/bookingI18n.js';

describe('booking i18n (EN after language gate)', () => {
  const business = {
    id: 'biz_1',
    name: 'VIDIA',
    timezone: 'Europe/Bucharest',
    welcome_message: 'Bun venit la VIDIA! Sunt asistentul virtual al locației noastre.',
    booking_settings: { services: [{ id: 's1', name: 'Tuns Clasic', duration_minutes: 30 }] },
  };

  it('resolveClientLanguage locks to EN when language_confirmed', () => {
    const lang = resolveClientLanguage('programare', 'en', {
      language_confirmed: true,
      client_language: 'en',
    });
    assert.equal(lang, 'en');
  });

  it('English welcome ignores Romanian admin welcome_message', () => {
    const text = buildEnglishTransparencyWelcome(business);
    assert.match(text, /Welcome to \*VIDIA\*/);
    assert.doesNotMatch(text, /Bun venit la VIDIA/);
  });

  it('MISSING_SERVICE renders in English', () => {
    const result = stampResultLanguage({
      status: 'MISSING_INFO',
      user_message_template_key: 'MISSING_SERVICE',
      data: {
        services: [{ name: 'Tuns Clasic', duration_minutes: 30, price_ron: 50 }],
        list_button: 'Services',
      },
    }, 'en');
    const text = renderHandlerResult(business, result);
    assert.match(text, /Which service would you like\?/i);
    assert.match(text, /Services/);
    assert.doesNotMatch(text, /Ce serviciu dorești/);
  });

  it('formatServiceAskMessage returns English copy', () => {
    const text = formatServiceAskMessage([{ name: 'Classic Cut' }], 'en');
    assert.match(text, /Which service/i);
  });

  it('day grid list nav labels are English', () => {
    const page = buildListPickerPage(
      Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, title: `Day ${i}`, description: 'x' })),
      0,
      10,
      'en',
    );
    assert.ok(page.items.some((i) => i.title.includes('More options')));
  });

  it('localizeMenuOption maps Programare to Booking', () => {
    const opt = localizeMenuOption({ id: 'book', title: '📅 Programare' }, 'en');
    assert.equal(opt.title, 'Booking');
  });

  it('formatDayGridMessage body is English', () => {
    const body = formatDayGridMessage([], business.timezone, 'Haircut', 'en');
    assert.match(body, /Choose a day/i);
    assert.match(body, /Available days/i);
  });

  it('bookingUi returns English list button labels', () => {
    assert.equal(bookingUi('listServices', 'en'), 'Services');
    assert.equal(bookingUi('listDays', 'en'), 'Available days');
  });
});
