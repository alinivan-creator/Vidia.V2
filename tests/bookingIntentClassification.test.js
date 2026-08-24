import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapBookingIntentToExtraction,
  parseBookingIntentClassification,
  shouldOfferServiceListNotUnknown,
  allowUnknownServiceError,
} from '../src/services/bookingIntentMapper.js';
import {
  finalizeGroundedExtract,
} from '../src/services/turnExtract.js';
import { looksLikeGeneralBookingOnly } from '../src/services/intentTriageService.js';
import { isTypedServiceAttempt, matchServiceMention } from '../src/utils/serviceMatch.js';

const CATALOG = [
  { id: 'svc-tuns', name: 'Tuns Clasic', duration_minutes: 30, price_ron: 50 },
  { id: 'svc-barba', name: 'Tuns + Barba', duration_minutes: 45, price_ron: 80 },
];

const business = {
  id: 'biz-intent-test',
  name: 'Salon Test',
  timezone: 'Europe/Bucharest',
  booking_settings: { services: CATALOG },
};

describe('booking intent classification mapping', () => {
  it('parses Gemini classification JSON', () => {
    const parsed = parseBookingIntentClassification({
      intent: 'general_booking_request',
      service_mentioned: null,
      confidence: 'high',
    });
    assert.equal(parsed?.intent, 'general_booking_request');
    assert.equal(parsed?.service_mentioned, null);
    assert.equal(parsed?.confidence, 'high');
  });

  it('"buna ziua, doresc sa fac o programare la salonul dvs" → general_booking_request, null', () => {
    const text = 'buna ziua, doresc sa fac o programare la salonul dvs';
    const classification = {
      intent: 'general_booking_request',
      service_mentioned: null,
      confidence: 'high',
    };
    const extraction = mapBookingIntentToExtraction(classification, text, business.timezone, business);
    assert.equal(extraction?.booking_intent, 'general_booking_request');
    assert.equal(extraction?.extracted_service, null);
    assert.equal(extraction?.intent, 'book');
    assert.equal(shouldOfferServiceListNotUnknown(extraction), true);
    assert.equal(allowUnknownServiceError(extraction), false);
    assert.equal(looksLikeGeneralBookingOnly(text, { services: CATALOG }), true);
  });

  it('"as vrea sa ma tund maine" → specific_service_request, Tuns Clasic', () => {
    const text = 'as vrea sa ma tund maine';
    const classification = {
      intent: 'specific_service_request',
      service_mentioned: 'Tuns Clasic',
      confidence: 'high',
    };
    const extraction = mapBookingIntentToExtraction(classification, text, business.timezone, business);
    assert.equal(extraction?.booking_intent, 'specific_service_request');
    assert.equal(extraction?.extracted_service, 'Tuns Clasic');
    assert.equal(extraction?.intent, 'select_service');
    assert.equal(shouldOfferServiceListNotUnknown(extraction), false);
    assert.equal(allowUnknownServiceError(extraction), true);
    assert.equal(matchServiceMention('tuns clasic', CATALOG)?.name, 'Tuns Clasic');
  });

  it('"vreau sa anulez programarea" → cancellation, null', () => {
    const text = 'vreau sa anulez programarea';
    const classification = {
      intent: 'cancellation',
      service_mentioned: null,
      confidence: 'high',
    };
    const extraction = mapBookingIntentToExtraction(classification, text, business.timezone, business);
    assert.equal(extraction?.booking_intent, 'cancellation');
    assert.equal(extraction?.extracted_service, null);
    assert.equal(extraction?.intent, 'cancel');
  });

  it('"la ce ora sunteti deschisi" → question, null', () => {
    const text = 'la ce ora sunteti deschisi';
    const classification = {
      intent: 'question',
      service_mentioned: null,
      confidence: 'high',
    };
    const extraction = mapBookingIntentToExtraction(classification, text, business.timezone, business);
    assert.equal(extraction?.booking_intent, 'question');
    assert.equal(extraction?.extracted_service, null);
    assert.equal(extraction?.intent, 'hours');
    assert.equal(shouldOfferServiceListNotUnknown(extraction), true);
  });

  it('unknown tattoo request → low confidence offers list, not unknown_service error', () => {
    const text = 'vreau o programare la ceva ce nu aveti gen tatuaj';
    const classification = {
      intent: 'specific_service_request',
      service_mentioned: null,
      confidence: 'low',
    };
    const extraction = mapBookingIntentToExtraction(classification, text, business.timezone, business);
    assert.equal(extraction?.booking_intent, 'specific_service_request');
    assert.equal(extraction?.extracted_service, null);
    assert.equal(extraction?.intent, 'book');
    assert.equal(shouldOfferServiceListNotUnknown(extraction), true);
    assert.equal(allowUnknownServiceError(extraction), false);

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

  it('high-confidence specific miss still allows unknown_service after grounding', () => {
    const extraction = mapBookingIntentToExtraction(
      {
        intent: 'specific_service_request',
        service_mentioned: 'Tatuaj',
        confidence: 'high',
      },
      'vreau tatuaj',
      business.timezone,
      business,
    );
    assert.equal(allowUnknownServiceError(extraction), true);
    const grounded = finalizeGroundedExtract({
      action: 'book',
      service_name: null,
      service_id: null,
      unknown_service_name: 'Tatuaj',
      confidence: 'high',
      source: 'nlu',
      extraction,
    });
    assert.equal(grounded.action, 'unknown_service');
  });

  it('typed combo with catalog vocabulary is not general-only booking', () => {
    const text = 'Tuns si vopsit';
    assert.equal(isTypedServiceAttempt(text), true);
    assert.equal(looksLikeGeneralBookingOnly(text, { services: CATALOG }), false);
  });
});
