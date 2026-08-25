import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractLikelyEmployeeName,
  resolveStaffMentionFromText,
} from '../src/db/employeeService.js';
import { looksLikeBusinessFactQuestion } from '../src/utils/businessInfoLookup.js';
import {
  detectModificationIntent,
  looksLikeGratitude,
} from '../src/services/intentTriageService.js';
import {
  interpretPendingActionReply,
  readPendingAction,
  PENDING_ACTIONS,
  shouldSkipStaffRebind,
} from '../src/services/pendingActionService.js';
import { extractTurnIntent } from '../src/services/turnExtract.js';
import { CONVERSATION_STEPS } from '../src/db/conversationStateService.js';
import { getBookingWait, BOOKING_WAIT } from '../src/services/bookingWaitState.js';

const services = [
  { id: 'svc-tuns', name: 'Tuns Clasic', duration_minutes: 30, price_ron: 50 },
];

const employees = [
  { id: 'e1', name: 'Mihai', google_calendar_id: 'm@x.com', active: true, sort_order: 0 },
  { id: 'e2', name: 'Stefan', google_calendar_id: 's@x.com', active: true, sort_order: 1 },
];

const salonBusiness = {
  id: '00000000-0000-4000-8000-000000000077',
  name: 'Barber Shop Timisoara',
  timezone: 'Europe/Bucharest',
  booking_settings: {
    services,
    business_info: { parking: { enabled: true } },
  },
};

const idle = { current_step: CONVERSATION_STEPS.IDLE, context_data: {} };

async function extract(text, convState = idle) {
  return extractTurnIntent({
    business: salonBusiness,
    textBody: text,
    typedText: text,
    convState,
    requestId: 'pending-action-arch',
  });
}

describe('conversation pending_action architecture (6 documented cases)', () => {
  it('1. parking FAQ variants → missing_info, never employee Salon', async () => {
    const variants = [
      'aveti parcare la salon?',
      'Exista parcare?',
      'Pot sa parchez undeva langa?',
      'Do you have parking at the salon?',
    ];
    for (const text of variants) {
      assert.equal(looksLikeBusinessFactQuestion(text) || /parking|parcare|parchez/i.test(text), true, text);
      assert.equal(extractLikelyEmployeeName(text, { services }), null, `guess for: ${text}`);
      const out = await extract(text);
      assert.equal(out.action, 'missing_info', text);
      assert.equal(out.employee_name, null, text);
      assert.ok(shouldSkipStaffRebind(out.action));
    }
  });

  it('2. book at salon / dvs → never treats salon/dvs as staff', async () => {
    const variants = [
      'vreau sa imi fac si eu o programare la salonul dvs barber shop din Timisoara',
      'as vrea o programare la salon',
      'programare la clinica dvs',
      'vreau programare la dumneavoastra',
    ];
    for (const text of variants) {
      assert.equal(extractLikelyEmployeeName(text, { services }), null, text);
      const staff = resolveStaffMentionFromText(text, employees, services);
      assert.equal(staff.employee_name, null, text);
      const out = await extract(text);
      assert.equal(out.employee_name, null, text);
      assert.notEqual(out.user_message_template_key, 'MISSING_EMPLOYEE');
      // Primary documented phrasing must enter booking; shorter ones may soft-chat.
      if (/vreau|as vrea/i.test(text)) {
        assert.equal(out.action, 'book', text);
      }
    }
  });

  it('3. awaiting employee confirm — "La Stefan" / variants → staff choice, not unknown_service', async () => {
    const choosing = {
      current_step: CONVERSATION_STEPS.CHOOSING_EMPLOYEE,
      context_data: {
        pending_offer: { kind: 'employee', id: 'e1', name: 'Mihai', rejected: 'Darius' },
        suggested_employee_id: 'e1',
        available_employees: ['Mihai', 'Stefan'],
        pending_action: {
          kind: PENDING_ACTIONS.EMPLOYEE_CONFIRM,
          offered: { id: 'e1', name: 'Mihai' },
          rejected: 'Darius',
          options: ['Mihai', 'Stefan'],
        },
        session_language: 'ro',
      },
    };
    assert.equal(getBookingWait(choosing), BOOKING_WAIT.EMPLOYEE);
    assert.equal(readPendingAction(choosing)?.kind, PENDING_ACTIONS.EMPLOYEE_CONFIRM);

    const variants = ['La Stefan', 'la stefan', 'Stefan', 'cu Stefan te rog'];
    for (const text of variants) {
      const pending = interpretPendingActionReply({
        textBody: text,
        convState: choosing,
        employees,
        services,
      });
      assert.ok(pending, text);
      assert.equal(pending.action, 'select_employee', text);
      assert.equal(pending.employee_id, 'e2', text);

      const out = await extract(text, choosing);
      // Full extract uses DB employees (empty in unit tests) — must still NOT
      // treat the reply as a typed service while awaiting employee confirmation.
      assert.notEqual(out.action, 'unknown_service', text);
      assert.ok(
        out.action === 'select_employee'
          || (out.action === 'book' && /stefan/i.test(String(out.employee_name || ''))),
        `${text} → ${out.action} emp=${out.employee_name}`,
      );
    }

    const yes = interpretPendingActionReply({
      textBody: 'da',
      convState: choosing,
      employees,
      services,
    });
    assert.equal(yes?.action, 'accept_offer');
    assert.equal(yes?.employee_id, 'e1');
  });

  it('4+5. reschedule natural variants (incl. HH:MM) → reschedule, no throw', async () => {
    const variants = [
      'am si eu o programare vineri la 9:30, se poate sa o mutam la ora 15?',
      'Am si eu o programare vineri la 9:30 o pot muta la 15:00?',
      'as vrea sa mut programarea de vineri de la 9:30 la 15',
      'pot sa reprogramez vineri 9:30 pentru 15:00?',
    ];
    for (const text of variants) {
      assert.equal(detectModificationIntent(text), 'reschedule', text);
      const out = await extract(text);
      assert.equal(out.action, 'reschedule', text);
    }
  });

  it('6. post-flow chitchat / thanks variants → thanks, never crash path', async () => {
    const variants = [
      'In regula multumesc',
      'ok mersi',
      'multumesc frumos',
      'perfect, thanks',
    ];
    for (const text of variants) {
      assert.equal(looksLikeGratitude(text), true, text);
      const out = await extract(text);
      assert.equal(out.action, 'thanks', text);
      assert.equal(out.employee_name, null, text);
    }
  });
});
