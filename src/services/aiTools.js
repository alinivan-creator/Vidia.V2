/**
 * LLM tools (OpenAI function calling) + Guard executor.
 * The model may only *request* these. Backend validates hours/catalog/calendar
 * and is the only writer to drafts / Google Calendar.
 */

import { getAvailableSlots, isSlotAvailable } from '../db/cacheService.js';
import { getActiveDraftBooking } from '../db/draftBookingService.js';
import { listEmployees, matchEmployeeMention } from '../db/employeeService.js';
import {
  formatBusinessHoursText,
  formatSlotLabel,
  getBookingConfig,
  getConfiguredBusinessHours,
  encodeSlotId,
} from '../utils/datetime.js';
import {
  assertWithinWorkingHours,
  getHoursForDate,
  hasConfiguredOpenDay,
  hoursUnsetClientMessage,
  resolveServiceDurationMinutes,
} from '../utils/workingHours.js';
import { getBusinessContactInfo } from './contactService.js';
import {
  applyPendingEmployeeChange,
  handleBookingInteractiveReply,
  handleFreeTextSlotRequest,
  parseRomanianDateTime,
} from './bookingFlowService.js';
import { handleBookingAction, handleCallbackRequest } from './menuHandler.js';
import { handleGlobalModificationIntent } from './modificationFlowService.js';
import { lazySyncCalendar } from './googleCalendarService.js';
import { rememberMenuOptions } from './whatsappService.js';
import {
  CONVERSATION_STEPS,
  setConversationStep,
} from '../db/conversationStateService.js';

/** @typedef {import('../db/businessService.js').Business} Business */

/**
 * @param {string} name
 * @param {string} description
 * @param {Record<string, unknown>} parameters
 */
function tool(name, description, parameters) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', additionalProperties: false, ...parameters },
    },
  };
}

const INFO_TOOLS = [
  tool('get_services_list', 'Lista serviciilor active, prețuri și durate din Admin. Apelează înainte să vorbești despre servicii.', {
    properties: {},
  }),
  tool('get_business_hours', 'Programul de lucru din Admin (zile deschise/închise). Nu inventa ore. Apelează pentru întrebări de program sau înainte de o oră cerută.', {
    properties: {
      date_text: {
        type: 'string',
        description: 'Opțional: ziua cerută (ex. „duminică”, „mâine”, YYYY-MM-DD).',
      },
    },
  }),
  tool('get_contact_info', 'Telefon, adresă, email, website din Admin.', {
    properties: {},
  }),
  tool('verify_employee', 'Verifică dacă un nume de angajat există în catalogul activ. Apelează când clientul cere un specialist.', {
    properties: {
      name: { type: 'string', description: 'Numele menționat de client.' },
    },
    required: ['name'],
  }),
  tool('request_human_callback', 'Cere un om din echipă (reclamație, legal, medical, cerere în afara scope-ului).', {
    properties: {
      reason: { type: 'string', description: 'Motiv scurt.' },
    },
  }),
];

const BOOKING_TOOLS = [
  tool(
    'check_availability',
    'Garda de disponibilitate. Verifică MAI ÎNTÂI programul din Admin; Google Calendar e interogat doar dacă ziua e deschisă. Apelează înainte să spui că o oră e liberă sau ocupată.',
    {
      properties: {
        date_text: { type: 'string', description: 'Ziua (ex. „vineri”, „mâine”, YYYY-MM-DD).' },
        time_text: { type: 'string', description: 'Ora (ex. „10:30”, „14”).' },
        service_name: { type: 'string', description: 'Serviciul, dacă e cunoscut.' },
        employee_name: { type: 'string', description: 'Angajatul, dacă e cerut.' },
      },
    },
  ),
  tool(
    'list_available_slots',
    'Returnează sloturi reale generate de backend (program Admin + calendar). Nu inventa ore.',
    {
      properties: {
        service_name: { type: 'string' },
        employee_name: { type: 'string' },
        date_text: { type: 'string', description: 'Opțional, restrânge la o zi.' },
      },
    },
  ),
  tool(
    'begin_booking',
    'Pornește fluxul de programare în backend (draft + pași). Obligatoriu când clientul vrea să se programeze. Nu scrie tu în calendar.',
    {
      properties: {
        service_name: { type: 'string' },
        employee_name: { type: 'string' },
        datetime_text: { type: 'string', description: 'Textul original cu zi/oră, dacă există.' },
      },
    },
  ),
  tool(
    'hold_slot',
    'Reține un interval (soft lock) după validarea programului și a calendarului. Apelează când clientul a ales o oră anume.',
    {
      properties: {
        datetime_text: { type: 'string', description: 'Ex. „mâine la 10:30”.' },
      },
      required: ['datetime_text'],
    },
  ),
  tool(
    'confirm_booking',
    'Confirmă programarea: backend-ul scrie în Google Calendar și în baza de date. Doar după hold valid.',
    { properties: {} },
  ),
  tool(
    'cancel_pending',
    'Anulează hold-ul / programarea în curs (neconfirmată).',
    { properties: {} },
  ),
  tool(
    'change_employee',
    'Schimbă angajatul pe draft-ul curent, după verify_employee.',
    {
      properties: {
        name: { type: 'string' },
      },
      required: ['name'],
    },
  ),
  tool(
    'cancel_confirmed',
    'Anulare a unei programări DEJA confirmate.',
    { properties: {} },
  ),
  tool(
    'reschedule_confirmed',
    'Reprogramare a unei programări DEJA confirmate.',
    { properties: {} },
  ),
];

/**
 * @param {Business} business
 */
export function getAgentTools(business) {
  if (business.business_type === 'consulting') return INFO_TOOLS;
  return [...INFO_TOOLS, ...BOOKING_TOOLS];
}

/**
 * @typedef {Object} ToolContext
 * @property {Business} business
 * @property {string} recipientPhone
 * @property {string | null} [clientId]
 * @property {string | null} [requestId]
 * @property {string} userMessage
 * @property {import('../db/conversationStateService.js').ConversationState | null} [convState]
 * @property {import('../db/draftBookingService.js').DraftBooking | null} [draft]
 */

function jsonResult(payload, uiSent = false) {
  return { ...payload, ui_sent: Boolean(uiSent) };
}

function matchServiceByName(business, name) {
  const n = String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (!n) return null;
  const { services } = getBookingConfig(business);
  let best = null;
  let bestLen = 0;
  for (const s of services) {
    const sn = String(s.name)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    if (sn.length >= 3 && n.includes(sn) && sn.length > bestLen) {
      best = s;
      bestLen = sn.length;
    }
  }
  return best;
}

function combineDateTimeText(args, fallback) {
  const parts = [args.date_text, args.time_text, args.datetime_text, fallback]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);
  return parts.join(' ');
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {ToolContext} ctx
 */
export async function executeAgentTool(name, args, ctx) {
  const { business, recipientPhone, clientId = null, requestId = null, userMessage } = ctx;
  let draft = ctx.draft || await getActiveDraftBooking(business.id, recipientPhone);

  try {
    switch (name) {
      case 'get_services_list': {
        const { services } = getBookingConfig(business);
        return jsonResult({
          ok: true,
          services: services.map((s) => ({
            name: s.name,
            duration_minutes: s.duration_minutes,
            price_ron: s.price_ron ?? null,
          })),
        });
      }

      case 'get_business_hours': {
        const hours = getConfiguredBusinessHours(business);
        if (!hours) {
          return jsonResult({ ok: false, status: 'hours_unset', message: hoursUnsetClientMessage() });
        }
        const dateText = String(args.date_text ?? '').trim();
        if (dateText) {
          const parsed = parseRomanianDateTime(`${dateText} 12:00`, business.timezone)
            || parseRomanianDateTime(dateText, business.timezone);
          const when = parsed || new Date();
          const info = getHoursForDate(business, when);
          return jsonResult({
            ok: true,
            schedule: formatBusinessHoursText(hours),
            day: info.dayName,
            open: info.open,
            hours: info.dayHours,
          });
        }
        return jsonResult({
          ok: true,
          schedule: formatBusinessHoursText(hours),
          has_open_day: hasConfiguredOpenDay(business),
        });
      }

      case 'get_contact_info': {
        const info = getBusinessContactInfo(business);
        return jsonResult({
          ok: true,
          phone: info.phone || null,
          email: info.email || null,
          address: info.address || null,
          website: info.website || null,
          maps_url: info.mapsUrl || null,
        });
      }

      case 'verify_employee': {
        const employees = await listEmployees(business.id, { activeOnly: true });
        const mentioned = matchEmployeeMention(String(args.name ?? ''), employees);
        return jsonResult({
          ok: true,
          found: Boolean(mentioned),
          employee: mentioned ? { id: mentioned.id, name: mentioned.name } : null,
          staff: employees.map((e) => e.name),
        });
      }

      case 'check_availability': {
        const blob = combineDateTimeText(args, userMessage);
        const start = parseRomanianDateTime(blob, business.timezone);
        if (!start) {
          return jsonResult({
            ok: false,
            status: 'unparsed',
            message: 'Nu am putut interpreta data/ora. Cere o formulare de tip „vineri la 10:30”.',
            google_queried: false,
          });
        }

        const service =
          matchServiceByName(business, args.service_name)
          || draft?.selected_service
          || null;
        const duration = resolveServiceDurationMinutes(business, service);
        const end = duration
          ? new Date(start.getTime() + duration * 60_000)
          : new Date(start.getTime() + 60_000);

        const hoursCheck = assertWithinWorkingHours(business, start, end);
        if (!hoursCheck.ok) {
          return jsonResult({
            ok: false,
            status: hoursCheck.reason,
            message: hoursCheck.message,
            google_queried: false,
            label: formatSlotLabel(start, business.timezone),
          });
        }

        if (!duration) {
          return jsonResult({
            ok: true,
            status: 'within_hours_need_service',
            google_queried: false,
            label: formatSlotLabel(start, business.timezone),
            message: 'Ora e în program, dar trebuie un serviciu din catalog ca să verific calendarul.',
          });
        }

        const employees = await listEmployees(business.id, { activeOnly: true });
        const employee = matchEmployeeMention(String(args.employee_name ?? ''), employees);
        const empId = employee?.id || draft?.employee_id || null;

        await lazySyncCalendar({
          business,
          requestId,
          employeeId: empId,
        });

        const slotId = encodeSlotId(start, business.timezone);
        const free = await isSlotAvailable({
          business,
          slotId,
          durationMinutes: duration,
          excludeDraftId: draft?.id ?? null,
          employeeId: empId,
        });

        return jsonResult({
          ok: true,
          status: free ? 'free' : 'occupied',
          google_queried: true,
          label: formatSlotLabel(start, business.timezone),
          service: service?.name ?? null,
          employee: employee?.name ?? null,
        });
      }

      case 'list_available_slots': {
        const service =
          matchServiceByName(business, args.service_name)
          || draft?.selected_service
          || null;
        const duration = resolveServiceDurationMinutes(business, service);
        if (!duration) {
          const { services } = getBookingConfig(business);
          return jsonResult({
            ok: false,
            status: 'need_service',
            services: services.map((s) => s.name),
            google_queried: false,
          });
        }
        if (!hasConfiguredOpenDay(business)) {
          return jsonResult({
            ok: false,
            status: 'hours_unset',
            message: hoursUnsetClientMessage(),
            google_queried: false,
          });
        }

        const employees = await listEmployees(business.id, { activeOnly: true });
        const employee = matchEmployeeMention(String(args.employee_name ?? ''), employees);
        const empId = employee?.id || draft?.employee_id || null;

        await lazySyncCalendar({ business, requestId, employeeId: empId });
        const slots = await getAvailableSlots({
          business,
          durationMinutes: duration,
          limit: 10,
          excludeDraftId: draft?.id ?? null,
          employeeId: empId,
        });

        const options = slots.map((s) => ({
          id: s.id,
          title: formatSlotLabel(s.start, business.timezone),
        }));
        if (options.length && draft) {
          await rememberMenuOptions(business.id, recipientPhone, options, 'slot');
          await setConversationStep({
            businessId: business.id,
            rawPhone: recipientPhone,
            step: CONVERSATION_STEPS.SELECTING_SLOT,
            context: { draft_id: draft.id, service, intent: 'book' },
            requestId,
          });
        }

        return jsonResult({
          ok: true,
          google_queried: true,
          service: service.name,
          employee: employee?.name ?? null,
          slots: options.map((o, i) => ({ n: i + 1, label: o.title })),
        });
      }

      case 'begin_booking': {
        const hint = combineDateTimeText(args, userMessage);
        await handleBookingAction({
          business,
          recipientPhone,
          clientId,
          hintText: hint,
          requestId,
        });
        return jsonResult({ ok: true, started: true }, true);
      }

      case 'hold_slot': {
        draft = draft || await getActiveDraftBooking(business.id, recipientPhone);
        if (!draft?.selected_service) {
          return jsonResult({
            ok: false,
            status: 'need_booking',
            message: 'Trebuie un serviciu selectat înainte de a reține ora. Apelează begin_booking.',
          });
        }
        const when = String(args.datetime_text || userMessage);
        if (!parseRomanianDateTime(when, business.timezone)) {
          return jsonResult({
            ok: false,
            status: 'unparsed',
            message: 'Nu am interpretat data/ora. Exemplu: „mâine la 10:30”.',
          });
        }
        const handled = await handleFreeTextSlotRequest({
          business,
          recipientPhone,
          draft,
          textBody: when,
          requestId,
        });
        return jsonResult({ ok: handled, held: handled }, true);
      }

      case 'confirm_booking': {
        await handleBookingInteractiveReply({
          business,
          recipientPhone,
          replyId: 'confirm_booking',
          clientId,
          requestId,
        });
        return jsonResult({ ok: true }, true);
      }

      case 'cancel_pending': {
        await handleBookingInteractiveReply({
          business,
          recipientPhone,
          replyId: 'cancel_booking',
          clientId,
          requestId,
        });
        return jsonResult({ ok: true }, true);
      }

      case 'change_employee': {
        draft = draft || await getActiveDraftBooking(business.id, recipientPhone);
        if (!draft) {
          await handleBookingAction({
            business,
            recipientPhone,
            clientId,
            hintText: String(args.name || ''),
            requestId,
          });
          return jsonResult({ ok: true, started: true }, true);
        }
        await applyPendingEmployeeChange({
          business,
          recipientPhone,
          draft,
          textBody: String(args.name || ''),
          requestId,
        });
        return jsonResult({ ok: true }, true);
      }

      case 'request_human_callback': {
        await handleCallbackRequest({
          business,
          recipientPhone,
          userMessage,
          reason: String(args.reason || 'ai_tool_callback'),
          clientId,
          requestId,
        });
        return jsonResult({ ok: true }, true);
      }

      case 'cancel_confirmed': {
        await handleGlobalModificationIntent({
          business,
          recipientPhone,
          intent: 'cancel',
          activeDraft: draft,
          requestId,
        });
        return jsonResult({ ok: true }, true);
      }

      case 'reschedule_confirmed': {
        await handleGlobalModificationIntent({
          business,
          recipientPhone,
          intent: 'reschedule',
          activeDraft: draft,
          requestId,
        });
        return jsonResult({ ok: true }, true);
      }

      default:
        return jsonResult({ ok: false, error: `unknown_tool:${name}` });
    }
  } catch (error) {
    console.error('Eroare detalii:', error);
    return jsonResult({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
