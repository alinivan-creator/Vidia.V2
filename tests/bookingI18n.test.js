import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bm, BOOKING_MSG } from '../src/utils/bookingI18n.js';
import { durationMissingClientMessage } from '../src/utils/workingHours.js';
import { clarificationPrompt } from '../src/services/bookingWaitState.js';

describe('booking i18n dictionary', () => {
  it('every BOOKING_MSG key has ro and en strings', () => {
    for (const [key, row] of Object.entries(BOOKING_MSG)) {
      assert.ok(row.ro?.length, `${key} missing ro`);
      assert.ok(row.en?.length, `${key} missing en`);
    }
  });

  it('critical booking errors render in English', () => {
    assert.match(bm('errConfirmCalendar', 'en'), /could not be confirmed/i);
    assert.match(bm('errCancelOne', 'en'), /could not be cancelled/i);
    assert.match(bm('errHoldExpired', 'en'), /expired/i);
    assert.match(bm('askFullName', 'en'), /first and last name/i);
    assert.match(bm('businessSuspended', 'en'), /temporarily unavailable/i);
    assert.doesNotMatch(bm('errSaveBooking', 'en'), /ă|î|â|ș|ț/i);
  });

  it('durationMissingClientMessage respects lang', () => {
    assert.match(durationMissingClientMessage('Tuns', 'en'), /cannot be confirmed/i);
    assert.match(durationMissingClientMessage('Tuns', 'ro'), /Această programare/);
  });

  it('clarificationPrompt respects lang', () => {
    assert.match(clarificationPrompt(null, 'en'), /could not be understood/i);
    assert.match(clarificationPrompt(17, 'en'), /Please confirm/i);
    assert.match(clarificationPrompt(17, 'ro'), /confirmați/i);
  });
});
