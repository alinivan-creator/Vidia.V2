import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapBookingIntentToExtraction,
  parseBookingIntentClassification,
  shouldOfferServiceListNotUnknown,
  allowUnknownServiceError,
  resolveRelativeDate,
  turnActionForBookingIntent,
} from '../src/services/bookingIntentMapper.js';
import {
  finalizeGroundedExtract,
} from '../src/services/turnExtract.js';
import { looksLikeGeneralBookingOnly } from '../src/services/intentTriageService.js';
import { isTypedServiceAttempt, matchServiceMention } from '../src/utils/serviceMatch.js';

const SALON_CATALOG = [
  { id: 'svc-tuns', name: 'Tuns Clasic', duration_minutes: 30, price_ron: 50 },
  { id: 'svc-barba', name: 'Tuns + Barba', duration_minutes: 45, price_ron: 80 },
];

const ITP_CATALOG = [
  { id: 'svc-itp', name: 'ITP auto', duration_minutes: 30, price_ron: 100 },
];

const salonBusiness = {
  id: 'biz-intent-test',
  name: 'Salon Test',
  timezone: 'Europe/Bucharest',
  booking_settings: { services: SALON_CATALOG },
};

const itpBusiness = {
  id: 'biz-itp-test',
  name: 'Statie ITP Test',
  timezone: 'Europe/Bucharest',
  booking_settings: { services: ITP_CATALOG },
};

/** Saturday 2026-08-22 — next Monday is 2026-08-24 */
const SATURDAY = new Date('2026-08-22T10:00:00+03:00');

describe('booking intent classification mapping', () => {
  it('parses extended Gemini classification JSON', () => {
    const parsed = parseBookingIntentClassification({
      intent: 'general_booking_request',
      service_mentioned: null,
      existing_appointment_time: null,
      requested_new_time: null,
      sensitive_topic: false,
      contains_complaint_or_feedback: false,
      confidence: 'high',
    });
    assert.equal(parsed?.intent, 'general_booking_request');
    assert.equal(parsed?.service_mentioned, null);
    assert.equal(parsed?.confidence, 'high');
  });

  it('"buna ziua, doresc sa fac o programare la salonul dvs" → general_booking_request, null', () => {
    const text = 'buna ziua, doresc sa fac o programare la salonul dvs';
    const extraction = mapBookingIntentToExtraction({
      intent: 'general_booking_request',
      service_mentioned: null,
      existing_appointment_time: null,
      requested_new_time: null,
      confidence: 'high',
    }, text, salonBusiness.timezone, salonBusiness);
    assert.equal(extraction?.booking_intent, 'general_booking_request');
    assert.equal(extraction?.extracted_service, null);
    assert.equal(extraction?.intent, 'book');
    assert.equal(shouldOfferServiceListNotUnknown(extraction), true);
    assert.equal(looksLikeGeneralBookingOnly(text, { services: SALON_CATALOG }), true);
  });

  it('"buna ziua, as vrea sa fac o programare la statia dvs" → general_booking_request, null', () => {
    const text = 'buna ziua, as vrea sa fac o programare la statia dvs';
    const extraction = mapBookingIntentToExtraction({
      intent: 'general_booking_request',
      service_mentioned: null,
      existing_appointment_time: null,
      requested_new_time: null,
      confidence: 'high',
    }, text, itpBusiness.timezone, itpBusiness);
    assert.equal(extraction?.booking_intent, 'general_booking_request');
    assert.equal(extraction?.extracted_service, null);
    assert.equal(shouldOfferServiceListNotUnknown(extraction), true);
  });

  it('"as vrea sa ma tund maine" → specific_service_request, Tuns Clasic', () => {
    const text = 'as vrea sa ma tund maine';
    const extraction = mapBookingIntentToExtraction({
      intent: 'specific_service_request',
      service_mentioned: 'Tuns Clasic',
      existing_appointment_time: null,
      requested_new_time: null,
      confidence: 'high',
    }, text, salonBusiness.timezone, salonBusiness);
    assert.equal(extraction?.booking_intent, 'specific_service_request');
    assert.equal(extraction?.extracted_service, 'Tuns Clasic');
    assert.equal(extraction?.intent, 'select_service');
    assert.equal(allowUnknownServiceError(extraction), true);
    assert.equal(matchServiceMention('tuns clasic', SALON_CATALOG)?.name, 'Tuns Clasic');
  });

  it('"vreau sa fac ITP maine" → specific_service_request, ITP auto', () => {
    const extraction = mapBookingIntentToExtraction({
      intent: 'specific_service_request',
      service_mentioned: 'ITP auto',
      existing_appointment_time: null,
      requested_new_time: null,
      confidence: 'high',
    }, 'vreau sa fac ITP maine', itpBusiness.timezone, itpBusiness);
    assert.equal(extraction?.extracted_service, 'ITP auto');
    assert.equal(extraction?.intent, 'select_service');
  });

  it('short "ITP" → specific_service_request high confidence', () => {
    const extraction = mapBookingIntentToExtraction({
      intent: 'specific_service_request',
      service_mentioned: 'ITP auto',
      existing_appointment_time: null,
      requested_new_time: null,
      confidence: 'high',
    }, 'ITP', itpBusiness.timezone, itpBusiness);
    assert.equal(extraction?.booking_intent, 'specific_service_request');
    assert.equal(extraction?.service_confidence, 'high');
    assert.equal(extraction?.extracted_service, 'ITP auto');
  });

  it('"vreau sa anulez programarea" → cancellation, null', () => {
    const extraction = mapBookingIntentToExtraction({
      intent: 'cancellation',
      service_mentioned: null,
      existing_appointment_time: null,
      requested_new_time: null,
      confidence: 'high',
    }, 'vreau sa anulez programarea', salonBusiness.timezone, salonBusiness);
    assert.equal(extraction?.booking_intent, 'cancellation');
    assert.equal(extraction?.intent, 'cancel');
    assert.equal(shouldOfferServiceListNotUnknown(extraction), false);
  });

  it('"vreau sa anulez programarea de luni" → cancellation with existing raw luni', () => {
    const extraction = mapBookingIntentToExtraction({
      intent: 'cancellation',
      service_mentioned: null,
      existing_appointment_time: 'luni',
      requested_new_time: null,
      confidence: 'high',
    }, 'vreau sa anulez programarea de luni', salonBusiness.timezone, salonBusiness);
    assert.equal(extraction?.booking_intent, 'cancellation');
    assert.equal(extraction?.modify_target_raw, 'luni');
    assert.ok(extraction?.existing_appointment_date);
    assert.match(extraction.existing_appointment_date, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('"la ce ora sunteti deschisi" → question → hours', () => {
    const extraction = mapBookingIntentToExtraction({
      intent: 'question',
      service_mentioned: null,
      existing_appointment_time: null,
      requested_new_time: null,
      confidence: 'high',
    }, 'la ce ora sunteti deschisi', salonBusiness.timezone, salonBusiness);
    assert.equal(extraction?.intent, 'hours');
    assert.equal(shouldOfferServiceListNotUnknown(extraction), true);
  });

  it('unknown tattoo request → low confidence offers list, not unknown_service error', () => {
    const extraction = mapBookingIntentToExtraction({
      intent: 'specific_service_request',
      service_mentioned: null,
      existing_appointment_time: null,
      requested_new_time: null,
      confidence: 'low',
    }, 'vreau o programare la ceva ce nu aveti gen tatuaj', salonBusiness.timezone, salonBusiness);
    assert.equal(shouldOfferServiceListNotUnknown(extraction), true);
    const grounded = finalizeGroundedExtract({
      action: 'book',
      service_name: null,
      service_id: null,
      unknown_service_name: null,
      confidence: 'low',
      source: 'nlu',
      extraction,
    });
    assert.notEqual(grounded.action, 'unknown_service');
  });

  it('reschedule with existing + new time maps to reschedule action, not book', () => {
    const text = 'am si eu o programare vineri la 9:30, se poate sa o mutam la ora 15?';
    const extraction = mapBookingIntentToExtraction({
      intent: 'reschedule_request',
      service_mentioned: null,
      existing_appointment_time: 'vineri 9:30',
      requested_new_time: 'ora 15',
      confidence: 'high',
    }, text, salonBusiness.timezone, salonBusiness);
    assert.equal(extraction?.booking_intent, 'reschedule_request');
    assert.equal(extraction?.intent, 'reschedule');
    assert.equal(extraction?.modify_target_raw, 'vineri 9:30');
    assert.equal(extraction?.modify_new_raw, 'ora 15');
    assert.equal(extraction?.requested_reschedule_time_hhmm, '15:00');
    assert.equal(extraction?.extracted_service, null);
    assert.equal(shouldOfferServiceListNotUnknown(extraction), false);
  });

  it('resolveRelativeDate: Saturday + "luni" → next Monday (not far future)', () => {
    const resolved = resolveRelativeDate('luni', salonBusiness.timezone, SATURDAY);
    assert.equal(resolved.dateKey, '2026-08-24');
  });

  it('reschedule "vineri" → "luni" stores raw fragments; backend resolves luni', () => {
    const extraction = mapBookingIntentToExtraction({
      intent: 'reschedule_request',
      service_mentioned: null,
      existing_appointment_time: 'vineri',
      requested_new_time: 'luni',
      confidence: 'high',
    }, 'as vrea sa mut programarea de vineri pe luni', salonBusiness.timezone, salonBusiness);
    assert.equal(extraction?.modify_target_raw, 'vineri');
    assert.equal(extraction?.modify_new_raw, 'luni');
    assert.match(extraction?.requested_reschedule_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(resolveRelativeDate('luni', salonBusiness.timezone, SATURDAY).dateKey, '2026-08-24');
  });

  it('typed combo with catalog vocabulary is not general-only booking', () => {
    const text = 'Tuns si vopsit';
    assert.equal(isTypedServiceAttempt(text), true);
    assert.equal(looksLikeGeneralBookingOnly(text, { services: SALON_CATALOG }), false);
  });

  it('"ce faci" → chitchat action, not book', () => {
    const extraction = mapBookingIntentToExtraction({
      intent: 'chitchat',
      service_mentioned: null,
      existing_appointment_time: null,
      requested_new_time: null,
      sensitive_topic: false,
      contains_complaint_or_feedback: false,
      confidence: 'high',
    }, 'ce faci', salonBusiness.timezone, salonBusiness);
    assert.equal(turnActionForBookingIntent(extraction), 'chitchat');
  });

  it('"nu mai pot sa ajung" → unable_to_attend', () => {
    const extraction = mapBookingIntentToExtraction({
      intent: 'unable_to_attend',
      service_mentioned: null,
      existing_appointment_time: null,
      requested_new_time: null,
      sensitive_topic: false,
      contains_complaint_or_feedback: false,
      confidence: 'high',
    }, 'nu mai pot sa ajung', salonBusiness.timezone, salonBusiness);
    assert.equal(turnActionForBookingIntent(extraction), 'unable_to_attend');
    assert.equal(shouldOfferServiceListNotUnknown(extraction), false);
  });

  it('"pot sa intarzii 5 minute?" → running_late', () => {
    const extraction = mapBookingIntentToExtraction({
      intent: 'running_late',
      service_mentioned: null,
      existing_appointment_time: null,
      requested_new_time: null,
      sensitive_topic: false,
      contains_complaint_or_feedback: false,
      confidence: 'high',
    }, 'pot sa intarzii 5 minute?', salonBusiness.timezone, salonBusiness);
    assert.equal(turnActionForBookingIntent(extraction), 'running_late');
  });

  it('"o sa ma doara?" → sensitive_question', () => {
    const extraction = mapBookingIntentToExtraction({
      intent: 'question',
      service_mentioned: null,
      existing_appointment_time: null,
      requested_new_time: null,
      sensitive_topic: true,
      contains_complaint_or_feedback: false,
      confidence: 'high',
    }, 'o sa ma doara?', salonBusiness.timezone, salonBusiness);
    assert.equal(turnActionForBookingIntent(extraction), 'sensitive_question');
    assert.equal(shouldOfferServiceListNotUnknown(extraction), false);
  });

  it('"faceti clatite?" → off_topic', () => {
    const extraction = mapBookingIntentToExtraction({
      intent: 'off_topic',
      service_mentioned: null,
      existing_appointment_time: null,
      requested_new_time: null,
      sensitive_topic: false,
      contains_complaint_or_feedback: false,
      confidence: 'high',
    }, 'faceti clatite?', salonBusiness.timezone, salonBusiness);
    assert.equal(turnActionForBookingIntent(extraction), 'off_topic');
  });

  it('"am vorbit cu patronul..." → special_request', () => {
    const extraction = mapBookingIntentToExtraction({
      intent: 'special_request',
      service_mentioned: null,
      existing_appointment_time: null,
      requested_new_time: '09:00',
      sensitive_topic: false,
      contains_complaint_or_feedback: false,
      confidence: 'high',
    }, 'am vorbit cu patronul sa ma bagi la 09:00', salonBusiness.timezone, salonBusiness);
    assert.equal(turnActionForBookingIntent(extraction), 'special_request');
  });
});
