'use strict';
/* ==========================================================================
   LessRepeat Studio, product dashboard SPA.
   Vanilla JS. Zero dependencies. Hash routing. Talks only to our own /api/*
   so provider keys stay server side. No em dashes anywhere. Use commas or periods.
   ========================================================================== */

/* ---------- tiny DOM helpers ---------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const el = (tag, attrs, kids) => {
  const n = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === 'class') n.className = attrs[k];
    else if (k === 'html') n.innerHTML = attrs[k];
    else if (k.slice(0, 2) === 'on' && typeof attrs[k] === 'function') n.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
    else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
  }
  if (kids != null) (Array.isArray(kids) ? kids : [kids]).forEach((c) => {
    if (c == null || c === false) return;
    n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  });
  return n;
};

/* XSS guard. Always escape any user supplied string before it touches innerHTML.
   Most rendering uses el()+textContent which is safe by construction. esc() is the
   belt-and-suspenders for the rare html: paths. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------- app state ---------- */
const State = {
  me: null,            // { user, tenant }
  health: null,        // { ok, providers, model }
  agents: [],
  providers: null,
  usage: null,
  telephony: null,
  wallet: null,
  presets: [],
  tickets: [],
  demoLinks: [],
  agency: null,
  invoices: [],
  integrations: [],
  agencyPrompt: null,
  customVoices: [],
  activeAgentId: null, // for Talk-to-it
  loaded: { agents: false, providers: false, usage: false, telephony: false, wallet: false, presets: false, tickets: false, demoLinks: false, agency: false, invoices: false, integrations: false, agencyPrompt: false, customVoices: false }
};

function currentTheme() { return localStorage.getItem('lessrepeat_theme') || 'dark'; }
function applyTheme(theme) { document.documentElement.setAttribute('data-theme', theme); localStorage.setItem('lessrepeat_theme', theme); }
function toggleTheme() { applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'); const button = $('#themeToggle'); if (button) button.setAttribute('aria-label', currentTheme() === 'dark' ? 'Use light mode' : 'Use dark mode'); }
applyTheme(currentTheme());

const GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const VOICE_MODELS = ['kokoro', GEMINI_TTS_MODEL, 'mulberry', 'muga'];
const SPEAKERS = ['speaker_1', 'speaker_2', 'speaker_3', 'speaker_4'];
const KOKORO_VOICES = [
  { id: 'hm_omega', label: 'Arjun, young clear male', speed: 1.06 },
  { id: 'hm_psi', label: 'Vikram, steady mature male', speed: 0.96 },
  { id: 'hm_omega(2)+hm_psi(1)', label: 'Rohan, 25, casual sales', speed: 1.08 },
  { id: 'hm_omega(1)+hm_psi(2)', label: 'Mahesh, 35, simple English', speed: 0.90 },
  { id: 'hm_omega+hm_psi', label: 'Rajiv, balanced conversational', speed: 0.94 },
  { id: 'hf_alpha', label: 'Asha, clear confident woman', speed: 0.96 },
  { id: 'hf_beta', label: 'Meera, warm friendly woman', speed: 0.92 },
  { id: 'hf_alpha(1)+hf_beta(2)', label: 'Kavita, 40, warm and measured', speed: 0.84 },
  { id: 'hf_alpha(2)+hf_beta(1)', label: 'Priya, professional natural', speed: 0.98 },
  { id: 'hf_alpha+hf_beta', label: 'Nandini, balanced approachable', speed: 0.90 }
];
const GEMINI_TELUGU_VOICES = [
  { id: 'Achird', label: 'Sravani, friendly Telugu woman' },
  { id: 'Sulafat', label: 'Ananya, warm Telugu woman' },
  { id: 'Gacrux', label: 'Madhavi, mature Telugu woman' },
  { id: 'Iapetus', label: 'Arjun, clear Telugu man' },
  { id: 'Zubenelgenubi', label: 'Kiran, casual Telugu man' },
  { id: 'Charon', label: 'Ravi, steady Telugu man' }
];
const INDIAN_VOICE_PROFILES = [
  { id: 'indian-neutral', label: 'Natural Indian English', speaker: 'speaker_2', f0: 0, description: 'Natural Indian English accent, clear everyday speech, warm and realistic, conversational pacing, no exaggerated pronunciation.' },
  { id: 'indian-professional', label: 'Professional Indian English', speaker: 'speaker_1', f0: -1, description: 'Professional Indian English accent, confident and polished, clear diction, calm businesslike delivery, natural pacing.' },
  { id: 'indian-warm', label: 'Warm Indian Conversational', speaker: 'speaker_3', f0: 1, description: 'Warm conversational Indian English accent, friendly and empathetic, natural pauses, relaxed rhythm, realistic human delivery.' },
  { id: 'hinglish-natural', label: 'Natural Hinglish', speaker: 'speaker_4', f0: 0, description: 'Natural urban Indian Hinglish delivery, fluent code switching between Hindi and English when the text requires it, casual and authentic, never caricatured.' }
];
const MUGA_TONES = ['neutral', 'happy', 'sad', 'excited', 'angry', 'whisper'];
/* Rs per 1000 chars. Mulberry promo about Rs 0.50 / 1000. Muga slightly higher. */
const RATE = { mulberry: 0.50, muga: 0.99 };

/* ===========================================================================
   FETCH WRAPPER
   credentials:include sends the HttpOnly LessRepeat session cookie. JSON in, JSON out.
   A 401 on any authed call bounces to the login card.
   =========================================================================== */
async function api(path, opts) {
  opts = opts || {};
  const init = { method: opts.method || 'GET', credentials: 'include', headers: {} };
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 35000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  init.signal = controller.signal;
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    clearTimeout(timeout);
    if (e && e.name === 'AbortError') throw new ApiError(408, 'The agent took too long to respond. Please try again.');
    throw new ApiError(0, 'Network error. Is the server running.');
  }
  clearTimeout(timeout);
  if (res.status === 401 && !opts.allow401) {
    State.me = null;
    if (!path.endsWith('/api/me')) renderAuth();
    throw new ApiError(401, 'Please sign in.');
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.indexOf('application/json') !== -1) {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || data.message || ('Request failed (' + res.status + ').'), data);
    return data;
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new ApiError(res.status, txt || ('Request failed (' + res.status + ').'));
  }
  return res; // raw (e.g. audio/wav)
}
function ApiError(status, message, data) { this.status = status; this.message = message; this.data = data || {}; }
ApiError.prototype = Object.create(Error.prototype);

/* ===========================================================================
   TOASTS
   =========================================================================== */
function toast(message, kind, title) {
  kind = kind || 'info';
  const host = $('#toasts');
  const t = el('div', { class: 'toast ' + kind }, [
    el('span', { class: 'ti' }),
    el('div', {}, [title ? el('b', {}, title) : null, el('div', {}, message)])
  ]);
  host.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, kind === 'err' ? 5200 : 3400);
}

/* ===========================================================================
   MODAL
   =========================================================================== */
function modal(opts) {
  // opts: { title, body(node), confirmText, confirmKind, onConfirm, cancelText }
  const host = $('#modal-host');
  const close = () => {
    $$('audio', host).forEach((audio) => audio.pause());
    host.classList.add('hide'); host.setAttribute('aria-hidden', 'true'); host.innerHTML = '';
  };
  const confirmBtn = el('button', { class: 'btn ' + (opts.confirmKind === 'danger' ? 'btn-danger' : 'btn-primary') }, opts.confirmText || 'Confirm');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    try { await opts.onConfirm(); close(); }
    catch (e) { confirmBtn.disabled = false; toast(e.message || 'Action failed.', 'err'); }
  });
  const card = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
    el('h3', {}, opts.title || ''),
    opts.body || null,
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn btn-ghost', onclick: close }, opts.cancelText || 'Cancel'),
      confirmBtn
    ])
  ]);
  host.innerHTML = '';
  host.appendChild(el('div', { onclick: (e) => { if (e.target === e.currentTarget) close(); }, style: 'position:absolute;inset:0' }));
  host.appendChild(card);
  host.classList.remove('hide');
  host.setAttribute('aria-hidden', 'false');
  return close;
}

/* ===========================================================================
   SMALL UTILITIES
   =========================================================================== */
function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]).join('').toUpperCase() || '?';
}
function isPlatformUserClient(user) {
  return !!user && (user.role === 'super_admin' || user.role === 'admin');
}
function brandSVG(size) {
  const image = document.createElement('img');
  image.src = '/assets/lessrepeat-icon-256.png?v=20260830-png1';
  image.alt = 'LessRepeat';
  image.width = size || 30; image.height = size || 30;
  image.decoding = 'async';
  return image;
}
function fmtInr(n) {
  const v = Number(n || 0);
  return v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}
function skeleton(kind, n) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < (n || 1); i++) frag.appendChild(el('div', { class: 'sk ' + (kind || 'sk-card') }));
  return frag;
}

let chartsPromise = null;
function ensureCharts() {
  if (window.LessRepeatCharts) return Promise.resolve(window.LessRepeatCharts);
  if (chartsPromise) return chartsPromise;
  chartsPromise = new Promise((resolve, reject) => {
    const script = el('script', { src: '/assets/charts.js?v=20260829-lessrepeat2' });
    script.onload = () => window.LessRepeatCharts ? resolve(window.LessRepeatCharts) : reject(new Error('Analytics bundle did not initialize.'));
    script.onerror = () => reject(new Error('Analytics bundle could not be loaded.'));
    document.head.appendChild(script);
  });
  return chartsPromise;
}

/* ===========================================================================
   BOOT
   =========================================================================== */
async function boot() {
  try {
    const me = await api('/api/me', { allow401: true });
    State.me = me;
    renderShell();
  } catch (e) {
    if (e.status === 401) renderAuth();
    else { renderAuth(); }
  }
}

/* ===========================================================================
   AUTH GATE
   =========================================================================== */
function renderAuth() {
  let mode = 'login'; // or 'signup'
  const root = $('#app');
  root.removeAttribute('aria-busy');

  function draw() {
    const errBox = el('div', { class: 'auth-err', id: 'authErr' });
    const fields = [];
    if (mode === 'signup') {
      fields.push(field('Your name', el('input', { class: 'input', id: 'f_name', type: 'text', placeholder: 'Your full name', autocomplete: 'name' })));
      fields.push(field('Company', el('input', { class: 'input', id: 'f_company', type: 'text', placeholder: 'Your agency or company', autocomplete: 'organization' })));
    }
    const emailInput = el('input', { class: 'input', id: 'f_email', type: 'email', placeholder: 'you@company.com', autocomplete: 'email' });
    const passwordInput = el('input', { class: 'input', id: 'f_pass', type: 'password', placeholder: 'Enter your password', autocomplete: mode === 'signup' ? 'new-password' : 'current-password' });
    const showPassword = el('button', { class: 'auth-show-password', type: 'button', 'aria-label': 'Show password', onclick: () => {
      const visible = passwordInput.type === 'text';
      passwordInput.type = visible ? 'password' : 'text';
      showPassword.textContent = visible ? 'Show' : 'Hide';
      showPassword.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
    } }, 'Show');
    fields.push(field('Work email', emailInput));
    fields.push(el('div', { class: 'field' }, [el('label', { for: 'f_pass' }, 'Password'), el('div', { class: 'auth-password' }, [passwordInput, showPassword])]));

    const submit = el('button', { class: 'btn btn-primary btn-lg auth-submit', type: 'submit' }, mode === 'login' ? 'Enter LessRepeat' : 'Create workspace');

    const form = el('form', { class: 'auth-form', onsubmit: onSubmit }, fields.concat([errBox, submit]));

    const formPanel = el('section', { class: 'auth-form-panel' }, [
      el('div', { class: 'auth-brand' }, [
        (function () { const s = brandSVG(34); s.classList.add('lm'); return s; })(),
        el('span', { class: 'nm' }, 'LessRepeat')
      ]),
      el('div', { class: 'auth-heading' }, [
        el('span', { class: 'section-kicker' }, mode === 'login' ? 'Your business workspace' : 'New workspace'),
        el('h1', {}, mode === 'login' ? 'Welcome back.' : 'Run the whole agency.'),
        el('p', { class: 'sub' }, mode === 'login' ? 'Manage your voice agents, review customer calls, and follow up on new leads.' : 'Create an isolated workspace for AI voice operations. Telephony and carrier charges remain separate.')
      ]),
      form,
      el('div', { class: 'auth-toggle' }, [
        document.createTextNode('New here? Ask your administrator for a workspace invitation. '),
        el('a', { href: '/admin' }, 'Admin sign in')
      ]),
      mode === 'login' ? el('div', { class: 'auth-demo' }, [el('span', { class: 'auth-demo-dot' }), el('span', {}, 'Sign in with the email and password you activated through your invitation.')]) : null
    ]);

    const proofPanel = el('aside', { class: 'auth-proof-panel' }, [
      el('div', { class: 'auth-grid-pattern', 'aria-hidden': 'true' }),
      el('div', { class: 'auth-proof-top' }, [
        el('span', { class: 'auth-proof-label' }, 'Made for your business'),
        el('span', { class: 'auth-live-pill' }, [el('span', {}), 'AI voice workspace'])
      ]),
      el('div', { class: 'auth-proof-copy' }, [
        el('h2', {}, 'Every conversation. A clearer next step.'),
        el('p', {}, 'Keep your business knowledge, voice agents, recordings and customer follow-ups together in one private workspace.')
      ]),
      el('div', { class: 'auth-proof-metrics' }, [
        el('div', {}, [el('strong', {}, 'Voice'), el('span', {}, 'Business-specific agents')]),
        el('div', {}, [el('strong', {}, 'Calls'), el('span', {}, 'Recordings and outcomes')]),
        el('div', {}, [el('strong', {}, 'Leads'), el('span', {}, 'Organized follow-ups')])
      ]),
      el('div', { class: 'auth-capabilities' }, ['AI voice agents', 'Knowledge base', 'Call recordings', 'Customer leads'].map((label) => el('span', {}, label)))
    ]);

    root.innerHTML = '';
    root.appendChild(el('div', { class: 'auth-wrap' }, [formPanel, proofPanel]));
    const first = $('#' + (mode === 'signup' ? 'f_name' : 'f_email'));
    if (first) first.focus();
  }

  function field(label, input) {
    return el('div', { class: 'field' }, [el('label', {}, label), input]);
  }

  async function onSubmit(e) {
    e.preventDefault();
    const err = $('#authErr');
    err.classList.remove('show');
    const email = ($('#f_email').value || '').trim();
    const password = $('#f_pass').value || '';
    if (!email || !password) { showErr('Email and password are required.'); return; }
    if (mode === 'signup' && password.length < 12) { showErr('Use at least 12 characters for your password.'); return; }
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = mode === 'login' ? 'Opening LessRepeat...' : 'Creating workspace...';
    try {
      let body, route;
      if (mode === 'signup') {
        body = { email: email, password: password, name: ($('#f_name').value || '').trim(), company: ($('#f_company').value || '').trim() };
        route = '/api/auth/signup';
      } else {
        body = { email: email, password: password };
        route = '/api/auth/login';
      }
      const res = await api(route, { method: 'POST', body: body, allow401: true });
      State.me = { user: res.user, tenant: res.tenant };
      resetData();
      toast(mode === 'login' ? 'Signed in.' : 'Account created.', 'ok');
      renderShell();
    } catch (ex) {
      btn.disabled = false; btn.textContent = mode === 'login' ? 'Enter LessRepeat' : 'Create workspace';
      if (ex.status === 409) showErr('That email is already registered. Try signing in.');
      else if (ex.status === 401) showErr('Wrong email or password.');
      else showErr(ex.message || 'Something went wrong.');
    }
  }
  function showErr(m) { const err = $('#authErr'); err.textContent = m; err.classList.add('show'); }

  draw();
}
function resetData() {
  State.agents = []; State.providers = null; State.usage = null; State.telephony = null;
  State.wallet = null; State.presets = []; State.tickets = [];
  State.demoLinks = [];
  State.agency = null; State.invoices = []; State.integrations = []; State.agencyPrompt = null;
  State.customVoices = [];
  State.loaded = { agents: false, providers: false, usage: false, telephony: false, wallet: false, presets: false, tickets: false, demoLinks: false, agency: false, invoices: false, integrations: false, agencyPrompt: false, customVoices: false };
  State.activeAgentId = null;
}

/* ===========================================================================
   CONSOLE SHELL
   =========================================================================== */
const ROUTES = [
  { id: 'overview', label: 'Overview', icon: 'grid' },
  { id: 'agents', label: 'My Agents', icon: 'users', ownerOnly: true },
  { id: 'presets', label: 'Agent Templates', icon: 'template', ownerOnly: true },
  { id: 'studio', label: 'Voice Studio', icon: 'wave', ownerOnly: true },
  { id: 'knowledge', label: 'Knowledge Base', icon: 'book', ownerOnly: true },
  { id: 'analytics', label: 'Calls & Recordings', icon: 'chart' },
  { id: 'contacts', label: 'Contacts & Leads', icon: 'contact' },
  { id: 'automation', label: 'Automation', icon: 'bolt', ownerOnly: true },
  { id: 'demos', label: 'Demo links', icon: 'link', ownerOnly: true },
  { id: 'talk', label: 'Talk to it', icon: 'mic' },
  { id: 'telephony', label: 'Telephony', icon: 'phone', ownerOnly: true },
  { id: 'invoices', label: 'Invoices', icon: 'invoice', ownerOnly: true },
  { id: 'integrations', label: 'Integrations', icon: 'plug', ownerOnly: true },
  { id: 'agency-prompt', label: 'Agency prompt', icon: 'prompt', ownerOnly: true },
  { id: 'billing', label: 'Usage & Plan', icon: 'wallet', ownerOnly: true },
  { id: 'support', label: 'Support', icon: 'support' },
  { id: 'settings', label: 'Business Settings', icon: 'gear', ownerOnly: true }
];

function navIcon(name) {
  const paths = {
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 6.2a3 3 0 0 1 0 5.6"/><path d="M17 14.5a5.5 5.5 0 0 1 3.5 5.5"/>',
    wave: '<path d="M2 12h2l2-6 3 14 3-18 3 14 2-6h2"/>',
    mic: '<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/><path d="M8.5 21h7"/>',
    phone: '<path d="M5 3.5h3l1.5 4.5-2 1.5a12 12 0 0 0 5.5 5.5l1.5-2 4.5 1.5v3a1.5 1.5 0 0 1-1.6 1.5A16.5 16.5 0 0 1 3.5 5.1 1.5 1.5 0 0 1 5 3.5z"/>',
    gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.6M12 18.9v2.6M21.5 12h-2.6M5.1 12H2.5M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3 5.5 5.5"/>',
    template: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    wallet: '<path d="M4 6.5h14a2 2 0 0 1 2 2v9H4a2 2 0 0 1-2-2v-11a2 2 0 0 0 2 2z"/><path d="M15 11h7v4h-7a2 2 0 0 1 0-4z"/>',
    support: '<path d="M4 13a8 8 0 0 1 16 0v5a2 2 0 0 1-2 2h-3"/><path d="M4 13v4H2v-4h2M20 13v4h2v-4h-2"/>',
    shield: '<path d="M12 3 20 6v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6l8-3z"/><path d="m9 12 2 2 4-5"/>',
    link: '<path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.3-2.3a4 4 0 0 0-5.7-5.7l-1.3 1.3"/><path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.3 2.3a4 4 0 0 0 5.7 5.7l1.3-1.3"/>',
    invoice: '<path d="M6 3h9l3 3v15H6z"/><path d="M15 3v4h4M9 11h6M9 15h6M9 19h4"/>',
    plug: '<path d="M8 3v5M16 3v5M6 8h12v2a6 6 0 0 1-12 0V8zM12 16v5"/>',
    prompt: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 2 2-2 2M12 13h5"/>',
    book: '<path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H12v18H7.5A3.5 3.5 0 0 0 4 23z"/><path d="M20 5.5A3.5 3.5 0 0 0 16.5 2H12v18h4.5A3.5 3.5 0 0 1 20 23z"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    contact: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M17 8h4M19 6v4"/>',
    bolt: '<path d="m13 2-9 12h7l-1 8 9-12h-7z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/>',
    logout: '<path d="M14 3.5H6.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5H14"/><path d="M17 8l4 4-4 4"/><path d="M21 12H9"/>'
  };
  return '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (paths[name] || paths.grid) + '</svg>';
}

function renderShell() {
  if (isPlatformUserClient(State.me.user) && !new URLSearchParams(location.search).has('workspace')) {
    location.replace('/admin'); return;
  }
  const root = $('#app');
  root.removeAttribute('aria-busy');
  const t = State.me.tenant, u = State.me.user;

  const visibleRoutes = ROUTES.filter((r) => {
    if (r.adminOnly && !['super_admin', 'admin'].includes(u.role)) return false;
    if (r.ownerOnly && !['super_admin', 'admin', 'owner'].includes(u.role)) return false;
    return true;
  });
  const nav = el('nav', { class: 'nav' }, visibleRoutes.map((r) =>
    el('a', { href: '#/' + r.id, 'data-route': r.id, html: navIcon(r.icon) + '<span>' + esc(r.label) + '</span>' })
  ));

  const side = el('aside', { class: 'side' }, [
    el('div', { class: 'side-brand' }, [
      (function () { const s = brandSVG(30); s.classList.add('lm'); return s; })(),
      el('span', { class: 'nm' }, 'LessRepeat')
    ]),
    nav,
    el('div', { class: 'side-foot' }, [
      isPlatformUserClient(u) ? el('a', { href: '/admin', class: 'btn btn-ghost' }, 'Back to Admin Console') : null,
      el('div', { class: 'tenant-chip' }, [
        el('div', { class: 'av' }, initials(t.name)),
        el('div', { class: 'meta' }, [
          el('div', { class: 'tn', title: t.name }, t.name),
          el('div', { class: 'tp' }, (t.planName || t.plan || 'Studio') + ' plan')
        ])
      ]),
      el('button', { class: 'side-logout', type: 'button', title: 'Sign out of LessRepeat', onclick: doLogout, html: navIcon('logout') + '<span>Sign out</span>' })
    ])
  ]);

  const top = el('header', { class: 'top' }, [
    el('div', { class: 'flex items-center gap-2', style: 'min-width:0' }, [
      el('button', { class: 'menu-btn', 'aria-label': 'Menu', onclick: () => $('.shell').classList.toggle('nav-open'), html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>' }),
      el('div', { class: 'top-route' }, [
        el('span', { class: 'crumb' }, 'Business workspace'),
        el('span', { class: 'ttl', id: 'routeTitle' }, 'Overview')
      ])
    ]),
    el('div', { class: 'top-actions' }, [
      el('button', { class: 'theme-toggle', id: 'themeToggle', type: 'button', 'aria-label': currentTheme() === 'dark' ? 'Use light mode' : 'Use dark mode', onclick: toggleTheme, html: navIcon('sun') }),
      el('div', { class: 'health-row', id: 'healthRow' }, healthChips())
    ])
  ]);

  const impersonationBanner = State.me.impersonation ? el('div', { class: 'impersonation-banner' }, [
    el('div', {}, [el('b', {}, 'Viewing as ' + u.email), el('span', {}, 'Read-only safety mode. Reason: ' + (State.me.impersonation.reason || 'Support review'))]),
    el('button', { class: 'btn btn-dark', onclick: exitImpersonation }, 'Exit user view')
  ]) : null;

  const shell = el('div', { class: 'shell' + (impersonationBanner ? ' is-impersonating' : '') }, [
    side, top, impersonationBanner,
    el('main', { class: 'main', id: 'view' }),
    el('div', { class: 'nav-scrim', onclick: () => $('.shell').classList.remove('nav-open') })
  ]);

  root.innerHTML = '';
  root.appendChild(shell);

  window.removeEventListener('hashchange', onRoute);
  window.addEventListener('hashchange', onRoute);
  loadHealth();
  onRoute();
}

async function exitImpersonation() {
  await api('/api/auth/impersonation/exit', { method: 'POST', body: {} });
  State.me = await api('/api/me');
  renderShell();
  toast('Returned to super admin.', 'ok');
}

async function doLogout() {
  const button = document.activeElement && document.activeElement.classList.contains('side-logout') ? document.activeElement : $('.side-logout');
  if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); const label = button.querySelector('span'); if (label) label.textContent = 'Signing out...'; }
  try { await api('/api/auth/logout', { method: 'POST', body: {}, allow401: true }); } catch (e) {}
  State.me = null; resetData();
  history.replaceState(null, '', location.pathname);
  renderAuth();
  toast('Signed out securely.', 'info');
}

/* ---- health chips ---- */
function healthChips() {
  const layers = [
    { key: 'tts', label: 'TTS' },
    { key: 'llm', label: 'Brain' },
    { key: 'telephony', label: 'Telephony' }
  ];
  return layers.map((L) => {
    const chip = el('span', { class: 'hchip loading', 'data-layer': L.key }, [
      el('span', { class: 'dot' }),
      el('span', { class: 'lbl-txt' }, L.label)
    ]);
    return chip;
  });
}
async function loadHealth() {
  try {
    const h = await api('/api/health', { allow401: true });
    State.health = h;
    paintHealth();
  } catch (e) {
    $$('#healthRow .hchip').forEach((c) => { c.className = 'hchip bad'; });
  }
}
function paintHealth() {
  const h = State.health; if (!h) return;
  const map = {
    tts: h.providers && h.providers.tts ? Object.values(h.providers.tts).some(Boolean) : false,
    llm: h.providers && h.providers.llm ? Object.values(h.providers.llm).some(Boolean) : false,
    telephony: h.providers && h.providers.telephony ? Object.values(h.providers.telephony).some(Boolean) : false
  };
  $$('#healthRow .hchip').forEach((c) => {
    const layer = c.getAttribute('data-layer');
    c.classList.remove('loading');
    c.className = 'hchip ' + (map[layer] ? 'ok' : 'bad');
    c.setAttribute('data-layer', layer);
  });
}

/* ===========================================================================
   ROUTER
   =========================================================================== */
function currentRoute() {
  const hash = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
  const found = ROUTES.find((r) => r.id === hash &&
    (!r.adminOnly || (State.me && ['super_admin', 'admin'].includes(State.me.user.role))) &&
    (!r.ownerOnly || (State.me && ['super_admin', 'admin', 'owner'].includes(State.me.user.role))));
  return found ? found.id : 'overview';
}
function onRoute() {
  if (!State.me) return;
  const id = currentRoute();
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('data-route') === id));
  const r = ROUTES.find((x) => x.id === id);
  const tt = $('#routeTitle'); if (tt) tt.textContent = r ? r.label : 'Overview';
  $('.shell') && $('.shell').classList.remove('nav-open');
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  const view = $('#view');
  view.innerHTML = '';
  const wrap = el('div', { class: 'view' });
  view.appendChild(wrap);
  ({
    overview: viewOverview, agents: viewAgents, presets: viewPresets, studio: viewStudio, demos: viewDemoLinks,
    knowledge: viewKnowledge, analytics: viewAnalytics, contacts: viewContacts, automation: viewAutomation,
    talk: viewTalk, telephony: viewTelephony, invoices: viewInvoices, integrations: viewIntegrations,
    'agency-prompt': viewAgencyPrompt, billing: viewBilling,
    support: viewSupport, admin: viewAdmin, settings: viewSettings
  }[id] || viewOverview)(wrap);
}
function goto(id) { location.hash = '#/' + id; }

/* ---- shared view header ---- */
function viewHead(title, sub) {
  return el('div', { class: 'view-head' }, [el('div', { class: 'view-head-copy' }, [el('h2', {}, title), sub ? el('p', {}, sub) : null])]);
}

/* ===========================================================================
   1. OVERVIEW
   =========================================================================== */
async function viewOverview(root) {
  return viewTenantOverview(root);
}

async function viewAgencyOverview(root) {
  const name = State.me.user.name || State.me.user.email;
  const head = viewHead('Good evening, ' + name + '.', 'Revenue, client activity, invoices, and operational risk across the agency.');
  head.appendChild(el('div', { class: 'view-actions' }, [
    el('button', { class: 'btn btn-ghost', onclick: () => goto('admin') }, 'Open clients'),
    el('button', { class: 'btn btn-primary', onclick: () => goto('invoices') }, 'Issue invoice')
  ]));
  root.appendChild(head);
  const chartHost = el('div', { class: 'agency-chart-host', 'aria-busy': 'true' }, [skeleton('sk-stat', 4), skeleton('sk-card', 2)]);
  const recentHost = el('div', { class: 'card agency-recent-card' }, skeleton('sk-card', 1));
  const actionCard = el('div', { class: 'card agency-command-card' }, [
    el('span', { class: 'section-kicker' }, 'Next actions'),
    el('h3', {}, 'Move the agency forward.'),
    el('p', {}, 'Log client outreach, issue an invoice, review setup requests, or update the operating prompt.'),
    el('div', { class: 'agency-action-list' }, [
      actionLink('Approach a client', 'Record a WhatsApp, email, call, or meeting touchpoint.', 'admin'),
      actionLink('Issue an invoice', 'Create a stored INR invoice and track its lifecycle.', 'invoices'),
      actionLink('Review integrations', 'WhatsApp and Meta Ad Library setup states.', 'integrations'),
      actionLink('Edit agency prompt', 'Keep one persistent operating instruction.', 'agency-prompt')
    ])
  ]);
  root.appendChild(chartHost);
  root.appendChild(el('div', { class: 'agency-bottom-grid' }, [recentHost, actionCard]));
  try {
    const data = await api('/api/agency/overview');
    State.agency = data; State.loaded.agency = true;
    chartHost.innerHTML = ''; chartHost.removeAttribute('aria-busy');
    const charts = await ensureCharts();
    charts.mountAgencyDashboard(chartHost, data);
    renderRecentAgencyActivity(recentHost, data.recent || []);
  } catch (e) {
    chartHost.innerHTML = '';
    chartHost.appendChild(el('div', { class: 'card card-pad error-state' }, [el('h3', {}, 'Agency analytics unavailable'), el('p', {}, e.message || 'Could not load analytics.'), el('button', { class: 'btn btn-ghost', onclick: () => onRoute() }, 'Try again')]));
    renderRecentAgencyActivity(recentHost, []);
  }
}

function actionLink(title, copy, route) {
  return el('button', { class: 'agency-action', onclick: () => goto(route) }, [
    el('span', {}, [el('strong', {}, title), el('small', {}, copy)]),
    el('span', { class: 'agency-action-arrow', 'aria-hidden': 'true' }, '→')
  ]);
}

function renderRecentAgencyActivity(host, rows) {
  host.innerHTML = '';
  host.appendChild(el('div', { class: 'agency-card-head' }, [el('div', {}, [el('span', { class: 'section-kicker' }, 'Live operations'), el('h3', {}, 'Recent client activity')]), el('button', { class: 'btn btn-quiet btn-sm', onclick: () => goto('admin') }, 'View clients')]));
  if (!rows.length) {
    host.appendChild(el('div', { class: 'empty compact' }, [el('div', { class: 'ttl' }, 'No client activity yet'), el('p', {}, 'Approaches and lifecycle changes will appear here.') ]));
    return;
  }
  rows.forEach((row) => host.appendChild(el('div', { class: 'agency-activity-row' }, [
    el('span', { class: 'agency-activity-icon' }, initials(row.tenantName)),
    el('div', {}, [el('strong', {}, row.tenantName), el('p', {}, row.summary || row.type)]),
    el('time', {}, relativeTime(row.createdAt))
  ])));
}

function relativeTime(iso) {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  if (diff < 60000) return 'now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h';
  return Math.floor(diff / 86400000) + 'd';
}

async function viewTenantOverview(root) {
  const name = State.me.user.name || State.me.user.email;
  root.appendChild(viewHead('Welcome back, ' + name + '.', 'Calls, agents, leads, and recent business activity in one view.'));

  const productHost = el('div', { class: 'product-overview' }, skeleton('sk-stat', 4));
  root.appendChild(productHost);
  api('/api/product/overview').then((data) => {
    const stats = data.stats || {};
    productHost.innerHTML = '';
    productHost.appendChild(el('div', { class: 'product-stat-grid' }, [
      productStat('Total calls', String(stats.totalCalls || 0), 'Across browser, demo, and phone'),
      productStat('Active AI agents', String(stats.activeAgents || 0), 'Ready to handle conversations'),
      productStat('Leads collected', String(stats.leadsCollected || 0), 'Saved contacts and prospects'),
      productStat('Average call', formatDuration(stats.averageDurationSeconds || 0), 'Completed conversations')
    ]));
    productHost.appendChild(el('div', { class: 'overview-feed-grid' }, [
      overviewListCard('Recent calls', (data.recentCalls || []).map((call) => ({ title: call.agentName, copy: (call.callerName || call.mode || 'Voice conversation') + ' · ' + formatDuration(call.durationSeconds), time: relativeTime(call.createdAt) })), 'No calls yet. Test an agent or share a Demo link.'),
      overviewListCard('Recent activity', (data.activity || []).map((item) => ({ title: humanizeAction(item.action), copy: 'Workspace activity', time: relativeTime(item.createdAt) })), 'Your latest workspace changes will appear here.')
    ]));
  }).catch((error) => {
    productHost.innerHTML = '';
    productHost.appendChild(el('div', { class: 'card card-pad error-state' }, [el('h3', {}, 'Business overview unavailable'), el('p', {}, error.message)]));
  });

  const chartHost = el('div', { id: 'chartHost', style: 'min-width:0' }, [
    skeleton('sk-stat', 3),
    skeleton('sk-card', 2)
  ]);

  const body = el('div', { class: 'grid grid-12', style: 'margin-top:18px' }, [
    chartHost,
    el('div', { class: 'card card-pad', id: 'qaHost' }, [
      el('h3', { class: 't-h3', style: 'margin-bottom:14px' }, 'Quick actions'),
      el('div', { class: 'qa-row' }, [
        el('button', { class: 'btn btn-primary', onclick: () => goto('agents') }, 'Build an agent'),
        el('button', { class: 'btn btn-ghost', onclick: () => goto('studio') }, 'Open Voice Studio'),
        el('button', { class: 'btn btn-ghost', onclick: () => goto('talk') }, 'Talk to it'),
        el('button', { class: 'btn btn-ghost', onclick: () => goto('telephony') }, 'Telephony')
      ]),
      el('div', { class: 'divider', style: 'margin:18px 0' }),
      el('div', { id: 'provMini', class: 'soft', style: 'font-size:.85rem' }, 'Checking providers...')
    ])
  ]);
  root.appendChild(body);

  // load usage + agents in parallel
  try {
    const [usage, agentsRes] = await Promise.all([
      api('/api/usage'),
      State.loaded.agents ? Promise.resolve({ agents: State.agents }) : api('/api/agents')
    ]);
    State.usage = usage;
    State.agents = agentsRes.agents || [];
    State.loaded.agents = true;

    chartHost.innerHTML = '';
    const charts = await ensureCharts();
    charts.mountTenantDashboard(chartHost, usage);
  } catch (e) {
    chartHost.innerHTML = '';
    chartHost.appendChild(el('div', { class: 'card card-pad error-state' }, [
      el('h3', {}, 'Usage analytics unavailable'),
      el('p', {}, e.message || 'Could not load usage statistics.'),
      el('button', { class: 'btn btn-ghost', onclick: () => onRoute() }, 'Try again')
    ]));
  }

  // provider mini summary
  ensureProviders().then(() => {
    const pm = $('#provMini'); if (!pm) return;
    const reg = State.providers || {};
    const live = [];
    ['tts', 'llm', 'telephony'].forEach((layer) => {
      (reg[layer] || []).forEach((p) => { if (p.live) live.push(p.label); });
    });
    pm.textContent = live.length ? ('Active providers: ' + live.join(', ') + '.') : 'No live providers detected.';
  }).catch(() => {});
}

function statCard(lbl, val, delta, up) {
  return el('div', { class: 'card stat' }, [
    el('div', { class: 'lbl' }, lbl),
    el('div', { class: 'val' }, val),
    el('div', { class: 'delta' + (up ? ' up' : '') }, delta)
  ]);
}
function estimateCost(usage) {
  // fallback if backend does not return costInr in totals
  let c = 0;
  (usage.days || []).forEach((d) => { c += (d.costInr || (d.chars || 0) / 1000 * RATE.mulberry); });
  return Math.round(c * 100) / 100;
}

/* ---- sparkline (inline SVG, no libs) ---- */
function sparkPanel(days) {
  const data = (days || []).map((d) => ({ day: d.day, v: d.chars || 0 }));
  const total = data.reduce((s, d) => s + d.v, 0);
  const head = el('div', { class: 'hd' }, [
    el('div', { class: 't' }, 'Usage, characters per day'),
    el('div', { class: 'v' }, fmtInr(total) + ' total')
  ]);
  const svg = buildSpark(data);
  const xlabels = el('div', { class: 'spark-x' }, [
    el('span', {}, data.length ? shortDay(data[0].day) : ''),
    el('span', {}, data.length ? shortDay(data[data.length - 1].day) : 'no data yet')
  ]);
  return el('div', {}, [head, svg, xlabels]);
}
function shortDay(iso) {
  if (!iso) return '';
  const p = iso.split('-'); return p.length === 3 ? (p[2] + '/' + p[1]) : iso;
}
function buildSpark(data) {
  const W = 600, H = 120, pad = 6;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'spark-svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.innerHTML =
    '<defs>' +
    '<linearGradient id="sparkline" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#34E7E4"/><stop offset="0.6" stop-color="#6E7BFF"/><stop offset="1" stop-color="#A855F7"/></linearGradient>' +
    '<linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6E7BFF" stop-opacity="0.32"/><stop offset="1" stop-color="#6E7BFF" stop-opacity="0"/></linearGradient>' +
    '</defs>';
  if (!data.length) {
    const txt = document.createElementNS(ns, 'text');
    txt.setAttribute('x', W / 2); txt.setAttribute('y', H / 2 + 4); txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('fill', '#5C6479'); txt.setAttribute('font-size', '13'); txt.setAttribute('font-family', 'monospace');
    txt.textContent = 'Synthesize something to see usage here.';
    svg.appendChild(txt);
    return svg;
  }
  const max = Math.max(1, ...data.map((d) => d.v));
  const n = data.length;
  const x = (i) => pad + (n === 1 ? (W - 2 * pad) / 2 : (i / (n - 1)) * (W - 2 * pad));
  const y = (v) => H - pad - (v / max) * (H - 2 * pad);
  let line = '';
  data.forEach((d, i) => { line += (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(d.v).toFixed(1) + ' '; });
  const area = 'M' + x(0).toFixed(1) + ' ' + (H - pad) + ' ' + line.replace(/^M/, 'L') + 'L' + x(n - 1).toFixed(1) + ' ' + (H - pad) + ' Z';
  const areaP = document.createElementNS(ns, 'path'); areaP.setAttribute('class', 'area'); areaP.setAttribute('d', area);
  const lineP = document.createElementNS(ns, 'path'); lineP.setAttribute('class', 'ln'); lineP.setAttribute('d', line.trim());
  svg.appendChild(areaP); svg.appendChild(lineP);
  // last point dot
  const c = document.createElementNS(ns, 'circle');
  c.setAttribute('cx', x(n - 1)); c.setAttribute('cy', y(data[n - 1].v)); c.setAttribute('r', 3.2);
  c.setAttribute('fill', '#A855F7'); c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', '1');
  svg.appendChild(c);
  return svg;
}

/* ===========================================================================
   PROVIDERS + AGENTS data loaders
   =========================================================================== */
async function ensureProviders() {
  if (State.loaded.providers) return State.providers;
  const res = await api('/api/providers');
  // res can be { tts:[...], llm:[...], telephony:[...] } or { providers:{...} }
  State.providers = res.providers || res;
  State.loaded.providers = true;
  return State.providers;
}
async function ensureAgents(force) {
  if (State.loaded.agents && !force) return State.agents;
  const res = await api('/api/agents');
  State.agents = res.agents || [];
  State.loaded.agents = true;
  return State.agents;
}

function formatDuration(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  if (value < 60) return Math.round(value) + 's';
  return Math.floor(value / 60) + 'm ' + Math.round(value % 60) + 's';
}
function productStat(label, value, helper) { return el('div', { class: 'card product-stat' }, [el('div', { class: 'product-stat-label' }, label), el('div', { class: 'product-stat-value' }, value), el('div', { class: 'muted product-stat-helper' }, helper)]); }
function humanizeAction(action) { return String(action || 'Activity').replace(/[._]/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function overviewListCard(title, rows, emptyText) {
  return el('section', { class: 'card card-pad overview-list-card' }, [el('h3', { class: 't-h3' }, title), rows.length ? el('div', { class: 'overview-list' }, rows.map((row) => el('div', { class: 'overview-list-row' }, [el('span', { class: 'overview-list-dot' }), el('div', { class: 'overview-list-copy' }, [el('b', {}, row.title), el('span', {}, row.copy)]), el('time', {}, row.time)]))) : el('p', { class: 'muted' }, emptyText)]);
}
async function ensureCustomVoices(force) {
  if (State.loaded.customVoices && !force) return State.customVoices;
  const res = await api('/api/custom-voices');
  State.customVoices = res.voices || [];
  State.loaded.customVoices = true;
  return State.customVoices;
}
async function ensureTelephony(force) {
  if (State.loaded.telephony && !force) return State.telephony;
  const res = await api('/api/telephony/status');
  State.telephony = res;
  State.loaded.telephony = true;
  return State.telephony;
}

/* ===========================================================================
   2. AGENTS
   =========================================================================== */
async function viewAgents(root) {
  root.appendChild(viewHead('Agents', 'Each agent is a persona plus a voice. Preview the voice, then assign a number and ship it.'));
  await ensureCustomVoices().catch(() => []);
  const builder = buildAgentForm(null);
  root.appendChild(builder);

  const gridHost = el('div', { id: 'agentsGrid', class: 'agents-grid', style: 'margin-top:22px' }, skeleton('sk-card', 3));
  root.appendChild(gridHost);

  try {
    await Promise.all([ensureAgents(true), ensureTelephony().catch(() => null), ensureProviders().catch(() => null)]);
    refillDidOptions();
    paintAgents();
  } catch (e) {
    gridHost.innerHTML = '';
    gridHost.appendChild(el('div', { class: 'empty muted' }, 'Could not load agents. ' + esc(e.message)));
  }
}

function dids() {
  const t = State.telephony || {};
  const list = t.dids || (t.did ? [{ number: t.did }] : []);
  return list.map((d) => (typeof d === 'string' ? d : d.number || d.did)).filter(Boolean);
}
function refillDidOptions() {
  const sel = $('#f_did'); if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '';
  sel.appendChild(el('option', { value: '' }, 'No number assigned'));
  dids().forEach((n) => sel.appendChild(el('option', { value: n }, n)));
  if (cur) sel.value = cur;
}

function buildAgentForm(existing) {
  const e = existing || {};
  const tts = e.tts || {};
  const card = el('div', { class: 'card builder' });
  const state = {
    provider: tts.provider || 'kokoro',
    model: tts.model || 'kokoro',
    speaker: tts.speaker || 'hf_beta',
    speed: tts.speed != null ? tts.speed : ((KOKORO_VOICES.find((voice) => voice.id === tts.speaker) || {}).speed || 0.92),
    f0: tts.f0_up_key != null ? tts.f0_up_key : 0,
    profile: tts.profile || '',
    customVoiceId: tts.customVoiceId || ''
  };

  const nameI = el('input', { class: 'input', id: 'f_name', type: 'text', value: e.name || '', placeholder: 'Front Desk', maxlength: 80 });
  const personaI = el('textarea', { class: 'textarea', id: 'f_persona', rows: 4, placeholder: 'You are a warm, sharp receptionist. Answer in 1 to 2 short spoken sentences, qualify the lead, and book a callback.' }, e.persona || '');
  const greetI = el('input', { class: 'input', id: 'f_greeting', type: 'text', value: e.greeting || '', placeholder: 'Hi, thanks for calling. How can I help today?', maxlength: 240 });
  const industrySel = el('select', { class: 'select', id: 'f_industry' }, ['general', 'healthcare', 'real_estate', 'legal', 'restaurant', 'education', 'ecommerce', 'financial_services'].map((value) => el('option', { value, selected: value === (e.industry || 'general') ? 'selected' : false }, value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()))));
  const languageSel = el('select', { class: 'select', id: 'f_language' }, [
    ['en-IN', 'English, India'], ['hi-IN', 'Hindi'], ['hinglish', 'Hinglish'], ['ta-IN', 'Tamil'], ['te-IN', 'Telugu'], ['kn-IN', 'Kannada'], ['ml-IN', 'Malayalam'], ['mr-IN', 'Marathi'], ['bn-IN', 'Bengali'], ['gu-IN', 'Gujarati']
  ].map(([value, label]) => el('option', { value, selected: value === (e.language || 'en-IN') ? 'selected' : false }, label)));
  const descI = el('input', { class: 'input', id: 'f_desc', type: 'text', value: (tts.description || ''), placeholder: 'Optional voice direction, e.g. calm and confident' });
  const profileSel = el('select', { class: 'select', id: 'f_voice_profile' }, [
    el('option', { value: '' }, 'Custom voice'),
    ...INDIAN_VOICE_PROFILES.map((profile) => el('option', { value: profile.id, selected: profile.id === state.profile ? 'selected' : false }, profile.label))
  ]);
  const savedVoiceSel = el('select', { class: 'select' }, [
    el('option', { value: '' }, State.customVoices.length ? 'Choose a saved voice' : 'No saved voices yet'),
    ...State.customVoices.map((voice) => el('option', { value: voice.id, selected: voice.id === state.customVoiceId ? 'selected' : false }, voice.name))
  ]);

  const modelSeg = el('div', { class: 'seg', id: 'f_model_seg' }, VOICE_MODELS.map((m) =>
    el('button', { type: 'button', class: m === state.model ? 'on' : '', 'data-m': m, onclick: () => {
      state.model = m;
      state.provider = m === 'kokoro' ? 'kokoro' : (m === GEMINI_TTS_MODEL ? 'gemini_tts' : 'rumik');
      syncVoice(true);
    } }, m === 'kokoro' ? 'Kokoro free' : (m === GEMINI_TTS_MODEL ? 'Gemini Telugu preview' : m))
  ));
  const speakerSel = el('select', { class: 'select', id: 'f_speaker' });
  const f0Val = el('span', { class: 'rv', id: 'f_f0_val' }, String(state.f0));
  const f0Range = el('input', { type: 'range', id: 'f_f0', min: -12, max: 12, step: 1, value: state.f0, oninput: (ev) => { state.f0 = +ev.target.value; f0Val.textContent = (state.f0 > 0 ? '+' : '') + state.f0; } });
  if (state.f0 > 0) f0Val.textContent = '+' + state.f0;

  const didSel = el('select', { class: 'select', id: 'f_did' }, [el('option', { value: '' }, 'No number assigned')]);
  if (e.telephony && e.telephony.did) { /* set after dids load */ setTimeout(() => { try { didSel.value = e.telephony.did; } catch (x) {} }, 0); }

  const speakerField = field('Speaker', speakerSel);
  const savedVoiceField = field('Saved custom voice', savedVoiceSel);
  const profileField = field('Indian accent profile', profileSel);
  const descField = field('Voice direction', descI);
  const outcomeRows = el('div', { class: 'outcome-field-list' });
  const initialOutcome = Array.isArray(e.outcomeSchema) && e.outcomeSchema.length ? e.outcomeSchema : [
    { key: 'caller_name', label: 'Caller name', type: 'string' },
    { key: 'callback_number', label: 'Callback number', type: 'string' },
    { key: 'reason', label: 'Reason for calling', type: 'string' },
    { key: 'next_step', label: 'Agreed next step', type: 'string' }
  ];
  function addOutcomeRow(value) {
    const row = value || {};
    const labelInput = el('input', { class: 'input outcome-label', value: row.label || '', placeholder: 'Example: Appointment time', maxlength: 80 });
    const typeSelect = el('select', { class: 'select outcome-type' }, [['string','Text'],['number','Number'],['boolean','Yes or no']].map(([value, label]) => el('option', { value, selected: value === (row.type || 'string') ? 'selected' : false }, label)));
    let host;
    const remove = el('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-label': 'Remove field', onclick: () => host.remove() }, 'Remove');
    host = el('div', { class: 'outcome-field-row', 'data-key': row.key || '' }, [labelInput, typeSelect, remove]);
    outcomeRows.appendChild(host);
  }
  initialOutcome.forEach(addOutcomeRow);
  const outcomeEditor = el('section', { class: 'outcome-editor' }, [
    el('div', { class: 'outcome-editor-head' }, [
      el('div', {}, [el('h4', {}, 'Information to capture'), el('p', { class: 'muted' }, 'Define the result for this business. Confirmed values appear in Calls & Recordings after each completed conversation.')]),
      el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => addOutcomeRow({}) }, 'Add field')
    ]),
    outcomeRows
  ]);
  profileSel.addEventListener('change', () => {
    state.profile = profileSel.value;
    const profile = INDIAN_VOICE_PROFILES.find((item) => item.id === state.profile);
    if (!profile) return;
    state.customVoiceId = ''; savedVoiceSel.value = '';
    state.speaker = profile.speaker; state.f0 = profile.f0;
    speakerSel.value = profile.speaker; f0Range.value = String(profile.f0);
    f0Val.textContent = profile.f0 > 0 ? '+' + profile.f0 : String(profile.f0);
    descI.value = profile.description;
  });
  savedVoiceSel.addEventListener('change', () => {
    state.customVoiceId = savedVoiceSel.value;
    const voice = State.customVoices.find((item) => item.id === state.customVoiceId);
    if (!voice) return;
    state.provider = voice.provider || 'rumik'; state.model = voice.model; state.speaker = voice.speaker; state.speed = voice.speed || 1; state.f0 = voice.f0_up_key; state.profile = '';
    profileSel.value = ''; speakerSel.value = voice.speaker; f0Range.value = String(voice.f0_up_key); f0Val.textContent = voice.f0_up_key > 0 ? '+' + voice.f0_up_key : String(voice.f0_up_key);
    descI.value = voice.description || '';
    syncVoice();
  });
  function syncVoice(resetSpeaker) {
    $$('#f_model_seg button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-m') === state.model));
    const isMul = state.model === 'mulberry';
    const isKokoro = state.model === 'kokoro';
    const isGemini = state.model === GEMINI_TTS_MODEL;
    const choices = isKokoro ? KOKORO_VOICES : (isGemini ? GEMINI_TELUGU_VOICES : SPEAKERS.map((id) => ({ id, label: id })));
    if (resetSpeaker || !choices.some((item) => item.id === state.speaker)) {
      state.speaker = choices[0].id;
      if (choices[0].speed) state.speed = choices[0].speed;
    }
    speakerSel.innerHTML = '';
    choices.forEach((item) => speakerSel.appendChild(el('option', { value: item.id, selected: item.id === state.speaker ? 'selected' : false }, item.label)));
    speakerSel.onchange = () => { state.speaker = speakerSel.value; const choice = choices.find((item) => item.id === state.speaker); if (choice && choice.speed) state.speed = choice.speed; };
    speakerField.style.display = (isMul || isKokoro || isGemini) ? '' : 'none';
    profileField.style.display = isMul ? '' : 'none';
    f0Range.closest('.field').style.display = isMul ? '' : 'none';
    descField.style.display = (isMul || isGemini) ? '' : 'none';
  }

  const submitBtn = el('button', { class: 'btn btn-primary' }, existing ? 'Save changes' : 'Create agent');
  const form = el('form', { onsubmit: onSave }, [
    el('div', { class: 'form-grid' }, [
      field('Agent name', nameI),
      field('Assigned number', didSel),
      field('Industry', industrySel),
      field('Primary language', languageSel),
      (function () { const f = field('Persona', personaI); f.classList.add('full'); return f; })(),
      (function () { const f = field('Greeting', greetI); f.classList.add('full'); return f; })(),
      field('Voice model', modelSeg),
      savedVoiceField,
      profileField,
      field('Pitch, f0_up_key', el('div', { class: 'range-row' }, [f0Range, f0Val])),
      speakerField,
      descField
    ]),
    outcomeEditor,
    el('div', { class: 'flex gap-2', style: 'margin-top:18px;align-items:center;flex-wrap:wrap' }, [submitBtn, el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { modalClose(); goto('studio'); } }, 'Customize your own voice'), existing ? el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => modalClose() }, 'Cancel') : null])
  ]);

  card.appendChild(el('h3', {}, existing ? 'Edit agent' : 'New agent'));
  card.appendChild(el('p', { class: 'hint' }, existing ? 'Update the persona, voice, or assigned number.' : 'Describe the persona and pick a voice. You can preview it instantly before assigning a number.'));
  card.appendChild(form);
  syncVoice();

  let _modalClose = null;
  function modalClose() { if (_modalClose) _modalClose(); }
  card._setModalClose = (fn) => { _modalClose = fn; };

  async function onSave(ev) {
    ev.preventDefault();
    const name = nameI.value.trim();
    const persona = personaI.value.trim();
    if (!name) { toast('Give the agent a name.', 'err'); nameI.focus(); return; }
    if (!persona) { toast('Add a persona so the agent knows how to behave.', 'err'); personaI.focus(); return; }
    submitBtn.disabled = true; submitBtn.textContent = existing ? 'Saving...' : 'Creating...';
    const payload = {
      name: name,
      persona: persona,
      greeting: greetI.value.trim(),
      industry: industrySel.value,
      language: languageSel.value,
      did: didSel.value || '',
      tts: { provider: state.provider, model: state.model, speaker: state.speaker, speed: state.speed, f0_up_key: state.f0, profile: state.profile, customVoiceId: state.customVoiceId, description: descI.value.trim() },
      outcomeSchema: $$('.outcome-field-row', outcomeRows).map((row) => ({ key: row.getAttribute('data-key') || '', label: $('.outcome-label', row).value.trim(), type: $('.outcome-type', row).value })).filter((item) => item.label)
    };
    try {
      if (existing) {
        payload.id = existing.id;
        const res = await api('/api/agents/update', { method: 'POST', body: payload });
        const idx = State.agents.findIndex((a) => a.id === existing.id);
        if (idx !== -1) State.agents[idx] = res.agent || Object.assign({}, existing, payload);
        toast('Agent updated.', 'ok');
        modalClose();
      } else {
        const res = await api('/api/agents', { method: 'POST', body: payload });
        if (res.agent) State.agents.push(res.agent);
        toast('Agent created.', 'ok');
        // reset the inline form
        nameI.value = ''; personaI.value = ''; greetI.value = ''; descI.value = ''; didSel.value = ''; profileSel.value = ''; state.profile = '';
      }
      paintAgents();
    } catch (ex) {
      toast(ex.message || 'Could not save agent.', 'err');
    } finally {
      submitBtn.disabled = false; submitBtn.textContent = existing ? 'Save changes' : 'Create agent';
    }
  }

  return card;
}

function paintAgents() {
  const grid = $('#agentsGrid'); if (!grid) return;
  refillDidOptions();
  grid.innerHTML = '';
  if (!State.agents.length) {
    grid.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'ttl' }, 'No agents yet'),
      el('div', {}, 'Use the builder above to create your first voice agent.')
    ]));
    return;
  }
  State.agents.forEach((a) => grid.appendChild(agentCard(a)));
}

function agentCard(a) {
  const tts = a.tts || {};
  const profile = INDIAN_VOICE_PROFILES.find((item) => item.id === tts.profile);
  const providerLabel = tts.provider === 'kokoro' ? 'Local, ₹0 API' : (tts.provider === 'gemini_tts' ? 'Gemini Telugu preview, live uses Dograh default' : 'Rumik');
  const voiceLine = providerLabel + ' / ' + (profile ? profile.label + ' / ' : '') + (tts.speaker || 'speaker') + (tts.f0_up_key ? ' / pitch ' + (tts.f0_up_key > 0 ? '+' : '') + tts.f0_up_key : '');
  const did = a.telephony && a.telephony.did ? a.telephony.did : null;

  const previewBtn = el('button', { class: 'btn btn-ghost btn-sm' }, 'Preview voice');
  previewBtn.addEventListener('click', () => previewAgentVoice(a, previewBtn));

  // textContent everywhere = XSS safe for persona/name
  return el('div', { class: 'card card-glow agent-card' }, [
    el('div', { class: 'ac-top' }, [
      el('div', { class: 'ac-av' }, initials(a.name)),
      el('div', { style: 'min-width:0' }, [
        el('div', { class: 'ac-name' }, a.name),
        el('div', { class: 'ac-voice' }, voiceLine)
      ])
    ]),
    el('div', { class: 'ac-persona' }, a.persona || 'No persona set.'),
    el('div', { class: 'ac-meta' }, [
      did ? el('span', { class: 'tag' }, did) : el('span', { class: 'tag' }, 'no number'),
      el('span', { class: 'tag' }, (tts.model || 'mulberry'))
      ,el('span', { class: 'tag' }, String(a.language || 'en-IN'))
    ]),
    el('div', { class: 'ac-actions' }, [
      previewBtn,
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => openAgentWorkflow(a) }, 'Workflow'),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => openEditAgent(a) }, 'Edit'),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => changeAgentLanguage(a) }, 'Language'),
      el('button', { class: 'btn btn-ghost btn-sm', onclick: () => confirmDeleteAgent(a) }, 'Delete')
    ])
  ]);
}

function changeAgentLanguage(agent) {
  const options=[['en-IN','English (India)'],['te-IN','తెలుగు (Telugu)'],['hi-IN','हिन्दी (Hindi)'],['hinglish','Hinglish'],['ta-IN','Tamil'],['kn-IN','Kannada'],['ml-IN','Malayalam'],['mr-IN','Marathi'],['bn-IN','Bengali'],['gu-IN','Gujarati']];
  if(agent.language&&!options.some(([code])=>code===agent.language))options.push([agent.language,agent.language]);
  const language=el('select',{class:'select','aria-label':'Primary language'},options.map(([value,label])=>el('option',{value,selected:value===(agent.language||'en-IN')},label)));
  const greeting=el('textarea',{class:'input',rows:3,'aria-label':'Greeting'},agent.greeting||'');
  modal({title:'Language · '+agent.name,body:el('div',{},[
    field('Primary language',language),field('Greeting (optional)',greeting),
    el('p',{class:'muted'},'This is the opening language, not a language lock. Callers can ask to switch languages and switch back during the same call without restarting their enquiry. Saved details stay with that call. A mismatched greeting is replaced with a default; review it after saving. Live calls use Dograh speech; supported languages and pronunciation depend on its speech providers. Local Kokoro remains available for previews.')
  ]),confirmText:'Save language',onConfirm:async()=>{
    await api('/api/agents/update',{method:'POST',body:{id:agent.id,language:language.value,greeting:greeting.value}});
    await ensureAgents(true);paintAgents();toast('Language saved and voice workflows republished.','ok');
  }});
}

function openAgentWorkflow(agent) {
  const fields = Array.isArray(agent.outcomeSchema) ? agent.outcomeSchema : [];
  const fieldItems = fields.length ? fields.map((item) => el('span', { class: 'workflow-field' }, item.label)) : [el('span', { class: 'muted' }, 'No outcome fields configured')];
  const node = (kind, title, copy, content) => el('div', { class: 'workflow-node workflow-node-' + kind }, [el('span', { class: 'workflow-node-kind' }, kind), el('h4', {}, title), copy ? el('p', {}, copy) : null, content ? el('div', { class: 'workflow-fields' }, content) : null]);
  const arrow = (label) => el('div', { class: 'workflow-edge' }, [el('span', {}, label), el('i', {})]);
  modal({
    title: agent.name + ' workflow',
    body: el('div', { class: 'workflow-view' }, [
      el('p', { class: 'workflow-intro' }, 'This is the published business flow. Dograh runs the underlying realtime workflow.'),
      node('rules', 'Identity and boundaries', agent.persona || 'Configured agent instructions'),
      arrow('Start call'),
      node('start', 'Greeting', agent.greeting || 'Open the conversation and understand the caller request.'),
      arrow('Continue'),
      node('agent', 'Handle conversation', 'Answer from approved business knowledge, ask relevant questions, and confirm important details.'),
      arrow('Complete or escalate'),
      node('capture', 'Capture business outcome', 'Only explicitly provided or confirmed values are extracted.', fieldItems),
      arrow('Finish'),
      node('end', 'Save call result', 'Store the outcome, recording links when enabled, and collected fields for review.')
    ]),
    confirmText: 'Close', onConfirm: async () => {}
  });
}

async function previewAgentVoice(a, btn) {
  const tts = a.tts || {};
  const text = (a.greeting && a.greeting.trim()) || ('Hi, this is ' + (a.name || 'your agent') + '. How can I help today.');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'Synthesizing...';
  try {
    const body = { text: text, provider: tts.provider || 'rumik', model: tts.model || 'mulberry', speaker: tts.speaker, speed: tts.speed, f0_up_key: tts.f0_up_key, description: tts.description };
    const res = await api('/api/tts', { method: 'POST', body: body });
    const buf = await res.arrayBuffer();
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    await audio.play();
    btn.textContent = 'Playing...';
    audio.onended = () => { btn.textContent = old; btn.disabled = false; URL.revokeObjectURL(url); };
  } catch (ex) {
    toast(ex.message || 'Voice preview failed.', 'err');
    btn.textContent = old; btn.disabled = false;
  }
}

function openEditAgent(a) {
  const form = buildAgentForm(a);
  form.style.boxShadow = 'none'; form.style.border = '0'; form.style.background = 'transparent'; form.style.padding = '0';
  const host = $('#modal-host');
  const close = () => { host.classList.add('hide'); host.setAttribute('aria-hidden', 'true'); host.innerHTML = ''; };
  form._setModalClose(() => { close(); paintAgents(); });
  const card = el('div', { class: 'modal agent-edit-modal', role: 'dialog', 'aria-modal': 'true', style: 'max-width:780px' }, [form]);
  host.innerHTML = '';
  host.appendChild(el('div', { onclick: (ev) => { if (ev.target === ev.currentTarget) close(); }, style: 'position:absolute;inset:0' }));
  host.appendChild(card);
  host.classList.remove('hide');
  host.setAttribute('aria-hidden', 'false');
  setTimeout(refillDidOptions, 0);
}

function confirmDeleteAgent(a) {
  modal({
    title: 'Delete agent',
    body: el('p', {}, ['Delete ', el('b', {}, a.name), '. This cannot be undone.']),
    confirmText: 'Delete agent', confirmKind: 'danger',
    onConfirm: async () => {
      await api('/api/agents/delete', { method: 'POST', body: { id: a.id } });
      State.agents = State.agents.filter((x) => x.id !== a.id);
      paintAgents();
      toast('Agent deleted.', 'ok');
    }
  });
}

/* helper used by builder */
function field(label, input) { return el('div', { class: 'field' }, [el('label', {}, label), input]); }

/* ===========================================================================
   3. VOICE STUDIO
   =========================================================================== */
async function viewStudio(root) {
  root.appendChild(viewHead('Voice Studio', 'Type anything, pick a model, and synthesize. See the waveform, hear it back, and watch the cost in real time.'));
  await ensureCustomVoices().catch(() => []);

  const st = { provider: 'kokoro', model: 'kokoro', tone: 'neutral', speaker: 'hf_beta', speed: 0.92, f0: 0, profile: '', stream: false };

  const textArea = el('textarea', { class: 'textarea studio-text', id: 's_text', placeholder: 'Welcome to LessRepeat. AI voice agents that speak, understand and act.' }, 'Welcome to LessRepeat. AI voice agents that speak, understand and act.');

  // model picker
  const modelSeg = el('div', { class: 'seg' }, VOICE_MODELS.map((m) =>
    el('button', { type: 'button', class: m === st.model ? 'on' : '', 'data-m': m, onclick: () => { st.model = m; st.provider = m === 'kokoro' ? 'kokoro' : (m === GEMINI_TTS_MODEL ? 'gemini_tts' : 'rumik'); syncCtl(true); updateCost(); } }, m === 'kokoro' ? 'Kokoro free' : (m === GEMINI_TTS_MODEL ? 'Gemini Telugu' : m))
  ));
  // muga tones
  const toneSeg = el('div', { class: 'seg', id: 's_tones' }, MUGA_TONES.map((tn) =>
    el('button', { type: 'button', class: tn === st.tone ? 'on' : '', 'data-t': tn, onclick: () => { st.tone = tn; $$('#s_tones button').forEach((b) => b.classList.toggle('on', b.getAttribute('data-t') === tn)); } }, tn)
  ));
  // mulberry controls
  const speakerSel = el('select', { class: 'select' });
  speakerSel.addEventListener('change', () => { st.speaker = speakerSel.value; });
  const f0Val = el('span', { class: 'rv' }, '0');
  const f0Range = el('input', { type: 'range', min: -12, max: 12, step: 1, value: 0, oninput: (ev) => { st.f0 = +ev.target.value; f0Val.textContent = (st.f0 > 0 ? '+' : '') + st.f0; } });
  const descI = el('input', { class: 'input', placeholder: 'Optional voice direction, e.g. warm and reassuring' });
  descI.addEventListener('input', () => { st.desc = descI.value; });
  const profileSel = el('select', { class: 'select' }, [
    el('option', { value: '' }, 'Custom voice'),
    ...INDIAN_VOICE_PROFILES.map((profile) => el('option', { value: profile.id, selected: profile.id === st.profile ? 'selected' : false }, profile.label))
  ]);
  let editingVoiceId = '';
  const voiceNameI = el('input', { class: 'input', placeholder: 'Voice name, e.g. Priya Support' });
  const savedStudioSel = el('select', { class: 'select' }, [
    el('option', { value: '' }, 'New custom voice'),
    ...State.customVoices.map((voice) => el('option', { value: voice.id }, voice.name))
  ]);
  profileSel.addEventListener('change', () => {
    st.profile = profileSel.value;
    const profile = INDIAN_VOICE_PROFILES.find((item) => item.id === st.profile);
    if (!profile) return;
    st.speaker = profile.speaker; st.f0 = profile.f0; st.desc = profile.description;
    speakerSel.value = profile.speaker; f0Range.value = String(profile.f0);
    f0Val.textContent = profile.f0 > 0 ? '+' + profile.f0 : String(profile.f0);
    descI.value = profile.description;
  });
  savedStudioSel.addEventListener('change', () => {
    const voice = State.customVoices.find((item) => item.id === savedStudioSel.value);
    editingVoiceId = voice ? voice.id : '';
    if (!voice) { voiceNameI.value = ''; return; }
    voiceNameI.value = voice.name; st.provider = voice.provider || 'rumik'; st.model = voice.model; st.speaker = voice.speaker; st.speed = voice.speed || 1; st.f0 = voice.f0_up_key; st.desc = voice.description || ''; st.profile = '';
    profileSel.value = ''; speakerSel.value = voice.speaker; f0Range.value = String(voice.f0_up_key); f0Val.textContent = voice.f0_up_key > 0 ? '+' + voice.f0_up_key : String(voice.f0_up_key); descI.value = voice.description || '';
    syncCtl();
  });

  const mugaCtl = field('Tone (muga)', toneSeg);
  const mulSpeaker = field('Speaker (mulberry)', speakerSel);
  const mulProfile = field('Indian accent profile', profileSel);
  const mulPitch = field('Pitch, f0_up_key', el('div', { class: 'range-row' }, [f0Range, f0Val]));
  const mulDesc = field('Voice direction', descI);
  let streamToggle;
  function syncCtl(resetSpeaker) {
    $$('.seg button[data-m]').forEach((b) => b.classList.toggle('on', b.getAttribute('data-m') === st.model));
    const isMul = st.model === 'mulberry';
    const isKokoro = st.model === 'kokoro';
    const isGemini = st.model === GEMINI_TTS_MODEL;
    const choices = isKokoro ? KOKORO_VOICES : (isGemini ? GEMINI_TELUGU_VOICES : SPEAKERS.map((id) => ({ id, label: id })));
    if (resetSpeaker || !choices.some((item) => item.id === st.speaker)) {
      st.speaker = choices[0].id;
      if (choices[0].speed) st.speed = choices[0].speed;
    }
    speakerSel.innerHTML = '';
    choices.forEach((item) => speakerSel.appendChild(el('option', { value: item.id, selected: item.id === st.speaker ? 'selected' : false }, item.label)));
    speakerSel.onchange = () => { st.speaker = speakerSel.value; const choice = choices.find((item) => item.id === st.speaker); if (choice && choice.speed) st.speed = choice.speed; };
    mugaCtl.style.display = st.model === 'muga' ? '' : 'none';
    [mulProfile, mulPitch].forEach((f) => f.style.display = isMul ? '' : 'none');
    mulSpeaker.style.display = (isMul || isKokoro || isGemini) ? '' : 'none';
    mulDesc.style.display = (isMul || isGemini) ? '' : 'none';
    if (streamToggle) { streamToggle.style.display = isGemini ? 'none' : ''; if (isGemini) st.stream = false; }
  }

  const charsEl = el('span', { class: 'c-chars', id: 's_chars' }, '0 chars');
  const costEl = el('span', { class: 'c-cost', id: 's_cost' }, [document.createTextNode('about '), el('b', {}, '₹0.00')]);
  function updateCost() {
    const len = (textArea.value || '').length;
    const capped = Math.min(len, 2000);
    charsEl.textContent = len + ' chars' + (len > 2000 ? ' (capped at 2000)' : '');
    costEl.innerHTML = '';
    if (st.model === GEMINI_TTS_MODEL) {
      costEl.appendChild(el('b', {}, 'metered by audio duration'));
      return;
    }
    const cost = st.model === 'kokoro' ? 0 : capped / 1000 * (RATE[st.model] || RATE.mulberry);
    costEl.appendChild(document.createTextNode('about '));
    costEl.appendChild(el('b', {}, '₹' + cost.toFixed(2)));
  }
  textArea.addEventListener('input', updateCost);

  streamToggle = el('label', { class: 'streamtoggle' }, [
    el('input', { type: 'checkbox', onchange: (ev) => { st.stream = ev.target.checked; } }),
    document.createTextNode('Stream progressively (low latency)')
  ]);

  const synthBtn = el('button', { class: 'btn btn-primary' }, 'Synthesize');
  const saveVoiceBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Save custom voice');
  const audioEl = el('audio', { controls: 'controls', preload: 'none' });
  const waveCanvas = el('canvas', { class: 'wave-canvas', id: 's_wave' });
  const playerRow = el('div', { class: 'player-row', style: 'display:none' }, [audioEl]);

  synthBtn.addEventListener('click', () => doSynthesize(st, textArea, synthBtn, audioEl, waveCanvas, playerRow));
  saveVoiceBtn.addEventListener('click', async () => {
    const name = voiceNameI.value.trim();
    if (!name) { toast('Give this voice a name before saving.', 'err'); voiceNameI.focus(); return; }
    saveVoiceBtn.disabled = true; saveVoiceBtn.textContent = 'Saving voice...';
    try {
      const out = await api('/api/custom-voices', { method: 'POST', body: { id: editingVoiceId || undefined, name, provider: st.provider, model: st.model, speaker: st.speaker, speed: st.speed, f0_up_key: st.f0, description: st.desc || descI.value.trim() } });
      const index = State.customVoices.findIndex((item) => item.id === out.voice.id);
      if (index === -1) State.customVoices.push(out.voice); else State.customVoices[index] = out.voice;
      editingVoiceId = out.voice.id; savedStudioSel.innerHTML = ''; savedStudioSel.appendChild(el('option', { value: '' }, 'New custom voice'));
      State.customVoices.forEach((voice) => savedStudioSel.appendChild(el('option', { value: voice.id, selected: voice.id === editingVoiceId ? 'selected' : false }, voice.name)));
      toast('Custom voice saved. It is now available when creating or editing agents.', 'ok');
    } catch (error) { toast(error.message || 'Could not save custom voice.', 'err'); }
    finally { saveVoiceBtn.disabled = false; saveVoiceBtn.textContent = 'Save custom voice'; }
  });

  const main = el('div', { class: 'card studio-main' }, [
    field('Text to speak', textArea),
    el('div', { class: 'wave-wrap' }, [waveCanvas, playerRow]),
    el('div', { class: 'flex items-center gap-2', style: 'flex-wrap:wrap' }, [synthBtn, streamToggle])
  ]);

  const side = el('div', { class: 'studio-side' }, [
    el('div', { class: 'card card-pad' }, [
      el('h3', { class: 't-h3', style: 'margin-bottom:14px' }, 'Saved voice library'),
      field('Load or update', savedStudioSel),
      field('Voice name', voiceNameI),
      saveVoiceBtn,
      el('p', { class: 'muted', style: 'font-size:.76rem;line-height:1.5;margin-top:10px' }, 'Synthesize and listen first, then save the exact speaker, pitch, and voice direction for reuse across agents.')
    ]),
    el('div', { class: 'card card-pad' }, [
      el('h3', { class: 't-h3', style: 'margin-bottom:14px' }, 'Voice'),
      field('Model', modelSeg),
      mugaCtl, mulProfile, mulSpeaker, mulPitch, mulDesc
    ]),
    el('div', { class: 'card card-pad' }, [
      el('h3', { class: 't-h3', style: 'margin-bottom:14px' }, 'Economics'),
      el('div', { class: 'cost-readout' }, [charsEl, costEl]),
      el('p', { class: 'muted', style: 'font-size:.8rem;margin-top:10px' }, 'Kokoro runs locally with no per-character fee. Gemini Telugu uses your Gemini API quota for Studio previews. Live agent and demo calls use the stable Dograh default voice because this project currently has no reliable Gemini Live quota.')
    ])
  ]);

  root.appendChild(el('div', { class: 'studio-grid' }, [main, side]));
  profileSel.dispatchEvent(new Event('change'));
  syncCtl(); updateCost();
  // size the canvas after layout
  setTimeout(() => sizeCanvas(waveCanvas), 30);
  window.addEventListener('resize', () => sizeCanvas(waveCanvas), { once: true });
}

async function doSynthesize(st, textArea, btn, audioEl, canvas, playerRow) {
  const raw = (textArea.value || '').trim();
  if (!raw) { toast('Type something to synthesize.', 'err'); textArea.focus(); return; }
  let text = raw.slice(0, 2000);
  // muga tone is applied as a [tone] prefix
  if (st.model === 'muga' && st.tone && st.tone !== 'neutral') text = '[' + st.tone + '] ' + text;

  const old = btn.textContent; btn.disabled = true; btn.textContent = 'Synthesizing...';

  if (st.stream) {
    try {
      await streamSynthesize(text, st, canvas, btn);
      btn.disabled = false; btn.textContent = old;
      refreshUsageSoft();
      return;
    } catch (ex) {
      toast('Stream failed, falling back to file. ' + (ex.message || ''), 'info');
      // fall through to normal synth
    }
  }

  try {
    const body = { text: text, provider: st.provider, model: st.model };
    if (st.model === 'kokoro') { body.speaker = st.speaker; body.speed = st.speed; }
    if (st.model === GEMINI_TTS_MODEL) { body.speaker = st.speaker; body.description = st.desc || ''; }
    if (st.model === 'mulberry') { body.speaker = st.speaker; body.f0_up_key = st.f0; if (st.desc) body.description = st.desc; }
    const res = await api('/api/tts', { method: 'POST', body: body });
    const chars = res.headers.get('X-Chars');
    const credits = res.headers.get('X-Credits-Used');
    const buf = await res.arrayBuffer();
    const blob = new Blob([buf], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    audioEl.src = url; playerRow.style.display = '';
    drawWaveformFromBuffer(buf.slice(0), canvas);
    audioEl.play().catch(() => {});
    toast('Synthesized ' + (chars || text.length) + ' chars' + (credits ? ', ' + credits + ' credits.' : '.'), 'ok');
    refreshUsageSoft();
  } catch (ex) {
    toast(ex.message || 'Synthesis failed.', 'err');
  } finally {
    btn.disabled = false; btn.textContent = old;
  }
}

function refreshUsageSoft() {
  // invalidate cached usage so Overview reflects new chars next visit
  State.loaded.usage = false; State.usage = null;
}

/* ---- waveform rendering ---- */
function sizeCanvas(canvas) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 560, h = canvas.clientHeight || 90;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // idle baseline
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(110,123,255,0.25)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
}
function drawWaveformFromBuffer(arrbuf, canvas) {
  try {
    const samples = decodeWavPcm(arrbuf);
    if (!samples) { sizeCanvas(canvas); return; }
    drawWaveform(samples, canvas);
  } catch (e) { sizeCanvas(canvas); }
}
function decodeWavPcm(arrbuf) {
  const dv = new DataView(arrbuf);
  if (dv.byteLength < 44) return null;
  // verify RIFF/WAVE
  if (dv.getUint32(0, false) !== 0x52494646) return null; // 'RIFF'
  // walk chunks to find fmt + data
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= dv.byteLength) {
    const id = dv.getUint32(off, false);
    const sz = dv.getUint32(off + 4, true);
    if (id === 0x666d7420) { // 'fmt '
      fmt = { format: dv.getUint16(off + 8, true), channels: dv.getUint16(off + 10, true), bits: dv.getUint16(off + 22, true) };
    } else if (id === 0x64617461) { // 'data'
      dataOff = off + 8; dataLen = sz; break;
    }
    off += 8 + sz + (sz & 1);
  }
  if (!fmt || dataOff < 0 || fmt.bits !== 16) return null;
  const n = Math.floor(dataLen / 2);
  const ch = fmt.channels || 1;
  const out = new Float32Array(Math.floor(n / ch));
  let j = 0;
  for (let i = 0; i + ch <= n; i += ch) {
    const s = dv.getInt16(dataOff + i * 2, true);
    out[j++] = s / 32768;
  }
  return out;
}
function drawWaveform(samples, canvas) {
  sizeCanvas(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr, h = canvas.height / dpr;
  ctx.clearRect(0, 0, w, h);
  const bars = Math.max(40, Math.min(180, Math.floor(w / 4)));
  const block = Math.floor(samples.length / bars) || 1;
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, '#34E7E4'); grad.addColorStop(0.6, '#6E7BFF'); grad.addColorStop(1, '#A855F7');
  ctx.fillStyle = grad;
  const bw = w / bars;
  for (let b = 0; b < bars; b++) {
    let peak = 0;
    for (let k = 0; k < block; k++) { const v = Math.abs(samples[b * block + k] || 0); if (v > peak) peak = v; }
    const bh = Math.max(2, peak * (h * 0.92));
    const x = b * bw, y = (h - bh) / 2;
    const r = Math.min(bw * 0.34, 2);
    roundRect(ctx, x + bw * 0.18, y, bw * 0.64, bh, r);
  }
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath(); ctx.fill();
}

/* ---- streaming TTS (PCM int16 LE 24kHz) via /api/ws-connect then wss Rumik ---- */
async function streamSynthesize(text, st, canvas, btn) {
  const mint = await api('/api/ws-connect', { method: 'POST', body: { text: text, model: st.model } });
  if (!mint.ws_url) throw new ApiError(0, 'No ws_url returned.');
  return new Promise((resolve, reject) => {
    let ws, audioCtx, nextTime = 0, started = false, chunks = [];
    const SR = 24000;
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR }); } catch (e) { return reject(new ApiError(0, 'No Web Audio.')); }
    const url = mint.ws_url + (mint.token && mint.ws_url.indexOf('token=') === -1 ? (mint.ws_url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(mint.token) : '');
    try { ws = new WebSocket(url); } catch (e) { return reject(new ApiError(0, 'WebSocket failed.')); }
    ws.binaryType = 'arraybuffer';
    const fail = (m) => { try { ws.close(); } catch (e) {} reject(new ApiError(0, m)); };
    const timeout = setTimeout(() => fail('Stream timed out.'), 20000);
    ws.onopen = () => { try { ws.send(JSON.stringify({ text: text, model: st.model })); } catch (e) {} };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try { const m = JSON.parse(ev.data); if (m.type === 'end' || m.done) { clearTimeout(timeout); finish(); } } catch (e) {}
        return;
      }
      const pcm = new Int16Array(ev.data);
      if (!pcm.length) return;
      chunks.push(pcm);
      const f32 = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
      const ab = audioCtx.createBuffer(1, f32.length, SR);
      ab.copyToChannel(f32, 0);
      const src = audioCtx.createBufferSource(); src.buffer = ab; src.connect(audioCtx.destination);
      const now = audioCtx.currentTime;
      if (nextTime < now) nextTime = now + 0.04;
      src.start(nextTime); nextTime += ab.duration;
      started = true;
    };
    ws.onclose = () => { clearTimeout(timeout); if (started) finish(); else fail('Stream closed early.'); };
    ws.onerror = () => { clearTimeout(timeout); fail('Stream connection error.'); };
    function finish() {
      // draw the gathered waveform once
      if (chunks.length) {
        let total = 0; chunks.forEach((c) => total += c.length);
        const all = new Float32Array(total); let o = 0;
        chunks.forEach((c) => { for (let i = 0; i < c.length; i++) all[o++] = c[i] / 32768; });
        try { drawWaveform(all, canvas); } catch (e) {}
      }
      try { ws.close(); } catch (e) {}
      resolve();
    }
  });
}

/* ===========================================================================
   4. DEMO LINKS
   =========================================================================== */
async function viewDemoLinks(root) {
  root.appendChild(viewHead('Demo links', 'Create a tenant-branded web voice experience for one agent, then share it without exposing Studio access or provider secrets.'));
  const grid = el('div', { class: 'demo-admin-grid' }, [
    el('div', { class: 'card demo-create-card', id: 'demoCreateHost' }),
    el('div', { class: 'card demo-list-card', id: 'demoListHost' })
  ]);
  root.appendChild(grid);

  const createHost = $('#demoCreateHost', root);
  const listHost = $('#demoListHost', root);
  createHost.appendChild(skeleton('sk-card', 1));
  listHost.appendChild(skeleton('sk-card', 1));

  try {
    await ensureAgents();
    const payload = await api('/api/demo-links');
    State.demoLinks = payload.demoLinks || [];
    State.loaded.demoLinks = true;
  } catch (error) {
    createHost.innerHTML = '';
    listHost.innerHTML = '';
    listHost.appendChild(el('div', { class: 'demo-error', role: 'alert' }, error.message || 'Demo links could not be loaded.'));
    return;
  }

  function ephemeralUrl(item) {
    if (item && item.sharePath) return location.origin + item.sharePath;
    try { return sessionStorage.getItem('lessrepeat_demo_' + item.id) || ''; } catch (_) { return ''; }
  }
  function rememberUrl(id, url) {
    try { sessionStorage.setItem('lessrepeat_demo_' + id, url); } catch (_) {}
  }
  async function copyUrl(url) {
    if (!url) return;
    try { await navigator.clipboard.writeText(url); toast('Demo link copied.', 'ok'); }
    catch (_) {
      const input = el('textarea', { style: 'position:fixed;opacity:0;pointer-events:none' }, url);
      document.body.appendChild(input); input.select(); document.execCommand('copy'); input.remove();
      toast('Demo link copied.', 'ok');
    }
  }
  function openUrl(url) {
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }
  function redraw() {
    root.innerHTML = '';
    viewDemoLinks(root);
  }

  createHost.innerHTML = '';
  createHost.appendChild(el('div', { class: 'demo-card-head' }, [
    el('div', {}, [el('h3', { class: 't-h3' }, 'Create a share link'), el('p', { class: 'muted' }, 'The URL is recoverable after restart. Its secret is encrypted at rest, while validation still uses a SHA-256 hash.')])
  ]));
  if (!State.agents.length) {
    createHost.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'ttl' }, 'Create an agent first'),
      el('p', {}, 'A demo link must be scoped to one tenant-owned agent.'),
      el('button', { class: 'btn btn-primary', onclick: () => goto('agents') }, 'Open agents')
    ]));
  } else {
    const demoVoiceLabel = (item) => {
      const tts = item.tts || {};
      const voice = KOKORO_VOICES.find((choice) => choice.id === (tts.provider === 'kokoro' ? tts.speaker : 'hf_beta'));
      return voice ? voice.label.split(',')[0] : 'Meera';
    };
    const agent = el('select', { class: 'select', id: 'demoAgent' }, State.agents.map((item) => el('option', { value: item.id }, item.name + ' · Dograh default')));
    const label = el('input', { class: 'input', id: 'demoLabel', maxlength: '80', placeholder: 'Prospect demo' });
    const expiry = el('select', { class: 'select', id: 'demoExpiry' }, [1, 3, 7, 14, 30].map((days) => el('option', { value: days, selected: days === 7 ? 'selected' : false }, days + (days === 1 ? ' day' : ' days'))));
    const duration = el('select', { class: 'select', id: 'demoDuration' }, [60, 180, 300, 600].map((seconds) => el('option', { value: seconds, selected: seconds === 300 ? 'selected' : false }, Math.round(seconds / 60) + (seconds === 60 ? ' minute' : ' minutes'))));
    const starts = el('input', { class: 'input', id: 'demoStarts', type: 'number', min: '1', max: '1000', value: '25', inputmode: 'numeric' });
    const submit = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Create link');
    const form = el('form', { class: 'demo-create-form' }, [
      el('div', { class: 'field' }, [el('label', {}, 'Agent'), agent]),
      el('div', { class: 'field' }, [el('label', {}, 'Internal label'), label]),
      el('div', { class: 'field' }, [el('label', {}, 'Expires after'), expiry]),
      el('div', { class: 'field' }, [el('label', {}, 'Call duration'), duration]),
      el('div', { class: 'field' }, [el('label', {}, 'Maximum starts'), starts]),
      submit
    ]);
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); submit.disabled = true; submit.textContent = 'Creating...';
      try {
        const result = await api('/api/demo-links', { method: 'POST', body: {
          agentId: agent.value, label: label.value.trim(), expiresInDays: Number(expiry.value),
          maxSessionSeconds: Number(duration.value), maxStarts: Number(starts.value)
        } });
        const fullUrl = location.origin + result.sharePath;
        rememberUrl(result.demoLink.id, fullUrl);
        State.demoLinks.unshift(result.demoLink);
        await copyUrl(fullUrl);
        toast('Created and copied. Open it in a separate tab to test.', 'ok', 'Demo ready');
        redraw();
      } catch (error) {
        toast(error.message || 'Demo link could not be created.', 'err');
        submit.disabled = false; submit.textContent = 'Create demo link';
      }
    });
    createHost.appendChild(form);
  }

  listHost.innerHTML = '';
  listHost.appendChild(el('div', { class: 'demo-card-head' }, [
    el('div', {}, [el('h3', { class: 't-h3' }, 'Distributed demos'), el('p', { class: 'muted' }, 'Open, copy, or revoke an active share link at any time.')]),
    el('span', { class: 'tag' }, State.demoLinks.length + ' total')
  ]));
  if (!State.demoLinks.length) {
    listHost.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'ttl' }, 'No demo links yet'), el('p', {}, 'Create one to share a branded web voice experience.') ]));
  } else {
    const agentNames = Object.fromEntries(State.agents.map((item) => [item.id, item.name]));
    const demoVoices = Object.fromEntries(State.agents.map((item) => {
      const tts = item.tts || {};
      const voice = KOKORO_VOICES.find((choice) => choice.id === (tts.provider === 'kokoro' ? tts.speaker : 'hf_beta'));
      return [item.id, 'Dograh default'];
    }));
    const list = el('div', { class: 'demo-link-list' });
    State.demoLinks.forEach((item) => {
      const url = ephemeralUrl(item);
      const status = item.status || 'active';
      const card = el('article', { class: 'demo-link-row' }, [
        el('div', { class: 'demo-link-main' }, [
          el('div', { class: 'demo-link-title' }, [el('strong', {}, item.label), el('span', { class: 'demo-status ' + status }, status)]),
          el('div', { class: 'demo-link-meta' }, [
            el('span', {}, agentNames[item.agentId] || 'Agent'),
            el('span', {}, demoVoices[item.agentId] || 'Dograh default'),
            el('span', {}, item.starts + ' of ' + item.maxStarts + ' starts'),
            el('span', {}, 'Expires ' + new Date(item.expiresAt).toLocaleDateString())
          ]),
          !url && status === 'active' ? el('p', { class: 'demo-once-note' }, 'This legacy link was created before recoverable links were enabled. Revoke and replace it once.') : null
        ]),
        el('div', { class: 'demo-link-actions' }, [
          el('button', { class: 'btn btn-ghost', disabled: !url ? 'disabled' : false, onclick: () => openUrl(url) }, 'Open'),
          el('button', { class: 'btn btn-ghost', disabled: !url ? 'disabled' : false, onclick: () => copyUrl(url) }, 'Copy'),
          status === 'active' ? el('button', { class: 'btn btn-danger-soft', onclick: () => modal({
            title: 'Revoke this demo link?',
            body: el('p', { class: 'muted' }, 'Visitors will no longer be able to start a voice session with this URL.'),
            confirmText: 'Revoke link', confirmKind: 'danger',
            onConfirm: async () => { await api('/api/demo-links/revoke', { method: 'POST', body: { id: item.id } }); try { sessionStorage.removeItem('lessrepeat_demo_' + item.id); } catch (_) {} toast('Demo link revoked.', 'ok'); redraw(); }
          }) }, 'Revoke') : null
        ])
      ]);
      list.appendChild(card);
    });
    listHost.appendChild(list);
  }
}

/* ===========================================================================
   5. TALK TO IT
   =========================================================================== */
async function viewTalk(root) {
  root.appendChild(viewHead('Talk to your agent', 'A direct realtime voice call through the same Dograh workflow runtime used on the phone.'));

  await ensureAgents().catch(() => {});
  const callableAgents = State.agents.filter((agent) => agent.dograh && agent.dograh.status === 'active' && Number(agent.dograh.workflowId) > 0);
  if (!callableAgents.some((agent) => agent.id === State.activeAgentId)) State.activeAgentId = callableAgents.length ? callableAgents[0].id : null;

  const transcript = el('div', { class: 'voice-call-stage', id: 't_voice_call', 'aria-live': 'polite', style: 'overflow-y:auto; display:flex; flex-direction:column; gap:10px; padding:24px 16px; background:var(--panel-2);' }, [
    el('div', { class: 'bubble sys' }, callableAgents.length ? 'Start a conversation. The agent will greet you, listen automatically, and take turns.' : State.agents.length ? 'None of your agents has an active voice workflow. Open Agents and create or update an agent first.' : 'Create an agent first, then come back to talk to it.')
  ]);

  const agentSel = el('select', { class: 'select', disabled: callableAgents.length ? false : 'disabled' }, callableAgents.length
    ? callableAgents.map((a) => el('option', { value: a.id, selected: a.id === State.activeAgentId ? 'selected' : false }, a.name))
    : [el('option', { value: '' }, 'No agents yet')]);
  agentSel.addEventListener('change', () => { State.activeAgentId = agentSel.value; });

  const textIn = el('input', { class: 'input', placeholder: State.agents.length ? 'Type a message...' : 'Create an agent to begin', disabled: 'disabled' });
  const sendBtn = el('button', { class: 'btn btn-primary', disabled: 'disabled' }, 'Send');
  const sessionBtn = el('button', { class: 'btn btn-primary conversation-btn', 'aria-label': 'Start conversation', disabled: callableAgents.length ? false : 'disabled' }, [
    el('span', { class: 'conversation-btn-icon', 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.9.33 1.78.62 2.63a2 2 0 0 1-.45 2.11L8 9.73a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.85.29 1.73.5 2.63.62A2 2 0 0 1 22 16.9z"/></svg>' }),
    el('span', { class: 'conversation-btn-label' }, 'Start voice conversation')
  ]);
  const callHint = el('span', { class: 'conversation-call-hint' }, callableAgents.length ? 'Select an agent, press Start voice conversation, then allow microphone access.' : 'Create a voice-ready agent to enable calling.');

  const statusDot = el('span', { class: 'conversation-dot', 'aria-hidden': 'true' });
  const statusText = el('span', {}, 'Ready');
  const statusPill = el('div', { class: 'conversation-status idle', role: 'status' }, [statusDot, statusText]);
  const pipelinePill = el('div', { class: 'conversation-pipeline' }, 'Dograh realtime voice · Deepgram · Groq · Rumik');
  const timingText = el('div', { class: 'conversation-timing', 'aria-live': 'polite' }, 'Latency is measured inside the live call runtime');

  const audio = el('audio', { autoplay: 'autoplay', playsinline: 'playsinline' });

  // Diagnostics DOM fields
  const dConn = el('span', { class: 't-mono' }, '-');
  const dStt = el('span', { class: 't-mono' }, '-');
  const dVad = el('span', { class: 't-mono' }, '-');
  const dTtfb = el('span', { class: 't-mono' }, '-');
  const dBarge = el('span', { class: 't-mono' }, '-');

  const diagPanel = el('div', { class: 'card card-pad diagnostics-panel', style: 'display:flex; flex-direction:column; gap:12px' }, [
    el('h3', { class: 't-h3', style: 'margin-bottom:6px' }, 'Diagnostic Metrics'),
    el('div', { style: 'display:flex; justify-content:space-between; font-size:.88rem; padding:4px 0; border-bottom:1px solid var(--line)' }, [el('span', { class: 'soft' }, 'Connect Time'), dConn]),
    el('div', { style: 'display:flex; justify-content:space-between; font-size:.88rem; padding:4px 0; border-bottom:1px solid var(--line)' }, [el('span', { class: 'soft' }, 'First Partial STT'), dStt]),
    el('div', { style: 'display:flex; justify-content:space-between; font-size:.88rem; padding:4px 0; border-bottom:1px solid var(--line)' }, [el('span', { class: 'soft' }, 'Turn Finalization (VAD)'), dVad]),
    el('div', { style: 'display:flex; justify-content:space-between; font-size:.88rem; padding:4px 0; border-bottom:1px solid var(--line)' }, [el('span', { class: 'soft' }, 'First Response (TTFB)'), dTtfb]),
    el('div', { style: 'display:flex; justify-content:space-between; font-size:.88rem; padding:4px 0; border-bottom:1px solid var(--line)' }, [el('span', { class: 'soft' }, 'Barge-in Stop Latency'), dBarge]),
    el('div', { class: 'divider', style: 'margin:10px 0' }),
    el('p', { class: 'muted', style: 'font-size:.8rem; line-height:1.4' }, 'Live WebRTC session metrics. Barge-in stop latency measures target playback cancel time under 250ms.'),
    el('p', { class: 'muted', style: 'font-size:.8rem; font-weight:600' }, 'Hotkeys: Spacebar toggles call, Escape cancels.')
  ]);

  let pc = null;
  let ws = null;
  let stream = null;
  let running = false;
  let peerId = '';
  let clickTime = 0;
  let phase = 'idle';
  let liveBubble = null;
  let bargeInStartTime = 0;
  let reconnectAttempts = 0;
  let isSpeaking = false;
  let voiceTransport = 'browser';
  let leaseToken = null;
  let connectionTimer = null;
  let attemptId = 0;
  function notifyLease(token, action) {
    if (!token) return Promise.resolve();
    return fetch('/api/voice/lease', {method:'POST', keepalive:true,
      headers:{'Content-Type':'application/json'},body:JSON.stringify({token,action})})
      .then(r => {if (!r.ok) throw new Error('Call reservation expired. Please try again.');});
  }
  let voiceAudio = null;
  let voiceRequest = null;

  function stopCustomVoice() {
    if (voiceRequest) { voiceRequest.abort(); voiceRequest = null; }
    if (voiceAudio) { voiceAudio.pause(); voiceAudio.src = ''; voiceAudio = null; }
  }

  async function speakWithAgentVoice(text) {
    stopCustomVoice();
    voiceRequest = new AbortController();
    try {
      const response = await fetch('/api/agents/tts', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: State.activeAgentId, text }), signal: voiceRequest.signal
      });
      if (!response.ok) throw new Error('Custom voice synthesis failed');
      const url = URL.createObjectURL(await response.blob());
      voiceAudio = new Audio(url);
      voiceAudio.onended = voiceAudio.onerror = () => { URL.revokeObjectURL(url); voiceAudio = null; };
      setPhase('speaking', 'Agent speaking');
      await voiceAudio.play();
    } catch (error) {
      if (error.name !== 'AbortError') appendBubble('sys', 'The saved voice could not be played for this reply.');
    } finally { voiceRequest = null; }
  }

  function setPhase(next, label) {
    phase = next;
    isSpeaking = (next === 'speaking');
    statusPill.className = 'conversation-status ' + next;
    statusText.textContent = label || next;
  }

  function setButton(active) {
    running = active;
    $('.conversation-btn-label', sessionBtn).textContent = active ? 'End conversation' : 'Start voice conversation';
    sessionBtn.classList.toggle('active', active);
    sessionBtn.setAttribute('aria-label', active ? 'End conversation' : 'Start conversation');
    agentSel.disabled = active;
    textIn.disabled = !active;
    sendBtn.disabled = !active;
    if (!active) {
      textIn.value = '';
    }
  }

  function appendBubble(role, text) {
    if ($('.bubble.sys', transcript) && transcript.children.length === 1) {
      $('.bubble.sys', transcript).remove();
    }
    const b = el('div', { class: 'bubble ' + role, style: role === 'user' ? 'align-self: flex-end; background: rgba(168,85,247,.22); border: 1px solid rgba(192,132,252,.28); padding: 8px 12px; border-radius: 12px 12px 0 12px; font-size: .92rem; max-width: 80%;' : role === 'bot' ? 'align-self: flex-start; background: var(--bg-2); padding: 8px 12px; border-radius: 12px 12px 12px 0; font-size: .92rem; max-width: 80%;' : 'align-self: center; background: var(--panel); border: 1px solid var(--line); color: var(--ink-soft); font-size: .82rem; padding: 4px 8px; border-radius: 99px;' }, text);
    transcript.appendChild(b);
    transcript.scrollTop = transcript.scrollHeight;
    return b;
  }

  function renderLiveCaption(text, isFinal) {
    if (!text.trim()) return;
    if (isFinal) {
      if (liveBubble) { liveBubble.remove(); liveBubble = null; }
      appendBubble('user', text);
    } else {
      if (!liveBubble) {
        liveBubble = el('div', { class: 'bubble user live-transcript', style: 'align-self: flex-end; background: rgba(168,85,247,.18); border: 1px solid rgba(192,132,252,.22); opacity: 0.8; padding: 8px 12px; border-radius: 12px 12px 0 12px; font-size: .92rem; max-width: 80%; font-style: italic;' }, text);
        transcript.appendChild(liveBubble);
      } else {
        liveBubble.textContent = text;
      }
      transcript.scrollTop = transcript.scrollHeight;
    }
  }

  function stopCall(message) {
    attemptId++;
    clearTimeout(connectionTimer); connectionTimer = null;
    const endedLease = leaseToken; leaseToken = null;
    notifyLease(endedLease,'ended').catch(() => {});
    setButton(false);
    if (ws) ws.onclose = ws.onmessage = ws.onopen = ws.onerror = null;
    if (ws && ws.readyState < 2) { try { ws.close(); } catch (_) {} }
    ws = null;
    if (pc) { try { pc.getSenders().forEach((s) => s.track && s.track.stop()); pc.close(); } catch (_) {} }
    pc = null;
    if (stream) stream.getTracks().forEach((track) => track.stop());
    stream = null;
    audio.srcObject = null;
    stopCustomVoice();
    setPhase('idle', message || 'Ready');
    liveBubble = null;
    bargeInStartTime = 0;
    reconnectAttempts = 0;

    // Clean up events
    window.removeEventListener('hashchange', cleanupNav);
    window.removeEventListener('beforeunload', cleanupUnload);
    window.removeEventListener('keydown', handleKeys);
  }

  function securePeerId() {
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
    return 'PC-' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function handleSignal(message) {
    if (!pc) return;
    if (message.type === 'answer') {
      await pc.setRemoteDescription({ type: 'answer', sdp: message.payload.sdp });
      const connDuration = Date.now() - clickTime;
      dConn.textContent = connDuration + 'ms';
      return;
    }
    if (message.type === 'ice-candidate') {
      const c = message.payload && message.payload.candidate;
      if (c) await pc.addIceCandidate(c).catch(() => {});
      return;
    }
    if (message.type === 'call-ended') return stopCall('Call ended');
    if (message.type === 'error' || message.type === 'rtf-pipeline-error') {
      const detail = (message.payload && (message.payload.message || message.payload.error)) || 'Realtime voice call failed';
      appendBubble('sys', detail);
      setPhase('error', 'Call error');
      return;
    }
    if (message.type === 'rtf-user-transcription') {
      const p = message.payload || {};
      if (p.text) {
        if (p.text.trim()) stopCustomVoice();
        if (isSpeaking && !bargeInStartTime) {
          bargeInStartTime = Date.now();
        }
        if (!dStt.textContent || dStt.textContent === '-') {
          dStt.textContent = (Date.now() - clickTime) + 'ms';
        }
        setPhase(p.final ? 'thinking' : 'listening', p.final ? 'Agent thinking' : 'Listening');
        if (p.final) {
          const finalDuration = Date.now() - (bargeInStartTime || clickTime);
          dVad.textContent = finalDuration + 'ms';
        }
        renderLiveCaption(p.text, p.final);
      }
      return;
    }
    if (message.type === 'rtf-bot-text') {
      const botText = message.payload.text || '';
      appendBubble('bot', botText);
      if (botText.trim() && voiceTransport === 'browser') speakWithAgentVoice(botText);
      return;
    }
    if (message.type === 'rtf-bot-started-speaking') {
      setPhase('speaking', 'Agent speaking');
    }
    if (message.type === 'rtf-bot-stopped-speaking') {
      setPhase('listening', 'Listening');
      if (bargeInStartTime) {
        dBarge.textContent = (Date.now() - bargeInStartTime) + 'ms';
        bargeInStartTime = 0;
      }
    }
    if (message.type === 'rtf-ttfb-metric') {
      const p = message.payload || {};
      const ttfbVal = Math.round(Number(p.ttfb_seconds || 0) * 1000);
      dTtfb.textContent = ttfbVal + 'ms';
      timingText.textContent = ttfbVal + 'ms first response · ' + String(p.processor || p.model || 'live runtime');
    }
  }

  async function startCall() {
    if (running || !State.activeAgentId) return;
    const attempt = ++attemptId;
    setButton(true); setPhase('connecting', 'Connecting realtime call');
    clickTime = Date.now();
    dConn.textContent = '-';
    dStt.textContent = '-';
    dVad.textContent = '-';
    dTtfb.textContent = '-';
    dBarge.textContent = '-';

    // Hook listeners
    window.addEventListener('hashchange', cleanupNav);
    window.addEventListener('beforeunload', cleanupUnload);
    window.addEventListener('keydown', handleKeys);

    try {
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (attempt !== attemptId) { microphone.getTracks().forEach(t => t.stop()); return; }
      stream = microphone;
      const session = await api('/api/voice/session', { method: 'POST', timeoutMs: 15000, body: { agentId: State.activeAgentId } });
      if (attempt !== attemptId) { notifyLease(session.leaseToken,'ended').catch(() => {}); return; }
      leaseToken = session.leaseToken;
      connectionTimer = setTimeout(() => {stopCall('Connection timed out'); toast('The call could not connect. Your call slot has been released; try again.','err');},45000);
      voiceTransport = session.voiceTransport || 'browser';

      const turn = session.turnCredentials || { uris: [] };
      const iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
      if (turn && turn.uris && turn.uris.length) {
        iceServers.push({ urls: turn.uris, username: turn.username, credential: turn.password });
      }
      pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: turn.uris.length ? 'relay' : 'all' });
      window.__rumikPc = pc;

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      // Dograh remains the realtime conversation engine. Its fallback voice is
      // intentionally muted; rtf-bot-text is synthesized with this agent's saved Rumik voice.
      pc.ontrack = (event) => { if (event.track.kind === 'audio') { audio.srcObject = event.streams[0]; audio.muted = voiceTransport === 'browser'; if (!audio.muted) audio.play().catch(() => {}); } };
      pc.onconnectionstatechange = () => {
        if (!pc) return;
        console.log('Rumik WebRTC state', pc.connectionState, pc.iceConnectionState);
        timingText.textContent = 'WebRTC ' + pc.connectionState + ' · ICE ' + pc.iceConnectionState;
        if (pc.connectionState === 'connected') {
          clearTimeout(connectionTimer); connectionTimer = null;
          notifyLease(session.leaseToken,'connected').catch(error => {if (attempt === attemptId) {stopCall(); toast(error.message,'err');}});
          setPhase('listening', 'Live call connected');
        }
        if (pc.connectionState === 'failed') { setPhase('error', 'Connection failed'); stopCall('Connection failed'); }
      };

      peerId = securePeerId();

      function connectWss() {
        if (!running || attempt !== attemptId) return;
        ws = new WebSocket(session.signalingUrl);
        ws.onmessage = async (event) => {
          try { await handleSignal(JSON.parse(event.data)); }
          catch (error) { setPhase('error', 'Signaling error'); toast(error.message || 'Realtime signaling failed.', 'err'); }
        };
        ws.onclose = (event) => {
          if (running && event.reason !== 'call ended') {
            if (reconnectAttempts < 5) {
              const delay = Math.min(5000, 1000 * Math.pow(2, reconnectAttempts));
              reconnectAttempts++;
              setTimeout(connectWss, delay);
            } else {
              stopCall('Call ended');
            }
          }
        };
        ws.onopen = () => {
          reconnectAttempts = 0;
          const offer = pc.localDescription;
          ws.send(JSON.stringify({ type: 'offer', payload: { sdp: offer.sdp, type: 'offer', pc_id: peerId, workflow_id: session.workflowId, workflow_run_id: session.workflowRunId } }));
        };
      }

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      connectWss();

      pc.onicecandidate = (event) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (event.candidate) {
          ws.send(JSON.stringify({ type: 'ice-candidate', payload: { candidate: { candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid, sdpMLineIndex: event.candidate.sdpMLineIndex }, pc_id: peerId } }));
        }
      };

    } catch (error) {
      if (attempt !== attemptId) return;
      stopCall('Could not connect');
      setPhase('error', 'Needs attention');
      appendBubble('sys', error.message || 'Could not start the realtime voice call.');
      toast(error.message || 'Realtime voice call failed.', 'err');
    }
  }

  // Navigation and unload hooks
  const cleanupNav = () => { if (location.hash !== '#/talk') stopCall(); };
  const cleanupUnload = () => { stopCall(); };
  const handleKeys = (e) => {
    if (document.activeElement === textIn) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (running) stopCall('Ready');
      else startCall();
    } else if (e.code === 'Escape') {
      e.preventDefault();
      if (running) stopCall('Cancelled');
    }
  };

  sessionBtn.addEventListener('click', () => running ? stopCall('Ready') : startCall());

  async function handleSend() {
    const text = textIn.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    appendBubble('user', text);
    textIn.value = '';
    ws.send(JSON.stringify({ type: 'text-input', payload: { text } }));
  }

  sendBtn.addEventListener('click', handleSend);
  textIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSend(); });

  const panel = el('div', { class: 'card talk-panel' }, [
    el('div', { class: 'talk-head' }, [
      el('div', { class: 'talk-identity' }, [
        el('div', { class: 'who' }, [document.createTextNode('Live conversation '), el('span', {}, '(automatic turn-taking)')]),
        statusPill, pipelinePill, timingText
      ]),
      el('div', { class: 'talk-agent-select' }, [el('span', {}, 'Agent'), agentSel])
    ]),
    transcript,
    el('div', { class: 'talk-input' }, [el('div', { class: 'talk-call-action' }, [sessionBtn, callHint]), textIn, sendBtn, audio])
  ]);

  const side = el('div', { class: 'talk-side' }, [diagPanel]);
  root.appendChild(el('div', { class: 'talk-grid' }, [panel, side]));
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(',') + 1)); };
    r.onerror = reject; r.readAsDataURL(blob);
  });
}

/* ===========================================================================
   5. TELEPHONY
   =========================================================================== */
async function viewTelephony(root) {
  root.appendChild(viewHead('Telephony', 'Your VoBiz numbers and call routing, connected through Dograh. Outbound calls require an explicit confirmation.'));

  const statusHost = el('div', { class: 'card card-pad', id: 'telStatus' }, skeleton('sk-line', 5));
  const dialHost = el('div', { class: 'card card-pad' }, dialForm());
  root.appendChild(el('div', { class: 'tel-grid' }, [statusHost, dialHost]));

  try {
    const s = await ensureTelephony(true);
    paintTelephony(statusHost, s);
    refreshDialNumbers(s);
  } catch (e) {
    statusHost.innerHTML = '';
    statusHost.appendChild(el('div', { class: 'muted' }, 'Could not reach VoBiz through Dograh. ' + esc(e.message)));
  }
}

function paintTelephony(host, s) {
  host.innerHTML = '';
  const connected = s.connected === true && s.provider === 'vobiz' && s.orchestrator === 'dograh';
  const config = s.configuration || {};
  const didList = Array.isArray(s.dids) ? s.dids : (s.did ? [{ number: s.did, status: 'active' }] : []);

  host.appendChild(el('div', { class: 'flex items-center justify-between', style: 'margin-bottom:14px' }, [
    el('h3', { class: 't-h3' }, 'VoBiz via Dograh'),
    el('span', { class: 'pill' }, [
      el('span', { class: 'dot' + (connected ? '' : ' bad') }),
      connected ? 'connected' : 'unavailable'
    ])
  ]));

  if (didList.length) {
    host.appendChild(el('div', { class: 'muted', style: 'font-size:.8rem;margin-bottom:8px' }, 'VoBiz numbers'));
    didList.forEach((d) => {
      const num = typeof d === 'string' ? d : (d.did_number || d.number || d.did || '');
      const status = d.user_status_label || d.status || 'active';
      const exp = d.expiry_date || d.expiry || d.expires || d.expiresAt;
      const route = d.inboundWorkflowName || (d.inboundWorkflowId ? 'Workflow ' + d.inboundWorkflowId : 'No inbound workflow');
      host.appendChild(el('div', { class: 'did-row' }, [
        el('div', {}, [
          el('div', { class: 'num' }, num),
          el('div', { class: 'exp' }, exp ? 'Expires ' + exp : route)
        ]),
        el('span', { class: 'pill' }, [el('span', { class: 'dot' + (status !== 'active' ? ' warn' : '') }), status])
      ]));
    });
  }

  host.appendChild(el('div', { class: 'divider', style: 'margin:14px 0' }));
  host.appendChild(el('div', { class: 'status-line' }, [
    el('span', { class: 'k' }, 'Configuration'),
    el('span', { class: 'v' }, config.name || ('VoBiz config ' + (config.id || '')))
  ]));
  host.appendChild(el('div', { class: 'status-line' }, [
    el('span', { class: 'k' }, 'Outbound workflow'),
    el('span', { class: 'v' }, s.workflowId ? 'Workflow ' + s.workflowId : 'not configured')
  ]));
  if (s.dashboard) host.appendChild(el('div', { class: 'status-line' }, [
    el('span', { class: 'k' }, 'Dograh'),
    el('a', { class: 'v', href: s.dashboard, target: '_blank', rel: 'noopener', style: 'color:var(--accent)' }, 'Open console')
  ]));

  host.appendChild(el('div', { class: 'inbound-note' }, 'Outbound calls are initiated by Dograh using the active VoBiz configuration. Inbound calls follow the workflow assigned to each VoBiz number.'));
}

function dialForm() {
  const numI = el('input', { class: 'input', id: 'dial_num', type: 'tel', inputmode: 'numeric', maxlength: 10, placeholder: '9876543210' });
  numI.addEventListener('input', () => { numI.value = numI.value.replace(/\D/g, '').slice(0, 10); });
  const callableAgents = State.agents.filter((agent) => agent.dograh && agent.dograh.workflowId);
  const agentSelect = el('select', { class: 'input' }, callableAgents.length
    ? callableAgents.map((agent) => el('option', { value: agent.id }, agent.name))
    : [el('option', { value: '' }, 'No provisioned agents')]);
  const btn = el('button', { class: 'btn btn-primary' }, 'Place call');
  if (!callableAgents.length) btn.disabled = true;
  const form = el('form', { class: 'dial-form', onsubmit: (e) => { e.preventDefault(); onDial(numI, agentSelect, btn); } }, [
    el('h3', { class: 't-h3' }, 'Outbound call'),
    el('p', { class: 'muted', style: 'font-size:.85rem' }, 'Enter a 10 digit Indian mobile number. Dograh dials it through your VoBiz number.'),
    el('div', { class: 'field' }, [
      el('label', {}, 'Number'),
      el('div', { class: 'dial-input-row' }, [el('span', { class: 'prefix' }, '+91'), numI])
    ]),
    el('div', { class: 'field' }, [el('label', {}, 'Voice agent'), agentSelect]),
    el('div', { class: 'cost-warn' }, ['This places a ', el('b', {}, 'real paid VoBiz call'), ' and charges your telephony account.']),
    btn
  ]);
  return form;
}
function refreshDialNumbers() { /* placeholder for future caller-id selection */ }

function onDial(numI, agentSelect, btn) {
  const num = (numI.value || '').replace(/\D/g, '');
  if (num.length !== 10) { toast('Enter a valid 10 digit mobile number.', 'err'); numI.focus(); return; }
  if (!agentSelect.value) { toast('Create a provisioned voice agent before placing a call.', 'err'); return; }
  modal({
    title: 'Confirm a real call',
    body: el('div', {}, [
      el('p', {}, ['You are about to place a real outbound call to ', el('b', {}, '+91 ' + num), '.']),
      el('div', { class: 'danger-note' }, [
        el('b', {}, 'This is a live, paid call. '),
        document.createTextNode('Dograh will initiate it through your VoBiz configuration and charge your telephony account. Only continue if you intend to ring this number now.')
      ])
    ]),
    confirmText: 'Yes, place the call', confirmKind: 'danger',
    onConfirm: async () => {
      btn.disabled = true; btn.textContent = 'Dialing...';
      try {
        const res = await api('/api/telephony/dial', { method: 'POST', body: { number: num, agentId: agentSelect.value, confirm: true } });
        toast('Call placed to +91 ' + num + '.', 'ok');
        State.loaded.telephony = false; // refresh wallet next view
      } catch (ex) {
        if (ex.status === 400 && ex.data && ex.data.code === 'needs_confirm') toast('Confirmation required. Please retry.', 'err');
        else toast(ex.message || 'Dial failed.', 'err');
        throw ex;
      } finally {
        btn.disabled = false; btn.textContent = 'Place call';
      }
    }
  });
}

/* ===========================================================================
   6. PRESETS, BILLING, SUPPORT, AND SUPER ADMIN
   =========================================================================== */
async function viewPresets(root) {
  root.appendChild(viewHead('Agent presets', 'Start with a production-minded intake flow, then customize the voice, instructions, calendar, and your own number.'));
  const notice = el('div', { class: 'inbound-note', style: 'margin:0 0 18px' }, 'Presets are starting points. Personal Injury does not provide legal advice, and Dental does not diagnose. Review the workflow and consent language before using it live.');
  const host = el('div', { class: 'preset-grid' }, skeleton('sk-card', 6));
  root.appendChild(notice); root.appendChild(host);
  try {
    const out = await api('/api/presets');
    State.presets = out.presets || [];
    if (out.starterPresetId) State.presets.sort((a,b) => Number(b.id === out.starterPresetId) - Number(a.id === out.starterPresetId));
    host.innerHTML = '';
    State.presets.forEach((p) => {
      const privacy = p.recommendedPrivacyMode || p.privacyMode || 'standard';
      host.appendChild(el('article', { class: 'card preset-card' }, [
        el('div', { class: 'preset-icon' }, (p.name || '?').slice(0, 1)),
        el('div', { class: 'flex items-center justify-between gap-2' }, [
          el('h3', { class: 't-h3' }, p.name),
          el('span', { class: 'badge-ready' }, privacy.replace(/_/g, ' '))
        ]),
        p.id === out.starterPresetId ? el('span', { class: 'badge-ready' }, 'Recommended for your business') : null,
        el('p', { class: 'muted' }, p.description || (p.persona || '').slice(0, 160) || 'Editable voice-agent starting point.'),
        el('div', { class: 'preset-meta' }, [
          el('span', {}, p.category || 'Voice agent'),
          el('span', {}, 'BYON ready')
        ]),
        el('button', { class: 'btn btn-primary', onclick: () => createFromPreset(p) }, 'Use this preset')
      ]));
    });
    if (!State.presets.length) host.appendChild(el('div', { class: 'empty muted' }, 'No presets are available.'));
  } catch (e) { host.innerHTML = ''; host.appendChild(el('div', { class: 'card card-pad muted' }, e.message)); }
}

function createFromPreset(preset) {
  modal({
    title: 'Create ' + preset.name,
    body: el('div', {}, [
      el('p', {}, 'This creates an editable agent in your workspace. No phone number is attached until you connect your own number.'),
      field('Agent name', el('input', { class: 'input', id: 'preset_agent_name', value: preset.name }))
    ]),
    confirmText: 'Create agent',
    onConfirm: async () => {
      const name = ($('#preset_agent_name').value || preset.name).trim();
      await api('/api/agents', { method: 'POST', body: { presetId: preset.id, name: name } });
      State.loaded.agents = false;
      toast(name + ' created.', 'ok');
      goto('agents');
    }
  });
}

/* ===========================================================================
   AGENCY FINANCE, INTEGRATIONS, AND OPERATING PROMPT
   =========================================================================== */
async function viewInvoices(root) {
  const canManage = isPlatformUserClient(State.me.user);
  const head = viewHead('Invoices', canManage ? 'Create, issue, and track agency invoices. Stored status never implies an email was sent.' : 'Review invoices issued to this workspace. Agency operators control status and collection records.');
  if (canManage) head.appendChild(el('div', { class: 'view-actions' }, [el('button', { class: 'btn btn-primary', onclick: openInvoiceComposer }, 'Create invoice')]));
  root.appendChild(head);
  const summary = el('div', { class: 'invoice-summary-grid' }, skeleton('sk-stat', 4));
  const tableCard = el('section', { class: 'card invoice-table-card' }, skeleton('sk-card', 1));
  root.appendChild(summary); root.appendChild(tableCard);
  try {
    const out = await api('/api/invoices');
    State.invoices = out.invoices || []; State.loaded.invoices = true;
    paintInvoices(summary, tableCard, State.invoices);
  } catch (e) {
    summary.innerHTML = '';
    tableCard.innerHTML = '';
    tableCard.appendChild(el('div', { class: 'error-state' }, [el('h3', {}, 'Invoices unavailable'), el('p', {}, e.message), el('button', { class: 'btn btn-ghost', onclick: () => onRoute() }, 'Try again')]));
  }
}

function invoiceEffectiveStatus(row) { return row.status || row.storedStatus || 'draft'; }
function invoiceStatusLabel(status) { return String(status || 'draft').replace(/_/g, ' '); }
function paintInvoices(summary, host, rows) {
  const sums = { outstanding: 0, overdue: 0, paid: 0, issued: 0 };
  rows.forEach((row) => {
    const status = invoiceEffectiveStatus(row);
    if (status === 'issued' || status === 'overdue') sums.outstanding += row.amountPaise || 0;
    if (status === 'overdue') sums.overdue += row.amountPaise || 0;
    if (status === 'paid') sums.paid += row.amountPaise || 0;
    if (row.storedStatus === 'issued' || row.storedStatus === 'paid') sums.issued += row.amountPaise || 0;
  });
  summary.innerHTML = '';
  [['Outstanding', sums.outstanding, 'Issued and unpaid'], ['Overdue', sums.overdue, 'Past the due date'], ['Paid', sums.paid, 'Recorded as collected'], ['Total issued', sums.issued, 'Excludes drafts and voids']].forEach((item, index) => summary.appendChild(el('article', { class: 'agency-metric' + (index === 1 ? ' critical' : index === 2 ? ' positive' : '') }, [el('div', { class: 'agency-metric-label' }, item[0]), el('div', { class: 'agency-metric-value' }, '₹' + fmtInr(item[1] / 100)), el('div', { class: 'agency-metric-note' }, item[2])] )));
  host.innerHTML = '';
  const controls = el('div', { class: 'invoice-table-head' }, [
    el('div', {}, [el('span', { class: 'section-kicker' }, 'Agency finance'), el('h3', {}, 'Invoice register')]),
    el('div', { class: 'invoice-filters' }, ['all','draft','issued','overdue','paid','void'].map((status) => el('button', { class: 'invoice-filter' + (status === 'all' ? ' active' : ''), 'data-filter': status, onclick: (event) => {
      $$('.invoice-filter', host).forEach((button) => button.classList.toggle('active', button === event.currentTarget));
      renderInvoiceRows(host.querySelector('tbody'), rows, status);
    } }, invoiceStatusLabel(status))))
  ]);
  const table = el('table', { class: 'data-table invoice-table' }, [
    el('thead', {}, el('tr', {}, ['Invoice','Client','Issued','Due','Status','Amount',''].map((label) => el('th', {}, label)))),
    el('tbody')
  ]);
  host.appendChild(controls);
  host.appendChild(el('div', { class: 'table-scroll' }, table));
  renderInvoiceRows(table.querySelector('tbody'), rows, 'all');
}

function renderInvoiceRows(body, rows, filter) {
  body.innerHTML = '';
  const visible = rows.filter((row) => filter === 'all' || invoiceEffectiveStatus(row) === filter);
  if (!visible.length) {
    const canManage = isPlatformUserClient(State.me.user);
    const cell = el('td', { colspan: '7' }, el('div', { class: 'empty compact' }, [el('div', { class: 'ttl' }, filter === 'all' ? 'No invoices yet' : 'No ' + filter + ' invoices'), el('p', {}, canManage ? 'Create an invoice to start the register.' : 'Agency-issued invoices will appear here.'), filter === 'all' && canManage ? el('button', { class: 'btn btn-primary btn-sm', onclick: openInvoiceComposer }, 'Create invoice') : null]));
    body.appendChild(el('tr', {}, cell)); return;
  }
  visible.forEach((row) => {
    const status = invoiceEffectiveStatus(row);
    body.appendChild(el('tr', {}, [
      el('td', { class: 'mono-cell' }, row.invoiceNumber),
      el('td', {}, [el('strong', {}, row.clientName), row.clientEmail ? el('small', {}, row.clientEmail) : null]),
      el('td', {}, row.issueDate), el('td', {}, row.dueDate),
      el('td', {}, el('span', { class: 'status-badge status-' + status }, invoiceStatusLabel(status))),
      el('td', { class: 'money-cell' }, '₹' + fmtInr((row.amountPaise || 0) / 100)),
      el('td', {}, el('button', { class: 'btn btn-quiet btn-sm', onclick: () => inspectInvoice(row) }, 'Open'))
    ]));
  });
}

async function openInvoiceComposer() {
  if (!isPlatformUserClient(State.me.user)) { toast('Only agency operators can create invoices.', 'err'); return; }
  let tenants = [];
  if (isPlatformUserClient(State.me.user)) {
    try { tenants = (await api('/api/admin/tenants')).tenants || []; } catch (_) {}
  }
  if (!tenants.length) tenants = [State.me.tenant];
  const tenantSelect = el('select', { class: 'select' }, tenants.map((tenant) => el('option', { value: tenant.id }, tenant.name)));
  const clientName = el('input', { class: 'input', value: tenants[0].name || '' });
  tenantSelect.onchange = () => { const selected = tenants.find((tenant) => tenant.id === tenantSelect.value); if (selected) clientName.value = selected.name; };
  const clientEmail = el('input', { class: 'input', type: 'email', placeholder: 'billing@client.com' });
  const description = el('textarea', { class: 'textarea', placeholder: 'Automation system implementation and monthly operations' });
  const amount = el('input', { class: 'input', type: 'number', min: '1', max: '10000000', step: '0.01', placeholder: '5000' });
  const issueDate = el('input', { class: 'input', type: 'date', value: new Date().toISOString().slice(0, 10) });
  const due = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const dueDate = el('input', { class: 'input', type: 'date', value: due });
  const issueNow = el('input', { type: 'checkbox', checked: 'checked' }); issueNow.checked = true;
  modal({
    title: 'Create invoice',
    body: el('div', { class: 'invoice-form' }, [
      field('Client workspace', tenantSelect), field('Client name', clientName), field('Billing email, optional', clientEmail), field('Amount in INR', amount), field('Issue date', issueDate), field('Due date', dueDate), field('Description', description),
      el('label', { class: 'check-row' }, [issueNow, el('span', {}, [el('strong', {}, 'Issue now'), el('small', {}, 'Stores an issued invoice. It does not send an email.')])])
    ]),
    confirmText: 'Create invoice',
    onConfirm: async () => {
      const paise = Math.round(Number(amount.value) * 100);
      const out = await api('/api/invoices', { method: 'POST', body: { tenantId: tenantSelect.value, clientName: clientName.value.trim(), clientEmail: clientEmail.value.trim(), description: description.value.trim(), amountPaise: paise, issueDate: issueDate.value, dueDate: dueDate.value, issueNow: issueNow.checked } });
      toast(out.note || 'Invoice created.', 'ok');
      State.loaded.invoices = false; goto('invoices'); onRoute();
    }
  });
}

function inspectInvoice(row) {
  const status = invoiceEffectiveStatus(row);
  const actions = el('div', { class: 'invoice-detail-actions' });
  if (isPlatformUserClient(State.me.user)) {
    if (row.storedStatus === 'draft') actions.appendChild(el('button', { class: 'btn btn-primary', onclick: () => updateInvoiceStatus(row.id, 'issued') }, 'Issue invoice'));
    if (row.storedStatus === 'issued') actions.appendChild(el('button', { class: 'btn btn-primary', onclick: () => updateInvoiceStatus(row.id, 'paid') }, 'Mark paid'));
    if (row.storedStatus === 'draft' || row.storedStatus === 'issued') actions.appendChild(el('button', { class: 'btn btn-ghost', onclick: () => updateInvoiceStatus(row.id, 'void') }, 'Void invoice'));
  }
  actions.appendChild(el('button', { class: 'btn btn-ghost', onclick: () => window.print() }, 'Print'));
  modal({
    title: row.invoiceNumber,
    body: el('article', { class: 'invoice-detail' }, [
      el('div', { class: 'invoice-detail-top' }, [el('div', {}, [el('span', { class: 'section-kicker' }, 'Billed to'), el('h4', {}, row.clientName), row.clientEmail ? el('p', {}, row.clientEmail) : null]), el('span', { class: 'status-badge status-' + status }, invoiceStatusLabel(status))]),
      el('div', { class: 'invoice-detail-amount' }, [el('span', {}, 'Amount'), el('strong', {}, '₹' + fmtInr((row.amountPaise || 0) / 100))]),
      el('p', { class: 'invoice-detail-description' }, row.description),
      el('dl', {}, [el('div', {}, [el('dt', {}, 'Issued'), el('dd', {}, row.issueDate)]), el('div', {}, [el('dt', {}, 'Due'), el('dd', {}, row.dueDate)]), el('div', {}, [el('dt', {}, 'Delivery'), el('dd', {}, row.deliveryStatus === 'not_sent' ? 'Not emailed' : row.deliveryStatus)])]),
      actions
    ]),
    confirmText: 'Close', onConfirm: async () => {}
  });
}

async function updateInvoiceStatus(invoiceId, status) {
  try {
    await api('/api/invoices/status', { method: 'POST', body: { invoiceId, status } });
    toast('Invoice marked ' + invoiceStatusLabel(status) + '.', 'ok');
    const host = $('#modal-host'); if (host) host.classList.add('hide');
    onRoute();
  } catch (e) { toast(e.message, 'err'); }
}

async function viewIntegrations(root) {
  root.appendChild(viewHead('Integrations', 'Bring client conversations and ad research into the operating system without pretending setup is complete.'));
  const host = el('div', { class: 'integration-grid' }, skeleton('sk-card', 2)); root.appendChild(host);
  try {
    const out = await api('/api/integrations');
    State.integrations = out.integrations || []; State.loaded.integrations = true;
    host.innerHTML = '';
    State.integrations.forEach((item) => host.appendChild(integrationCard(item)));
  } catch (e) { host.innerHTML = ''; host.appendChild(el('div', { class: 'card card-pad error-state' }, e.message)); }
}

function integrationCard(item) {
  const requested = item.status === 'requested';
  const mark = item.id === 'whatsapp-business' ? 'WA' : 'META';
  const button = el('button', { class: 'btn ' + (requested ? 'btn-ghost' : 'btn-primary'), disabled: requested ? 'disabled' : null }, requested ? 'Setup requested' : 'Request setup');
  button.onclick = async () => {
    button.disabled = true; button.textContent = 'Recording request...';
    try { const out = await api('/api/integrations/request', { method: 'POST', body: { integrationId: item.id } }); toast(out.note, 'ok'); onRoute(); }
    catch (e) { button.disabled = false; button.textContent = 'Request setup'; toast(e.message, 'err'); }
  };
  return el('article', { class: 'card integration-card' }, [
    el('div', { class: 'integration-head' }, [el('span', { class: 'integration-mark' }, mark), el('span', { class: 'status-badge ' + (requested ? 'status-requested' : 'status-setup') }, requested ? 'requested' : 'setup required')]),
    el('span', { class: 'section-kicker' }, item.category), el('h3', {}, item.name), el('p', {}, item.description),
    el('div', { class: 'integration-columns' }, [
      el('div', {}, [el('h4', {}, 'What you will see'), el('ul', {}, (item.capabilities || []).map((value) => el('li', {}, value)))]),
      el('div', {}, [el('h4', {}, 'Required to connect'), el('ul', {}, (item.setup || []).map((value) => el('li', {}, value)))])
    ]),
    el('div', { class: 'integration-foot' }, [button, el('small', {}, 'No external service is contacted by this request.')])
  ]);
}

async function viewAgencyPrompt(root) {
  root.appendChild(viewHead('Agency prompt', 'One persistent operating instruction for this workspace. Per-agent personas remain separate.'));
  const host = el('div', { class: 'prompt-layout' }, [el('section', { class: 'card prompt-editor' }, skeleton('sk-card', 1)), el('aside', { class: 'card prompt-guide' }, skeleton('sk-card', 1))]);
  root.appendChild(host);
  try {
    const out = await api('/api/agency/prompt'); State.agencyPrompt = out; State.loaded.agencyPrompt = true;
    paintAgencyPrompt(host, out);
  } catch (e) { host.innerHTML = ''; host.appendChild(el('div', { class: 'card card-pad error-state' }, e.message)); }
}

function paintAgencyPrompt(host, data) {
  const text = el('textarea', { class: 'agency-prompt-text', maxlength: '12000', placeholder: 'Define workspace-wide rules for escalation, compliance, quality, and how every voice agent should operate...' });
  text.value = data.prompt || '';
  const count = el('span', { class: 'prompt-count' }, text.value.length.toLocaleString('en-IN') + ' / 12,000');
  text.oninput = () => { count.textContent = text.value.length.toLocaleString('en-IN') + ' / 12,000'; };
  const save = el('button', { class: 'btn btn-primary' }, 'Save operating prompt');
  save.onclick = async () => {
    save.disabled = true; save.textContent = 'Saving...';
    try {
      const out = await api('/api/agency/prompt', { method: 'POST', body: { prompt: text.value } });
      const syncNote = out.failedAgents ? ' Saved, but ' + out.failedAgents + ' voice workflow' + (out.failedAgents === 1 ? '' : 's') + ' could not be synchronized.' : ' Applied to ' + out.syncedAgents + ' active voice workflow' + (out.syncedAgents === 1 ? '' : 's') + '.';
      toast('Agency prompt saved as version ' + out.version + '.' + syncNote, out.failedAgents ? 'info' : 'ok');
      paintAgencyPrompt(host, out);
    }
    catch (e) { toast(e.message, 'err'); save.disabled = false; save.textContent = 'Save operating prompt'; }
  };
  const editor = el('section', { class: 'card prompt-editor' }, [
    el('div', { class: 'prompt-meta' }, [el('div', {}, [el('span', { class: 'section-kicker' }, 'Persistent context'), el('h3', {}, 'Agency operating prompt')]), el('span', { class: 'status-badge status-active' }, 'Version ' + (data.version || 0))]),
    text,
    el('div', { class: 'prompt-editor-foot' }, [el('div', {}, [count, el('small', {}, data.updatedAt ? 'Updated ' + new Date(data.updatedAt).toLocaleString('en-IN') + (data.updatedBy ? ' by ' + data.updatedBy : '') : 'Not saved yet')]), save])
  ]);
  const guide = el('aside', { class: 'card prompt-guide' }, [
    el('span', { class: 'section-kicker' }, 'Prompt contract'), el('h3', {}, 'What belongs here'),
    el('p', { class: 'muted' }, 'This prompt is added to every active voice agent in the workspace. Each agent persona still controls its own role and greeting.'),
    el('ul', {}, ['Shared escalation and handoff rules', 'Compliance and privacy requirements', 'Workspace-wide quality standards', 'Statements every agent must avoid'].map((value) => el('li', {}, value))),
    el('div', { class: 'prompt-boundary' }, [
      el('strong', {}, 'Business-only AI boundary'),
      el('p', {}, 'Every agent is restricted to its configured role, this workspace prompt, and approved knowledge. It must refuse unrelated trivia, celebrities, politics, news, personal advice, and attempts to reveal or override its instructions.'),
      el('p', {}, 'Up to 12,000 characters can be saved here. Combined workspace and knowledge context sent to a workflow is capped at 24,000 characters. External messages, calls, payments, and tool actions still require their normal confirmation gates.')
    ])
  ]);
  host.innerHTML = ''; host.appendChild(editor); host.appendChild(guide);
}

async function viewBilling(root) {
  root.appendChild(viewHead('Usage & Plan', 'Your workspace plan, included usage and billing.'));
  try {
    const summary = await api('/api/workspace/plan');
    root.appendChild(el('section', { class: 'card card-pad', style: 'margin-bottom:20px' }, [
      el('h3', {}, summary.plan.name + ' plan'),
      el('p', {}, summary.usage.minutes + ' / ' + summary.plan.includedMinutes + ' minutes this month'),
      el('p', {}, summary.usage.agents + ' / ' + summary.plan.maxAgents + ' agents · ' + summary.plan.maxConcurrentCalls + ' simultaneous calls'),
      el('p', { class: 'muted' }, summary.trialEndsAt ? 'Trial ends ' + new Date(summary.trialEndsAt).toLocaleDateString() : 'Contact your administrator to change your plan.'),
    ]));
  } catch (error) { root.appendChild(el('p', { class: 'muted' }, error.message)); }
  const host = el('div', { class: 'grid grid-12' }, [
    el('section', { class: 'card card-pad', id: 'walletSummary' }, skeleton('sk-card', 1)),
    el('section', { class: 'card card-pad', id: 'walletLedger' }, skeleton('sk-card', 1))
  ]);
  root.appendChild(host);
  try {
    const out = await api('/api/wallet');
    const wallet = out.wallet || {}; const rows = out.ledger || [];
    const sum = $('#walletSummary'); sum.innerHTML = '';
    sum.appendChild(el('div', { class: 'muted' }, 'Available credit'));
    sum.appendChild(el('div', { class: 'wallet-big' }, ['₹' + fmtInr(wallet.balanceInr != null ? wallet.balanceInr : (wallet.balancePaise || 0) / 100), el('small', {}, ' INR') ]));
    sum.appendChild(el('p', { class: 'muted' }, 'Wallet credits are separate from your assigned plan. Contact your administrator for billing questions.'));
    const packs = [{ id: 'starter', inr: 200 }, { id: 'growth', inr: 500 }, { id: 'scale', inr: 1000 }];
    sum.appendChild(el('div', { class: 'pack-row' }, packs.map((pack) => el('button', { class: 'btn btn-ghost', onclick: () => startRecharge(pack.id) }, 'Add ₹' + fmtInr(pack.inr)))));
    const ledger = $('#walletLedger'); ledger.innerHTML = '';
    ledger.appendChild(el('h3', { class: 't-h3', style: 'margin-bottom:14px' }, 'Transaction history'));
    rows.slice(0, 20).forEach((x) => ledger.appendChild(el('div', { class: 'ledger-row' }, [
      el('div', {}, [el('div', {}, x.description || String(x.type || '').replace(/_/g, ' ')), el('small', { class: 'muted' }, x.createdAt || '')]),
      el('b', { class: Number(x.amountPaise) >= 0 ? 'money-plus' : 'money-minus' }, (Number(x.amountPaise) >= 0 ? '+' : '') + '₹' + fmtInr(Number(x.amountPaise || 0) / 100))
    ])));
    if (!rows.length) ledger.appendChild(el('div', { class: 'muted' }, 'No wallet activity yet.'));
  } catch (e) { host.innerHTML = ''; host.appendChild(el('div', { class: 'card card-pad muted' }, e.message)); }
}

async function startRecharge(packId) {
  try {
    const out = await api('/api/payment-intents', { method: 'POST', body: { packId: packId } });
    const checkoutUrl = out.checkout && (out.checkout.action || out.checkout.url);
    if (checkoutUrl && out.checkout.fields) {
      const form = el('form', { method: 'POST', action: checkoutUrl });
      Object.keys(out.checkout.fields).forEach((k) => form.appendChild(el('input', { type: 'hidden', name: k, value: out.checkout.fields[k] })));
      document.body.appendChild(form); form.submit(); return;
    }
    toast(out.message || 'PayU checkout is not enabled yet. Your wallet was not charged.', 'info');
  } catch (e) { toast(e.message, 'err'); }
}

async function viewSupport(root) {
  root.appendChild(viewHead('Support', 'Open a ticket and keep every reply attached to your workspace.'));
  const subject = el('input', { class: 'input', placeholder: 'What do you need help with.' });
  const message = el('textarea', { class: 'input textarea', placeholder: 'Describe the issue, expected result, and what happened.' });
  const create = el('button', { class: 'btn btn-primary' }, 'Open ticket');
  const list = el('div', { class: 'ticket-list' }, skeleton('sk-card', 2));
  create.onclick = async () => {
    create.disabled = true;
    try {
      await api('/api/support/tickets', { method: 'POST', body: { subject: subject.value.trim(), message: message.value.trim(), priority: 'normal' } });
      subject.value = ''; message.value = ''; toast('Support ticket opened.', 'ok'); await loadTickets(list);
    } catch (e) { toast(e.message, 'err'); } finally { create.disabled = false; }
  };
  root.appendChild(el('div', { class: 'support-layout' }, [
    el('section', { class: 'card card-pad support-compose' }, [el('h3', { class: 't-h3' }, 'New ticket'), field('Subject', subject), field('Message', message), create]),
    list
  ]));
  await loadTickets(list);
}

async function loadTickets(host) {
  try {
    const out = await api('/api/support/tickets'); host.innerHTML = '';
    (out.tickets || []).forEach((t) => host.appendChild(ticketCard(t, false)));
    if (!(out.tickets || []).length) host.appendChild(el('div', { class: 'card card-pad muted' }, 'No support tickets yet.'));
  } catch (e) { host.innerHTML = ''; host.appendChild(el('div', { class: 'card card-pad muted' }, e.message)); }
}

function ticketCard(t, admin) {
  const messages = (t.messages || []).map((m) => el('div', { class: 'ticket-message' }, [
    el('b', {}, m.authorName || m.authorRole || 'User'), el('span', {}, m.message || m.body || '')
  ]));
  const reply = el('input', { class: 'input', placeholder: 'Write a reply.' });
  const send = el('button', { class: 'btn btn-ghost' }, 'Reply');
  send.onclick = async () => {
    const msg = reply.value.trim(); if (!msg) return;
    send.disabled = true;
    try {
      await api(admin ? '/api/admin/tickets/reply' : '/api/support/tickets/reply', { method: 'POST', body: { ticketId: t.id, message: msg } });
      toast('Reply sent.', 'ok'); onRoute();
    } catch (e) { toast(e.message, 'err'); } finally { send.disabled = false; }
  };
  const adminControls = admin ? el('div', { class: 'ticket-admin-controls' }, [
    (function () { const s = el('select', { class: 'select' }, ['open','in_progress','waiting_on_customer','resolved','closed'].map((v) => el('option', { value: v }, v.replace(/_/g, ' ')))); s.value = t.status || 'open'; s.setAttribute('data-ticket-status', t.id); return s; })(),
    (function () { const s = el('select', { class: 'select' }, ['low','normal','high','urgent'].map((v) => el('option', { value: v }, v))); s.value = t.priority || 'normal'; s.setAttribute('data-ticket-priority', t.id); return s; })(),
    el('button', { class: 'btn btn-ghost', onclick: async () => { const status = document.querySelector('[data-ticket-status="' + t.id + '"]').value; const priority = document.querySelector('[data-ticket-priority="' + t.id + '"]').value; await api('/api/admin/tickets/update', { method: 'POST', body: { ticketId: t.id, status: status, priority: priority } }); toast('Ticket updated.', 'ok'); onRoute(); } }, 'Update')
  ]) : null;
  return el('article', { class: 'card ticket-card' }, [
    el('div', { class: 'flex items-center justify-between gap-2' }, [el('h3', { class: 't-h3' }, t.subject), el('span', { class: 'pill' }, t.status || 'open')]),
    adminControls, ...messages, el('div', { class: 'ticket-reply' }, [reply, send])
  ]);
}

async function viewAdmin(root) {
  if (!State.me || !['super_admin', 'admin'].includes(State.me.user.role)) { goto('overview'); return; }
  const superAdmin = State.me.user.role === 'super_admin';
  const head = viewHead('Clients', 'Add, approach, inspect, pause, and offboard client workspaces with an immutable activity trail.');
  if (superAdmin) head.appendChild(el('div', { class: 'view-actions' }, [el('button', { class: 'btn btn-primary', onclick: openClientComposer }, 'Add client')]));
  root.appendChild(head);
  const stats = el('div', { class: 'admin-kpi-grid' }, skeleton('sk-stat', 5));
  const tenantHost = el('div', { class: 'card admin-client-card' }, skeleton('sk-card', 1));
  const ticketHost = el('div', { class: 'ticket-list' }, skeleton('sk-card', 2));
  const eventHost = el('div', { class: 'card card-pad admin-table agency-events-card' }, skeleton('sk-card', 1));
  root.appendChild(stats); root.appendChild(el('div', { class: 'admin-layout' }, [tenantHost, ticketHost])); root.appendChild(eventHost);
  try {
    const calls = [api('/api/admin/tickets'), api('/api/admin/payment-events')];
    if (superAdmin) calls.unshift(api('/api/admin/overview'), api('/api/admin/tenants'), api('/api/admin/users'));
    const data = await Promise.all(calls);
    const o = superAdmin ? data[0] : { totals: {} }, ts = superAdmin ? data[1] : { tenants: [] }, users = superAdmin ? data[2] : { users: [] }, tickets = data[superAdmin ? 3 : 0], events = data[superAdmin ? 4 : 1];
    stats.innerHTML = '';
    const totals = o.totals || {};
    [['Active clients', totals.activeTenants != null ? totals.activeTenants : 'Restricted', 'Live workspaces'], ['Revenue recorded', superAdmin ? '₹' + fmtInr((totals.invoicedPaise || 0) / 100) : 'Restricted', 'Issued invoices'], ['Outstanding', superAdmin ? '₹' + fmtInr((totals.outstandingPaise || 0) / 100) : 'Restricted', 'Receivables'], ['Open tickets', totals.openTickets != null ? totals.openTickets : (tickets.tickets || []).filter((t) => t.status !== 'closed').length, 'Needs attention'], ['Calls', superAdmin ? totals.calls : 'Restricted', 'Tracked usage']].forEach((x) => stats.appendChild(el('article', { class: 'agency-metric' }, [el('div', { class: 'agency-metric-label' }, x[0]), el('div', { class: 'agency-metric-value' }, String(x[1] || 0)), el('div', { class: 'agency-metric-note' }, x[2])])));
    tenantHost.innerHTML = ''; tenantHost.appendChild(el('div', { class: 'admin-client-head' }, [el('div', {}, [el('span', { class: 'section-kicker' }, 'Portfolio'), el('h3', {}, 'Client workspaces')]), superAdmin ? el('button', { class: 'btn btn-ghost btn-sm', onclick: openClientComposer }, 'Add client') : null]));
    if (superAdmin) (ts.tenants || []).forEach((t) => tenantHost.appendChild(adminTenantRow(t, (users.users || []).filter((u) => u.tenantId === t.id))));
    else tenantHost.appendChild(el('div', { class: 'muted' }, 'Tenant controls require super admin access.'));
    ticketHost.innerHTML = ''; (tickets.tickets || []).forEach((t) => ticketHost.appendChild(ticketCard(t, true)));
    eventHost.innerHTML = ''; eventHost.appendChild(el('div', { class: 'agency-card-head' }, [el('div', {}, [el('span', { class: 'section-kicker' }, 'Financial operations'), el('h3', {}, 'PayU event log')]) ]));
    (events.events || []).slice(0, 25).forEach((e) => eventHost.appendChild(el('div', { class: 'admin-row' }, [el('div', {}, [el('b', {}, e.txnid || 'Unknown transaction'), el('small', { class: 'muted' }, (e.reason || '') + ' · ' + (e.createdAt || ''))]), el('span', { class: 'pill' }, e.status || 'received')])));
    if (!(events.events || []).length) eventHost.appendChild(el('div', { class: 'muted' }, 'No PayU webhooks received yet.'));
  } catch (e) { tenantHost.innerHTML = ''; tenantHost.appendChild(el('div', { class: 'muted' }, e.message)); }
}

function adminTenantRow(t, users) {
  const wallet = t.wallet || {};
  const toggle = el('button', { class: 'btn btn-ghost' }, t.status === 'suspended' ? 'Reactivate' : 'Suspend');
  toggle.onclick = async () => {
    const status = t.status === 'suspended' ? 'active' : 'suspended';
    await api('/api/admin/tenants/status', { method: 'POST', body: { tenantId: t.id, status: status } });
    toast('Tenant set to ' + status + '.', 'ok'); onRoute();
  };
  const credit = el('button', { class: 'btn btn-ghost', onclick: () => adjustWallet(t) }, 'Adjust credit');
  const inspect = el('button', { class: 'btn btn-primary', onclick: () => inspectTenant(t, users || []) }, 'Open workspace');
  const approach = el('button', { class: 'btn btn-ghost', onclick: () => openClientApproach(t) }, 'Log approach');
  return el('div', { class: 'admin-client-row' }, [
    el('div', { class: 'admin-client-identity' }, [el('span', { class: 'client-avatar' }, initials(t.name)), el('div', {}, [el('b', {}, t.name), el('small', { class: 'muted' }, (t.users || 0) + ' users, ' + (t.agents || 0) + ' agents')])]),
    el('div', { class: 'admin-client-signal' }, [el('span', {}, 'Activity'), el('strong', {}, fmtInr((t.calls || 0)) + ' calls')]),
    el('div', { class: 'admin-client-signal' }, [el('span', {}, 'Outstanding'), el('strong', {}, '₹' + fmtInr((t.outstandingPaise || 0) / 100))]),
    el('div', { class: 'admin-client-signal' }, [el('span', {}, 'Wallet'), el('strong', {}, '₹' + fmtInr((wallet.balancePaise || 0) / 100))]),
    el('span', { class: 'status-badge status-' + (t.status || 'active') }, invoiceStatusLabel(t.status || 'active')),
    el('div', { class: 'admin-client-actions' }, [inspect, approach, credit, toggle])
  ]);
}

function openClientComposer() { window.location.assign('/admin#/clients'); }

function openClientApproach(t) {
  const channel = el('select', { class: 'select' }, ['whatsapp','email','phone','linkedin','meeting','other'].map((value) => el('option', { value }, invoiceStatusLabel(value))));
  const summary = el('textarea', { class: 'textarea', placeholder: 'What happened, what they need, and the next move.' });
  modal({ title: 'Log approach to ' + t.name, body: el('div', { class: 'invoice-form' }, [field('Channel', channel), field('Summary', summary)]), confirmText: 'Record activity', onConfirm: async () => {
    await api('/api/admin/client-approach', { method: 'POST', body: { tenantId: t.id, channel: channel.value, summary: summary.value.trim() } });
    toast('Client approach recorded.', 'ok'); onRoute();
  }});
}

async function inspectTenant(t, users) {
  const out = await api('/api/admin/tenant-detail?tenantId=' + encodeURIComponent(t.id));
  const tabs = [
    ['Users', (out.users || []).map((u) => u.name + ' · ' + u.email + ' · ' + u.role)],
    ['Agents', (out.agents || []).map((a) => a.name + ' · ' + ((a.telephony || {}).did || 'No number'))],
    ['Numbers', (out.numbers || []).map((n) => n.address + ' · ' + n.provider + ' · ' + n.status)],
    ['Calls', (out.usage || []).map((u) => u.day + ' · ' + (u.calls || 0) + ' calls')],
    ['Billing', (out.ledger || []).map((x) => (x.type || 'entry') + ' · ₹' + fmtInr((x.amountPaise || 0) / 100))],
    ['Support', (out.tickets || []).map((x) => x.subject + ' · ' + x.status)]
  ];
  const body = el('div', { class: 'tenant-inspector' }, tabs.map((tab) => el('section', {}, [el('h4', {}, tab[0]), ...(tab[1].length ? tab[1].map((line) => el('div', { class: 'inspector-line' }, line)) : [el('div', { class: 'muted' }, 'No records')])])));
  const user = (out.users || []).find((u) => u.role !== 'super_admin' && u.status === 'active');
  if (user) body.prepend(el('button', { class: 'btn btn-dark', onclick: () => startImpersonation(user) }, 'View as ' + user.email));
  modal({ title: out.tenant.name, body: body, confirmText: 'Close', onConfirm: async () => {} });
}

function startImpersonation(user) {
  const reason = el('input', { class: 'input', placeholder: 'Support ticket or investigation reason' });
  const password = el('input', { class: 'input', type: 'password', placeholder: 'Your super admin password' });
  modal({ title: 'View as ' + user.email, body: el('div', {}, [el('p', {}, 'This creates a 30 minute read-only user session. Billing, roles, status, and secrets remain blocked.'), field('Reason', reason), field('Re-enter your password', password)]), confirmText: 'Enter user view', onConfirm: async () => {
    await api('/api/admin/impersonations', { method: 'POST', body: { userId: user.id, reason: reason.value.trim(), password: password.value } });
    State.me = await api('/api/me'); renderShell(); goto('overview');
  }});
}

function adjustWallet(t) {
  const amount = el('input', { class: 'input', type: 'number', step: '0.01', placeholder: '100.00' });
  const reason = el('input', { class: 'input', placeholder: 'Required adjustment reason' });
  modal({ title: 'Adjust ' + t.name + ' wallet', body: el('div', {}, [field('Amount in INR, negative deducts', amount), field('Reason', reason)]), confirmText: 'Apply adjustment', onConfirm: async () => {
    const paise = Math.round(Number(amount.value) * 100);
    await api('/api/admin/wallet/adjust', { method: 'POST', body: { tenantId: t.id, amountPaise: paise, reason: reason.value.trim(), idempotencyKey: 'ui_' + Date.now() + '_' + Math.random().toString(36).slice(2) } });
    toast('Wallet adjusted.', 'ok'); onRoute();
  }});
}

/* ===========================================================================
   PRODUCT WORKSPACE
   =========================================================================== */
async function viewKnowledge(root) {
  const head = viewHead('Knowledge Base', 'Give every agent accurate company context from documents, websites, and FAQs.');
  head.appendChild(el('div', { class: 'view-actions' }, [el('button', { class: 'btn btn-primary', onclick: () => openKnowledgeModal() }, 'Add knowledge') ]));
  root.appendChild(head);
  const host = el('div', { class: 'resource-grid' }, skeleton('sk-card', 3)); root.appendChild(host);
  async function load() {
    try {
      const data = await api('/api/knowledge'); host.innerHTML = '';
      const items = data.items || [];
      if (!items.length) return host.appendChild(productEmpty('No knowledge added', 'Upload a document, add your website, or write FAQs so agents can answer business questions.', 'Add first source', openKnowledgeModal));
      items.forEach((item) => host.appendChild(el('article', { class: 'card resource-card' }, [
        el('div', { class: 'resource-icon' }, item.type === 'website' ? '↗' : item.type === 'faq' ? '?' : '▤'),
        el('div', { class: 'resource-main' }, [el('div', { class: 'resource-title' }, item.name), el('div', { class: 'muted resource-meta' }, humanizeAction(item.type) + (item.size ? ' · ' + formatBytes(item.size) : '')), item.contentPreview ? el('p', {}, item.contentPreview) : item.sourceUrl ? el('p', {}, item.sourceUrl) : null]),
        el('div', { class: 'resource-side' }, [el('span', { class: 'status-pill ' + item.status }, item.status), el('button', { class: 'btn btn-ghost btn-sm', onclick: () => deleteResource(item, '/api/knowledge/delete', load) }, 'Delete')])
      ])));
    } catch (error) { host.innerHTML = ''; host.appendChild(productError(error, load)); }
  }
  function openKnowledgeModal() {
    const type = el('select', { class: 'select' }, [['document','Document or PDF'],['website','Website'],['faq','FAQ']].map(([v,l]) => el('option', { value:v }, l)));
    const name = el('input', { class: 'input', placeholder: 'Pricing guide, company website, or a question' });
    const url = el('input', { class: 'input', placeholder: 'https://yourcompany.in' });
    const content = el('textarea', { class: 'textarea', rows: 6, placeholder: 'Paste document text, or write the FAQ answer here.' });
    const file = el('input', { class: 'input', type: 'file', accept: '.pdf,.txt,.md,.csv,.docx,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const urlField = field('Website URL', url), contentField = field('Text or answer', content), fileField = field('Choose file', file);
    const sync = () => { urlField.style.display = type.value === 'website' ? '' : 'none'; fileField.style.display = type.value === 'document' ? '' : 'none'; contentField.style.display = type.value === 'website' ? 'none' : ''; };
    type.onchange = sync; sync();
    modal({ title: 'Add knowledge source', body: el('div', { class: 'modal-form' }, [field('Source type', type), field('Name or question', name), urlField, fileField, contentField]), confirmText: 'Add source', onConfirm: async () => {
      let fileContent = content.value.trim(), fileName = '', mimeType = '', size = 0, fileData = '';
      const selected = file.files && file.files[0];
      if (selected) {
        fileName = selected.name; mimeType = selected.type; size = selected.size;
        if (size > 2 * 1024 * 1024) throw new Error('Documents must be 2 MB or smaller.');
        const bytes = new Uint8Array(await selected.arrayBuffer()); let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        fileData = btoa(binary); fileContent = '';
      }
      await api('/api/knowledge', { method: 'POST', body: { type: type.value, name: name.value.trim() || fileName, fileName, sourceUrl: url.value.trim(), content: fileContent, fileData, mimeType, size } });
      toast('Knowledge source saved.', 'ok'); await load();
    }});
  }
  load();
}

async function viewAnalytics(root) {
  root.appendChild(viewHead('Calls & Recordings', 'Review every agent and demo conversation, captured business details, and retained audio.'));
  const host = el('div', {}, [skeleton('sk-stat', 4), skeleton('sk-card', 2)]); root.appendChild(host);
  async function load() {
    try {
      const data = await api('/api/calls'); const stats = data.stats || {}; host.innerHTML = '';
      host.appendChild(el('div', { class: 'product-stat-grid' }, [productStat('Total calls', stats.total || 0, 'Visible Dograh runs'), productStat('Completed', stats.completed || 0, 'Finished conversations'), productStat('Success rate', (stats.successRate || 0) + '%', 'Based on call disposition'), productStat('Average duration', formatDuration(stats.averageDurationSeconds || 0), 'Completed calls')]));
      if (data.providerErrors) host.appendChild(el('div', { class: 'inline-notice' }, data.providerErrors + ' agent workflow could not be read. Other results are still shown.'));
      const calls = data.calls || [];
      if (!calls.length) return host.appendChild(productEmpty('No calls recorded yet', 'Use Talk to it, a Demo link, or Telephony. Completed calls will appear here automatically.', 'Test an agent', () => goto('talk')));
      host.appendChild(el('div', { class: 'card data-card' }, [
        el('div', { class: 'data-toolbar' }, [el('h3', { class: 't-h3' }, 'Call history'), el('span', { class: 'muted' }, calls.length + ' results')]),
        el('div', { class: 'data-table calls-table' }, [dataHeader(['Caller','Agent','Channel','Duration','Outcome','Recording','Review']), ...calls.map((call) => dataRow([
          el('div', {}, [el('b', {}, call.callerName || 'Unknown caller'), el('small', {}, call.phone || new Date(call.createdAt).toLocaleString())]), call.agentName, humanizeAction(call.mode), formatDuration(call.durationSeconds), el('span', { class: 'status-pill ' + call.status }, humanizeAction(call.disposition)), call.recordingUrl ? callRecordingPlayer(call.recordingUrl, 'Full recording', true) : el('span', { class: 'muted recording-unavailable' }, call.status === 'in_progress' ? 'Available after call' : 'Not retained'), el('div', { class: 'artifact-actions' }, [el('button', { class: 'text-button', onclick: () => openCallReview(call) }, 'View details')])
        ]))])
      ]));
    } catch (error) { host.innerHTML = ''; host.appendChild(productError(error, load)); }
  }
  load();
}

function audioClock(seconds) {
  const value = Number.isFinite(Number(seconds)) ? Math.max(0, Math.floor(Number(seconds))) : 0;
  return Math.floor(value / 60) + ':' + String(value % 60).padStart(2, '0');
}

const RECORDING_ICON = Object.freeze({
  play: '<svg viewBox="0 0 20 20" aria-hidden="true"><path class="fill" d="M6.2 4.2v11.6L15.6 10 6.2 4.2Z"/></svg>',
  pause: '<svg viewBox="0 0 20 20" aria-hidden="true"><path class="fill" d="M5.5 4.5h3.2v11H5.5v-11Zm5.8 0h3.2v11h-3.2v-11Z"/></svg>',
  volume: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 8h3l3.7-3v10l-3.7-3h-3V8Zm9.1-.9c1.7 1.5 1.7 4.3 0 5.8m2.1-8c3 2.8 3 7.4 0 10.2"/></svg>',
  muted: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 8h3l3.7-3v10l-3.7-3h-3V8Zm9.1-.7 4.1 5.4m0-5.4-4.1 5.4"/></svg>'
});

function callRecordingPlayer(url, label, compact) {
  const audio = el('audio', { preload: 'metadata', src: url + (String(url).includes('?') ? '&' : '?') + 'inline=true' });
  const play = el('button', { class: 'recording-control recording-play', type: 'button', title: 'Play recording', 'aria-label': 'Play ' + label, html: RECORDING_ICON.play });
  const progress = el('input', { class: 'recording-progress', type: 'range', min: '0', max: '1000', value: '0', step: '1', 'aria-label': 'Recording position' });
  const time = el('span', { class: 'recording-time' }, '0:00');
  const mute = el('button', { class: 'recording-control recording-mute', type: 'button', title: 'Mute recording', 'aria-label': 'Mute ' + label, html: RECORDING_ICON.volume });
  const volume = el('input', { class: 'recording-volume', type: 'range', min: '0', max: '1', value: '0.8', step: '0.05', 'aria-label': 'Recording volume' });
  const pulse = el('span', { class: 'recording-pulse', 'aria-hidden': 'true' }, [el('i'), el('i'), el('i')]);
  const player = el('div', { class: 'recording-player' + (compact ? ' is-compact' : '') }, [
    compact ? null : el('div', { class: 'recording-label' }, [pulse, el('span', {}, label)]),
    el('div', { class: 'recording-main' }, [play, progress, time, mute, volume]),
    audio
  ]);
  audio.volume = 0.8;
  let lastVolume = 0.8;

  function paintVolume() {
    const silent = audio.muted || audio.volume === 0;
    mute.innerHTML = silent ? RECORDING_ICON.muted : RECORDING_ICON.volume;
    mute.classList.toggle('is-muted', silent);
    mute.title = silent ? 'Unmute recording' : 'Mute recording';
    mute.setAttribute('aria-label', (silent ? 'Unmute ' : 'Mute ') + label);
    volume.style.setProperty('--volume', (silent ? 0 : audio.volume * 100) + '%');
  }
  function paintTime() {
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const played = duration ? Math.round((audio.currentTime / duration) * 1000) : 0;
    progress.value = String(played);
    progress.style.setProperty('--played', (played / 10) + '%');
    time.textContent = audioClock(audio.currentTime) + (compact ? '' : ' / ' + audioClock(duration));
  }
  play.onclick = async () => {
    if (!audio.paused) return audio.pause();
    $$('.recording-player audio').forEach((other) => { if (other !== audio) other.pause(); });
    try { await audio.play(); } catch (_) { toast('This recording could not be played. Try opening the call details again.', 'err'); }
  };
  progress.oninput = () => {
    progress.style.setProperty('--played', (Number(progress.value) / 10) + '%');
    if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = (Number(progress.value) / 1000) * audio.duration;
  };
  mute.onclick = () => {
    if (audio.muted || audio.volume === 0) {
      audio.muted = false; audio.volume = lastVolume || 0.8; volume.value = String(audio.volume);
    } else {
      lastVolume = audio.volume; audio.muted = true;
    }
    paintVolume();
  };
  volume.oninput = () => {
    audio.volume = Number(volume.value); audio.muted = false;
    if (audio.volume > 0) lastVolume = audio.volume;
    paintVolume();
  };
  audio.onplay = () => { play.innerHTML = RECORDING_ICON.pause; play.title = 'Pause recording'; player.classList.add('is-playing'); };
  audio.onpause = () => { play.innerHTML = RECORDING_ICON.play; play.title = 'Play recording'; player.classList.remove('is-playing'); };
  audio.onended = () => { audio.currentTime = 0; paintTime(); };
  audio.ontimeupdate = paintTime;
  audio.onloadedmetadata = paintTime;
  audio.onerror = () => player.classList.add('has-error');
  paintVolume();
  return player;
}

function openCallReview(call) {
  const schema = Array.isArray(call.outcomeSchema) ? call.outcomeSchema : [];
  const values = call.collected || {};
  const details = schema.map((field) => el('div', { class: 'call-detail-field' }, [
    el('span', {}, field.label),
    el('strong', {}, values[field.key] === undefined || values[field.key] === '' ? 'Not captured' : (typeof values[field.key] === 'boolean' ? (values[field.key] ? 'Yes' : 'No') : String(values[field.key])))
  ]));
  const recordings = [
    call.recordingUrl ? callRecordingPlayer(call.recordingUrl, 'Full conversation', false) : null,
    call.userRecordingUrl ? callRecordingPlayer(call.userRecordingUrl, 'Caller channel', false) : null,
    call.botRecordingUrl ? callRecordingPlayer(call.botRecordingUrl, 'Agent channel', false) : null
  ].filter(Boolean);
  modal({
    title: (call.callerName || 'Call') + ' · ' + call.agentName,
    body: el('div', { class: 'call-review' }, [
      el('div', { class: 'call-review-meta' }, [el('span', {}, new Date(call.createdAt).toLocaleString('en-IN')), el('span', {}, humanizeAction(call.mode)), el('span', {}, formatDuration(call.durationSeconds)), el('span', { class: 'status-pill ' + call.status }, humanizeAction(call.disposition))]),
      el('section', {}, [el('h4', {}, 'Collected business details'), details.length ? el('div', { class: 'call-detail-grid' }, details) : el('p', { class: 'muted' }, 'This agent has no outcome fields configured.')]),
      el('section', {}, [el('h4', {}, 'Recording'), recordings.length ? el('div', { class: 'call-audio-list' }, recordings) : el('p', { class: 'muted' }, 'No recording was retained. Enable recording and caller consent in Dograh to make audio available here.')]),
      call.transcriptUrl ? el('a', { class: 'btn btn-ghost', href: call.transcriptUrl, target: '_blank', rel: 'noopener' }, 'Open transcript') : null
    ]),
    confirmText: 'Close', onConfirm: async () => {}
  });
}

async function viewContacts(root) {
  const head = viewHead('Contacts & Leads', 'Review captured prospects, call notes, and follow-up status.');
  const add = el('button', { class: 'btn btn-primary' }, 'Add contact'); head.appendChild(el('div', { class: 'view-actions' }, [add])); root.appendChild(head);
  const controls = el('div', { class: 'filter-row' }); const search = el('input', { class: 'input', placeholder: 'Search name, phone, email, or company' }); const filter = el('select', { class: 'select' }, ['all','new','qualified','follow_up','customer','lost'].map((value) => el('option', { value }, humanizeAction(value)))); controls.append(search, filter); root.appendChild(controls);
  const host = el('div', {}, skeleton('sk-card', 2)); root.appendChild(host); let contacts = [];
  function paint() {
    host.innerHTML = ''; const query = search.value.trim().toLowerCase(); const rows = contacts.filter((contact) => (filter.value === 'all' || contact.status === filter.value) && (!query || [contact.name,contact.phone,contact.email,contact.company].join(' ').toLowerCase().includes(query)));
    if (!rows.length) return host.appendChild(productEmpty(contacts.length ? 'No matching contacts' : 'No contacts yet', contacts.length ? 'Try another search or status.' : 'Create a contact now. Call-captured leads can be reviewed here as the workflow grows.', contacts.length ? '' : 'Add first contact', contacts.length ? null : () => openContact()));
    host.appendChild(el('div', { class: 'card data-card' }, [el('div', { class: 'data-table contacts-table' }, [dataHeader(['Contact','Company','Status','Follow up','Notes','Actions']), ...rows.map((contact) => dataRow([el('div', {}, [el('b', {}, contact.name), el('small', {}, contact.phone + (contact.email ? ' · ' + contact.email : ''))]), contact.company || '—', el('span', { class: 'status-pill ' + contact.status }, humanizeAction(contact.status)), contact.followUpAt ? new Date(contact.followUpAt).toLocaleString() : 'Not scheduled', contact.notes || 'No notes', el('div', { class: 'artifact-actions' }, [el('button', { class: 'text-button', onclick: () => openContact(contact) }, 'Edit'), el('button', { class: 'text-button danger-text', onclick: () => deleteResource(contact, '/api/contacts/delete', load) }, 'Delete')])]))]) ]));
  }
  async function load() { try { const data = await api('/api/contacts'); contacts = data.contacts || []; paint(); } catch (error) { host.innerHTML = ''; host.appendChild(productError(error, load)); } }
  function openContact(existing) {
    const item = existing || {}; const name = el('input', { class: 'input', value: item.name || '', placeholder: 'Customer name' }); const phone = el('input', { class: 'input', value: item.phone || '', placeholder: '+91 98765 43210' }); const email = el('input', { class: 'input', value: item.email || '', placeholder: 'name@company.com' }); const company = el('input', { class: 'input', value: item.company || '', placeholder: 'Company' }); const status = el('select', { class: 'select' }, ['new','qualified','follow_up','customer','lost'].map((value) => el('option', { value, selected: value === (item.status || 'new') ? 'selected' : false }, humanizeAction(value)))); const follow = el('input', { class: 'input', type: 'datetime-local', value: item.followUpAt ? String(item.followUpAt).slice(0,16) : '' }); const notes = el('textarea', { class: 'textarea', rows: 4, placeholder: 'Call notes and next action' }, item.notes || '');
    modal({ title: existing ? 'Edit contact' : 'Add contact', body: el('div', { class: 'modal-form two-col' }, [field('Name', name),field('Phone', phone),field('Email', email),field('Company', company),field('Status', status),field('Follow up', follow),field('Notes', notes)]), confirmText: existing ? 'Save changes' : 'Add contact', onConfirm: async () => { await api('/api/contacts', { method:'POST', body:{ id:item.id, name:name.value.trim(), phone:phone.value.trim(), email:email.value.trim(), company:company.value.trim(), status:status.value, followUpAt:follow.value || null, notes:notes.value.trim() } }); toast('Contact saved.', 'ok'); await load(); }});
  }
  add.onclick = () => openContact(); search.oninput = paint; filter.onchange = paint; load();
}

async function viewAutomation(root) {
  const head = viewHead('Automation', 'Turn call outcomes into follow-ups, appointments, routing, and CRM-ready events.'); const add = el('button', { class: 'btn btn-primary' }, 'Create automation'); head.appendChild(el('div', { class: 'view-actions' }, [add])); root.appendChild(head);
  const host = el('div', { class: 'automation-grid' }, skeleton('sk-card', 3)); root.appendChild(host); let rules = [];
  async function load() { try { const data = await api('/api/automations'); rules = data.rules || []; paint(); } catch (error) { host.innerHTML='';host.appendChild(productError(error,load)); } }
  function paint() { host.innerHTML=''; if(!rules.length) return host.appendChild(productEmpty('No automations yet','Create a rule to make every completed call actionable.','Create first automation',()=>openRule())); rules.forEach((rule)=>host.appendChild(el('article',{class:'card automation-card'},[el('div',{class:'automation-top'},[el('span',{class:'automation-bolt'},'↯'),el('span',{class:'status-pill '+rule.status},rule.status)]),el('h3',{},rule.name),el('div',{class:'automation-flow'},[el('span',{},humanizeAction(rule.trigger)),el('b',{},'→'),el('span',{},humanizeAction(rule.action))]),rule.config.destination?el('p',{class:'muted'},rule.config.destination):null,el('div',{class:'ac-actions'},[el('button',{class:'btn btn-ghost btn-sm',onclick:()=>openRule(rule)},'Edit'),el('button',{class:'btn btn-ghost btn-sm',onclick:()=>deleteResource(rule,'/api/automations/delete',load)},'Delete')])]))); }
  function openRule(existing) { const item=existing||{}; const name=el('input',{class:'input',value:item.name||'',placeholder:'Follow up qualified leads'}); const trigger=el('select',{class:'select'},['call_completed','lead_qualified','appointment_requested','missed_call'].map(v=>el('option',{value:v,selected:v===(item.trigger||'call_completed')?'selected':false},humanizeAction(v)))); const action=el('select',{class:'select'},['create_follow_up','route_lead','book_appointment','send_webhook'].map(v=>el('option',{value:v,selected:v===(item.action||'create_follow_up')?'selected':false},humanizeAction(v)))); const status=el('select',{class:'select'},['active','paused'].map(v=>el('option',{value:v,selected:v===(item.status||'active')?'selected':false},humanizeAction(v)))); const destination=el('input',{class:'input',value:(item.config&&item.config.destination)||'',placeholder:'CRM queue, calendar, or webhook URL'}); modal({title:existing?'Edit automation':'Create automation',body:el('div',{class:'modal-form'},[field('Rule name',name),field('When this happens',trigger),field('Do this',action),field('Destination or details',destination),field('Status',status)]),confirmText:'Save automation',onConfirm:async()=>{await api('/api/automations',{method:'POST',body:{id:item.id,name:name.value.trim(),trigger:trigger.value,action:action.value,destination:destination.value.trim(),status:status.value}});toast('Automation saved.','ok');await load();}}); }
  add.onclick=()=>openRule(); load();
}

function productEmpty(title, copy, buttonText, action) { return el('div', { class: 'card product-empty' }, [el('div', { class: 'product-empty-mark' }, '✦'), el('h3', {}, title), el('p', { class: 'muted' }, copy), buttonText && action ? el('button', { class: 'btn btn-primary', onclick: action }, buttonText) : null]); }
function productError(error, retry) { return el('div', { class: 'card product-empty error-state' }, [el('h3', {}, 'Could not load this page'), el('p', {}, error.message || 'Try again.'), el('button', { class: 'btn btn-ghost', onclick: retry }, 'Try again')]); }
function formatBytes(bytes) { const value=Number(bytes||0); if(value<1024)return value+' B'; if(value<1024*1024)return (value/1024).toFixed(1)+' KB'; return (value/1024/1024).toFixed(1)+' MB'; }
function dataHeader(labels) { return el('div', { class: 'data-row data-header' }, labels.map((label) => el('div', {}, label))); }
function dataRow(values) { return el('div', { class: 'data-row' }, values.map((value) => value instanceof Node ? el('div', {}, value) : el('div', {}, String(value == null ? '' : value)))); }
function deleteResource(item, endpoint, reload) { modal({ title: 'Delete ' + (item.name || 'item'), body: el('p', {}, 'This removes it from your workspace.'), confirmText: 'Delete', confirmKind: 'danger', onConfirm: async () => { await api(endpoint, { method:'POST', body:{id:item.id} }); toast('Deleted.','ok'); await reload(); } }); }

/* ===========================================================================
   SETTINGS
   =========================================================================== */
async function viewSettings(root) {
  root.appendChild(viewHead('Business Settings', 'Company profile, team access, billing, and privacy. Platform infrastructure is managed by your administrator.'));

  const provHost = el('div', { id: 'provHost' }, skeleton('sk-card', 3));
  if (isPlatformUserClient(State.me.user)) root.appendChild(provHost);

  const t = State.me.tenant;
  const nameI = el('input', { class: 'input', id: 'set_name', type: 'text', value: t.name || '' });
  const colorVal = (t.branding && t.branding.color) || '#6E7BFF';
  const colorI = el('input', { type: 'color', id: 'set_color', value: colorVal });
  const colorHex = el('input', { class: 'input', id: 'set_color_hex', value: colorVal, style: 'max-width:130px;font-family:var(--mono)' });
  colorI.addEventListener('input', () => { colorHex.value = colorI.value; });
  colorHex.addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test(colorHex.value)) colorI.value = colorHex.value; });

  const saveBtn = el('button', { class: 'btn btn-primary' }, 'Save tenant settings');
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
    try {
      // tenant settings update is best effort. If the route is absent, surface a soft note.
      await api('/api/tenant/update', { method: 'POST', body: { name: nameI.value.trim(), color: colorI.value } });
      State.me.tenant.name = nameI.value.trim();
      State.me.tenant.branding = Object.assign({}, State.me.tenant.branding, { color: colorI.value });
      const tn = $('.tenant-chip .tn'); if (tn) { tn.textContent = State.me.tenant.name; tn.title = State.me.tenant.name; }
      const av = $('.tenant-chip .av'); if (av) av.textContent = initials(State.me.tenant.name);
      toast('Tenant settings saved.', 'ok');
    } catch (ex) {
      toast(ex.status === 404 ? 'Tenant settings endpoint not available in this build.' : (ex.message || 'Save failed.'), 'err');
    } finally {
      saveBtn.disabled = false; saveBtn.textContent = 'Save tenant settings';
    }
  });

  root.appendChild(el('div', { class: 'card card-pad', style: 'margin-top:8px' }, [
    el('h3', { class: 't-h3', style: 'margin-bottom:16px' }, 'Tenant'),
    el('div', { class: 'settings-form' }, [
      field('Tenant name', nameI),
      el('div', { class: 'field' }, [el('label', {}, 'Brand color'), el('div', { class: 'color-row' }, [colorI, colorHex])]),
      el('div', { class: 'flex gap-2', style: 'margin-top:6px' }, [saveBtn, el('button', { class: 'btn btn-ghost', onclick: doLogout }, 'Sign out')])
    ])
  ]));

  const privacySelect = el('select', { class: 'select', id: 'privacy_mode' }, [
    el('option', { value: 'standard' }, 'Standard retention'),
    el('option', { value: 'metadata_only' }, 'Privacy mode, metadata only'),
    el('option', { value: 'no_recording' }, 'HIPAA mode, no recording or transcript retention')
  ]);
  const privacySave = el('button', { class: 'btn btn-primary' }, 'Save privacy mode');
  privacySave.onclick = async () => {
    privacySave.disabled = true;
    try { await api('/api/privacy', { method: 'POST', body: { mode: privacySelect.value } }); toast('Privacy mode saved.', 'ok'); }
    catch (e) { toast(e.message, 'err'); } finally { privacySave.disabled = false; }
  };
  const provider = el('select', { class: 'select' }, [el('option', { value: 'vobiz' }, 'VoBiz'), el('option', { value: 'telnyx' }, 'Telnyx'), el('option', { value: 'sip' }, 'SIP trunk')]);
  const address = el('input', { class: 'input', placeholder: 'Verified E.164 number or SIP address' });
  const label = el('input', { class: 'input', placeholder: 'Main sales line' });
  const byonList = el('div', { class: 'byon-list muted' }, 'Loading connections...');
  const byonSave = el('button', { class: 'btn btn-ghost' }, 'Connect my number');
  byonSave.onclick = async () => {
    byonSave.disabled = true;
    try { await api('/api/byon', { method: 'POST', body: { provider: provider.value, address: address.value.trim(), label: label.value.trim() } }); toast('Number connection saved for verification.', 'ok'); await loadByon(byonList); }
    catch (e) { toast(e.message, 'err'); } finally { byonSave.disabled = false; }
  };
  root.appendChild(el('div', { class: 'settings-split' }, [
    el('section', { class: 'card card-pad' }, [
      el('h3', { class: 't-h3' }, 'Privacy and HIPAA mode'),
      el('p', { class: 'muted privacy-copy' }, 'HIPAA mode disables recording and transcript retention in LessRepeat. It does not by itself make your organization HIPAA compliant. You still need appropriate provider BAAs, policies, access controls, consent, and legal review.'),
      field('Retention policy', privacySelect), privacySave
    ]),
    el('section', { class: 'card card-pad' }, [
      el('h3', { class: 't-h3' }, 'Bring your own number'),
      el('p', { class: 'muted privacy-copy' }, 'Connect only a number or SIP address that your organization owns and has verified with the carrier.'),
      field('Provider', provider), field('Number or SIP address', address), field('Label', label), byonSave, byonList
    ])
  ]));
  Promise.all([
    api('/api/privacy').then((x) => { privacySelect.value = x.mode || 'standard'; }),
    loadByon(byonList)
  ]).catch(() => {});

  try {
    if (isPlatformUserClient(State.me.user)) {
      const reg = await ensureProviders();
      paintProviders(provHost, reg);
    }
  } catch (e) {
    provHost.innerHTML = '';
    provHost.appendChild(el('div', { class: 'card card-pad muted' }, 'Could not load providers. ' + esc(e.message)));
  }

  const teamHost = el('section', { class: 'card card-pad settings-section' }, [el('h3', { class: 't-h3' }, 'Team members'), el('p', { class: 'muted' }, 'Owners control billing and security. Members can operate agents and review calls.'), el('div', { class: 'team-list muted' }, 'Loading members...')]);
  root.appendChild(teamHost);
  if (['owner','admin','super_admin'].includes(State.me.user.role)) {
    api('/api/members').then((data) => {
      const list = $('.team-list', teamHost); list.innerHTML = '';
      (data.users || []).forEach((user) => list.appendChild(el('div', { class: 'team-row' }, [el('div', { class: 'ac-av small' }, initials(user.name || user.email)), el('div', { class: 'team-copy' }, [el('b', {}, user.name || user.email), el('span', {}, user.email)]), el('span', { class: 'status-pill active' }, user.role)])));
    }).catch((error) => { const list = $('.team-list', teamHost); list.textContent = error.message; });
  } else $('.team-list', teamHost).textContent = 'Only workspace owners can manage team access.';

  root.appendChild(el('div', { class: 'settings-split' }, [
    el('section', { class: 'card card-pad settings-section' }, [el('h3', { class: 't-h3' }, 'API keys'), el('p', { class: 'muted' }, 'Provider keys are stored only on the server and are never returned to the browser.'), el('div', { class: 'secure-key-row' }, [el('span', {}, 'Server-managed provider credentials'), el('span', { class: 'status-pill indexed' }, 'Protected')]), el('button', { class: 'btn btn-ghost', onclick: () => goto('integrations') }, 'Manage integrations')]),
    el('section', { class: 'card card-pad settings-section' }, [el('h3', { class: 't-h3' }, 'Billing'), el('p', { class: 'muted' }, 'Review wallet balance, usage, and add credits from the billing workspace.'), el('button', { class: 'btn btn-ghost', onclick: () => goto('billing') }, 'Open billing')])
  ]));
}

async function loadByon(host) {
  const out = await api('/api/byon'); host.innerHTML = '';
  (out.connections || []).forEach((x) => host.appendChild(el('div', { class: 'status-line' }, [
    el('span', { class: 'k' }, x.label || x.provider), el('span', { class: 'v' }, (x.address || '') + ' · ' + (x.status || 'pending'))
  ])));
  if (!(out.connections || []).length) host.textContent = 'No number connected yet.';
}

function paintProviders(host, reg) {
  host.innerHTML = '';
  const layers = [
    { key: 'tts', label: 'Text to speech' },
    { key: 'llm', label: 'Brain, LLM' },
    { key: 'telephony', label: 'Telephony' }
  ];
  layers.forEach((L) => {
    const list = reg[L.key] || [];
    const wrap = el('div', { class: 'prov-layer' }, [
      el('div', { class: 'lh' }, [el('span', { class: 'lt' }, L.label)]),
      el('div', { class: 'prov-grid' }, list.length ? list.map(provCard) : [el('div', { class: 'muted' }, 'No providers registered.')])
    ]);
    host.appendChild(wrap);
  });
}
function provCard(p) {
  const live = !!p.live;
  const selected = !!p.selected;
  const needs = p.needs || [];
  return el('div', { class: 'card prov-card' }, [
    el('div', { class: 'pc-top' }, [
      el('div', { class: 'pc-name' }, p.label || p.id),
      selected && live
        ? el('span', { class: 'badge-live' }, [el('span', { class: 'd' }), 'Selected'])
        : live
          ? el('span', { class: 'badge-ready' }, [el('span', { class: 'd' }), 'Configured'])
          : el('span', { class: 'badge-ready' }, [el('span', { class: 'd' }), 'Needs setup'])
    ]),
    selected && live
      ? el('div', { class: 'pc-needs' }, 'Default provider for dashboard-owned requests.')
      : live
        ? el('div', { class: 'pc-needs' }, 'Credentials available. Select it through trusted server configuration.')
      : el('div', { class: 'pc-needs' }, needs.length
          ? ['To enable, add ', ...needs.flatMap((n, i) => i ? [document.createTextNode(', '), el('code', {}, n)] : [el('code', {}, n)]), document.createTextNode(' to your .env.')]
          : 'Adapter is implemented but not configured.')
  ]);
}

/* ===========================================================================
   START
   =========================================================================== */
let _booted = false;
function bootOnce() { if (_booted) return; _booted = true; boot(); }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootOnce);
else bootOnce();
