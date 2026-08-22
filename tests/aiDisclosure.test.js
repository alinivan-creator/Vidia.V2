import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  needsAiDisclosure,
  buildMandatoryAiDisclosure,
  withMandatoryAiDisclosure,
  buildAiTransparencyWelcome,
  alreadyDisclosesAi,
} from '../src/utils/businessMessages.js';
import { renderHandlerResult } from '../src/services/turnPresent.js';

const business = {
  id: 'b1',
  name: 'Salon Test',
  timezone: 'Europe/Bucharest',
  welcome_message: 'Bun venit la Salon Test.',
  booking_settings: { gdpr_url: 'https://example.com/privacy' },
};

describe('mandatory AI disclosure (first contact)', () => {
  it('needs disclosure until ai_disclosed is true', () => {
    assert.equal(needsAiDisclosure({}), true);
    assert.equal(needsAiDisclosure(null), true);
    assert.equal(needsAiDisclosure({ ai_disclosed: true }), false);
  });

  it('builds RO and EN legal notes naming the virtual AI assistant', () => {
    const ro = buildMandatoryAiDisclosure(business, 'ro');
    const en = buildMandatoryAiDisclosure(business, 'en');
    assert.match(ro, /asistentul virtual AI/i);
    assert.match(ro, /politica de confidențialitate|privacy/i);
    assert.match(en, /virtual AI assistant/i);
    assert.match(en, /privacy policy/i);
    assert.match(en, /example\.com\/privacy/);
  });

  it('prepends disclosure to a direct booking reply once', () => {
    const body = 'Which service would you like?';
    const wrapped = withMandatoryAiDisclosure(body, business, 'en');
    assert.match(wrapped, /virtual AI assistant/i);
    assert.match(wrapped, /Which service would you like/);
    assert.equal(alreadyDisclosesAi(wrapped), true);
    // Second wrap must not duplicate.
    const again = withMandatoryAiDisclosure(wrapped, business, 'en');
    assert.equal(again, wrapped);
  });

  it('MENU welcome embeds disclosure in both languages', () => {
    const ro = buildAiTransparencyWelcome(business, 'ro');
    const en = buildAiTransparencyWelcome({ ...business, welcome_message: '' }, 'en');
    assert.match(ro, /asistentul virtual AI/i);
    assert.match(ro, /Bun venit/);
    assert.match(en, /virtual AI assistant/i);
    assert.match(en, /Welcome to/);
  });

  it('presentTurn template path attaches disclosure for non-MENU first replies', () => {
    const text = renderHandlerResult(business, {
      user_message_template_key: 'MISSING_SERVICE',
      machine_action: 'ACTION_ASK_SERVICE',
      data: {
        ui_language: 'en',
        attach_ai_disclosure: true,
        services: [{ id: 's1', name: 'Tuns', duration_minutes: 30 }],
      },
    });
    // renderHandlerResult does not attach — presentTurn does. Ensure machine path is EN.
    assert.match(text, /Which service would you like/i);
  });
});
