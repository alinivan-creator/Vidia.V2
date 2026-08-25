import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  interpretPendingActionReply,
  looksLikeListClarification,
  PENDING_ACTIONS,
  readPendingAction,
} from '../src/services/pendingActionService.js';
import { CONVERSATION_STEPS } from '../src/db/conversationStateService.js';
import { BOOKING_WAIT, getBookingWait } from '../src/services/bookingWaitState.js';
import { BOOKING_PREFIXES } from '../src/services/flowIds.js';

const employees = [
  { id: 'e1', name: 'Mihai', active: true },
  { id: 'e2', name: 'Stefan', active: true },
];

describe('employee picker list + context', () => {
  it('presentTurn includes MISSING_EMPLOYEE + employee list kind (source guard)', async () => {
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      new URL('../src/services/turnPresent.js', import.meta.url),
      'utf8',
    );
    assert.match(src, /'MISSING_EMPLOYEE'/);
    assert.match(src, /kind === 'employee'/);
    assert.match(src, /listTeam/);
  });

  it('CHOOSING_EMPLOYEE wait is EMPLOYEE not SERVICE', () => {
    const conv = { current_step: CONVERSATION_STEPS.CHOOSING_EMPLOYEE, context_data: {} };
    assert.equal(getBookingWait(conv), BOOKING_WAIT.EMPLOYEE);
  });

  it('"Care lista?" is list clarification → reprompt_employee, not services', () => {
    const variants = ['Care lista?', 'care listă?', 'ce lista?', 'which list?', 'unde e lista'];
    for (const text of variants) {
      assert.equal(looksLikeListClarification(text), true, text);
    }
    const choosing = {
      current_step: CONVERSATION_STEPS.CHOOSING_EMPLOYEE,
      context_data: {
        pending_action: {
          kind: PENDING_ACTIONS.EMPLOYEE_SELECT,
          options: ['Mihai', 'Stefan'],
        },
        last_menu: {
          kind: 'employee',
          options: [
            { id: `${BOOKING_PREFIXES.EMPLOYEE}e1`, title: 'Mihai' },
            { id: `${BOOKING_PREFIXES.EMPLOYEE}e2`, title: 'Stefan' },
            { id: BOOKING_PREFIXES.ANY_EMPLOYEE, title: 'Primul disponibil' },
          ],
        },
      },
    };
    assert.equal(readPendingAction(choosing)?.kind, PENDING_ACTIONS.EMPLOYEE_SELECT);
    const out = interpretPendingActionReply({
      textBody: 'Care lista?',
      convState: choosing,
      employees,
    });
    assert.equal(out?.action, 'reprompt_employee');
  });

  it('numeric "1" while awaiting employee → select_employee Mihai', () => {
    const choosing = {
      current_step: CONVERSATION_STEPS.CHOOSING_EMPLOYEE,
      context_data: {
        pending_action: {
          kind: PENDING_ACTIONS.EMPLOYEE_SELECT,
          options: ['Mihai', 'Stefan'],
        },
        last_menu: {
          kind: 'employee',
          options: [
            { id: `${BOOKING_PREFIXES.EMPLOYEE}e1`, title: 'Mihai' },
            { id: `${BOOKING_PREFIXES.EMPLOYEE}e2`, title: 'Stefan' },
            { id: BOOKING_PREFIXES.ANY_EMPLOYEE, title: 'Primul disponibil' },
          ],
        },
      },
    };
    const out = interpretPendingActionReply({
      textBody: '1',
      convState: choosing,
      employees,
    });
    assert.equal(out?.action, 'select_employee');
    assert.equal(out?.employee_id, 'e1');
    assert.equal(out?.employee_name, 'Mihai');
  });
});
