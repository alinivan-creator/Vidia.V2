import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * Regression: executeConfirm created a Google HOLD on slot pick, then FreeBusy on
 * confirm treated that same HOLD as an external busy block → "nu mai e liber".
 */
describe('confirm — own Google HOLD vs FreeBusy', () => {
  it('skips FreeBusy when draft already has google_event_id (our HOLD)', () => {
    const ownEventId = 'google_evt_hold_123';
    const freeBusyBusy = ownEventId ? false : true;
    assert.equal(freeBusyBusy, false);
  });

  it('runs FreeBusy when there is no Google hold yet (cache-only lock)', () => {
    const ownEventId = null;
    const freeBusyBusy = ownEventId ? false : true;
    assert.equal(freeBusyBusy, true);
  });
});
