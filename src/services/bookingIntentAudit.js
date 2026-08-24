import { logError } from '../db/loggerService.js';

/**
 * Audit trail for Gemini intent classifications — use misclassified production
 * samples to extend few-shot examples over time.
 *
 * @param {Object} params
 * @param {string | null} [params.businessId]
 * @param {string | null} [params.phoneNumber]
 * @param {string | null} [params.requestId]
 * @param {string} params.textBody
 * @param {import('./bookingIntentMapper.js').BookingIntentClassification} params.classification
 */
export async function recordBookingIntentClassification({
  businessId = null,
  phoneNumber = null,
  requestId = null,
  textBody,
  classification,
}) {
  if (!classification) return;
  await logError({
    message: 'Booking intent classification',
    source: 'ai',
    severity: 'info',
    businessId,
    phoneNumber,
    requestId,
    details: {
      type: 'booking_intent_classification',
      text_preview: String(textBody || '').slice(0, 240),
      intent: classification.intent,
      service_mentioned: classification.service_mentioned,
      existing_appointment_time: classification.existing_appointment_time,
      requested_new_time: classification.requested_new_time,
      sensitive_topic: classification.sensitive_topic,
      contains_complaint_or_feedback: classification.contains_complaint_or_feedback,
      confidence: classification.confidence,
    },
  });
}
