const API = '/admin';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let businesses = [];
let logsPollInterval = null;
/** @type {any} */
let currentJournal = null;
let currentJournalTab = 'errors';
let defaultSystemPrompt = '';
let defaultConversationLogic = '';

async function loadAiDefaults() {
  try {
    const data = await api('/ai-defaults');
    defaultSystemPrompt = typeof data.system_prompt === 'string' ? data.system_prompt : '';
    defaultConversationLogic = typeof data.conversation_logic === 'string' ? data.conversation_logic : '';
  } catch {
    defaultSystemPrompt = '';
    defaultConversationLogic = '';
  }
}

async function api(path, options = {}) {
  const { optional = false, ...fetchOpts } = options;
  const res = await fetch(`${API}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(fetchOpts.headers || {}) },
    ...fetchOpts,
  });

  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    const isLogin = path === '/login' || String(path).endsWith('/login');
    if (!optional && !isLogin) showLogin();
    throw new Error(data.error || 'Unauthorized');
  }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function showLogin() {
  $('#login-screen').classList.remove('hidden');
  $('#dashboard').classList.add('hidden');
  stopLogsPoll();
}

function showDashboard() {
  $('#login-screen').classList.add('hidden');
  $('#dashboard').classList.remove('hidden');
}

async function loadSchemaHealth() {
  const banner = $('#schema-alert-banner');
  const list = $('#schema-alert-list');
  if (!banner || !list) return;
  try {
    const health = await api('/health', { optional: true });
    const alerts = health.alerts || [];
    if (!alerts.length) {
      banner.classList.add('hidden');
      list.innerHTML = '';
      return;
    }
    list.innerHTML = alerts.map((a) => `
      <p><strong>${esc(a.message)}</strong>${a.hint ? ` — ${esc(a.hint)}` : ''}</p>
    `).join('');
    banner.classList.remove('hidden');
  } catch {
    banner.classList.add('hidden');
  }
}

$('#schema-refresh-btn')?.addEventListener('click', async () => {
  const btn = $('#schema-refresh-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Se reîmprospătează…';
  }
  try {
    const result = await api('/schema/refresh', { method: 'POST' });
    await loadSchemaHealth();
    if (result.message) {
      const list = $('#schema-alert-list');
      if (list && !result.ok) {
        list.innerHTML = `<p>${esc(result.message)}</p>` + list.innerHTML;
        $('#schema-alert-banner')?.classList.remove('hidden');
      }
    }
  } catch (err) {
    const list = $('#schema-alert-list');
    if (list) {
      list.innerHTML = `<p>Reîmprospătarea a eșuat: ${esc(err.message || 'eroare')}</p>`;
      $('#schema-alert-banner')?.classList.remove('hidden');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Reîmprospătează schema';
    }
  }
});

$('#schema-alert-logs-btn')?.addEventListener('click', () => {
  document.querySelector('[data-tab="logs"]')?.click();
});

async function checkSession() {
  try {
    await api('/session');
    showDashboard();
    await Promise.all([loadBusinesses(), loadAiDefaults(), loadSchemaHealth()]);
    startLogsPoll();
  } catch {
    showLogin();
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('#login-password').value;
  $('#login-error').classList.add('hidden');

  try {
    await api('/login', { method: 'POST', body: JSON.stringify({ password }) });
    showDashboard();
    await Promise.all([loadBusinesses(), loadAiDefaults(), loadSchemaHealth()]);
    startLogsPoll();
  } catch (err) {
    $('#login-error').textContent = err.message || 'Parolă incorectă';
    $('#login-error').classList.remove('hidden');
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

// Tabs
$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach((b) => {
      b.classList.remove('tab-active', 'text-vidia-red');
      b.classList.add('text-slate-500');
    });
    btn.classList.add('tab-active');
    btn.classList.remove('text-slate-500');

    const tab = btn.dataset.tab;
    $('#tab-businesses').classList.toggle('hidden', tab !== 'businesses');
    $('#tab-settings').classList.toggle('hidden', tab !== 'settings');
    $('#tab-logs').classList.toggle('hidden', tab !== 'logs');

    if (tab === 'logs') loadLogs();
    if (tab === 'settings') loadGoogleMasterSettings();
  });
});

// Module preview
function setPreview(type) {
  const booking = $('#preview-booking');
  const consulting = $('#preview-consulting');

  if (type === 'booking') {
    booking.className = 'preview-btn flex-1 border-2 border-vidia-red bg-red-50 rounded-lg p-4 text-left';
    consulting.className = 'preview-btn flex-1 border-2 border-vidia-border rounded-lg p-4 text-left hover:border-slate-300';
    $('#preview-desc').innerHTML = 'Modul <strong>booking</strong> — programări, calendar proxy, sloturi WhatsApp.';
  } else {
    consulting.className = 'preview-btn flex-1 border-2 border-vidia-red bg-red-50 rounded-lg p-4 text-left';
    booking.className = 'preview-btn flex-1 border-2 border-vidia-border rounded-lg p-4 text-left hover:border-slate-300';
    $('#preview-desc').innerHTML = 'Modul <strong>consulting</strong> — AI expert, fără calendar, colectare contact.';
  }
}

$('#preview-booking').addEventListener('click', () => setPreview('booking'));
$('#preview-consulting').addEventListener('click', () => setPreview('consulting'));

// Businesses
async function loadBusinesses() {
  const data = await api('/businesses');
  businesses = data.businesses || [];
  renderBusinesses();
  updateLogsFilter();
}

function renderBusinesses() {
  const el = $('#businesses-list');
  if (!businesses.length) {
    el.innerHTML = '<p class="text-sm text-slate-500">Nicio afacere înregistrată.</p>';
    return;
  }

  el.innerHTML = businesses.map((b) => {
    const typeBadge = b.business_type === 'booking'
      ? '<span class="bg-red-50 text-vidia-red text-xs px-2 py-0.5 rounded-full">booking</span>'
      : '<span class="bg-slate-100 text-slate-600 text-xs px-2 py-0.5 rounded-full">consulting</span>';
    const isActive = b.status === 'active';
    const statusBadge = isActive
      ? '<span class="bg-green-50 text-green-700 text-xs px-2 py-0.5 rounded-full">active</span>'
      : '<span class="bg-yellow-50 text-yellow-700 text-xs px-2 py-0.5 rounded-full">suspendat</span>';
    const toggleLabel = isActive ? 'Suspendă' : 'Reactivează';
    const toggleClass = isActive
      ? 'border-yellow-300 text-yellow-800 hover:bg-yellow-50'
      : 'border-green-300 text-green-800 hover:bg-green-50';

    return `
      <div class="bg-white border border-vidia-border rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div class="flex items-center gap-2 mb-1 flex-wrap">
            <h3 class="font-semibold">${esc(b.name)}</h3>
            ${typeBadge} ${statusBadge}
          </div>
          <p class="text-xs text-slate-500">slug: ${esc(b.slug)} · phone_id: ${esc(b.whatsapp_phone_number_id || '—')}</p>
          <p class="text-xs text-slate-400 mt-1">Creat: ${new Date(b.created_at).toLocaleString('ro-RO')}</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button data-edit="${b.id}" class="edit-business-btn text-sm border border-vidia-border px-3 py-2 rounded-lg hover:bg-vidia-light">
            Editează
          </button>
          <button data-journal="${b.id}" class="journal-business-btn text-sm border border-vidia-border px-3 py-2 rounded-lg hover:bg-vidia-light">
            Jurnale
          </button>
          <button data-toggle-status="${b.id}" data-next-status="${isActive ? 'paused' : 'active'}"
            class="toggle-status-btn text-sm border px-3 py-2 rounded-lg ${toggleClass}">
            ${toggleLabel}
          </button>
          <button data-delete="${b.id}" data-name="${esc(b.name)}"
            class="delete-business-btn text-sm border border-red-200 text-vidia-red px-3 py-2 rounded-lg hover:bg-red-50">
            Șterge
          </button>
        </div>
      </div>`;
  }).join('');

  $$('.edit-business-btn').forEach((btn) => {
    btn.addEventListener('click', () => openBusinessModal(btn.dataset.edit));
  });

  $$('.journal-business-btn').forEach((btn) => {
    btn.addEventListener('click', () => openBusinessModal(btn.dataset.journal, { focusJournal: true }));
  });

  $$('.toggle-status-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const next = btn.dataset.nextStatus;
      const label = next === 'paused' ? 'suspendezi' : 'reactivezi';
      if (!confirm(`Sigur ${label} această afacere?`)) return;
      try {
        await api(`/businesses/${btn.dataset.toggleStatus}/status`, {
          method: 'PATCH',
          body: JSON.stringify({ status: next }),
        });
        await loadBusinesses();
      } catch (err) {
        alert(err.message || 'Eroare status');
      }
    });
  });

  $$('.delete-business-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name || 'această afacere';
      if (!confirm(`Ștergi definitiv „${name}”? Datele conexe (programări, servicii, cache) vor fi eliminate.`)) {
        return;
      }
      try {
        await api(`/businesses/${btn.dataset.delete}`, { method: 'DELETE' });
        await loadBusinesses();
      } catch (err) {
        alert(err.message || 'Eroare ștergere');
      }
    });
  });
}

function updateLogsFilter() {
  const sel = $('#logs-business-filter');
  const current = sel.value;
  sel.innerHTML = '<option value="">Toate afacerile</option>' +
    businesses.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  sel.value = current;
}

// Modal
const defaultServices = [
  { id: 'tuns-clasic', name: 'Tuns Clasic', price_ron: 50, duration_minutes: 30 },
  { id: 'tuns-barba', name: 'Tuns + Barba', price_ron: 80, duration_minutes: 45 },
  { id: 'aranjat-barba', name: 'Aranjat Barba', price_ron: 30, duration_minutes: 20 },
];

const defaultSettings = {
  slot_interval_minutes: 30,
  booking_horizon_days: 7,
  pending_ttl_minutes: 5,
  business_hours: {
    '0': null,
    '1': { open: '09:00', close: '18:00' },
    '2': { open: '09:00', close: '18:00' },
    '3': { open: '09:00', close: '18:00' },
    '4': { open: '09:00', close: '18:00' },
    '5': { open: '09:00', close: '18:00' },
    '6': { open: '10:00', close: '14:00' },
  },
  services: defaultServices,
  contact: { phone: '', email: '', address: '', website: '', maps_url: '' },
  ai_facts: '',
};

const WEEKDAY_ROWS = [
  { key: '1', label: 'Luni' },
  { key: '2', label: 'Marți' },
  { key: '3', label: 'Miercuri' },
  { key: '4', label: 'Joi' },
  { key: '5', label: 'Vineri' },
  { key: '6', label: 'Sâmbătă' },
  { key: '0', label: 'Duminică' },
];

function renderHoursEditor(hours) {
  const root = $('#bf-hours');
  if (!root) return;
  const src = hours && typeof hours === 'object' ? hours : defaultSettings.business_hours;
  root.innerHTML = WEEKDAY_ROWS.map(({ key, label }) => {
    const h = src[key];
    const open = h?.open || '09:00';
    const close = h?.close || '18:00';
    const closed = !h || !h.open || !h.close;
    return `
      <div class="grid grid-cols-[7rem_1fr_1fr_auto] gap-2 items-center text-sm" data-day="${key}">
        <span class="font-medium">${label}</span>
        <input type="time" data-open class="border border-vidia-border rounded-lg px-2 py-1.5" value="${open}" ${closed ? 'disabled' : ''} />
        <input type="time" data-close class="border border-vidia-border rounded-lg px-2 py-1.5" value="${close}" ${closed ? 'disabled' : ''} />
        <label class="flex items-center gap-1 text-xs text-slate-600 whitespace-nowrap">
          <input type="checkbox" data-closed class="rounded border-vidia-border text-vidia-red focus:ring-vidia-red" ${closed ? 'checked' : ''} />
          Închis
        </label>
      </div>`;
  }).join('');

  root.querySelectorAll('[data-day]').forEach((row) => {
    const closedCb = row.querySelector('[data-closed]');
    const openIn = row.querySelector('[data-open]');
    const closeIn = row.querySelector('[data-close]');
    closedCb?.addEventListener('change', () => {
      const off = closedCb.checked;
      if (openIn) openIn.disabled = off;
      if (closeIn) closeIn.disabled = off;
    });
  });
}

function collectHoursFromEditor() {
  /** @type {Record<string, { open: string; close: string } | null>} */
  const hours = {};
  $('#bf-hours')?.querySelectorAll('[data-day]').forEach((row) => {
    const key = row.getAttribute('data-day');
    if (!key) return;
    const closed = row.querySelector('[data-closed]')?.checked;
    if (closed) {
      hours[key] = null;
      return;
    }
    const open = row.querySelector('[data-open]')?.value || '09:00';
    const close = row.querySelector('[data-close]')?.value || '18:00';
    hours[key] = { open, close };
  });
  return hours;
}

function fillContactFields(contact = {}) {
  $('#bf-contact-phone').value = contact.phone || '';
  $('#bf-contact-email').value = contact.email || '';
  $('#bf-contact-address').value = contact.address || '';
  $('#bf-contact-website').value = contact.website || '';
  $('#bf-contact-maps').value = contact.maps_url || contact.mapsUrl || '';
}

function collectContactFromForm() {
  return {
    phone: $('#bf-contact-phone').value.trim() || '',
    email: $('#bf-contact-email').value.trim() || '',
    address: $('#bf-contact-address').value.trim() || '',
    website: $('#bf-contact-website').value.trim() || '',
    maps_url: $('#bf-contact-maps').value.trim() || '',
  };
}

function slugifyService(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || `svc-${Date.now()}`;
}

function renderServicesRows(services) {
  const body = $('#bf-services-body');
  body.innerHTML = '';
  (services || []).forEach((s, idx) => {
    const tr = document.createElement('tr');
    tr.className = 'border-t border-vidia-border';
    tr.innerHTML = `
      <td class="px-2 py-1"><input data-field="name" value="${esc(s.name || '')}" class="w-full border border-vidia-border rounded px-2 py-1 text-sm" /></td>
      <td class="px-2 py-1"><input data-field="price_ron" type="number" min="0" value="${s.price_ron ?? ''}" class="w-full border border-vidia-border rounded px-2 py-1 text-sm" /></td>
      <td class="px-2 py-1"><input data-field="duration_minutes" type="number" min="5" step="5" value="${s.duration_minutes ?? 30}" class="w-full border border-vidia-border rounded px-2 py-1 text-sm" /></td>
      <td class="px-2 py-1 text-center"><button type="button" data-remove="${idx}" class="text-vidia-red text-xs">✕</button></td>
    `;
    tr.dataset.id = s.id || slugifyService(s.name || `svc-${idx}`);
    body.appendChild(tr);
  });

  body.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      btn.closest('tr')?.remove();
    });
  });
}

function collectServicesFromTable() {
  return [...$('#bf-services-body').querySelectorAll('tr')].map((tr, idx) => {
    const name = tr.querySelector('[data-field="name"]')?.value?.trim() || `Serviciu ${idx + 1}`;
    const price = Number(tr.querySelector('[data-field="price_ron"]')?.value);
    const duration = Number(tr.querySelector('[data-field="duration_minutes"]')?.value) || 30;
    return {
      id: tr.dataset.id || slugifyService(name),
      name,
      price_ron: Number.isFinite(price) ? price : null,
      duration_minutes: duration,
    };
  });
}

$('#bf-add-service')?.addEventListener('click', () => {
  const current = collectServicesFromTable();
  current.push({ id: `svc-${Date.now()}`, name: '', price_ron: 50, duration_minutes: 30 });
  renderServicesRows(current);
});

/** @type {Array<{ id?: string; name: string; google_calendar_id?: string | null; active?: boolean }>} */
let modalEmployees = [];

function renderEmployeesRows(employees) {
  modalEmployees = (employees || []).map((e) => ({ ...e }));
  const body = $('#bf-employees-body');
  if (!body) return;
  body.innerHTML = '';
  modalEmployees.forEach((e, idx) => {
    const tr = document.createElement('tr');
    tr.className = 'border-t border-vidia-border';
    tr.dataset.id = e.id || '';
    tr.innerHTML = `
      <td class="px-2 py-1"><input data-field="name" value="${esc(e.name || '')}" class="w-full border border-vidia-border rounded px-2 py-1 text-sm" /></td>
      <td class="px-2 py-1"><input data-field="calendar" value="${esc(e.google_calendar_id || '')}" class="w-full border border-vidia-border rounded px-2 py-1 text-sm" placeholder="email@gmail.com" /></td>
      <td class="px-2 py-1 text-center"><input data-field="active" type="checkbox" ${e.active !== false ? 'checked' : ''} /></td>
      <td class="px-2 py-1 text-center"><button type="button" data-remove-emp="${idx}" class="text-vidia-red text-xs">✕</button></td>
    `;
    body.appendChild(tr);
  });
  body.querySelectorAll('[data-remove-emp]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.closest('tr')?.dataset.id;
      btn.closest('tr')?.remove();
      if (id && $('#bf-id').value) {
        api(`/businesses/${$('#bf-id').value}/employees/${id}`, { method: 'DELETE' }).catch(() => {});
      }
    });
  });
}

function collectEmployeesFromTable() {
  return [...($('#bf-employees-body')?.querySelectorAll('tr') || [])].map((tr, idx) => ({
    id: tr.dataset.id || undefined,
    name: tr.querySelector('[data-field="name"]')?.value?.trim() || `Angajat ${idx + 1}`,
    google_calendar_id: tr.querySelector('[data-field="calendar"]')?.value?.trim() || null,
    active: Boolean(tr.querySelector('[data-field="active"]')?.checked),
    sort_order: idx,
  }));
}

$('#bf-add-employee')?.addEventListener('click', () => {
  const current = collectEmployeesFromTable();
  current.push({ name: '', google_calendar_id: null, active: true, sort_order: current.length });
  renderEmployeesRows(current);
});

async function loadEmployeesForBusiness(businessId) {
  const warn = $('#bf-employees-warning');
  if (!businessId) {
    renderEmployeesRows([]);
    if (warn) {
      warn.classList.add('hidden');
      warn.textContent = '';
    }
    return;
  }
  try {
    const data = await api(`/businesses/${businessId}/employees`, { optional: true });
    renderEmployeesRows(data.employees || []);
    if (warn) {
      if (data.warning) {
        warn.textContent = data.warning;
        warn.classList.remove('hidden');
      } else {
        warn.classList.add('hidden');
        warn.textContent = '';
      }
    }
  } catch {
    renderEmployeesRows([]);
    if (warn) {
      warn.textContent = 'Eroare: nu am putut încărca angajații.';
      warn.classList.remove('hidden');
    }
  }
}

async function persistEmployees(businessId) {
  if (!businessId) return;
  const rows = collectEmployeesFromTable();
  for (const row of rows) {
    if (!row.name) continue;
    await api(`/businesses/${businessId}/employees`, {
      method: 'POST',
      body: JSON.stringify({ ...row, business_id: businessId }),
    });
  }
}

$('#bf-sms-send')?.addEventListener('click', async () => {
  const businessId = $('#bf-id').value;
  const status = $('#bf-sms-status');
  const btn = $('#bf-sms-send');
  if (!businessId) {
    status.textContent = 'Salvează mai întâi afacerea, apoi trimite campania.';
    return;
  }
  const body = ($('#bf-sms-body').value || '').trim();
  if (body.length < 3) {
    status.textContent = 'Mesajul SMS este prea scurt.';
    return;
  }
  const phones = ($('#bf-sms-recipients')?.value || '').trim();
  status.textContent = 'Se trimite…';
  status.classList.remove('text-vidia-red');
  if (btn) btn.disabled = true;
  try {
    const result = await api(`/businesses/${businessId}/sms-campaigns`, {
      method: 'POST',
      body: JSON.stringify({ body, phones }),
    });
    const parts = [];
    if (result.error && !(result.sent > 0)) parts.push(result.error);
    parts.push(`Trimise cu succes: ${result.sent ?? 0}/${result.targetCount ?? 0}`);
    if (result.failed) parts.push(`eșuate: ${result.failed}`);
    if (result.skipped) parts.push(`sărite (fără opt-in): ${result.skipped}`);
    if (result.invalid?.length) parts.push(`invalide: ${result.invalid.length}`);
    if (result.truncated) parts.push('listă trunchiată la 200 numere');
    let text = parts.join(' · ');
    const errLines = [];
    if (result.invalid?.length) {
      errLines.push(`Invalide: ${result.invalid.slice(0, 8).join(', ')}`);
    }
    if (result.errors?.length) {
      errLines.push(...result.errors.slice(0, 8).map((e) => `${e.phone}: ${e.error}`));
    }
    if (errLines.length) text += `\n${errLines.join('\n')}`;
    status.textContent = text;
    status.classList.toggle('text-vidia-red', !result.ok && !(result.sent > 0));
    loadSmsOptInCount(businessId);
  } catch (err) {
    status.textContent = err.message || 'Campanie eșuată';
    status.classList.add('text-vidia-red');
  } finally {
    if (btn) btn.disabled = false;
  }
});

function openBusinessModal(id = null, opts = {}) {
  $('#business-modal').classList.remove('hidden');
  $('#form-error').classList.add('hidden');
  currentJournal = null;
  currentJournalTab = 'errors';

  if (id) {
    const b = businesses.find((x) => x.id === id);
    if (!b) return;
    $('#modal-title').textContent = 'Editează afacere';
    $('#bf-id').value = b.id;
    $('#bf-name').value = b.name;
    $('#bf-slug').value = b.slug;
    $('#bf-type').value = b.business_type;
    $('#bf-status').value = b.status;
    ensureTimezoneOption(b.timezone || 'Europe/Bucharest');
    $('#bf-timezone').value = b.timezone || 'Europe/Bucharest';
    $('#bf-phone-id').value = b.whatsapp_phone_number_id || '';
    $('#bf-token').value = '';
    $('#bf-twilio-sid').value = b.twilio_account_sid || '';
    $('#bf-twilio-token').value = '';
    $('#bf-calendar').value = b.google_calendar_id || '';
    $('#bf-g-mock').checked = b.google_calendar_mock_mode !== false;
    $('#bf-prompt').value = b.ai_system_prompt || '';
    ensureAiModelOption(b.ai_model || 'gpt-4o-mini');
    $('#bf-ai-model').value = b.ai_model || 'gpt-4o-mini';
    $('#bf-ai-temperature').value = b.ai_temperature != null ? String(b.ai_temperature) : '0.3';
    $('#bf-welcome').value = b.welcome_message || '';
    const settings = b.booking_settings || {};
    $('#bf-confirmation').value =
      typeof settings.confirmation_message === 'string' ? settings.confirmation_message : '';
    $('#bf-terms-url').value = typeof settings.terms_url === 'string' ? settings.terms_url : '';
    $('#bf-gdpr-url').value =
      typeof settings.gdpr_url === 'string'
        ? settings.gdpr_url
        : (typeof settings.privacy_url === 'string' ? settings.privacy_url : '');
    $('#bf-slot-interval').value = settings.slot_interval_minutes ?? defaultSettings.slot_interval_minutes;
    $('#bf-horizon-days').value = settings.booking_horizon_days ?? defaultSettings.booking_horizon_days;
    $('#bf-buffer-minutes').value = settings.buffer_minutes ?? 0;
    $('#bf-pending-ttl') && ($('#bf-pending-ttl').value = settings.pending_ttl_minutes ?? defaultSettings.pending_ttl_minutes);
    const advanced = { ...settings };
    delete advanced.services;
    delete advanced.google;
    delete advanced.twilio;
    delete advanced.business_hours;
    delete advanced.contact;
    delete advanced.ai_facts;
    delete advanced.confirmation_message;
    delete advanced.terms_url;
    delete advanced.gdpr_url;
    delete advanced.privacy_url;
    delete advanced.sms_from_number;
    delete advanced.slot_interval_minutes;
    delete advanced.booking_horizon_days;
    delete advanced.buffer_minutes;
    delete advanced.pending_ttl_minutes;
    delete advanced.conversation_logic;
    $('#bf-settings').value = Object.keys(advanced).length ? JSON.stringify(advanced, null, 2) : '{}';
    $('#bf-ai-facts').value = typeof settings.ai_facts === 'string' ? settings.ai_facts : '';
    if ($('#bf-conversation-logic')) {
      $('#bf-conversation-logic').value =
        typeof settings.conversation_logic === 'string' && settings.conversation_logic.trim()
          ? settings.conversation_logic
          : defaultConversationLogic;
    }
    renderHoursEditor(settings.business_hours || defaultSettings.business_hours);
    fillContactFields(settings.contact || {});
    renderServicesRows(b.services || settings.services || defaultServices);
    $('#bf-sms-from').value = typeof settings.sms_from_number === 'string' ? settings.sms_from_number : '';
    $('#bf-sms-recipients').value = '';
    $('#bf-sms-body').value = '';
    $('#bf-sms-status').textContent = '';
    $('#bf-sms-optin-count').textContent = '';
    $('#bf-journal-section').classList.remove('hidden');
    loadEmployeesForBusiness(b.id);
    loadSmsOptInCount(b.id);
    loadBusinessJournal(b.id).then(() => {
      if (opts.focusJournal) {
        $('#bf-journal-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    setPreview(b.business_type === 'consulting' ? 'consulting' : 'booking');
  } else {
    $('#modal-title').textContent = 'Adaugă afacere';
    $('#business-form').reset();
    $('#bf-id').value = '';
    $('#bf-type').value = 'booking';
    $('#bf-status').value = 'active';
    $('#bf-timezone').value = 'Europe/Bucharest';
    $('#bf-g-mock').checked = true;
    $('#bf-twilio-sid').value = '';
    $('#bf-twilio-token').value = '';
    $('#bf-ai-model').value = 'gpt-4o-mini';
    $('#bf-ai-temperature').value = '0.3';
    $('#bf-prompt').value = defaultSystemPrompt;
    $('#bf-conversation-logic').value = defaultConversationLogic;
    $('#bf-slot-interval').value = String(defaultSettings.slot_interval_minutes);
    $('#bf-horizon-days').value = String(defaultSettings.booking_horizon_days);
    $('#bf-buffer-minutes').value = '0';
    $('#bf-pending-ttl').value = String(defaultSettings.pending_ttl_minutes);
    $('#bf-settings').value = '{}';
    $('#bf-ai-facts').value = '';
    $('#bf-welcome').value = '';
    $('#bf-confirmation').value = '';
    $('#bf-terms-url').value = '';
    $('#bf-gdpr-url').value = '';
    $('#bf-sms-from').value = '';
    if ($('#bf-sms-recipients')) $('#bf-sms-recipients').value = '';
    $('#bf-sms-body').value = '';
    $('#bf-sms-status').textContent = '';
    $('#bf-sms-optin-count').textContent = '';
    $('#bf-journal-section').classList.add('hidden');
    $('#bf-journal-body').innerHTML = '';
    $('#bf-journal-stats').innerHTML = '';
    renderHoursEditor(defaultSettings.business_hours);
    fillContactFields(defaultSettings.contact);
    renderServicesRows(defaultServices);
    renderEmployeesRows([]);
    setPreview('booking');
  }
}

function ensureTimezoneOption(tz) {
  const sel = $('#bf-timezone');
  if (![...sel.options].some((o) => o.value === tz)) {
    const opt = document.createElement('option');
    opt.value = tz;
    opt.textContent = tz;
    sel.appendChild(opt);
  }
}

function ensureAiModelOption(model) {
  const sel = $('#bf-ai-model');
  if (![...sel.options].some((o) => o.value === model)) {
    const opt = document.createElement('option');
    opt.value = model;
    opt.textContent = model;
    sel.appendChild(opt);
  }
}

async function loadSmsOptInCount(businessId) {
  const el = $('#bf-sms-optin-count');
  if (!el || !businessId) return;
  try {
    const data = await api(`/businesses/${businessId}/sms-opted-in`, { optional: true });
    el.textContent = `Clienți cu opt-in SMS: ${data.count ?? (data.clients || []).length}`;
  } catch {
    el.textContent = 'Opt-in SMS: — (migrarea 010?)';
  }
}

async function loadBusinessJournal(businessId) {
  const body = $('#bf-journal-body');
  const stats = $('#bf-journal-stats');
  if (!businessId || !body) return;
  body.innerHTML = '<p class="text-xs text-slate-500">Se încarcă jurnalul…</p>';
  try {
    currentJournal = await api(`/businesses/${businessId}/journal?limit=40`, { optional: true });
    const s = currentJournal.stats || {};
    const schemaAlerts = currentJournal.schemaAlerts || [];
    stats.innerHTML = [
      schemaAlerts.length
        ? `<span class="px-2 py-1 rounded-full bg-red-100 text-red-800 font-medium">Alertă schemă: ${schemaAlerts.length}</span>`
        : '',
      `<span class="px-2 py-1 rounded-full bg-red-50 text-red-700">Erori deschise: ${s.openErrors ?? 0}</span>`,
      `<span class="px-2 py-1 rounded-full bg-blue-50 text-blue-700">Callback pending: ${s.pendingCallbacks ?? 0}</span>`,
      `<span class="px-2 py-1 rounded-full bg-slate-100 text-slate-700">Programări recente: ${s.recentBookings ?? 0}</span>`,
      `<span class="px-2 py-1 rounded-full bg-amber-50 text-amber-800">Pending TTL: ${s.pendingHolds ?? 0}</span>`,
      `<span class="px-2 py-1 rounded-full bg-emerald-50 text-emerald-800">Sesiuni active: ${s.liveSessions ?? 0}</span>`,
      `<span class="px-2 py-1 rounded-full bg-slate-100 text-slate-700">Campanii SMS: ${s.smsCampaigns ?? 0}</span>`,
    ].join('');
    renderJournalTab(currentJournalTab);
  } catch (err) {
    body.innerHTML = `<p class="text-xs text-vidia-red">${esc(err.message || 'Jurnal indisponibil')}</p>`;
  }
}

function setJournalTabActive(tab) {
  currentJournalTab = tab;
  $$('.journal-tab').forEach((btn) => {
    const active = btn.dataset.journalTab === tab;
    btn.className = active
      ? 'journal-tab text-xs px-3 py-1.5 rounded-full border border-vidia-red bg-red-50 text-vidia-red'
      : 'journal-tab text-xs px-3 py-1.5 rounded-full border border-vidia-border text-slate-600';
  });
}

function ttlLine(d) {
  const exp = d.pending_expires_at || d.locked_until;
  if (d.state !== 'pending_confirmation' || !exp) return '';
  const ms = new Date(exp).getTime() - Date.now();
  if (ms <= 0) return '<p class="text-[10px] text-amber-700 mt-0.5">TTL expirat — se eliberează la următorul mesaj / check disponibilitate</p>';
  const mins = Math.ceil(ms / 60000);
  return `<p class="text-[10px] text-amber-700 mt-0.5">TTL: ~${mins} min rămase (până la ${new Date(exp).toLocaleTimeString('ro-RO')})</p>`;
}

function renderJournalTab(tab) {
  setJournalTabActive(tab);
  const body = $('#bf-journal-body');
  if (!body || !currentJournal) return;

  if (tab === 'errors') {
    const logs = currentJournal.logs || [];
    const schemaAlerts = currentJournal.schemaAlerts || [];
    if (!logs.length && !schemaAlerts.length) {
      body.innerHTML = '<p class="text-xs text-slate-500">Nicio eroare / eveniment în jurnal.</p>';
      return;
    }
    const alertHtml = schemaAlerts.map((a) => `
      <div class="bg-red-50 border border-red-200 rounded-lg p-2.5">
        <p class="text-xs font-semibold text-red-800">${esc(a.message)}</p>
        ${a.hint ? `<p class="text-[10px] text-red-700 mt-0.5">${esc(a.hint)}</p>` : ''}
      </div>
    `).join('');
    body.innerHTML = alertHtml + logs.map((log) => `
      <div class="bg-white border border-vidia-border rounded-lg p-2.5 ${log.resolved ? 'opacity-60' : ''}">
        <div class="flex flex-wrap gap-2 items-center mb-1">
          <span class="text-[10px] font-medium px-1.5 py-0.5 rounded ${log.severity === 'critical' || log.severity === 'error' ? 'bg-red-100 text-red-800' : 'bg-slate-100 text-slate-700'}">${esc(log.severity)}</span>
          <span class="text-[10px] text-slate-500">${esc(log.source || '')}</span>
          <span class="text-[10px] text-slate-400 ml-auto">${new Date(log.created_at).toLocaleString('ro-RO')}</span>
        </div>
        <p class="text-xs font-medium">${esc(log.message)}</p>
        ${log.phone_number ? `<p class="text-[10px] text-slate-500 mt-0.5">${esc(log.phone_number)}</p>` : ''}
        ${!log.resolved ? `<button type="button" data-resolve-log="${log.id}" class="text-[10px] text-vidia-red mt-1 hover:underline">Marchează rezolvat</button>` : ''}
      </div>
    `).join('');
    $$('[data-resolve-log]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api(`/logs/${btn.dataset.resolveLog}/resolve`, { method: 'PATCH' });
        await loadBusinessJournal($('#bf-id').value);
      });
    });
    return;
  }

  if (tab === 'callbacks') {
    const rows = currentJournal.callbacks || [];
    if (!rows.length) {
      body.innerHTML = '<p class="text-xs text-slate-500">Nicio cerere de callback.</p>';
      return;
    }
    body.innerHTML = rows.map((c) => `
      <div class="bg-white border border-vidia-border rounded-lg p-2.5">
        <div class="flex flex-wrap gap-2 items-center mb-1">
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-800">${esc(c.status)}</span>
          <span class="text-[10px] text-slate-500">${esc(c.phone_number || '')}</span>
          <span class="text-[10px] text-slate-400 ml-auto">${new Date(c.created_at).toLocaleString('ro-RO')}</span>
        </div>
        <p class="text-xs">${esc(c.message || '')}</p>
        ${c.reason ? `<p class="text-[10px] text-slate-500 mt-0.5">Motiv: ${esc(c.reason)}</p>` : ''}
        <div class="flex gap-2 mt-1.5">
          ${c.status !== 'contacted' ? `<button type="button" data-cb="${c.id}" data-cb-status="contacted" class="text-[10px] text-blue-700 hover:underline">Marchează contactat</button>` : ''}
          ${c.status !== 'closed' ? `<button type="button" data-cb="${c.id}" data-cb-status="closed" class="text-[10px] text-vidia-red hover:underline">Închide</button>` : ''}
        </div>
      </div>
    `).join('');
    $$('[data-cb]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api(`/businesses/${$('#bf-id').value}/callbacks/${btn.dataset.cb}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: btn.dataset.cbStatus }),
        });
        await loadBusinessJournal($('#bf-id').value);
      });
    });
    return;
  }

  if (tab === 'bookings') {
    const rows = currentJournal.bookings || [];
    if (!rows.length) {
      body.innerHTML = '<p class="text-xs text-slate-500">Nicio programare recentă.</p>';
      return;
    }
    body.innerHTML = rows.map((d) => {
      const svc = d.selected_service?.name || 'Serviciu';
      const when = d.selected_slot_start
        ? new Date(d.selected_slot_start).toLocaleString('ro-RO')
        : '—';
      return `
        <div class="bg-white border border-vidia-border rounded-lg p-2.5">
          <div class="flex flex-wrap gap-2 items-center mb-1">
            <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100">${esc(d.state)}</span>
            <span class="text-[10px] text-slate-500">${esc(d.phone_number || '')}</span>
            <span class="text-[10px] text-slate-400 ml-auto">${when}</span>
          </div>
          <p class="text-xs font-medium">${esc(svc)}</p>
          ${ttlLine(d)}
          ${d.google_event_id ? `<p class="text-[10px] text-slate-500 mt-0.5">Google: ${esc(d.google_event_id)}</p>` : ''}
        </div>`;
    }).join('');
    return;
  }

  if (tab === 'sessions') {
    const rows = currentJournal.sessions || [];
    if (!rows.length) {
      body.innerHTML = '<p class="text-xs text-slate-500">Nicio sesiune WhatsApp înregistrată. TTL-ul de 5 minute rulează autonom.</p>';
      return;
    }
    body.innerHTML = rows.map((s) => {
      const intent = s.context_data?.last_booking_intent;
      const label = intent?.slot_label || '';
      const svc = intent?.service?.name || '';
      const hold = s.pending_draft;
      return `
        <div class="bg-white border border-vidia-border rounded-lg p-2.5">
          <div class="flex flex-wrap gap-2 items-center mb-1">
            <span class="text-[10px] px-1.5 py-0.5 rounded ${s.current_step === 'IDLE' ? 'bg-slate-100' : 'bg-emerald-50 text-emerald-800'}">${esc(s.current_step || 'IDLE')}</span>
            ${hold ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-800">pending 5 min</span>' : ''}
            <span class="text-[10px] text-slate-500">${esc(s.client_phone || '')}</span>
            <span class="text-[10px] text-slate-400 ml-auto">${s.updated_at ? new Date(s.updated_at).toLocaleString('ro-RO') : ''}</span>
          </div>
          ${label ? `<p class="text-xs">Ultima intenție: ${esc(svc ? `${svc} · ${label}` : label)}</p>` : '<p class="text-[10px] text-slate-500">Fără slot memorat</p>'}
          ${hold ? ttlLine(hold) : ''}
        </div>`;
    }).join('');
    return;
  }

  if (tab === 'sms') {
    const rows = currentJournal.smsCampaigns || [];
    if (!rows.length) {
      body.innerHTML = '<p class="text-xs text-slate-500">Nicio campanie SMS încă.</p>';
      return;
    }
    body.innerHTML = rows.map((c) => `
      <div class="bg-white border border-vidia-border rounded-lg p-2.5">
        <div class="flex flex-wrap gap-2 items-center mb-1">
          <span class="text-[10px] px-1.5 py-0.5 rounded bg-slate-100">${esc(c.status)}</span>
          <span class="text-[10px] text-slate-500">trimise ${c.sent_count ?? 0}/${c.target_count ?? 0}</span>
          <span class="text-[10px] text-slate-400 ml-auto">${new Date(c.created_at).toLocaleString('ro-RO')}</span>
        </div>
        <p class="text-xs">${esc((c.body || '').slice(0, 160))}</p>
      </div>
    `).join('');
  }
}

$$('.journal-tab').forEach((btn) => {
  btn.addEventListener('click', () => renderJournalTab(btn.dataset.journalTab));
});

$('#bf-journal-refresh')?.addEventListener('click', () => {
  const id = $('#bf-id').value;
  if (id) loadBusinessJournal(id);
});

$('#add-business-btn').addEventListener('click', () => openBusinessModal());
$('#modal-cancel').addEventListener('click', () => $('#business-modal').classList.add('hidden'));

$('#bf-type').addEventListener('change', (e) => {
  setPreview(e.target.value === 'consulting' ? 'consulting' : 'booking');
});

$('#bf-prompt-default')?.addEventListener('click', async () => {
  if (!defaultSystemPrompt) await loadAiDefaults();
  if (defaultSystemPrompt) {
    $('#bf-prompt').value = defaultSystemPrompt;
  }
});

$('#bf-logic-default')?.addEventListener('click', async () => {
  if (!defaultConversationLogic) await loadAiDefaults();
  if (defaultConversationLogic) {
    $('#bf-conversation-logic').value = defaultConversationLogic;
  }
});

$('#business-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#form-error').classList.add('hidden');

  let booking_settings;
  try {
    booking_settings = JSON.parse($('#bf-settings').value || '{}');
  } catch {
    $('#form-error').textContent = 'Alte setări booking (JSON) invalid';
    $('#form-error').classList.remove('hidden');
    return;
  }

  booking_settings.services = collectServicesFromTable();
  booking_settings.business_hours = collectHoursFromEditor();
  booking_settings.contact = collectContactFromForm();
  booking_settings.ai_facts = ($('#bf-ai-facts').value || '').trim();
  booking_settings.confirmation_message = ($('#bf-confirmation').value || '').trim();
  booking_settings.terms_url = ($('#bf-terms-url').value || '').trim();
  booking_settings.gdpr_url = ($('#bf-gdpr-url').value || '').trim();
  booking_settings.sms_from_number = ($('#bf-sms-from').value || '').trim();
  booking_settings.slot_interval_minutes = Number($('#bf-slot-interval').value) || 30;
  booking_settings.booking_horizon_days = Number($('#bf-horizon-days').value) || 7;
  booking_settings.buffer_minutes = Number($('#bf-buffer-minutes').value) || 0;
  booking_settings.pending_ttl_minutes = Number($('#bf-pending-ttl')?.value) || 5;
  booking_settings.conversation_logic = ($('#bf-conversation-logic')?.value || '').trim();
  delete booking_settings.privacy_url;

  const payload = {
    id: $('#bf-id').value || undefined,
    name: $('#bf-name').value,
    slug: $('#bf-slug').value || undefined,
    business_type: $('#bf-type').value,
    status: $('#bf-status').value,
    timezone: $('#bf-timezone').value || 'Europe/Bucharest',
    welcome_message: ($('#bf-welcome').value || '').trim() || undefined,
    whatsapp_phone_number_id: $('#bf-phone-id').value || null,
    google_calendar_id: $('#bf-calendar').value || null,
    google_calendar_mock_mode: $('#bf-g-mock').checked,
    twilio_account_sid: $('#bf-twilio-sid').value || null,
    ai_system_prompt: ($('#bf-prompt').value || '').trim(),
    ai_model: $('#bf-ai-model').value || 'gpt-4o-mini',
    ai_temperature: Number($('#bf-ai-temperature').value ?? 0.3),
    booking_settings,
    services: booking_settings.services,
  };

  const token = $('#bf-token').value;
  if (token) payload.whatsapp_access_token = token;

  const twilioToken = $('#bf-twilio-token').value;
  if (twilioToken) payload.twilio_auth_token = twilioToken;

  try {
    const saved = await api('/businesses', { method: 'POST', body: JSON.stringify(payload) });
    const savedBiz = saved?.business;
    const businessId = savedBiz?.id || payload.id;
    if (savedBiz?.id) {
      const idx = businesses.findIndex((b) => b.id === savedBiz.id);
      if (idx >= 0) businesses[idx] = { ...businesses[idx], ...savedBiz };
      else businesses.unshift(savedBiz);
      renderBusinesses();
    }
    if (businessId) {
      try {
        await persistEmployees(businessId);
      } catch (empErr) {
        $('#form-error').textContent =
          'Afacerea s-a salvat. Angajații nu: ' + (empErr.message || 'eroare');
        $('#form-error').classList.remove('hidden');
        await loadBusinesses();
        return;
      }
    }
    $('#business-modal').classList.add('hidden');
    await loadBusinesses();
  } catch (err) {
    $('#form-error').textContent = err.message;
    $('#form-error').classList.remove('hidden');
  }
});

// Logs
async function loadLogs() {
  const businessId = $('#logs-business-filter').value;
  const unresolved = $('#logs-unresolved-only').checked;
  const severity = $('#logs-severity-filter')?.value || '';
  const source = $('#logs-source-filter')?.value || '';
  const params = new URLSearchParams({ limit: '50' });
  if (businessId) params.set('business_id', businessId);
  if (unresolved) params.set('unresolved', 'true');
  if (severity) params.set('severity', severity);
  if (source) params.set('source', source);

  const data = await api(`/logs?${params}`);
  renderLogs(data.logs || []);
}

function renderLogs(logs) {
  const el = $('#logs-list');
  if (!logs.length) {
    el.innerHTML = '<p class="text-sm text-slate-500">Niciun log de eroare.</p>';
    return;
  }

  el.innerHTML = logs.map((log) => {
    const sevColors = {
      critical: 'bg-red-100 text-red-800',
      error: 'bg-orange-100 text-orange-800',
      warning: 'bg-yellow-100 text-yellow-800',
      info: 'bg-blue-100 text-blue-800',
      debug: 'bg-slate-100 text-slate-600',
    };
    const biz = businesses.find((b) => b.id === log.business_id);
    const bizName = biz ? biz.name : (log.business_id ? log.business_id.slice(0, 8) : 'system');

    return `
      <div class="bg-white border ${log.details?.alert ? 'border-red-300 ring-1 ring-red-100' : 'border-vidia-border'} rounded-xl p-4 ${log.resolved ? 'opacity-60' : ''}">
        <div class="flex flex-wrap items-center gap-2 mb-2">
          <span class="text-xs font-medium px-2 py-0.5 rounded-full ${sevColors[log.severity] || sevColors.error}">${log.severity}</span>
          <span class="text-xs bg-vidia-light px-2 py-0.5 rounded-full">${log.source}</span>
          <span class="text-xs text-slate-500">${bizName}</span>
          <span class="text-xs text-slate-400 ml-auto">${new Date(log.created_at).toLocaleString('ro-RO')}</span>
        </div>
        <p class="text-sm font-medium">${esc(log.message)}</p>
        ${log.http_status ? `<p class="text-xs text-slate-500 mt-1">HTTP ${log.http_status}</p>` : ''}
        <pre class="text-xs text-slate-500 mt-2 bg-vidia-light p-2 rounded-lg max-h-32 overflow-auto">${esc(JSON.stringify(log.details, null, 2))}</pre>
        ${!log.resolved ? `<button data-resolve="${log.id}" class="resolve-btn text-xs text-vidia-red mt-2 hover:underline">Marchează rezolvat</button>` : ''}
      </div>`;
  }).join('');

  $$('.resolve-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await api(`/logs/${btn.dataset.resolve}/resolve`, { method: 'PATCH' });
      loadLogs();
    });
  });
}

function startLogsPoll() {
  stopLogsPoll();
  logsPollInterval = setInterval(() => {
    if (!$('#tab-logs').classList.contains('hidden')) loadLogs();
    loadSchemaHealth();
  }, 10000);
}

function stopLogsPoll() {
  if (logsPollInterval) clearInterval(logsPollInterval);
}

$('#logs-business-filter').addEventListener('change', loadLogs);
$('#logs-unresolved-only').addEventListener('change', loadLogs);
$('#logs-severity-filter')?.addEventListener('change', loadLogs);
$('#logs-source-filter')?.addEventListener('change', loadLogs);
$('#refresh-logs-btn').addEventListener('click', loadLogs);

// Google Service Account settings
async function loadGoogleMasterSettings() {
  $('#gm-error').classList.add('hidden');
  try {
    const data = await api('/system-settings/google-master');
    const s = data.settings || {};
    $('#gm-sa-email').value = s.google_service_account_email || s.service_account_email || '';
    $('#gm-sa-key').value = '';
    $('#gm-sa-key-hint').classList.toggle(
      'hidden',
      !(s.has_google_service_account_private_key || s.has_service_account_private_key),
    );
    $('#gm-status').textContent = s.configured
      ? `Service Account configurat: ${s.google_service_account_email || s.service_account_email || '—'}`
      : 'Neconfigurat — completează email-ul robotului + private key din JSON-ul Google Cloud.';
  } catch (err) {
    $('#gm-error').textContent = err.message || 'Nu pot încărca setările';
    $('#gm-error').classList.remove('hidden');
  }
}

$('#google-master-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#gm-error').classList.add('hidden');

  const payload = {
    google_service_account_email: $('#gm-sa-email').value || null,
  };

  const saKey = $('#gm-sa-key').value.trim();
  if (saKey) payload.google_service_account_private_key = saKey;

  try {
    const data = await api('/system-settings/google-master', {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    const s = data.settings || {};
    $('#gm-status').textContent = s.configured
      ? 'Salvat. Google Service Account e activ.'
      : 'Salvat, dar lipsește email-ul sau cheia privată.';
    $('#gm-sa-key').value = '';
    $('#gm-sa-key-hint').classList.toggle(
      'hidden',
      !(s.has_google_service_account_private_key || s.has_service_account_private_key),
    );
  } catch (err) {
    $('#gm-error').textContent = err.message || 'Salvare eșuată';
    $('#gm-error').classList.remove('hidden');
  }
});

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

checkSession();
