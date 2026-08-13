import { waitUntil } from '@vercel/functions';

/**
 * Keep background work alive after the HTTP response is sent.
 * Local Node stays up after `res.send()`; Vercel freezes the isolate unless
 * `waitUntil` is used (Twilio/Google webhooks need this).
 *
 * @param {Promise<unknown>} work
 * @returns {Promise<void>}
 */
export async function continueAfterResponse(work) {
  const promise = Promise.resolve(work).catch((error) => {
    console.error('[afterResponse] Unhandled background error:', error);
  });

  if (process.env.VERCEL) {
    try {
      waitUntil(promise);
    } catch (error) {
      console.warn('[afterResponse] waitUntil unavailable — awaiting inline', error);
    }
  }

  // Always await: Twilio already got HTTP 200. Returning here used to freeze
  // the Vercel isolate before OpenAI/Twilio send finished (silent no-reply).
  await promise;
}
