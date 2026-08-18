/**
 * Meta WhatsApp Flows data-exchange endpoint.
 * Configure this URL in Meta Flow endpoint settings:
 *   {PUBLIC_WEBHOOK_BASE_URL}/webhook/whatsapp-flows
 *
 * Requires WHATSAPP_FLOW_PRIVATE_PEM when encryption is enabled on the Flow.
 * Tenant is resolved only from a signed flow_token — never from data.business_id.
 */

import { Router } from 'express';
import { env } from '../config/env.js';
import { getBusinessById } from '../db/businessService.js';
import { getDraftBookingById } from '../db/draftBookingService.js';
import {
  buildFlowInitData,
  buildFlowSlotsForDate,
  catalogServiceFromFlowData,
  decryptFlowRequest,
  encryptFlowResponse,
  parseFlowToken,
} from '../services/whatsappFlowService.js';
import { logError } from '../db/loggerService.js';

export const whatsappFlowsRouter = Router();

const EMPTY_FLOW = {
  service_label: 'Serviciu',
  min_date: new Date().toISOString().slice(0, 10),
  max_date: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10),
  available_slots: [{ id: 'slot_none', title: 'Nicio oră liberă' }],
};

whatsappFlowsRouter.get('/', (_req, res) => {
  res.status(200).json({
    ok: true,
    endpoint: '/webhook/whatsapp-flows',
    expects: 'POST encrypted Flow data_exchange from Meta',
  });
});

whatsappFlowsRouter.post('/', async (req, res) => {
  try {
    const body = req.body || {};

    if (body.action === 'ping' || body.type === 'ping') {
      return res.status(200).json({ data: { status: 'active' } });
    }

    const encrypted = Boolean(
      body.encrypted_flow_data && body.encrypted_aes_key && body.initial_vector,
    );
    if (!encrypted && env.isProduction) {
      return res.status(403).json({ error: 'encrypted_flow_data required' });
    }

    let aesKey = null;
    let payload = body;

    if (encrypted) {
      const decrypted = decryptFlowRequest(
        body.encrypted_flow_data,
        body.encrypted_aes_key,
        body.initial_vector,
      );
      aesKey = decrypted.aesKey;
      payload = decrypted.payload;
    }

    const action = payload?.action || payload?.screen || 'INIT';
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
    const businessId = parseFlowToken(payload?.flow_token);
    const business = businessId ? await getBusinessById(businessId) : null;
    const service = business ? catalogServiceFromFlowData(business, data) : null;

    /** @param {object} response */
    function send(response) {
      if (aesKey) {
        const { encrypted: cipher } = encryptFlowResponse(response, aesKey);
        return res.status(200).send(cipher);
      }
      return res.status(200).json(response);
    }

    if (action === 'INIT' || payload?.action === 'INIT') {
      return send({
        screen: 'BOOKING',
        data: business ? buildFlowInitData(business, service) : EMPTY_FLOW,
      });
    }

    const dateKey = String(data.appointment_date || data.selected_date || '').slice(0, 10);
    if (business && /^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      const draftId = typeof data.draft_id === 'string' ? data.draft_id : null;
      const scopedDraft = draftId ? await getDraftBookingById(draftId, business.id) : null;
      const slots = await buildFlowSlotsForDate({
        business,
        service,
        dateKey,
        employeeId: typeof data.employee_id === 'string' ? data.employee_id : null,
        draftId: scopedDraft?.id || null,
      });
      return send({
        screen: 'BOOKING',
        data: {
          ...buildFlowInitData(business, service),
          available_slots: slots,
        },
      });
    }

    return send({
      screen: 'BOOKING',
      data: business ? buildFlowInitData(business, service) : { available_slots: [] },
    });
  } catch (error) {
    console.error('Eroare detalii:', error);
    await logError({
      message: 'WhatsApp Flow endpoint error',
      source: 'webhook',
      severity: 'error',
      error,
    });
    return res.status(500).json({ error: 'flow_endpoint_failed' });
  }
});
