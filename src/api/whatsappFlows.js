/**
 * Meta WhatsApp Flows data-exchange endpoint.
 * Configure this URL in Meta Flow endpoint settings:
 *   {PUBLIC_WEBHOOK_BASE_URL}/webhook/whatsapp-flows
 *
 * Requires WHATSAPP_FLOW_PRIVATE_PEM when encryption is enabled on the Flow.
 */

import { Router } from 'express';
import { getBusinessById } from '../db/businessService.js';
import {
  buildFlowInitData,
  buildFlowSlotsForDate,
  decryptFlowRequest,
  encryptFlowResponse,
} from '../services/whatsappFlowService.js';
import { logError } from '../db/loggerService.js';

export const whatsappFlowsRouter = Router();

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

    // Health ping from Meta
    if (body.action === 'ping' || body.type === 'ping') {
      return res.status(200).json({ data: { status: 'active' } });
    }

    let aesKey = null;
    let payload = body;

    if (body.encrypted_flow_data && body.encrypted_aes_key && body.initial_vector) {
      const decrypted = decryptFlowRequest(
        body.encrypted_flow_data,
        body.encrypted_aes_key,
        body.initial_vector,
      );
      aesKey = decrypted.aesKey;
      payload = decrypted.payload;
    }

    const action = payload?.action || payload?.screen || 'INIT';
    const data = payload?.data || {};
    const flowToken = String(payload?.flow_token || '');
    // flow_token format: vidia_{businessIdPrefix}_… — full business id may be embedded later
    const businessId = typeof data.business_id === 'string'
      ? data.business_id
      : (flowToken.startsWith('vidia_') ? null : null);

    /** @type {import('../db/businessService.js').Business | null} */
    let business = null;
    if (businessId) {
      business = await getBusinessById(businessId);
    }

    const service = data.service_name
      ? { name: String(data.service_name), duration_minutes: Number(data.duration_minutes) || 30 }
      : null;

    if (action === 'INIT' || payload?.action === 'INIT') {
      const init = business
        ? buildFlowInitData(business, service)
        : {
          service_label: service?.name || 'Serviciu',
          min_date: new Date().toISOString().slice(0, 10),
          max_date: new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10),
          available_slots: [{ id: 'slot_pick_date_first', title: 'Alege mai întâi ziua' }],
        };
      const response = {
        screen: 'BOOKING',
        data: init,
      };
      if (aesKey) {
        const { encrypted } = encryptFlowResponse(response, aesKey);
        return res.status(200).send(encrypted);
      }
      return res.status(200).json(response);
    }

    const dateKey = String(data.appointment_date || data.selected_date || '').slice(0, 10);
    if (business && /^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
      const slots = await buildFlowSlotsForDate({
        business,
        service,
        dateKey,
        employeeId: typeof data.employee_id === 'string' ? data.employee_id : null,
        draftId: typeof data.draft_id === 'string' ? data.draft_id : null,
      });
      const response = {
        screen: 'BOOKING',
        data: {
          ...buildFlowInitData(business, service),
          available_slots: slots,
        },
      };
      if (aesKey) {
        const { encrypted } = encryptFlowResponse(response, aesKey);
        return res.status(200).send(encrypted);
      }
      return res.status(200).json(response);
    }

    const fallback = {
      screen: 'BOOKING',
      data: business ? buildFlowInitData(business, service) : { available_slots: [] },
    };
    if (aesKey) {
      const { encrypted } = encryptFlowResponse(fallback, aesKey);
      return res.status(200).send(encrypted);
    }
    return res.status(200).json(fallback);
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
