import { logError } from '../db/loggerService.js';
import { getBookingConfig, getConfiguredBusinessHours, formatBusinessHoursText } from '../utils/datetime.js';
import { getBusinessContactInfo } from './contactService.js';

/** @typedef {import('../db/businessService.js').Business} Business */

/**
 * @typedef {Object} AiResponse
 * @property {string} text
 * @property {boolean} mocked
 * @property {string | null} model
 * @property {boolean} [needsCallback]
 * @property {string} [callbackReason]
 */

/** Sentinel the model must emit alone when the request is out of AI scope. */
export const CALLBACK_SENTINEL = 'NEED_CALLBACK';

/**
 * Builds a services catalog block for the AI system prompt.
 * @param {Business} business
 * @returns {string}
 */
export function buildServicesCatalog(business) {
  const { services } = getBookingConfig(business);
  if (!services.length) {
    return (
      '\n\nCATALOG SERVICII: nesetat.\n' +
      'Dacă clientul întreabă de servicii/prețuri/durată, spune clar că nu ai aceste date configurate încă.'
    );
  }

  const lines = services.map((s) => {
    const price = s.price_ron != null ? `${s.price_ron} LEI` : 'preț la cerere';
    return `- ${s.name}: ${price}, durată ${s.duration_minutes} minute`;
  });

  return (
    `\n\nCATALOG SERVICII ȘI PREȚURI (folosește exclusiv aceste date):\n` +
    lines.join('\n')
  );
}

/**
 * @param {Business} business
 * @returns {string}
 */
export function buildBusinessHoursContext(business) {
  const hours = getConfiguredBusinessHours(business);
  if (!hours) {
    return (
      '\n\nPROGRAM DE LUCRU: nesetat în Admin.\n' +
      'Dacă clientul întreabă de program/oră de deschidere/închidere, ' +
      'spune că nu ai programul configurat încă și invită-l să scrie *programare* ' +
      'sau să folosească meniul Contact. NU inventa ore.'
    );
  }

  return (
    '\n\nPROGRAM DE LUCRU (singura sursă de adevăr — nu inventa altceva):\n' +
    formatBusinessHoursText(hours)
  );
}

/**
 * @param {Business} business
 * @returns {string}
 */
export function buildContactContext(business) {
  const info = getBusinessContactInfo(business);
  const lines = [];
  if (info.phone) lines.push(`- Telefon: ${info.phone}`);
  if (info.email) lines.push(`- Email: ${info.email}`);
  if (info.address) lines.push(`- Adresă: ${info.address}`);
  if (info.website) lines.push(`- Website: ${info.website}`);
  if (info.mapsUrl) lines.push(`- Hartă: ${info.mapsUrl}`);
  if (!getConfiguredBusinessHours(business) && info.hours) {
    lines.push(`- Program (text): ${info.hours}`);
  }

  if (!lines.length) {
    return (
      '\n\nCONTACT: nesetat în Admin.\n' +
      'Dacă clientul cere telefon/adresă/email și nu apar mai sus, spune că nu ai datele.'
    );
  }

  return '\n\nDATE CONTACT (folosește exclusiv acestea):\n' + lines.join('\n');
}

/**
 * @param {Business} business
 * @returns {string}
 */
function buildFactsContext(business) {
  const facts = business.booking_settings?.ai_facts;
  if (typeof facts !== 'string' || !facts.trim()) return '';
  return (
    '\n\nFACTS ADMIN (poți folosi doar aceste fapte suplimentare):\n' +
    facts.trim()
  );
}

/**
 * @param {Business} business
 * @returns {string}
 */
function buildModeContext(business) {
  if (business.business_type === 'consulting') {
    return `
MOD AFACERE: CONSULTING (fără calendar online).
- Răspunde la FAQ (servicii, prețuri orientative, contact) pe scurt.
- Nu oferi sloturi de calendar și nu pretinde că poți programa online.
- Dacă clientul vrea întâlnire, ofertă personalizată sau să vorbească cu un specialist, răspunde EXACT cu linia: ${CALLBACK_SENTINEL}`;
  }

  return `
MOD AFACERE: BOOKING (programări online).
- Pentru programare nouă: îndrumă scurt să scrie *programare*.
- Pentru anulare: îndrumă să scrie *anulează*.
- Pentru reprogramare: îndrumă să scrie *reprogramare*.
- Nu inventa disponibilitate — sloturile vin din Google Calendar prin fluxul de programare.`;
}

const TRIAGE_AND_STYLE_RULES = `
STIL & TRIAJ (obligatoriu):
1. Răspunde politicos, la obiect, în română — maxim 2–4 propoziții scurte.
2. Recunoaște instant intenția: FAQ (pret/program/contact/servicii) → răspunde din datele de mai jos; programare → *programare*; modificare → *reprogramare* / *anulează*.
3. Nu folosi formulări vagi tip „te pot ajuta cu orice”. Fii concret.
4. Nu inventa prețuri, ore, adrese, politici sau disponibilitate.
5. Dacă cererea depășește atribuțiile tale (reclamatii complexe, facturare, legal, medical, oferte personalizate, negociere, sau orice lipsă din prompt), NU improviza — răspunde EXACT cu o singură linie: ${CALLBACK_SENTINEL}
6. Nu explica sentinelul către client. Nu adăuga alt text pe aceeași linie cu ${CALLBACK_SENTINEL}.`;

const ANTI_HALLUCINATION_RULES = `
REGULI OBLIGATORII (anti-halucinație):
1. Răspunde DOAR cu informații din acest system prompt (catalog, program, contact, facts, promptul afacerii).
2. Dacă o informație lipsește, spune politicos că nu o ai — sau folosește ${CALLBACK_SENTINEL} dacă e nevoie de un om.
3. Nu completa din cunoștințe generale despre frizerii/saloane/industrii.
4. Nu inventa ore de lucru, prețuri, adrese, politici sau disponibilitate.`;

/**
 * @param {Business} business
 * @returns {string}
 */
function buildSystemPrompt(business) {
  const base =
    business.ai_system_prompt?.trim() ||
    `Ești asistentul virtual al ${business.name}. Răspunde concis, politicos și util în română.`;

  return (
    base +
    `\n\nNume afacere: ${business.name}` +
    buildModeContext(business) +
    buildServicesCatalog(business) +
    buildBusinessHoursContext(business) +
    buildContactContext(business) +
    buildFactsContext(business) +
    TRIAGE_AND_STYLE_RULES +
    ANTI_HALLUCINATION_RULES
  );
}

/**
 * Deterministic replies for common factual questions (no LLM).
 * @param {Business} business
 * @param {string} userMessage
 * @returns {string | null}
 */
function factualReply(business, userMessage) {
  const q = userMessage
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const asksHours = /program|orar|orele|deschid|inchid|cand sunteti|la ce ora/.test(q);
  const asksPrice = /pret|cost|cat costa|tarif|lei|cat e/.test(q);
  const asksDuration = /durata|minute|cat dureaza|timp/.test(q);
  const asksServices = /servici|detali|info|informat|lista|ce oferi|ce faceti/.test(q);
  const asksContact = /contact|telefon|adresa|email|unde sunteti|locatie|harta|cum ajung/.test(q);

  if (asksHours) {
    const hours = getConfiguredBusinessHours(business);
    if (!hours) {
      const legacy = getBusinessContactInfo(business).hours;
      if (legacy) {
        return `*Program — ${business.name}*\n\n${legacy}` +
          (business.business_type === 'booking' ? '\n\nPentru rezervare, scrie *programare*.' : '');
      }
      return (
        `Nu am programul de lucru configurat încă pentru *${business.name}*.` +
        (business.business_type === 'booking'
          ? '\nPentru o programare, scrie *programare*.'
          : '\nDacă vrei să te contacteze echipa, scrie *callback*.')
      );
    }
    return (
      `*Program de lucru — ${business.name}*\n\n` +
      formatBusinessHoursText(hours).replace(/^- /gm, '• ') +
      (business.business_type === 'booking' ? '\n\nPentru rezervare, scrie *programare*.' : '')
    );
  }

  if (asksContact) {
    const info = getBusinessContactInfo(business);
    const lines = [`*Contact — ${business.name}*`, ''];
    if (info.phone) lines.push(`• Telefon: ${info.phone}`);
    if (info.email) lines.push(`• Email: ${info.email}`);
    if (info.address) lines.push(`• Adresă: ${info.address}`);
    if (info.website) lines.push(`• Website: ${info.website}`);
    if (info.mapsUrl) lines.push(`• Hartă: ${info.mapsUrl}`);
    if (lines.length === 2) {
      return `Nu am datele de contact configurate încă pentru *${business.name}*.`;
    }
    return lines.join('\n');
  }

  if (asksPrice || asksDuration || asksServices) {
    const { services } = getBookingConfig(business);
    if (!services.length) {
      return `Nu am lista de servicii/prețuri configurată încă pentru *${business.name}*.`;
    }
    const lines = [`*Servicii — ${business.name}*`, ''];
    for (const s of services) {
      const price = s.price_ron != null ? `${s.price_ron} LEI` : 'la cerere';
      lines.push(`• *${s.name}* — ${price} · ${s.duration_minutes} min`);
    }
    if (business.business_type === 'booking') {
      lines.push('', 'Pentru programare, scrie *programare*.');
    } else {
      lines.push('', 'Pentru o discuție cu echipa, scrie *callback*.');
    }
    return lines.join('\n');
  }

  return null;
}

/**
 * @param {string} text
 * @returns {{ needsCallback: boolean; cleanText: string }}
 */
export function parseAiCallbackSignal(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { needsCallback: false, cleanText: '' };

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hasSentinel = lines.some((l) => {
    const upper = l.toUpperCase();
    return upper === CALLBACK_SENTINEL || upper.startsWith(`${CALLBACK_SENTINEL}:`);
  });
  if (hasSentinel) {
    return { needsCallback: true, cleanText: '' };
  }

  return { needsCallback: false, cleanText: raw };
}

/**
 * @param {Business} business
 * @param {string} userMessage
 * @returns {string}
 */
function mockAiResponse(business, userMessage) {
  const factual = factualReply(business, userMessage);
  if (factual) return factual;

  if (business.business_type === 'consulting') {
    return CALLBACK_SENTINEL;
  }

  return (
    `Bună! Sunt asistentul *${business.name}*.\n\n` +
    `Pot ajuta cu: *programare*, *reprogramare*, *anulează*, prețuri/program/contact.\n` +
    `Pentru altceva, scrie *callback* — te contactează echipa.`
  );
}

/**
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.userMessage
 * @param {string | null} [params.requestId]
 * @returns {Promise<AiResponse | null>}
 */
async function callOpenAi({ business, userMessage, requestId = null }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: business.ai_model || 'gpt-4o-mini',
        temperature: Math.min(Number(business.ai_temperature ?? 0.2), 0.25),
        max_tokens: 280,
        messages: [
          { role: 'system', content: buildSystemPrompt(business) },
          { role: 'user', content: userMessage },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      await logError({
        message: 'OpenAI API call failed',
        source: 'ai',
        severity: 'error',
        businessId: business.id,
        requestId,
        httpStatus: response.status,
        details: { response: data },
      });
      return null;
    }

    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) {
      return null;
    }

    const parsed = parseAiCallbackSignal(text);
    return {
      text: parsed.cleanText || text,
      mocked: false,
      model: business.ai_model,
      needsCallback: parsed.needsCallback,
      callbackReason: parsed.needsCallback ? 'ai_out_of_scope' : undefined,
    };
  } catch (error) {
    console.error('Eroare detalii:', error);
    await logError({
      message: 'OpenAI API network error',
      source: 'ai',
      severity: 'error',
      businessId: business.id,
      requestId,
      error,
    });
    return null;
  }
}

/**
 * @param {Object} params
 * @param {Business} params.business
 * @param {string} params.userMessage
 * @param {string | null} [params.requestId]
 * @returns {Promise<AiResponse>}
 */
export async function generateAiReply({ business, userMessage, requestId = null }) {
  const factual = factualReply(business, userMessage);
  if (factual) {
    return { text: factual, mocked: false, model: 'rules', needsCallback: false };
  }

  const live = await callOpenAi({ business, userMessage, requestId });
  if (live) {
    return live;
  }

  const mockedText = mockAiResponse(business, userMessage);
  const parsed = parseAiCallbackSignal(mockedText);
  return {
    text: parsed.cleanText || mockedText,
    mocked: true,
    model: null,
    needsCallback: parsed.needsCallback,
    callbackReason: parsed.needsCallback ? 'ai_fallback_out_of_scope' : undefined,
  };
}

/**
 * @param {Business} business
 * @returns {string}
 */
export function buildInfoButtonPrompt(business) {
  return `Vreau lista de servicii cu prețuri (în LEI) și durata fiecăruia pentru ${business.name}.`;
}
