import { Router } from 'express';
import crypto from 'node:crypto';
import { getBusinessByGoogleWebhookChannel } from '../db/businessService.js';
import { logError } from '../db/loggerService.js';
import { lazySyncCalendar } from '../services/googleCalendarService.js';
import { continueAfterResponse } from '../utils/afterResponse.js';

export const googleWebhookRouter = Router();

/**
 * Google Calendar Push Notifications receiver.
 * @see https://developers.google.com/calendar/api/guides/push
 *
 * Google sends POST with headers:
 *   X-Goog-Channel-ID, X-Goog-Resource-ID, X-Goog-Resource-State
 */
googleWebhookRouter.post('/calendar', async (req, res) => {
  const requestId = crypto.randomUUID();

  const channelId = req.get('X-Goog-Channel-ID') ?? '';
  const resourceId = req.get('X-Goog-Resource-ID') ?? '';
  const resourceState = req.get('X-Goog-Resource-State') ?? '';

  // Google requires fast 200 for sync/exists/update notifications
  res.sendStatus(200);

  if (!channelId && !resourceId) {
    return;
  }

  await continueAfterResponse((async () => {
    try {
      const business = await getBusinessByGoogleWebhookChannel({ channelId, resourceId });

      if (!business) {
        await logError({
          message: 'Google webhook: no business matched channel/resource',
          source: 'webhook',
          severity: 'warning',
          requestId,
          details: { channelId, resourceId, resourceState },
        });
        return;
      }

      if (resourceState === 'sync') {
        console.log(`[vidia-v2][google-webhook] Sync handshake for ${business.slug}`);
        return;
      }

      console.log(
        `[vidia-v2][google-webhook] Lazy sync triggered for ${business.slug} (${resourceState})`,
      );

      const result = await lazySyncCalendar({ business, requestId, force: true });

      if (result.skipped) {
        console.log(`[vidia-v2][google-webhook] Cache fresh — skipped sync for ${business.slug}`);
      } else {
        console.log(`[vidia-v2][google-webhook] Synced ${result.synced ?? 0} events for ${business.slug}`);
      }
    } catch (error) {
      await logError({
        message: 'Google webhook processing failed',
        source: 'webhook',
        severity: 'error',
        requestId,
        error,
        details: { channelId, resourceId, resourceState },
      });
    }
  })());
});
