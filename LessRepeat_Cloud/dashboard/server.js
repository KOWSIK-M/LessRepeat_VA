/**
 * LessRepeat. Zero-dependency Node server (the product, multi-tenant).
 *
 * Pure Node http/https/crypto/fs. No npm, no build step, no framework. Run with
 * `node server.js` and it serves the JSON API plus the static public/ site on
 * PORT (default 8787). Secrets stay server side, runtime state lives in data/.
 *
 * Routes are EXACTLY per SPEC section 4. Every agents/usage/telephony route is
 * tenant scoped through the session. The live provider calls (Deepgram, Groq, Rumik,
 * VoBiz through Dograh) are isolated in lib/providers.js.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const http = require('http');
const net = require('net');
const dns = require('dns').promises;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const core = require('./lib/core');
core.loadEnv();

const providers = require('./lib/providers');
const payu = require('./lib/payu');
const demoLinks = require('./lib/demo-links');
const dograh = require('./lib/dograh');
const { DEFAULT_OUTCOME_FIELDS, normalizeOutcomeSchema, buildAgentConfiguration, buildDograhWorkflowDefinition } = require('./lib/agent-workflow');

const PORT = parseInt(process.env.PORT || '8787', 10);
const DEFAULT_PROVIDERS = Object.freeze({
  stt: providers.stt.id,
  tts: providers.tts.id,
  llm: providers.llm.id,
  telephony: providers.telephony.id,
});
const KOKORO_DEFAULT_VOICE = 'hf_beta';
const GEMINI_TTS_DEFAULT_VOICE = 'Achird';
const GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
const GEMINI_LIVE_VOICE_MAP = Object.freeze({
  Achird: 'Puck',
  Sulafat: 'Aoede',
  Gacrux: 'Kore',
  Iapetus: 'Charon',
  Zubenelgenubi: 'Fenrir',
  Charon: 'Charon',
});

function kokoroPreset(voice) {
  return providers.KOKORO_VOICE_PRESETS.find((preset) => preset.id === voice) || null;
}

function geminiTtsPreset(voice) {
  return providers.GEMINI_TTS_VOICE_PRESETS.find((preset) => preset.id === voice) || null;
}

function normalizeAgentTts(input, fallback = {}) {
  const body = input && typeof input === 'object' ? input : {};
  const requestedProvider = String(body.provider != null ? body.provider : fallback.provider || 'kokoro');
  const provider = ['rumik', 'gemini_tts'].includes(requestedProvider) ? requestedProvider : 'kokoro';
  if (provider === 'kokoro') {
    const requestedVoice = body.speaker != null ? body.speaker : fallback.speaker;
    const speaker = providers.KOKORO_VOICES.has(requestedVoice) ? requestedVoice : KOKORO_DEFAULT_VOICE;
    const preset = kokoroPreset(speaker);
    const requestedSpeed = body.speed != null ? body.speed : fallback.speed;
    return {
      provider,
      model: 'kokoro',
      speaker,
      speed: Number.isFinite(Number(requestedSpeed))
        ? Math.max(0.75, Math.min(1.2, Number(requestedSpeed)))
        : (preset ? preset.speed : 1),
      f0_up_key: 0,
      profile: '',
      customVoiceId: String(body.customVoiceId != null ? body.customVoiceId : fallback.customVoiceId || ''),
      description: '',
    };
  }
  if (provider === 'gemini_tts') {
    const requestedVoice = body.speaker != null ? body.speaker : fallback.speaker;
    const speaker = providers.GEMINI_TTS_VOICES.has(requestedVoice) ? requestedVoice : GEMINI_TTS_DEFAULT_VOICE;
    const preset = geminiTtsPreset(speaker);
    return {
      provider,
      model: 'gemini-2.5-flash-preview-tts',
      speaker,
      speed: 1,
      f0_up_key: 0,
      profile: '',
      customVoiceId: String(body.customVoiceId != null ? body.customVoiceId : fallback.customVoiceId || ''),
      description: String(body.description != null ? body.description : fallback.description || (preset && preset.description) || '').trim().slice(0, 500),
    };
  }
  const requestedModel = body.model != null ? body.model : fallback.model;
  const requestedSpeaker = body.speaker != null ? body.speaker : fallback.speaker;
  const requestedPitch = body.f0_up_key != null ? body.f0_up_key : fallback.f0_up_key;
  return {
    provider,
    model: requestedModel === 'muga' ? 'muga' : 'mulberry',
    speaker: providers.TTS_SPEAKERS.has(requestedSpeaker) ? requestedSpeaker : 'speaker_1',
    f0_up_key: Number.isFinite(requestedPitch) ? Math.max(-12, Math.min(12, requestedPitch | 0)) : 0,
    profile: INDIAN_VOICE_PROFILE_IDS.has(String(body.profile != null ? body.profile : fallback.profile || '')) ? String(body.profile != null ? body.profile : fallback.profile) : '',
    customVoiceId: String(body.customVoiceId != null ? body.customVoiceId : fallback.customVoiceId || ''),
    description: String(body.description != null ? body.description : fallback.description || '').trim().slice(0, 500),
  };
}

function dograhVoiceConfigurations(tts) {
  if (!tts || !['kokoro', 'gemini_tts'].includes(tts.provider)) return {};
  const preset = kokoroPreset(tts.speaker);
  if (tts.provider === 'gemini_tts') {
    // Gemini Live can close an otherwise healthy call with resource_exhausted
    // when the account has no realtime quota. Keep production/demo calls on
    // Dograh's proven default unless the operator explicitly enables Live.
    if (String(process.env.ENABLE_GEMINI_LIVE_CALLS || '').toLowerCase() !== 'true') return {};
    const geminiKey = String(process.env.GEMINI_API_KEY || '');
    return {
      model_configuration_v2_override: {
        version: 2,
        mode: 'byok',
        byok: {
          mode: 'realtime',
          realtime: {
            realtime: {
              provider: 'google_realtime',
              api_key: geminiKey,
              model: String(process.env.GEMINI_LIVE_MODEL || GEMINI_LIVE_MODEL),
              voice: GEMINI_LIVE_VOICE_MAP[tts.speaker] || 'Puck',
              language: 'te',
              temperature: 0.35,
            },
            llm: {
              provider: 'google',
              api_key: geminiKey,
              model: String(process.env.GEMINI_DOGRAH_LLM_MODEL || 'gemini-3.5-flash-lite'),
            },
          },
        },
      },
    };
  }
  const ttsConfiguration = {
    provider: 'speaches', api_key: 'none', model: 'kokoro',
    voice: tts.speaker || KOKORO_DEFAULT_VOICE,
    base_url: String(process.env.KOKORO_DOGRAH_BASE_URL || 'http://kokoro-tts:8880/v1'), speed: Number(tts.speed || (preset && preset.speed) || 1),
  };
  return {
    model_configuration_v2_override: {
      version: 2,
      mode: 'byok',
      byok: {
        mode: 'pipeline',
        pipeline: {
          llm: {
            provider: 'groq', api_key: String(process.env.GROQ_API_KEY || ''),
            model: String(process.env.GROQ_MODEL || 'openai/gpt-oss-20b'),
          },
          stt: {
            provider: 'deepgram', api_key: String(process.env.DEEPGRAM_API_KEY || ''),
            model: String(process.env.DEEPGRAM_MODEL || 'nova-3-general'), language: 'multi',
          },
          tts: ttsConfiguration,
        },
      },
    },
  };
}

function demoVoiceTts(tts) {
  return normalizeAgentTts({ provider: 'rumik', model: 'mulberry', speaker: 'speaker_1' });
}

function demoVoiceSignature() {
  return 'dograh-default:stable:v3';
}

/* ==========================================================================
   Boot: ensure data/ + db.json, seed the demo tenant, migrate legacy agents.
   ========================================================================== */

const DEMO_EMAIL = String(process.env.TEST_USER_EMAIL || '').trim().toLowerCase();
const DEMO_PASS = String(process.env.TEST_USER_PASSWORD || '');
const DEMO_TENANT = String(process.env.TEST_USER_TENANT || 'LessRepeat Test');
const DEMO_LINK_ENCRYPTION_KEY = String(process.env.DEMO_LINK_ENCRYPTION_KEY || '');
const GEMINI_TTS_PROXY_KEY = String(process.env.GEMINI_TTS_PROXY_KEY || DEMO_LINK_ENCRYPTION_KEY || '');
const TRIAL_CREDIT_PAISE = 1000;
const CREDIT_PACKS = Object.freeze({
  starter: Object.freeze({ amount: '200.00', currency: 'INR', credits: 20000, productinfo: 'LessRepeat Starter Credits' }),
  growth: Object.freeze({ amount: '500.00', currency: 'INR', credits: 50000, productinfo: 'LessRepeat Growth Credits' }),
  scale: Object.freeze({ amount: '1000.00', currency: 'INR', credits: 100000, productinfo: 'LessRepeat Scale Credits' }),
});

function payuConfig() {
  if (!process.env.PAYU_KEY || !process.env.PAYU_SALT) return null;
  return { key: process.env.PAYU_KEY, salt: process.env.PAYU_SALT, env: process.env.PAYU_ENV === 'production' ? 'production' : 'test' };
}

function readForm(req, cap = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (chunk) => { size += chunk.length; if (size > cap) { reject(new Error('payload too large')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))));
    req.on('error', reject);
  });
}

const PRESET_LIBRARY = [
  {
    id: 'preset_personal_injury_v1', slug: 'personal-injury-intake', version: 1,
    name: 'Personal Injury Intake', category: 'legal', isSystem: true,
    greeting: 'Thank you for calling. I am an AI intake assistant and this call may be recorded. Are you in immediate danger or need emergency medical help?',
    fields: ['caller_name', 'callback_number', 'adverse_parties', 'incident_date', 'incident_location', 'incident_type', 'injuries', 'treatment', 'insurance', 'represented', 'deadline_risk', 'preferred_appointment'],
    guardrails: ['No legal advice', 'No case valuation', 'Escalate emergencies and deadline risk', 'Attorney decides case acceptance'],
  },
  {
    id: 'preset_dental_receptionist_v1', slug: 'dental-receptionist', version: 1,
    name: 'Dental Receptionist', category: 'healthcare', isSystem: true,
    greeting: 'Thank you for calling. I am the practice AI receptionist and this call may be recorded. How can I help today?',
    fields: ['caller_name', 'callback_number', 'new_or_existing_patient', 'reason', 'pain_level', 'emergency_signs', 'insurance', 'preferred_appointment'],
    guardrails: ['No diagnosis', 'Escalate breathing, bleeding, trauma, or severe swelling', 'Confirm booking details'],
  },
  {
    id: 'preset_real_estate_v1', slug: 'real-estate-lead', version: 1,
    name: 'Real Estate Lead Qualifier', category: 'real_estate', isSystem: true,
    greeting: 'Thanks for calling. I am the AI property assistant. Are you looking to buy, sell, rent, or schedule a viewing?',
    fields: ['caller_name', 'callback_number', 'intent', 'location', 'budget', 'timeline', 'financing', 'property_type', 'preferred_appointment'],
    guardrails: ['Do not promise availability or returns', 'Escalate fair housing questions', 'Confirm consent before follow-up'],
  },
  {
    id: 'preset_restaurant_v1', slug: 'restaurant-reservations', version: 1,
    name: 'Restaurant Reservations', category: 'hospitality', isSystem: true,
    greeting: 'Thank you for calling. I can help with a reservation, opening hours, directions, or a general question.',
    fields: ['caller_name', 'callback_number', 'party_size', 'date', 'time', 'dietary_needs', 'occasion', 'special_requests'],
    guardrails: ['Never confirm unavailable inventory', 'Escalate allergy questions to staff', 'Read back reservation details'],
  },
  {
    id: 'preset_appointment_v1', slug: 'appointment-booking', version: 1,
    name: 'Appointment Booking', category: 'scheduling', isSystem: true,
    greeting: 'Thanks for calling. I can help you schedule, move, or cancel an appointment.',
    fields: ['caller_name', 'callback_number', 'appointment_type', 'preferred_date', 'preferred_time', 'timezone', 'notes'],
    guardrails: ['Confirm timezone', 'Never invent calendar availability', 'Read back the final appointment'],
  },
  {
    id: 'preset_customer_support_v1', slug: 'customer-support', version: 1,
    name: 'Customer Support', category: 'support', isSystem: true,
    greeting: 'Thanks for contacting support. I am an AI assistant. Tell me what happened and I will help or route you to the right person.',
    fields: ['caller_name', 'callback_number', 'account_reference', 'issue_category', 'issue_summary', 'steps_tried', 'preferred_resolution'],
    guardrails: ['Never request passwords or full payment credentials', 'Escalate security incidents', 'Do not promise refunds'],
  },
  {
    id: 'preset_lead_qualification_v1', slug: 'lead-qualification', version: 1,
    name: 'Lead Qualification', category: 'sales', isSystem: true,
    greeting: 'Thanks for your interest. I am an AI assistant. I will ask a few quick questions and help you book the right next step.',
    fields: ['caller_name', 'company', 'callback_number', 'email', 'need', 'budget', 'authority', 'timeline', 'preferred_appointment'],
    guardrails: ['Disclose AI identity', 'Do not make unsupported product claims', 'Respect opt-out requests immediately'],
  },
  {
    id: 'preset_receptionist_v1', slug: 'general-receptionist', version: 1,
    name: 'AI Receptionist', category: 'reception', isSystem: true,
    greeting: 'Thank you for calling. I am the AI receptionist. How may I direct your call today?',
    fields: ['caller_name', 'callback_number', 'reason', 'department', 'urgency', 'message', 'preferred_follow_up'],
    guardrails: ['Disclose AI identity', 'Escalate emergencies', 'Do not reveal private staff or customer information'],
  },
];

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// Pull legacy agents from _legacy/agents.legacy.json or root agents.json (first
// that exists). Returns an array, never throws.
function readLegacyAgents() {
  const candidates = [
    path.join(core.ROOT, '_legacy', 'agents.legacy.json'),
    path.join(core.ROOT, 'agents.json'),
  ];
  for (const f of candidates) {
    try {
      const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(arr) && arr.length) return arr;
    } catch (_) { /* try next */ }
  }
  return [];
}

// Normalize a legacy agent (flat model/speaker/created) into the SPEC shape
// (nested tts object, createdAt ISO), scoped to the given tenant.
function migrateLegacyAgent(legacy, tenantId) {
  const model = legacy.model === 'muga' ? 'muga' : providers.tts.model;
  const speaker = providers.TTS_SPEAKERS.has(legacy.speaker) ? legacy.speaker : 'speaker_1';
  return {
    id: legacy.id || core.genId('ag_'),
    tenantId,
    name: String(legacy.name || 'Untitled Agent').slice(0, 60),
    persona: String(legacy.persona || '').slice(0, 1500),
    tts: {
      provider: providers.tts.id,
      model,
      speaker,
      f0_up_key: Number.isFinite(legacy.f0_up_key) ? legacy.f0_up_key : 0,
    },
    greeting: String(legacy.greeting || '').slice(0, 300),
    telephony: { did: String(legacy.did || providers.telephony.did) },
    createdAt: legacy.created ? new Date(legacy.created).toISOString() : new Date().toISOString(),
  };
}

async function boot() {
  // Force a load so a missing/corrupt db.json resolves to a clean default.
  const existing = core.db();
  await core.mutate((d) => {
    for (const preset of PRESET_LIBRARY) {
      if (!d.presets.some((p) => p.id === preset.id)) d.presets.push({ ...preset, createdAt: new Date().toISOString() });
    }
    for (const agent of d.agents) {
      if (Array.isArray(agent.outcomeSchema) && agent.outcomeSchema.length) continue;
      const preset = agent.presetId ? d.presets.find((item) => item.id === agent.presetId) : null;
      agent.outcomeSchema = normalizeOutcomeSchema(null, (preset && preset.fields) || DEFAULT_OUTCOME_FIELDS);
    }
  });

  const hasDemo = DEMO_EMAIL && existing.users.some((u) => u.email === DEMO_EMAIL);

  if (DEMO_EMAIL && DEMO_PASS.length >= 12 && !hasDemo) {
    const tenantId = core.genId('t_');
    const userId = core.genId('u_');
    const nowIso = new Date().toISOString();
    const legacy = readLegacyAgents();

    await core.mutate((d) => {
      d.tenants.push({
        id: tenantId,
        name: DEMO_TENANT,
        slug: makeSlug(DEMO_TENANT, new Set(d.tenants.map((t) => t.slug))),
        createdAt: nowIso,
        branding: { color: '#6E7BFF' },
        providers: { ...DEFAULT_PROVIDERS },
        plan: 'studio',
        status: 'active', privacyMode: 'standard',
      });
      d.users.push({
        id: userId,
        tenantId,
        email: DEMO_EMAIL,
        name: 'LessRepeat Demo',
        passHash: core.hashPassword(DEMO_PASS),
        role: process.env.TEST_USER_SUPER_ADMIN === 'true' ? 'super_admin' : 'owner', status: 'active',
        createdAt: nowIso,
      });
      d.wallets.push({ id: core.genId('wal_'), tenantId, currency: 'INR', balancePaise: 0, createdAt: nowIso, updatedAt: nowIso });
      addLedgerEntry(d, tenantId, TRIAL_CREDIT_PAISE, 'trial_grant', `trial:${tenantId}`, userId, { amountInr: 10, source: 'test_bootstrap' });
      // Migrate any legacy agents into the demo tenant.
      for (const la of legacy) d.agents.push(migrateLegacyAgent(la, tenantId));
    });

    console.log(`  Seeded env-configured test tenant "${DEMO_TENANT}" with ${legacy.length} migrated agent(s).`);
  }

  // Migrate the old provider selection without rewriting tenant data by hand.
  if (core.db().tenants.some((t) => t.providers && t.providers.telephony === 'voicelink')) {
    await core.mutate((d) => {
      d.tenants.forEach((t) => {
        if (t.providers && t.providers.telephony === 'voicelink') t.providers.telephony = 'vobiz';
      });
    });
  }

  // Fill missing or stale selections from the configured adapter defaults.
  // Existing valid selections remain intact so boot never forces a tenant back
  // to one specific LLM or TTS provider.
  if (core.db().tenants.some((t) => !t.providers || !t.providers.stt || !t.providers.tts || !t.providers.llm || !t.providers.telephony)) {
    await core.mutate((d) => {
      d.tenants.forEach((t) => {
        t.providers = { ...DEFAULT_PROVIDERS, ...(t.providers || {}) };
      });
    });
  }
}

/* ==========================================================================
   Public-facing serialization (never leak passHash, scope to tenant).
   ========================================================================== */
function publicUser(u) {
  return { id: u.id, tenantId: u.tenantId, email: u.email, name: u.name, role: u.role, status: u.status, createdAt: u.createdAt };
}
function publicTenant(t) {
  return {
    id: t.id, name: t.name, slug: t.slug, createdAt: t.createdAt,
    branding: t.branding, providers: t.providers, plan: t.plan,
    status: t.status, privacyMode: t.privacyMode,
  };
}
function agentOutcomeSchema(agent, database = core.db()) {
  const preset = agent && agent.presetId ? (database.presets || []).find((item) => item.id === agent.presetId) : null;
  return normalizeOutcomeSchema(agent && agent.outcomeSchema, (preset && preset.fields) || DEFAULT_OUTCOME_FIELDS);
}
function publicAgent(a) {
  return {
    id: a.id,
    name: a.name,
    persona: a.persona,
    tts: a.tts,
    greeting: a.greeting,
    industry: a.industry || 'general',
    language: a.language || 'en-IN',
    outcomeSchema: agentOutcomeSchema(a),
    telephony: a.telephony,
    presetId: a.presetId || null,

    dograh: a.dograh
      ? {
          workflowId: a.dograh.workflowId,
          status: a.dograh.status
        }
      : null,

    createdAt: a.createdAt
  };
}

// Slugify a company name into a tenant slug, ensuring uniqueness.
function makeSlug(name, taken) {
  const base = String(name || 'tenant').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tenant';
  let slug = base; let n = 2;
  while (taken.has(slug)) { slug = `${base}-${n++}`; }
  return slug;
}

// Bump a usage counter for today for a tenant. field in {chars, calls, llmTokens}.
async function bumpUsage(tenantId, field, amount) {
  const day = todayUtc();
  await core.mutate((d) => {
    let row = d.usage.find((r) => r.tenantId === tenantId && r.day === day);
    if (!row) { row = { tenantId, day, chars: 0, calls: 0, llmTokens: 0 }; d.usage.push(row); }
    row[field] = (row[field] || 0) + amount;
  });
}

function publicWallet(w) {
  return { id: w.id, tenantId: w.tenantId, currency: w.currency, balancePaise: w.balancePaise, balanceInr: w.balancePaise / 100, updatedAt: w.updatedAt };
}

function addLedgerEntry(d, tenantId, amountPaise, type, reference, actorUserId, metadata = {}) {
  const key = String(reference || '');
  if (key && d.ledger.some((x) => x.tenantId === tenantId && x.idempotencyKey === key)) return null;
  let wallet = d.wallets.find((w) => w.tenantId === tenantId);
  const now = new Date().toISOString();
  if (!wallet) {
    wallet = { id: core.genId('wal_'), tenantId, currency: 'INR', balancePaise: 0, createdAt: now, updatedAt: now };
    d.wallets.push(wallet);
  }
  if (!Number.isInteger(amountPaise) || wallet.balancePaise + amountPaise < 0) throw new Error('invalid wallet adjustment');
  wallet.balancePaise += amountPaise;
  wallet.updatedAt = now;
  const entry = { id: core.genId('led_'), tenantId, type, amountPaise, balanceAfterPaise: wallet.balancePaise, idempotencyKey: key || core.genId('idem_'), actorUserId, metadata, createdAt: now };
  d.ledger.push(entry);
  return entry;
}

function addAudit(d, ctx, action, targetType, targetId, metadata = {}) {
  d.auditEvents.push({ id: core.genId('aud_'), tenantId: ctx.tenant.id, actorUserId: ctx.impersonator ? ctx.impersonator.id : ctx.user.id, subjectUserId: ctx.impersonator ? ctx.user.id : null, action, targetType, targetId, metadata, createdAt: new Date().toISOString() });
}

function rejectImpersonated(res, ctx) {
  if (!ctx.impersonator) return false;
  core.sendJson(res, 403, { error: 'This action is blocked while viewing as another user', code: 'impersonation_read_only' });
  return true;
}

/* ==========================================================================
   Auth routes
   ========================================================================== */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INDIAN_VOICE_PROFILE_IDS = new Set(['indian-neutral', 'indian-professional', 'indian-warm', 'hinglish-natural']);

async function apiSignup(req, res, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const name = String(body.name || '').trim().slice(0, 80) || 'Owner';
  const company = String(body.company || '').trim().slice(0, 80) || `${name}'s Workspace`;

  if (!EMAIL_RE.test(email)) return core.sendJson(res, 422, { error: 'valid email required', code: 'bad_email' });
  if (password.length < 12) return core.sendJson(res, 422, { error: 'password must be at least 12 characters', code: 'weak_password' });
  if (core.db().users.some((u) => u.email === email)) {
    return core.sendJson(res, 409, { error: 'an account with this email already exists', code: 'email_taken' });
  }

  const tenantId = core.genId('t_');
  const userId = core.genId('u_');
  const nowIso = new Date().toISOString();
  let tenant; let user;

  await core.mutate((d) => {
    const taken = new Set(d.tenants.map((t) => t.slug));
    tenant = {
      id: tenantId, name: company, slug: makeSlug(company, taken), createdAt: nowIso,
      branding: { color: '#6E7BFF' },
      providers: { ...DEFAULT_PROVIDERS },
      plan: 'studio',
      status: 'active', privacyMode: 'standard',
    };
    user = {
      id: userId, tenantId, email, name,
      passHash: core.hashPassword(password), role: 'owner', status: 'active', createdAt: nowIso,
    };
    d.tenants.push(tenant);
    d.users.push(user);
    d.wallets.push({ id: core.genId('wal_'), tenantId, currency: 'INR', balancePaise: 0, createdAt: nowIso, updatedAt: nowIso });
    addLedgerEntry(d, tenantId, TRIAL_CREDIT_PAISE, 'trial_grant', `trial:${tenantId}`, userId, { amountInr: 10 });
    addAudit(d, { tenant, user }, 'auth.signup', 'tenant', tenantId);
  });

  const token = await core.createSession(userId, tenantId);
  core.send(res, 200, JSON.stringify({ user: publicUser(user), tenant: publicTenant(tenant) }), {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Set-Cookie': core.sessionCookie(token),
  });
}

async function apiLogin(req, res, body) {
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const d = core.db();
  const user = d.users.find((u) => u.email === email);
  // Same generic error whether the user is missing or the password is wrong.
  if (!user || !core.verifyPassword(password, user.passHash)) {
    return core.sendJson(res, 401, { error: 'invalid email or password', code: 'bad_creds' });
  }
  const tenant = d.tenants.find((t) => t.id === user.tenantId);
  if (!tenant || user.status !== 'active' || tenant.status !== 'active') {
    return core.sendJson(res, 401, { error: 'invalid email or password', code: 'bad_creds' });
  }

  const token = await core.createSession(user.id, user.tenantId);
  core.send(res, 200, JSON.stringify({ user: publicUser(user), tenant: publicTenant(tenant) }), {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Set-Cookie': core.sessionCookie(token),
  });
}

async function apiLogout(req, res) {
  await core.destroySession(req);
  core.send(res, 200, JSON.stringify({ ok: true }), {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Set-Cookie': core.clearCookie(),
  });
}

/* ==========================================================================
   Authed routes (ctx = { user, tenant, session, body })
   ========================================================================== */

function apiMe(req, res, ctx) {
  core.send(res, 200, JSON.stringify({ user: publicUser(ctx.user), tenant: publicTenant(ctx.tenant), impersonation: ctx.impersonator ? { actor: publicUser(ctx.impersonator), reason: ctx.session.impersonationReason, expiresAt: new Date(ctx.session.exp).toISOString() } : null }), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
}

function publicCustomVoice(voice) {
  return { id: voice.id, name: voice.name, provider: voice.provider || 'rumik', model: voice.model, speaker: voice.speaker, speed: voice.speed || 1, f0_up_key: voice.f0_up_key, description: voice.description, createdAt: voice.createdAt, updatedAt: voice.updatedAt };
}

function apiCustomVoices(req, res, ctx) {
  const voices = (core.db().customVoices || []).filter((voice) => voice.tenantId === ctx.tenant.id).sort((a, b) => a.name.localeCompare(b.name)).map(publicCustomVoice);
  core.sendJson(res, 200, { voices });
}

async function apiCustomVoiceSave(req, res, ctx) {
  const body = ctx.body || {};
  const name = String(body.name || '').trim().slice(0, 60);
  const normalized = normalizeAgentTts(body);
  const { provider, model, speaker, speed, f0_up_key: f0, description } = normalized;
  if (name.length < 2) return core.sendJson(res, 422, { error: 'voice name must be at least 2 characters', code: 'bad_voice_name' });
  if (provider === 'rumik' && model === 'mulberry' && description.length < 10) return core.sendJson(res, 422, { error: 'add at least 10 characters of voice direction', code: 'bad_voice_description' });
  let voice;
  await core.mutate((database) => {
    const now = new Date().toISOString();
    voice = body.id ? database.customVoices.find((item) => item.id === String(body.id) && item.tenantId === ctx.tenant.id) : null;
    if (voice) Object.assign(voice, { name, provider, model, speaker, speed, f0_up_key: f0, description, updatedAt: now });
    else { voice = { id: core.genId('voice_'), tenantId: ctx.tenant.id, name, provider, model, speaker, speed, f0_up_key: f0, description, createdBy: ctx.user.id, createdAt: now, updatedAt: now }; database.customVoices.push(voice); }
    addAudit(database, ctx, 'custom_voice.saved', 'custom_voice', voice.id, { name: voice.name });
  });
  core.sendJson(res, 200, { voice: publicCustomVoice(voice) });
}

async function apiCustomVoiceDelete(req, res, ctx) {
  const id = String((ctx.body || {}).id || '');
  const voice = (core.db().customVoices || []).find((item) => item.id === id && item.tenantId === ctx.tenant.id);
  if (!voice) return core.sendJson(res, 404, { error: 'custom voice not found', code: 'not_found' });
  await core.mutate((database) => { database.customVoices = database.customVoices.filter((item) => !(item.id === id && item.tenantId === ctx.tenant.id)); addAudit(database, ctx, 'custom_voice.deleted', 'custom_voice', id); });
  core.sendJson(res, 200, { ok: true });
}

function tenantAgencyPrompt(tenantId, database = core.db()) {
  const row = (database.agencyPrompts || []).find((item) => item.tenantId === tenantId);
  return row ? String(row.text || '') : '';
}

function tenantVoiceContext(tenantId, database = core.db()) {
  const agency = tenantAgencyPrompt(tenantId, database);
  const sources = (database.knowledgeItems || [])
    .filter((item) => item.tenantId === tenantId && item.status === 'indexed' && String(item.content || '').trim())
    .slice(0, 30)
    .map((item) => `[${item.name}]\n${String(item.content || '').trim()}`)
    .join('\n\n');
  return [agency, sources ? `Company knowledge, use this only when relevant and never invent missing facts:\n${sources}` : ''].filter(Boolean).join('\n\n').slice(0, 24000);
}

async function syncTenantVoiceWorkflows(tenantId, database = core.db()) {
  const agents = database.agents.filter((agent) => agent.tenantId === tenantId && agent.dograh && Number(agent.dograh.workflowId) > 0);
  const context = tenantVoiceContext(tenantId, database);
  const results = await Promise.allSettled(agents.map((agent) => {
    const configuration = buildAgentConfiguration({ name: agent.name, persona: agent.persona, greeting: agent.greeting, language: agent.language, outcomeSchema: agentOutcomeSchema(agent, database) });
    const definition = buildDograhWorkflowDefinition(configuration, context);
    const updates = [dograh.updateWorkflow(Number(agent.dograh.workflowId), configuration.name, definition, dograhVoiceConfigurations(agent.tts))];
    if (Number.isInteger(Number(agent.dograh.demoWorkflowId)) && Number(agent.dograh.demoWorkflowId) > 0) {
      updates.push(dograh.updateWorkflow(Number(agent.dograh.demoWorkflowId), `${configuration.name} - Demo`, definition, dograhVoiceConfigurations(demoVoiceTts(agent.tts))));
    }
    return Promise.all(updates);
  }));
  const syncedAgents = results.filter((result) => result.status === 'fulfilled').length;
  return { syncedAgents, failedAgents: results.length - syncedAgents };
}

const HVAC_TIMEZONE = 'Asia/Kolkata';
const HVAC_OUTCOMES = new Set(['new', 'booked', 'routed', 'follow_up', 'closed', 'abandoned']);
function calHeaders(version) {
  if (!process.env.CALCOM_API_KEY) throw new providers.ProviderError('Cal.com is not configured', 503, 'calendar_not_configured');
  return { Authorization: `Bearer ${process.env.CALCOM_API_KEY}`, 'cal-api-version': version, Accept: 'application/json' };
}
function calRequest(method, pathname, version, payload) {
  return new Promise((resolve, reject) => {
    const data = payload ? Buffer.from(JSON.stringify(payload)) : null;
    const headers = calHeaders(version);
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = String(data.length); }
    const upstream = require('https').request({ host: 'api.cal.com', path: pathname, method, headers }, (resp) => {
      const parts = []; resp.on('data', (part) => parts.push(part)); resp.on('end', () => {
        let body = {}; try { body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch (_) {}
        if (resp.statusCode < 200 || resp.statusCode >= 300) return reject(new providers.ProviderError(body.message || body.error || 'Cal.com request failed', resp.statusCode || 502, 'calendar_upstream'));
        resolve(body);
      });
    });
    upstream.on('error', reject); upstream.setTimeout(20000, () => upstream.destroy(new Error('Cal.com timeout')));
    if (data) upstream.write(data); upstream.end();
  });
}
function tenantHvacJobs(tenantId) { return core.db().hvacJobs.filter((job) => job.tenantId === tenantId); }
function publicHvacJob(job) { return { id: job.id, callerName: job.callerName, phone: job.phone, email: job.email || '', service: job.service, urgency: job.urgency, outcome: job.outcome, assignedTo: job.assignedTo || '', notes: job.notes || '', appointment: job.appointment || null, createdAt: job.createdAt, updatedAt: job.updatedAt }; }
function apiHvacDesk(req, res, ctx) {
  const jobs = tenantHvacJobs(ctx.tenant.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const count = (outcome) => jobs.filter((job) => job.outcome === outcome).length;
  core.sendJson(res, 200, { timezone: HVAC_TIMEZONE, calendarConfigured: Boolean(process.env.CALCOM_API_KEY), jobs: jobs.map(publicHvacJob), stats: { calls: jobs.length, booked: count('booked'), routed: count('routed'), followUp: count('follow_up') } });
}
async function apiHvacEventTypes(req, res) {
  try { const result = await calRequest('GET', '/v2/event-types', '2024-06-14'); core.sendJson(res, 200, { eventTypes: (result.data || []).map((event) => ({ id: event.id, title: event.title, slug: event.slug, lengthInMinutes: event.lengthInMinutes, locations: event.locations || [] })) }); }
  catch (e) { handleProviderError(res, e); }
}
async function apiHvacSlots(req, res) {
  try {
    const q = new URL(req.url, 'http://local').searchParams; const eventTypeId = Number(q.get('eventTypeId')); const start = String(q.get('start') || ''); const end = String(q.get('end') || '');
    if (!Number.isInteger(eventTypeId) || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return core.sendJson(res, 422, { error: 'event type and date range required', code: 'bad_calendar_query' });
    const result = await calRequest('GET', `/v2/slots?eventTypeId=${eventTypeId}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&timeZone=${encodeURIComponent(HVAC_TIMEZONE)}&format=range`, '2024-09-04');
    core.sendJson(res, 200, { timezone: HVAC_TIMEZONE, slots: result.data || {} });
  } catch (e) { handleProviderError(res, e); }
}
async function apiHvacJobSave(req, res, ctx) {
  const b = ctx.body || {}; const callerName = String(b.callerName || '').trim().slice(0, 100); const phone = String(b.phone || '').trim().slice(0, 32);
  if (!callerName || !phone) return core.sendJson(res, 422, { error: 'caller name and phone are required', code: 'missing_contact' });
  const outcome = HVAC_OUTCOMES.has(b.outcome) ? b.outcome : 'new'; const now = new Date().toISOString(); let job;
  await core.mutate((d) => {
    job = b.id ? d.hvacJobs.find((item) => item.id === String(b.id) && item.tenantId === ctx.tenant.id) : null;
    if (!job) { job = { id: core.genId('hvac_'), tenantId: ctx.tenant.id, createdAt: now, appointment: null }; d.hvacJobs.push(job); }
    Object.assign(job, { callerName, phone, email: String(b.email || '').trim().slice(0, 180), service: String(b.service || 'General HVAC').trim().slice(0, 80), urgency: String(b.urgency || 'normal').trim().slice(0, 30), outcome, assignedTo: String(b.assignedTo || '').trim().slice(0, 80), notes: String(b.notes || '').trim().slice(0, 2000), updatedAt: now });
    addAudit(d, ctx, 'hvac.job.saved', 'hvac_job', job.id, { outcome: job.outcome });
  });
  core.sendJson(res, 200, { job: publicHvacJob(job) });
}
async function apiHvacBook(req, res, ctx) {
  const b = ctx.body || {}; const eventTypeId = Number(b.eventTypeId); const start = String(b.start || ''); const attendee = b.attendee || {};
  if (!Number.isInteger(eventTypeId) || Number(eventTypeId) <= 0 || !/^\d{4}-\d{2}-\d{2}T/.test(start)) return core.sendJson(res, 422, { error: 'event type and appointment time are required', code: 'bad_booking' });
  const name = String(attendee.name || '').trim(); const email = String(attendee.email || '').trim().toLowerCase(); const phone = String(attendee.phone || '').trim();
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !phone) return core.sendJson(res, 422, { error: 'attendee name, email and phone are required for Cal.com booking', code: 'missing_booking_contact' });
  try {
    const booking = await calRequest('POST', '/v2/bookings', '2026-02-25', { eventTypeId, start: new Date(start).toISOString(), attendee: { name, email, phoneNumber: phone, timeZone: HVAC_TIMEZONE, language: 'en' }, metadata: { source: 'rumik_hvac_desk', service: String(b.service || 'General HVAC').slice(0, 80), urgency: String(b.urgency || 'normal').slice(0, 30), jobId: String(b.jobId || '') } });
    const now = new Date().toISOString(); let job;
    await core.mutate((d) => {
      job = b.jobId ? d.hvacJobs.find((item) => item.id === String(b.jobId) && item.tenantId === ctx.tenant.id) : null;
      if (!job) { job = { id: core.genId('hvac_'), tenantId: ctx.tenant.id, callerName: name, phone, email, service: String(b.service || 'General HVAC').slice(0, 80), urgency: String(b.urgency || 'normal').slice(0, 30), assignedTo: '', notes: '', createdAt: now }; d.hvacJobs.push(job); }
      job.outcome = 'booked'; job.updatedAt = now; job.appointment = { calBookingUid: booking.data && booking.data.uid, eventTypeId, start: booking.data && booking.data.start, end: booking.data && booking.data.end, status: booking.data && booking.data.status, timezone: HVAC_TIMEZONE };
      addAudit(d, ctx, 'hvac.booking.created', 'hvac_job', job.id, { eventTypeId, bookingUid: job.appointment.calBookingUid || '' });
    });
    core.sendJson(res, 201, { booking: booking.data, job: publicHvacJob(job) });
  } catch (e) { handleProviderError(res, e); }
}

function apiAgentsList(req, res, ctx) {
  const agents = core.db().agents
    .filter((a) => a.tenantId === ctx.tenant.id)
    .map(publicAgent);
  core.sendJson(res, 200, { agents });
}

async function apiAgentsCreate(req, res, ctx) {
  const b = ctx.body || {};

  const preset = b.presetId
    ? core.db().presets.find(
        (p) =>
          p.id === String(b.presetId) &&
          (p.isSystem || p.tenantId === ctx.tenant.id)
      )
    : null;

  if (b.presetId && !preset) {
    return core.sendJson(res, 404, {
      error: 'preset not found',
      code: 'not_found'
    });
  }

  const normalizedTts = normalizeAgentTts(b.tts);
  const customVoice = (core.db().customVoices || []).find((voice) => voice.id === normalizedTts.customVoiceId && voice.tenantId === ctx.tenant.id);
  if (customVoice) Object.assign(normalizedTts, normalizeAgentTts(customVoice, normalizedTts), { customVoiceId: customVoice.id });

  const configuration = buildAgentConfiguration(b, preset);
  let dograhWorkflow;
  let dograhEmbed;
  try {
    dograhWorkflow = await dograh.createWorkflow(
      configuration.name,
      buildDograhWorkflowDefinition(configuration, tenantVoiceContext(ctx.tenant.id))
    );
    if (['kokoro', 'gemini_tts'].includes(normalizedTts.provider)) {
      dograhWorkflow = await dograh.updateWorkflow(
        dograhWorkflow.id,
        configuration.name,
        buildDograhWorkflowDefinition(configuration, tenantVoiceContext(ctx.tenant.id)),
        dograhVoiceConfigurations(normalizedTts)
      );
    }
    dograhEmbed = await dograh.createEmbedToken(dograhWorkflow.id, { expiresInDays: 30 });
  } catch (error) {
    console.error('Dograh provisioning failed:', error.message || 'unknown error');
    return core.sendJson(res, 502, {
      error: error.message || 'Failed to provision Dograh agent',
      code: 'dograh_provision_failed'
    });
  }

  const agent = {
    id: core.genId('ag_'),
    tenantId: ctx.tenant.id,

    name: configuration.name,
    persona: configuration.persona,

    tts: { ...normalizedTts, customVoiceId: customVoice ? customVoice.id : '' },

    greeting: configuration.greeting,

    industry: String(b.industry || (preset && preset.category) || 'general').trim().slice(0, 50),
    language: String(b.language || 'en-IN').trim().slice(0, 20),

    presetId: preset ? preset.id : null,

    outcomeSchema: configuration.outcomeSchema,

    telephony: {
      did:
        String(
          b.did ||
          providers.telephony.did
        ).replace(/[^0-9]/g, '') ||
        providers.telephony.did
    },

    dograh: {
      workflowId: dograhWorkflow.id,
      status: dograhWorkflow.status || 'active',
      embedToken: dograhEmbed.token
    },

    createdAt: new Date().toISOString()
  };

  await core.mutate((d) => {
    d.agents.push(agent);
  });

  core.sendJson(res, 200, {
    agent: publicAgent(agent)
  });
}

async function apiAgentsUpdate(req, res, ctx) {
  const b = ctx.body || {};
  const id = String(b.id || '');
  const d = core.db();
  const agent = d.agents.find((a) => a.id === id);
  if (!agent) return core.sendJson(res, 404, { error: 'agent not found', code: 'not_found' });
  if (agent.tenantId !== ctx.tenant.id) {
    return core.sendJson(res, 403, { error: 'not your agent', code: 'forbidden' });
  }
  const preset = agent.presetId
    ? d.presets.find((p) => p.id === agent.presetId && (p.isSystem || p.tenantId === ctx.tenant.id))
    : null;
  const configuration = buildAgentConfiguration({
    name: b.name != null ? b.name : agent.name,
    persona: b.persona != null ? b.persona : agent.persona,
    greeting: b.greeting != null ? b.greeting : agent.greeting,
    language: b.language != null ? b.language : agent.language,
    outcomeSchema: b.outcomeSchema != null ? b.outcomeSchema : agent.outcomeSchema,
  }, preset);
  const nextTts = normalizeAgentTts(b.tts, agent.tts || {});
  const selectedCustomVoice = (d.customVoices || []).find((voice) => voice.id === nextTts.customVoiceId && voice.tenantId === ctx.tenant.id);
  if (selectedCustomVoice) Object.assign(nextTts, normalizeAgentTts(selectedCustomVoice, nextTts), { customVoiceId: selectedCustomVoice.id });
  else nextTts.customVoiceId = '';
  const dograhBehaviorChanged = b.name != null || b.persona != null || b.greeting != null || b.language != null || b.outcomeSchema != null || (b.tts && typeof b.tts === 'object');
  if (dograhBehaviorChanged && agent.dograh && Number.isInteger(Number(agent.dograh.workflowId)) && Number(agent.dograh.workflowId) > 0) {
    try {
      await dograh.updateWorkflow(
        Number(agent.dograh.workflowId),
        configuration.name,
        buildDograhWorkflowDefinition(configuration, tenantVoiceContext(ctx.tenant.id, d)),
        dograhVoiceConfigurations(nextTts)
      );
      if (Number.isInteger(Number(agent.dograh.demoWorkflowId)) && Number(agent.dograh.demoWorkflowId) > 0) {
        await dograh.updateWorkflow(
          Number(agent.dograh.demoWorkflowId),
          `${configuration.name} - Demo`,
          buildDograhWorkflowDefinition(configuration, tenantVoiceContext(ctx.tenant.id, d)),
          dograhVoiceConfigurations(demoVoiceTts(nextTts))
        );
      }
    } catch (error) {
      console.error('Dograh synchronization failed:', error.message || 'unknown error');
      return core.sendJson(res, 502, {
        error: error.message || 'Failed to synchronize Dograh agent',
        code: 'dograh_sync_failed'
      });
    }
  }
  let updated;
  await core.mutate((dd) => {
    const a = dd.agents.find((x) => x.id === id);
    a.name = configuration.name;
    a.persona = configuration.persona;
    a.greeting = configuration.greeting;
    a.outcomeSchema = configuration.outcomeSchema;
    if (b.industry != null) a.industry = String(b.industry || 'general').trim().slice(0, 50);
    if (b.language != null) a.language = String(b.language || 'en-IN').trim().slice(0, 20);
    if (b.did != null) {
      const did = String(b.did).replace(/[^0-9]/g, '');
      a.telephony = { ...(a.telephony || {}), did: did || providers.telephony.did };
    }
    if (b.tts && typeof b.tts === 'object') a.tts = nextTts;
    updated = a;
  });
  core.sendJson(res, 200, { agent: publicAgent(updated) });
}

async function apiAgentsDelete(req, res, ctx) {
  const id = String((ctx.body || {}).id || '');
  const agent = core.db().agents.find((a) => a.id === id);
  if (!agent) return core.sendJson(res, 404, { error: 'agent not found', code: 'not_found' });
  if (agent.tenantId !== ctx.tenant.id) {
    return core.sendJson(res, 403, { error: 'not your agent', code: 'forbidden' });
  }
  const dograhWorkflowIds = [...new Set([
    Number(agent.dograh && agent.dograh.workflowId),
    Number(agent.dograh && agent.dograh.demoWorkflowId),
  ].filter((workflowId) => Number.isInteger(workflowId) && workflowId > 0))];
  if (dograhWorkflowIds.length) {
    try {
      await Promise.all(dograhWorkflowIds.map((workflowId) => dograh.updateWorkflowStatus(workflowId, 'archived')));
    } catch (error) {
      console.error('Dograh archival failed:', error.message || 'unknown error');
      return core.sendJson(res, 502, {
        error: error.message || 'Failed to archive Dograh agent',
        code: 'dograh_archive_failed'
      });
    }
  }
  await core.mutate((database) => { database.agents = database.agents.filter((a) => a.id !== id); });
  core.sendJson(res, 200, { ok: true });
}

// POST /api/tts -> Rumik WAV bytes. Increments tenant usage.chars.
async function apiTts(req, res, ctx) {
  const b = ctx.body || {};
  try {
    const selected = providers.resolveSelection('tts', { provider: b.provider, model: b.model });
    const out = await selected.adapter.synthesize({
      text: b.text,
      model: selected.model,
      speaker: b.speaker,
      speed: b.speed,
      f0_up_key: b.f0_up_key,
      description: b.description,
    });
    // Count usage only on a real synthesis.
    bumpUsage(ctx.tenant.id, 'chars', out.chars).catch(() => {});
    core.send(res, 200, out.buffer, {
      'Content-Type': 'audio/wav',
      'Content-Length': out.buffer.length,
      'X-Credits-Used': out.credits,
      'X-Chars': String(out.chars),
    });
  } catch (e) {
    handleProviderError(res, e);
  }
}

function internalCredentialMatches(value) {
  const actual = Buffer.from(String(value || ''));
  const expected = Buffer.from(`Bearer ${GEMINI_TTS_PROXY_KEY}`);
  return actual.length === expected.length && actual.length > 7 && crypto.timingSafeEqual(actual, expected);
}

async function apiInternalGeminiTts(req, res, body) {
  if (!GEMINI_TTS_PROXY_KEY || !internalCredentialMatches(req.headers.authorization)) {
    return core.sendJson(res, 401, { error: 'invalid internal TTS credential', code: 'unauthorized' });
  }
  try {
    const selected = providers.resolveSelection('tts', { provider: 'gemini_tts', model: body && body.model });
    const out = await selected.adapter.synthesize({
      text: body && body.input,
      model: selected.model,
      speaker: body && body.voice,
    });
    core.send(res, 200, out.buffer, {
      'Content-Type': 'audio/wav',
      'Content-Length': out.buffer.length,
      'Cache-Control': 'no-store',
    });
  } catch (error) {
    handleProviderError(res, error);
  }
}

// POST /api/ws-connect -> { ws_url, token } (Rumik streaming mint).
async function apiWsConnect(req, res, ctx) {
  const b = ctx.body || {};
  try {
    const selected = providers.resolveSelection('tts', { provider: b.provider, model: b.model });
    const data = await selected.adapter.wsConnect({ text: b.text, model: selected.model });
    core.sendJson(res, 200, { ...data, provider: selected.provider, model: selected.model });
  } catch (e) {
    handleProviderError(res, e);
  }
}

// POST /api/chat -> { text, finish, provider, model, latency_ms } (Groq brain).
async function apiChat(req, res, ctx) {
  const b = ctx.body || {};
  try {
    const selected = providers.resolveSelection('llm', { provider: b.provider, model: b.model });
    const out = await selected.adapter.chat({ messages: b.messages, system: b.system, model: selected.model });
    // Rough token accounting for the usage view (4 chars ~= 1 token).
    const approxTokens = Math.ceil((out.text || '').length / 4);
    bumpUsage(ctx.tenant.id, 'llmTokens', approxTokens).catch(() => {});
    core.sendJson(res, 200, out);
  } catch (e) {
    handleProviderError(res, e);
  }
}

// POST /api/stt -> { text, provider, model, latency_ms } (Deepgram Nova-3).
async function apiStt(req, res, ctx) {
  const b = ctx.body || {};
  try {
    const out = await providers.stt.transcribe({ audio: b.audio, mime: b.mime });
    core.sendJson(res, 200, out);
  } catch (e) {
    handleProviderError(res, e);
  }
}

async function mintDograhVoiceSession(req, context) {
  const token = String(context.embedToken || '').trim();
  const base = String(process.env.DOGRAH_BASE_URL || '').replace(/\/$/, '');
  if (!token || !base) {
    const error = new Error('realtime voice session is not configured');
    error.status = 503; error.code = 'voice_session_unavailable'; throw error;
  }
  const requestOrigin = String(req.headers.origin || `https://${req.headers.host || ''}`);
  const upstream = await fetch(base + '/api/v1/public/embed/init', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: requestOrigin },
    body: JSON.stringify({ token, context_variables: {
      source: String(context.source || 'rumik_studio'),
      tenant_id: String(context.tenantId || ''),
      agent_id: String(context.agentId || ''),
      demo_link_id: String(context.demoLinkId || ''),
      max_session_seconds: String(context.maxSessionSeconds || ''),
    } }),
    signal: AbortSignal.timeout(12000),
  });
  const text = await upstream.text(); let data = {};
  try { data = JSON.parse(text); } catch (_) {}
  if (!upstream.ok) {
    const error = new Error(String(data.detail || 'Dograh could not start the realtime voice session'));
    error.status = upstream.status; error.code = 'voice_session_failed'; throw error;
  }
  const sessionToken = String(data.session_token || '');
  let turnCredentials = null;
  if (sessionToken) {
    try {
      const turnUpstream = await fetch(base + '/api/v1/public/embed/turn-credentials/' + encodeURIComponent(sessionToken), {
        method: 'GET', headers: { Origin: requestOrigin }, signal: AbortSignal.timeout(8000),
      });
      if (turnUpstream.ok) {
        const turnData = await turnUpstream.json();
        if (Array.isArray(turnData.uris) && turnData.uris.length && turnData.username && turnData.password) {
          turnCredentials = {
            uris: turnData.uris,
            username: String(turnData.username),
            password: String(turnData.password),
            ttl: Number(turnData.ttl || 0),
          };
        }
      }
    } catch (_) {}
  }
  return {
    sessionToken: data.session_token, workflowRunId: data.workflow_run_id,
    workflowId: data.config && data.config.workflow_id,
    signalingUrl: base.replace(/^http/, 'ws') + '/api/v1/ws/public/signaling/' + encodeURIComponent(data.session_token),
    turnCredentials,
    runtime: 'Dograh SmallWebRTC',
  };
}

async function apiVoiceSession(req, res, ctx) {
  const agentId = String((ctx.body || {}).agentId || '');
  const agent = core.db().agents.find((a) => a.id === agentId && a.tenantId === ctx.tenant.id);
  if (!agent) {
    return core.sendJson(res, 404, { error: 'agent not found', code: 'not_found' });
  }
  try {
    let embedToken = agent.dograh && agent.dograh.embedToken;
    const workflowId = Number(agent.dograh && agent.dograh.workflowId);
    if (!embedToken && Number.isInteger(workflowId) && workflowId > 0) {
      const embed = await dograh.createEmbedToken(workflowId, { expiresInDays: 30 });
      embedToken = embed && embed.token;
      if (embedToken) await core.mutate((database) => {
        const target = database.agents.find((item) => item.id === agent.id && item.tenantId === ctx.tenant.id);
        if (target) target.dograh = { ...(target.dograh || {}), embedToken };
      });
    }
    const session = await mintDograhVoiceSession(req, {
      source: 'agent_test', tenantId: ctx.tenant.id, agentId: agent.id, embedToken,
    });
    core.sendJson(res, 200, { ...session, voiceTransport: agent.tts && ['kokoro', 'gemini_tts'].includes(agent.tts.provider) ? 'dograh' : 'browser' });
  } catch (error) {
    core.sendJson(res, error.status || 502, { error: error.message || 'Dograh realtime voice session failed', code: error.code || 'voice_session_failed' });
  }
}

function tenantDemoLinks(tenantId) {
  return core.db().demoLinks.filter((link) => link.tenantId === tenantId);
}

const nativeDemoProvisioning = new Map();

async function ensureNativeDemoBinding(agent, tenantId) {
  const currentWorkflowId = Number(agent.dograh && agent.dograh.demoWorkflowId);
  const currentToken = String((agent.dograh && agent.dograh.demoEmbedToken) || '');
  const voiceSignature = demoVoiceSignature(agent.tts);
  if (Number.isInteger(currentWorkflowId) && currentWorkflowId > 0 && currentToken && agent.dograh.demoVoice === voiceSignature) {
    return { workflowId: currentWorkflowId, embedToken: currentToken };
  }
  if (nativeDemoProvisioning.has(agent.id)) return nativeDemoProvisioning.get(agent.id);

  const task = (async () => {
    const configuration = buildAgentConfiguration({
      name: agent.name,
      persona: agent.persona,
      greeting: agent.greeting,
      language: agent.language,
      outcomeSchema: agentOutcomeSchema(agent),
    });
    const definition = buildDograhWorkflowDefinition(configuration, tenantVoiceContext(tenantId));
    let workflowId = currentWorkflowId;
    if (!Number.isInteger(workflowId) || workflowId <= 0) {
      const workflow = await dograh.createWorkflow(
        `${configuration.name} - Demo`,
        definition
      );
      workflowId = Number(workflow.id);
    }
    await dograh.updateWorkflow(
      workflowId,
      `${configuration.name} - Demo`,
      definition,
      dograhVoiceConfigurations(demoVoiceTts(agent.tts))
    );
    let embedToken = currentToken;
    if (!embedToken) {
      const embed = await dograh.createEmbedToken(workflowId, { expiresInDays: 30 });
      embedToken = String((embed && embed.token) || '');
    }
    if (!embedToken) throw new Error('Dograh did not return a Demo embed token');

    await core.mutate((database) => {
      const target = database.agents.find((item) => item.id === agent.id && item.tenantId === tenantId);
      if (target) target.dograh = {
        ...(target.dograh || {}),
        demoWorkflowId: workflowId,
        demoEmbedToken: embedToken,
        demoVoice: voiceSignature,
      };
    });
    return { workflowId, embedToken };
  })();

  nativeDemoProvisioning.set(agent.id, task);
  try {
    return await task;
  } finally {
    nativeDemoProvisioning.delete(agent.id);
  }
}

function apiDemoLinksList(req, res, ctx) {
  const links = tenantDemoLinks(ctx.tenant.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((link) => {
      const token = demoLinks.openDemoToken(link.tokenCiphertext, DEMO_LINK_ENCRYPTION_KEY);
      return { ...demoLinks.publicDemoLink(link), sharePath: token ? `/demo/${token}` : '' };
    });
  core.sendJson(res, 200, { demoLinks: links });
}

async function apiDemoLinksCreate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  if (DEMO_LINK_ENCRYPTION_KEY.length < 32) {
    return core.sendJson(res, 503, { error: 'Demo link encryption is not configured', code: 'demo_encryption_unavailable' });
  }
  const body = ctx.body || {};
  const agent = core.db().agents.find((item) => item.id === String(body.agentId || '') && item.tenantId === ctx.tenant.id);
  if (!agent) return core.sendJson(res, 404, { error: 'agent not found', code: 'not_found' });
  try {
    await ensureNativeDemoBinding(agent, ctx.tenant.id);
  } catch (error) {
    console.error('Dograh Demo provisioning failed:', error.message || 'unknown error');
    return core.sendJson(res, 502, {
      error: error.message || 'Failed to provision the Dograh Demo voice',
      code: 'dograh_demo_provision_failed',
    });
  }
  const generated = demoLinks.createDemoToken();
  const limits = demoLinks.normalizeDemoLimits(body);
  const link = {
    id: generated.id, tokenHash: generated.tokenHash,
    tokenCiphertext: demoLinks.sealDemoToken(generated.token, DEMO_LINK_ENCRYPTION_KEY),
    tenantId: ctx.tenant.id, agentId: agent.id,
    label: String(body.label || `${agent.name} demo`).trim().slice(0, 80) || `${agent.name} demo`,
    status: 'active', starts: 0, createdBy: ctx.user.id, createdAt: new Date().toISOString(),
    ...limits,
  };
  await core.mutate((database) => {
    database.demoLinks.push(link);
    addAudit(database, ctx, 'demo_link.created', 'demo_link', link.id, { agentId: agent.id, expiresAt: link.expiresAt, maxStarts: link.maxStarts });
  });
  core.sendJson(res, 201, { demoLink: demoLinks.publicDemoLink(link), sharePath: `/demo/${generated.token}` });
}

async function apiDemoLinksRevoke(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const id = String((ctx.body || {}).id || '');
  const link = core.db().demoLinks.find((item) => item.id === id && item.tenantId === ctx.tenant.id);
  if (!link) return core.sendJson(res, 404, { error: 'demo link not found', code: 'not_found' });
  await core.mutate((database) => {
    const target = database.demoLinks.find((item) => item.id === id && item.tenantId === ctx.tenant.id);
    target.status = 'revoked'; target.revokedAt = new Date().toISOString(); target.revokedBy = ctx.user.id;
    addAudit(database, ctx, 'demo_link.revoked', 'demo_link', id, { agentId: target.agentId });
  });
  core.sendJson(res, 200, { ok: true });
}

function publicDemoContext(token) {
  const database = core.db();
  const link = demoLinks.findDemoLink(database, token);
  if (!link) return null;
  const tenant = database.tenants.find((item) => item.id === link.tenantId && item.status === 'active');
  const agent = database.agents.find((item) => item.id === link.agentId && item.tenantId === link.tenantId);
  if (!tenant || !agent) return null;
  const color = String((tenant.branding || {}).color || '#B88A2D');
  return { link, tenant, agent, color: /^#[0-9A-Fa-f]{6}$/.test(color) ? color : '#B88A2D' };
}

function apiPublicDemoMeta(req, res, token) {
  const context = publicDemoContext(token);
  if (!context) return core.sendJson(res, 404, { error: 'demo link not found', code: 'not_found' });
  const status = demoLinks.demoLinkStatus(context.link);
  core.sendJson(res, 200, {
    demo: { id: context.link.id, label: context.link.label, status, expiresAt: context.link.expiresAt, maxSessionSeconds: context.link.maxSessionSeconds },
    brand: { name: context.tenant.name, color: context.color },
    agent: {
      name: context.agent.name,
      greeting: String(context.agent.greeting || '').slice(0, 300),
      voice: { provider: 'dograh', speaker: 'default', label: 'Dograh default' },
    },
  });
}

async function apiPublicDemoSession(req, res, token) {
  const context = publicDemoContext(token);
  if (!context) return core.sendJson(res, 404, { error: 'demo link not found', code: 'not_found' });
  let reserved = false;
  try {
    const demoBinding = await ensureNativeDemoBinding(context.agent, context.tenant.id);
    await core.mutate((database) => {
      const target = database.demoLinks.find((item) => item.id === context.link.id);
      const status = demoLinks.demoLinkStatus(target);
      if (status !== 'active') {
        const error = new Error(`this demo link is ${status}`);
        error.status = 410; error.code = `demo_${status}`; throw error;
      }
      target.starts = Number(target.starts || 0) + 1;
      target.lastStartedAt = new Date().toISOString();
      reserved = true;
    });
   const session = await mintDograhVoiceSession(req, {
      source: 'public_demo',
      tenantId: context.tenant.id,
      agentId: context.agent.id,
      demoLinkId: context.link.id,
      maxSessionSeconds: context.link.maxSessionSeconds,
      embedToken: demoBinding.embedToken,
    });
    core.sendJson(res, 200, { ...session, maxSessionSeconds: context.link.maxSessionSeconds, voiceTransport: 'dograh' });
  } catch (error) {
    if (reserved) await core.mutate((database) => {
      const target = database.demoLinks.find((item) => item.id === context.link.id);
      if (target) target.starts = Math.max(0, Number(target.starts || 0) - 1);
    }).catch(() => {});
    core.sendJson(res, error.status || 502, { error: error.message || 'realtime demo failed', code: error.code || 'voice_session_failed' });
  }
}

// GET /api/telephony/status -> VoBiz configuration status from Dograh.
async function apiTelephonyStatus(req, res) {
  try {
    const status = await providers.telephony.status();
    core.sendJson(res, 200, { ...status, provider: 'vobiz', orchestrator: 'dograh' });
  } catch (e) {
    handleProviderError(res, e);
  }
}

// POST /api/telephony/dial -> places a REAL paid call. GUARDED behind confirm.
async function apiTelephonyDial(req, res, ctx) {
  const b = ctx.body || {};
  if (b.confirm !== true) {
    return core.sendJson(res, 400, {
      error: 'confirm required: this places a REAL paid call',
      code: 'needs_confirm',
    });
  }
  const agent = core.db().agents.find((item) => item.id === String(b.agentId || '') && item.tenantId === ctx.tenant.id);
  if (!agent) {
    return core.sendJson(res, 404, { error: 'agent not found', code: 'not_found' });
  }
  let workflowId = Number(agent.dograh && agent.dograh.workflowId);
  if (!Number.isInteger(workflowId) || workflowId <= 0) {
    return core.sendJson(res, 409, {
      error: 'the selected agent does not have a provisioned Dograh workflow',
      code: 'agent_workflow_required',
    });
  }
  if (ctx.tenant.privacyMode === 'no_recording') {
    workflowId = Number(process.env.DOGRAH_NO_RECORDING_WORKFLOW_ID || 0);
    if (!Number.isInteger(workflowId) || workflowId <= 0) {
      return core.sendJson(res, 409, {
        error: 'HIPAA mode blocks phone calls until a verified no-recording Dograh workflow is configured',
        code: 'privacy_workflow_required',
      });
    }
  }
  try {
    const r = await providers.telephony.dial(b.number, { workflowId });
    // Count the dial attempt against today's usage.
    bumpUsage(ctx.tenant.id, 'calls', 1).catch(() => {});
    core.sendJson(res, r.status, r.data);
  } catch (e) {
    handleProviderError(res, e);
  }
}

// GET /api/usage -> tenant scoped daily rows + totals, with a rough INR cost.
function apiUsage(req, res, ctx) {
  const rows = core.db().usage
    .filter((u) => u.tenantId === ctx.tenant.id)
    .sort((a, b) => (a.day < b.day ? -1 : 1));
  // Economics estimate for the promotional AI layer. Telephony and other
  // carrier-inclusive costs are tracked separately and are not implied here.
  const INR_PER_1K_CHARS = 0.12;
  const INR_PER_CALL = 0.9;
  const days = rows.map((r) => ({
    day: r.day,
    chars: r.chars || 0,
    calls: r.calls || 0,
    llmTokens: r.llmTokens || 0,
    costInr: Math.round(((r.chars || 0) / 1000 * INR_PER_1K_CHARS + (r.calls || 0) * INR_PER_CALL) * 100) / 100,
  }));
  const totals = days.reduce((acc, d) => ({
    chars: acc.chars + d.chars,
    calls: acc.calls + d.calls,
    llmTokens: acc.llmTokens + d.llmTokens,
    costInr: Math.round((acc.costInr + d.costInr) * 100) / 100,
  }), { chars: 0, calls: 0, llmTokens: 0, costInr: 0 });
  core.sendJson(res, 200, { days, totals });
}

function apiPresets(req, res, ctx) {
  const presets = core.db().presets.filter((p) => p.isSystem || p.tenantId === ctx.tenant.id);
  core.sendJson(res, 200, { presets });
}

function apiWallet(req, res, ctx) {
  const d = core.db();
  const wallet = d.wallets.find((w) => w.tenantId === ctx.tenant.id);
  const ledger = d.ledger.filter((x) => x.tenantId === ctx.tenant.id).slice(-100).reverse();
  core.sendJson(res, 200, { wallet: publicWallet(wallet || { id: null, tenantId: ctx.tenant.id, currency: 'INR', balancePaise: 0 }), ledger });
}

function apiPaymentIntents(req, res, ctx) {
  const intents = core.db().paymentIntents.filter((x) => x.tenantId === ctx.tenant.id).map((x) => ({ ...x, gatewayPayload: undefined, intentToken: undefined, customer: undefined }));
  core.sendJson(res, 200, { paymentIntents: intents });
}

async function apiPaymentIntentCreate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const packId = String(b.packId || '');
  let base;
  try { base = payu.createPaymentIntent({ packId, packs: CREDIT_PACKS, tenantId: ctx.tenant.id, userId: ctx.user.id }); }
  catch (e) { return core.sendJson(res, 422, { error: e.message, code: 'bad_pack' }); }
  const customer = { firstname: String(b.firstname || ctx.user.name || 'Customer').trim().slice(0, 60), email: ctx.user.email, phone: String(b.phone || '').trim().slice(0, 20) };
  const intent = { id: core.genId('pay_'), provider: 'payu', ...base, customer, amountPaise: Math.round(Number(base.amount) * 100), updatedAt: base.createdAt };
  let checkout = null; const cfg = payuConfig();
  if (cfg && process.env.RAPIDX_PUBLIC_URL) {
    try {
      const origin = String(process.env.RAPIDX_PUBLIC_URL).replace(/\/$/, '');
      checkout = payu.buildCheckout({ intent, customer, successUrl: `${origin}/api/payu/callback`, failureUrl: `${origin}/api/payu/return`, config: cfg });
    } catch (e) { return core.sendJson(res, 503, { error: 'PayU checkout configuration is invalid', code: 'payu_config' }); }
  }
  await core.mutate((d) => { d.paymentIntents.push(intent); addAudit(d, ctx, 'billing.payment_intent.created', 'payment_intent', intent.id, { packId, amountPaise: intent.amountPaise }); });
  core.sendJson(res, 201, { paymentIntent: { ...intent, intentToken: undefined, customer: undefined }, checkoutReady: !!checkout, checkout, message: checkout ? undefined : 'PayU is not configured. The intent is saved but cannot be paid yet.' });
}

async function apiPayuCallback(req, res, payload) {
  const cfg = payuConfig();
  if (!cfg) return core.sendJson(res, 503, { error: 'PayU is not configured', code: 'payu_unavailable' });
  const intent = core.db().paymentIntents.find((x) => x.txnid === String(payload.txnid || ''));
  const eventId = core.genId('pevt_');
  const safePayload = Object.fromEntries(Object.entries(payload || {}).filter(([k]) => !/hash|salt|key|card|token/i.test(k)).map(([k, v]) => [k, String(v).slice(0, 500)]));
  if (!intent) {
    await core.mutate((d) => d.paymentEvents.push({ id: eventId, provider: 'payu', txnid: String(payload.txnid || ''), status: 'rejected', reason: 'intent_not_found', payload: safePayload, createdAt: new Date().toISOString() }));
    return core.sendJson(res, 404, { error: 'payment intent not found', code: 'not_found' });
  }
  const callback = payu.verifyCallback({ payload, intent, customer: intent.customer, config: cfg });
  await core.mutate((d) => d.paymentEvents.push({ id: eventId, provider: 'payu', tenantId: intent.tenantId, paymentIntentId: intent.id, txnid: intent.txnid, status: callback.valid ? 'verified_hash' : 'rejected', reason: callback.reason, payload: safePayload, createdAt: new Date().toISOString() }));
  if (!callback.valid || !callback.creditable) return core.sendJson(res, 400, { error: callback.reason, code: 'payu_callback_rejected' });
  let verification;
  try { verification = await payu.verifyPayment({ intent, config: cfg }); }
  catch (_) { return core.sendJson(res, 502, { error: 'PayU verification unavailable', code: 'payu_verify_failed' }); }
  if (!verification.verified) return core.sendJson(res, 409, { error: verification.reason, code: 'payu_not_verified' });
  let entry; let duplicate = false;
  await core.mutate((d) => {
    const stored = d.paymentIntents.find((x) => x.id === intent.id);
    if (stored.status === 'credited') { duplicate = true; return; }
    entry = addLedgerEntry(d, stored.tenantId, stored.credits, 'payment_credit', `payu:${stored.txnid}`, stored.userId, { paymentIntentId: stored.id, payuId: verification.payuId, packId: stored.packId });
    if (!entry) { duplicate = true; stored.status = 'credited'; return; }
    stored.status = 'credited'; stored.payuId = verification.payuId; stored.updatedAt = new Date().toISOString();
    d.auditEvents.push({ id: core.genId('aud_'), tenantId: stored.tenantId, actorUserId: stored.userId, action: 'billing.payment.credited', targetType: 'payment_intent', targetId: stored.id, metadata: { ledgerId: entry.id }, createdAt: stored.updatedAt });
  });
  core.sendJson(res, 200, { ok: true, credited: !duplicate, duplicate });
}

function apiPayuReturn(req, res, payload) {
  const result = payu.classifyBrowserReturn(payload);
  core.sendJson(res, 202, { ...result, message: 'Payment is pending server verification. A browser return never credits the wallet.' });
}

function apiSupportList(req, res, ctx) {
  const d = core.db();
  const tickets = d.supportTickets.filter((x) => x.tenantId === ctx.tenant.id).map((t) => ({ ...t, messages: d.supportMessages.filter((m) => m.ticketId === t.id && m.tenantId === ctx.tenant.id && !m.internal) }));
  core.sendJson(res, 200, { tickets });
}

async function apiSupportCreate(req, res, ctx) {
  const b = ctx.body || {};
  const subject = String(b.subject || '').trim().slice(0, 120);
  const message = String(b.message || '').trim().slice(0, 5000);
  if (!subject || !message) return core.sendJson(res, 422, { error: 'subject and message required', code: 'bad_ticket' });
  const now = new Date().toISOString();
  const ticket = { id: core.genId('tic_'), tenantId: ctx.tenant.id, createdBy: ctx.user.id, subject, priority: ['low', 'normal', 'high', 'urgent'].includes(b.priority) ? b.priority : 'normal', status: 'open', createdAt: now, updatedAt: now };
  const first = { id: core.genId('msg_'), ticketId: ticket.id, tenantId: ctx.tenant.id, authorUserId: ctx.user.id, body: message, internal: false, createdAt: now };
  await core.mutate((d) => { d.supportTickets.push(ticket); d.supportMessages.push(first); addAudit(d, ctx, 'support.ticket.created', 'ticket', ticket.id); });
  core.sendJson(res, 201, { ticket: { ...ticket, messages: [first] } });
}

async function apiSupportReply(req, res, ctx) {
  const b = ctx.body || {};
  const ticket = core.db().supportTickets.find((t) => t.id === String(b.ticketId || '') && t.tenantId === ctx.tenant.id);
  if (!ticket) return core.sendJson(res, 404, { error: 'ticket not found', code: 'not_found' });
  const text = String(b.message || '').trim().slice(0, 5000);
  if (!text) return core.sendJson(res, 422, { error: 'message required', code: 'bad_message' });
  const msg = { id: core.genId('msg_'), ticketId: ticket.id, tenantId: ctx.tenant.id, authorUserId: ctx.user.id, body: text, internal: false, createdAt: new Date().toISOString() };
  await core.mutate((d) => { d.supportMessages.push(msg); const t = d.supportTickets.find((x) => x.id === ticket.id); t.updatedAt = msg.createdAt; addAudit(d, ctx, 'support.ticket.replied', 'ticket', ticket.id); });
  core.sendJson(res, 201, { message: msg });
}

function apiByonList(req, res, ctx) {
  const connections = core.db().byonConnections.filter((x) => x.tenantId === ctx.tenant.id).map((x) => ({ ...x, credentials: undefined }));
  core.sendJson(res, 200, { connections });
}

function apiPrivacyGet(req, res, ctx) { core.sendJson(res, 200, { mode: ctx.tenant.privacyMode || 'standard' }); }

async function apiByonSave(req, res, ctx) {
  const b = ctx.body || {};
  const provider = String(b.provider || '').toLowerCase();
  if (!['vobiz', 'twilio', 'telnyx', 'plivo', 'vonage', 'sip'].includes(provider)) return core.sendJson(res, 422, { error: 'unsupported BYON provider', code: 'bad_provider' });
  const address = String(b.address || '').replace(/[^0-9+]/g, '').slice(0, 32);
  if (!address) return core.sendJson(res, 422, { error: 'phone address required', code: 'bad_address' });
  const connection = { id: core.genId('byon_'), tenantId: ctx.tenant.id, provider, address, label: String(b.label || '').slice(0, 64), status: 'pending_verification', createdBy: ctx.user.id, createdAt: new Date().toISOString() };
  await core.mutate((d) => { d.byonConnections.push(connection); addAudit(d, ctx, 'telephony.byon.created', 'byon_connection', connection.id, { provider, address }); });
  core.sendJson(res, 201, { connection });
}

async function apiPrivacyMode(req, res, ctx) {
  const mode = String((ctx.body || {}).mode || '');
  if (!['standard', 'metadata_only', 'no_recording'].includes(mode)) return core.sendJson(res, 422, { error: 'invalid privacy mode', code: 'bad_privacy_mode' });
  await core.mutate((d) => { const t = d.tenants.find((x) => x.id === ctx.tenant.id); t.privacyMode = mode; addAudit(d, ctx, 'tenant.privacy_mode.updated', 'tenant', t.id, { mode }); });
  core.sendJson(res, 200, { mode });
}

function apiMembers(req, res, ctx) {
  core.sendJson(res, 200, { users: core.db().users.filter((u) => u.tenantId === ctx.tenant.id).map(publicUser) });
}

function apiAudit(req, res, ctx) {
  core.sendJson(res, 200, { auditEvents: core.db().auditEvents.filter((e) => e.tenantId === ctx.tenant.id).slice(-200).reverse() });
}

const INVOICE_STATUSES = new Set(['draft', 'issued', 'paid', 'void']);
const APPROACH_CHANNELS = new Set(['whatsapp', 'email', 'phone', 'linkedin', 'meeting', 'other']);
const INTEGRATION_CATALOG = [
  {
    id: 'whatsapp-business',
    name: 'WhatsApp Business Cloud',
    category: 'Messaging',
    description: 'Manage consent-safe conversations, templates, delivery state, and client replies from one workspace.',
    capabilities: ['Shared inbox', 'Approved templates', 'Delivery events', 'Conversation activity'],
    setup: ['Meta business verification', 'WhatsApp phone number', 'Access token', 'Signed webhook'],
  },
  {
    id: 'meta-ad-library',
    name: 'Meta Ad Library',
    category: 'Research',
    description: 'Track public competitor ads and save research context without presenting sample records as live campaign data.',
    capabilities: ['Public ad search', 'Competitor watchlists', 'Creative snapshots', 'Research notes'],
    setup: ['Meta developer app', 'Permitted API access', 'Rate-limit policy', 'Health check'],
  },
];

function isPlatformUser(user) {
  return user && (user.role === 'super_admin' || user.role === 'admin');
}

function requestOriginAllowed(req) {
  const rawOrigin = String(req.headers.origin || '').trim();
  if (!rawOrigin) return true;
  let origin;
  try { origin = new URL(rawOrigin); } catch (_) { return false; }
  if (!['http:', 'https:'].includes(origin.protocol)) return false;
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const requestHost = forwardedHost || String(req.headers.host || '').trim();
  const configuredOrigin = String(process.env.PUBLIC_ORIGIN || '').trim().replace(/\/$/, '');
  if (configuredOrigin) return rawOrigin === configuredOrigin;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const requestProto = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
  return !!requestHost && origin.origin === `${requestProto}://${requestHost}`;
}

function requestRateKey(req) {
  const peer = String(req.socket.remoteAddress || 'local').replace(/^::ffff:/, '');
  if (process.env.TRUST_PROXY !== '1') return peer;
  const privatePeer = peer === '127.0.0.1' || peer === '::1' || peer.startsWith('10.') || peer.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(peer);
  if (!privatePeer) return peer;
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return net.isIP(forwarded) ? forwarded : peer;
}

function invoiceState(invoice, now = Date.now()) {
  if (invoice.status === 'issued' && invoice.dueDate && new Date(`${invoice.dueDate}T23:59:59Z`).getTime() < now) return 'overdue';
  return invoice.status;
}

function validDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function publicInvoice(invoice) {
  return {
    id: invoice.id,
    tenantId: invoice.tenantId,
    invoiceNumber: invoice.invoiceNumber,
    clientName: invoice.clientName,
    clientEmail: invoice.clientEmail || '',
    description: invoice.description,
    amountPaise: invoice.amountPaise,
    currency: invoice.currency || 'INR',
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    status: invoiceState(invoice),
    storedStatus: invoice.status,
    deliveryStatus: invoice.deliveryStatus || 'not_sent',
    createdAt: invoice.createdAt,
    updatedAt: invoice.updatedAt,
    issuedAt: invoice.issuedAt || null,
    paidAt: invoice.paidAt || null,
  };
}

function scopedInvoices(ctx) {
  const rows = core.db().invoices || [];
  return (isPlatformUser(ctx.user) ? rows : rows.filter((row) => row.tenantId === ctx.tenant.id));
}

function apiInvoices(req, res, ctx) {
  core.sendJson(res, 200, { invoices: scopedInvoices(ctx).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicInvoice) });
}

async function apiInvoiceCreate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const d = core.db();
  const requestedTenantId = String(b.tenantId || '');
  const tenant = isPlatformUser(ctx.user)
    ? d.tenants.find((row) => row.id === requestedTenantId)
    : d.tenants.find((row) => row.id === ctx.tenant.id);
  if (!tenant) return core.sendJson(res, 422, { error: 'valid client workspace required', code: 'bad_tenant' });
  const amountPaise = Number(b.amountPaise);
  const description = String(b.description || '').trim().slice(0, 500);
  const clientName = String(b.clientName || tenant.name || '').trim().slice(0, 120);
  const clientEmail = String(b.clientEmail || '').trim().toLowerCase().slice(0, 160);
  const dueDate = String(b.dueDate || '').trim();
  const issueDate = String(b.issueDate || todayUtc()).trim();
  const initialStatus = b.issueNow === true ? 'issued' : 'draft';
  if (!Number.isInteger(amountPaise) || amountPaise < 100 || amountPaise > 1000000000) return core.sendJson(res, 422, { error: 'amount must be between ₹1 and ₹10,000,000', code: 'bad_amount' });
  if (!description || !clientName) return core.sendJson(res, 422, { error: 'client name and description required', code: 'bad_invoice' });
  if (clientEmail && !EMAIL_RE.test(clientEmail)) return core.sendJson(res, 422, { error: 'client email is invalid', code: 'bad_email' });
  if (!validDateOnly(issueDate) || !validDateOnly(dueDate)) return core.sendJson(res, 422, { error: 'valid issue and due dates are required', code: 'bad_date' });
  if (dueDate < issueDate) return core.sendJson(res, 422, { error: 'due date cannot be before issue date', code: 'bad_date' });
  let invoice;
  await core.mutate((store) => {
    const year = issueDate.slice(0, 4);
    const sequence = store.invoices.filter((row) => String(row.invoiceNumber || '').startsWith(`RX-${year}-`)).length + 1;
    const now = new Date().toISOString();
    invoice = {
      id: core.genId('inv_'), tenantId: tenant.id, invoiceNumber: `RX-${year}-${String(sequence).padStart(4, '0')}`,
      clientName, clientEmail, description, amountPaise, currency: 'INR', issueDate, dueDate,
      status: initialStatus, deliveryStatus: 'not_sent', createdBy: ctx.user.id, createdAt: now, updatedAt: now,
      issuedAt: initialStatus === 'issued' ? now : null,
    };
    store.invoices.push(invoice);
    store.invoiceEvents.push({ id: core.genId('ine_'), tenantId: tenant.id, invoiceId: invoice.id, type: initialStatus === 'issued' ? 'issued' : 'created', actorUserId: ctx.user.id, createdAt: now });
    store.clientActivities.push({ id: core.genId('act_'), tenantId: tenant.id, type: initialStatus === 'issued' ? 'invoice_issued' : 'invoice_created', channel: 'internal', visibility: 'internal', summary: `${invoice.invoiceNumber} ${initialStatus === 'issued' ? 'issued' : 'created'} for ₹${(amountPaise / 100).toLocaleString('en-IN')}.`, actorUserId: ctx.user.id, createdAt: now });
    addAudit(store, ctx, initialStatus === 'issued' ? 'invoice.issued' : 'invoice.created', 'invoice', invoice.id, { invoiceNumber: invoice.invoiceNumber, tenantId: tenant.id, amountPaise });
  });
  core.sendJson(res, 201, { invoice: publicInvoice(invoice), note: 'The invoice is stored in LessRepeat. No email was sent.' });
}

async function apiInvoiceStatus(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const requested = String(b.status || '');
  if (!INVOICE_STATUSES.has(requested)) return core.sendJson(res, 422, { error: 'invalid invoice status', code: 'bad_status' });
  const current = scopedInvoices(ctx).find((row) => row.id === String(b.invoiceId || ''));
  if (!current) return core.sendJson(res, 404, { error: 'invoice not found', code: 'not_found' });
  const transitions = { draft: new Set(['issued', 'void']), issued: new Set(['paid', 'void']), paid: new Set(), void: new Set() };
  if (!transitions[current.status] || !transitions[current.status].has(requested)) {
    const final = current.status === 'void' || current.status === 'paid';
    return core.sendJson(res, 409, {
      error: final ? 'paid and void invoices are final' : `invoice cannot move from ${current.status} to ${requested}`,
      code: final ? 'invoice_final' : 'invalid_transition',
    });
  }
  let updated;
  await core.mutate((store) => {
    const invoice = store.invoices.find((row) => row.id === current.id);
    if (!invoice || !transitions[invoice.status] || !transitions[invoice.status].has(requested)) return;
    const now = new Date().toISOString();
    invoice.status = requested; invoice.updatedAt = now;
    if (requested === 'issued' && !invoice.issuedAt) invoice.issuedAt = now;
    if (requested === 'paid') invoice.paidAt = now;
    if (requested === 'void') invoice.voidedAt = now;
    store.invoiceEvents.push({ id: core.genId('ine_'), tenantId: invoice.tenantId, invoiceId: invoice.id, type: requested, actorUserId: ctx.user.id, createdAt: now });
    store.clientActivities.push({ id: core.genId('act_'), tenantId: invoice.tenantId, type: `invoice_${requested}`, channel: 'internal', visibility: 'internal', summary: `${invoice.invoiceNumber} marked ${requested}.`, actorUserId: ctx.user.id, createdAt: now });
    addAudit(store, ctx, `invoice.${requested}`, 'invoice', invoice.id, { invoiceNumber: invoice.invoiceNumber, tenantId: invoice.tenantId });
    updated = { ...invoice };
  });
  if (!updated) return core.sendJson(res, 409, { error: 'invoice state changed before this update', code: 'invoice_conflict' });
  core.sendJson(res, 200, { invoice: publicInvoice(updated) });
}

function apiAgencyOverview(req, res, ctx) {
  const d = core.db();
  const platform = isPlatformUser(ctx.user);
  const tenantIds = platform ? new Set(d.tenants.map((t) => t.id)) : new Set([ctx.tenant.id]);
  const tenants = d.tenants.filter((t) => tenantIds.has(t.id));
  const invoices = d.invoices.filter((row) => tenantIds.has(row.tenantId));
  const usage = d.usage.filter((row) => tenantIds.has(row.tenantId));
  const activities = d.clientActivities.filter((row) => tenantIds.has(row.tenantId) && (platform || row.visibility === 'tenant'));
  const audit = d.auditEvents.filter((row) => tenantIds.has(row.tenantId));
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const dayInvoices = invoices.filter((row) => row.issueDate === date && row.status !== 'draft' && row.status !== 'void');
    const dayPaid = invoices.filter((row) => row.paidAt && row.paidAt.slice(0, 10) === date);
    const dayUsage = usage.filter((row) => row.day === date);
    const dayActivities = activities.filter((row) => row.createdAt.slice(0, 10) === date);
    days.push({
      date,
      invoicedPaise: dayInvoices.reduce((sum, row) => sum + row.amountPaise, 0),
      paidPaise: dayPaid.reduce((sum, row) => sum + row.amountPaise, 0),
      calls: dayUsage.reduce((sum, row) => sum + Number(row.calls || 0), 0),
      activity: dayActivities.length + audit.filter((row) => row.createdAt && row.createdAt.slice(0, 10) === date).length,
    });
  }
  const issued = invoices.filter((row) => row.status === 'issued' || row.status === 'paid');
  const paid = invoices.filter((row) => row.status === 'paid');
  const outstanding = invoices.filter((row) => row.status === 'issued');
  const comparisons = tenants.map((tenant) => ({
    tenantId: tenant.id,
    name: tenant.name,
    status: tenant.status || 'active',
    calls: usage.filter((row) => row.tenantId === tenant.id).reduce((sum, row) => sum + Number(row.calls || 0), 0),
    activity: activities.filter((row) => row.tenantId === tenant.id).length + audit.filter((row) => row.tenantId === tenant.id).length,
    outstandingPaise: outstanding.filter((row) => row.tenantId === tenant.id).reduce((sum, row) => sum + row.amountPaise, 0),
  })).sort((a, b) => (b.calls + b.activity) - (a.calls + a.activity)).slice(0, 8);
  const portfolio = ['active', 'onboarding', 'suspended', 'closed'].map((status) => ({ status, count: tenants.filter((t) => (t.status || 'active') === status).length }));
  const recent = activities.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 12).map((row) => ({ id: row.id, tenantId: row.tenantId, tenantName: (d.tenants.find((t) => t.id === row.tenantId) || {}).name || 'Workspace', type: row.type, channel: row.channel, summary: row.summary, createdAt: row.createdAt }));
  core.sendJson(res, 200, {
    dataMode: 'live_staging', currency: 'INR', asOf: new Date().toISOString(),
    kpis: {
      clients: tenants.length,
      activeClients: tenants.filter((t) => (t.status || 'active') === 'active').length,
      closedClients: tenants.filter((t) => t.status === 'closed').length,
      invoicedPaise: issued.reduce((sum, row) => sum + row.amountPaise, 0),
      paidPaise: paid.reduce((sum, row) => sum + row.amountPaise, 0),
      outstandingPaise: outstanding.reduce((sum, row) => sum + row.amountPaise, 0),
      calls: usage.reduce((sum, row) => sum + Number(row.calls || 0), 0),
      activity: activities.length + audit.length,
    },
    days, comparisons, portfolio, recent,
  });
}

async function apiClientApproach(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  if (!isPlatformUser(ctx.user)) return core.sendJson(res, 403, { error: 'platform admin required', code: 'forbidden' });
  const b = ctx.body || {};
  const tenant = core.db().tenants.find((row) => row.id === String(b.tenantId || ''));
  const channel = String(b.channel || '').toLowerCase();
  const summary = String(b.summary || '').trim().slice(0, 500);
  if (!tenant || !APPROACH_CHANNELS.has(channel) || !summary) return core.sendJson(res, 422, { error: 'valid client, channel, and summary required', code: 'bad_activity' });
  let activity;
  await core.mutate((store) => {
    const now = new Date().toISOString();
    activity = { id: core.genId('act_'), tenantId: tenant.id, type: 'approach', channel, visibility: 'internal', summary, actorUserId: ctx.user.id, createdAt: now };
    store.clientActivities.push(activity);
    const target = store.tenants.find((row) => row.id === tenant.id); target.lastApproachedAt = now;
    addAudit(store, ctx, 'client.approached', 'tenant', tenant.id, { channel });
  });
  core.sendJson(res, 201, { activity });
}

function apiIntegrations(req, res, ctx) {
  const requests = core.db().integrationRequests.filter((row) => row.tenantId === ctx.tenant.id);
  const integrations = INTEGRATION_CATALOG.map((item) => {
    const request = requests.filter((row) => row.integrationId === item.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return { ...item, status: request ? request.status : 'setup_required', requestedAt: request ? request.createdAt : null };
  });
  core.sendJson(res, 200, { integrations, note: 'Setup requests do not connect external services.' });
}

async function apiIntegrationRequest(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const integrationId = String((ctx.body || {}).integrationId || '');
  const item = INTEGRATION_CATALOG.find((row) => row.id === integrationId);
  if (!item) return core.sendJson(res, 422, { error: 'unknown integration', code: 'bad_integration' });
  let request;
  await core.mutate((store) => {
    const existing = store.integrationRequests.find((row) => row.tenantId === ctx.tenant.id && row.integrationId === integrationId && row.status === 'requested');
    if (existing) { request = existing; return; }
    request = { id: core.genId('int_'), tenantId: ctx.tenant.id, integrationId, status: 'requested', createdBy: ctx.user.id, createdAt: new Date().toISOString() };
    store.integrationRequests.push(request);
    addAudit(store, ctx, 'integration.setup_requested', 'integration', integrationId);
  });
  core.sendJson(res, 201, { request, note: 'Request recorded. The integration is not connected.' });
}

function apiAgencyPromptGet(req, res, ctx) {
  const row = core.db().agencyPrompts.find((item) => item.tenantId === ctx.tenant.id);
  const editor = row ? core.db().users.find((user) => user.id === row.updatedBy) : null;
  core.sendJson(res, 200, { prompt: row ? row.text : '', version: row ? row.version : 0, updatedAt: row ? row.updatedAt : null, updatedBy: editor ? editor.name || editor.email : null });
}

async function apiAgencyPromptSave(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const text = String((ctx.body || {}).prompt || '').trim();
  if (text.length < 20 || text.length > 12000) return core.sendJson(res, 422, { error: 'agency prompt must be between 20 and 12,000 characters', code: 'bad_prompt' });
  let row;
  await core.mutate((store) => {
    const now = new Date().toISOString();
    row = store.agencyPrompts.find((item) => item.tenantId === ctx.tenant.id);
    if (!row) {
      row = { tenantId: ctx.tenant.id, text, version: 1, updatedBy: ctx.user.id, updatedAt: now };
      store.agencyPrompts.push(row);
    } else {
      row.text = text; row.version += 1; row.updatedBy = ctx.user.id; row.updatedAt = now;
    }
    addAudit(store, ctx, 'agency.prompt.updated', 'agency_prompt', ctx.tenant.id, { version: row.version });
  });
  const { syncedAgents, failedAgents } = await syncTenantVoiceWorkflows(ctx.tenant.id);
  core.sendJson(res, 200, { prompt: row.text, version: row.version, updatedAt: row.updatedAt, updatedBy: ctx.user.name || ctx.user.email, syncedAgents, failedAgents });
}

async function synthesizeAgentTts(res, tenantId, agent, text) {
  const cleanText = String(text || '').trim().slice(0, 4000);
  if (!cleanText) return core.sendJson(res, 422, { error: 'text is required', code: 'missing_text' });
  const tts = agent.tts || {};
  try {
    const selected = providers.resolveSelection('tts', { provider: tts.provider, model: tts.model });
    const out = await selected.adapter.synthesize({
      text: cleanText,
      model: selected.model,
      speaker: tts.speaker,
      speed: tts.speed,
      f0_up_key: tts.f0_up_key,
      description: tts.description,
    });
    bumpUsage(tenantId, 'chars', out.chars).catch(() => {});
    core.send(res, 200, out.buffer, {
      'Content-Type': 'audio/wav',
      'Content-Length': out.buffer.length,
      'Cache-Control': 'no-store',
      'X-Voice-Source': tts.customVoiceId ? 'custom' : 'agent',
      'X-Chars': String(out.chars),
    });
  } catch (error) {
    handleProviderError(res, error);
  }
}

async function apiAgentTts(req, res, ctx) {
  const agent = core.db().agents.find((item) => item.id === String((ctx.body || {}).agentId || '') && item.tenantId === ctx.tenant.id);
  if (!agent) return core.sendJson(res, 404, { error: 'agent not found', code: 'not_found' });
  return synthesizeAgentTts(res, ctx.tenant.id, agent, (ctx.body || {}).text);
}

async function apiPublicDemoTts(req, res, token, body) {
  const context = publicDemoContext(token);
  if (!context) return core.sendJson(res, 404, { error: 'demo link not found', code: 'not_found' });
  const status = demoLinks.demoLinkStatus(context.link);
  if (status !== 'active') return core.sendJson(res, 410, { error: `this demo link is ${status}`, code: `demo_${status}` });
  return synthesizeAgentTts(res, context.tenant.id, context.agent, body && body.text);
}

function publicKnowledgeItem(item) {
  return {
    id: item.id, type: item.type, name: item.name, sourceUrl: item.sourceUrl || '',
    mimeType: item.mimeType || '', size: Number(item.size || 0), status: item.status,
    contentPreview: String(item.content || '').slice(0, 240), createdAt: item.createdAt, updatedAt: item.updatedAt,
  };
}

function privateAddress(address) {
  const value = String(address || '').toLowerCase();
  if (value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe80:')) return true;
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

async function validatePublicWebsiteUrl(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('enter a valid public website URL');
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) throw new Error('private network websites cannot be crawled');
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((row) => privateAddress(row.address))) throw new Error('private network websites cannot be crawled');
  return parsed;
}

async function crawlWebsiteText(sourceUrl) {
  let target = (await validatePublicWebsiteUrl(sourceUrl)).toString();
  for (let redirect = 0; redirect < 4; redirect += 1) {
    const response = await fetch(target, { redirect: 'manual', headers: { Accept: 'text/html,text/plain', 'User-Agent': 'LessRepeatKnowledgeBot/1.0' }, signal: AbortSignal.timeout(10000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('website returned an invalid redirect');
      target = (await validatePublicWebsiteUrl(new URL(location, target).toString())).toString();
      continue;
    }
    if (!response.ok) throw new Error(`website returned status ${response.status}`);
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) throw new Error('website did not return readable HTML or text');
    const raw = (await response.text()).slice(0, 1000000);
    return raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/\s+/g, ' ').trim().slice(0, 200000);
  }
  throw new Error('website redirected too many times');
}

async function extractUploadedDocument(body) {
  const encoded = String(body.fileData || '');
  if (!encoded) return String(body.content || '').trim().slice(0, 200000);
  if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) throw new Error('document encoding is invalid');
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.length > 2 * 1024 * 1024) throw new Error('document must be 2 MB or smaller');
  const name = String(body.fileName || body.name || '').toLowerCase();
  const mimeType = String(body.mimeType || '').toLowerCase();
  if (mimeType.includes('pdf') || name.endsWith('.pdf')) {
    if (buffer.subarray(0, 4).toString('ascii') !== '%PDF') throw new Error('the selected file is not a valid PDF');
    const parsePdf = require('pdf-parse');
    const result = await parsePdf(buffer, { max: 250 });
    return String(result.text || '').replace(/\s+\n/g, '\n').trim().slice(0, 200000);
  }
  if (mimeType.includes('wordprocessingml') || name.endsWith('.docx')) {
    if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) throw new Error('the selected file is not a valid DOCX document');
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return String(result.value || '').trim().slice(0, 200000);
  }
  if (mimeType.startsWith('text/') || /\.(txt|md|csv)$/i.test(name)) return buffer.toString('utf8').trim().slice(0, 200000);
  throw new Error('supported document types are PDF, DOCX, TXT, MD, and CSV');
}

function apiKnowledgeList(req, res, ctx) {
  const items = (core.db().knowledgeItems || []).filter((item) => item.tenantId === ctx.tenant.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  core.sendJson(res, 200, { items: items.map(publicKnowledgeItem) });
}

async function apiKnowledgeSave(req, res, ctx) {
  const body = ctx.body || {};
  const allowedTypes = new Set(['document', 'website', 'faq']);
  const type = allowedTypes.has(String(body.type || '')) ? String(body.type) : 'document';
  const name = String(body.name || '').trim().slice(0, 140);
  const sourceUrl = String(body.sourceUrl || '').trim().slice(0, 1000);
  let content = String(body.content || '').trim().slice(0, 200000);
  if (!name) return core.sendJson(res, 422, { error: 'a knowledge source name is required', code: 'bad_knowledge_name' });
  if (type === 'website') {
    try { content = await crawlWebsiteText(sourceUrl); }
    catch (error) { return core.sendJson(res, 422, { error: error.message || 'website could not be crawled', code: 'bad_knowledge_url' }); }
  }
  if (type === 'document' && body.fileData) {
    try { content = await extractUploadedDocument(body); }
    catch (error) { return core.sendJson(res, 422, { error: error.message || 'document could not be read', code: 'bad_document' }); }
  }
  if (type === 'faq' && content.length < 5) return core.sendJson(res, 422, { error: 'add a question and answer', code: 'bad_faq' });
  let item;
  await core.mutate((database) => {
    const now = new Date().toISOString();
    item = body.id ? database.knowledgeItems.find((row) => row.id === String(body.id) && row.tenantId === ctx.tenant.id) : null;
    const values = {
      type, name, sourceUrl: type === 'website' ? sourceUrl : '', content,
      mimeType: String(body.mimeType || '').slice(0, 100), size: Math.max(0, Math.min(Number(body.size || 0), 25 * 1024 * 1024)),
      status: content || type === 'faq' ? 'indexed' : 'uploaded', updatedAt: now,
    };
    if (item) Object.assign(item, values);
    else { item = { id: core.genId('kb_'), tenantId: ctx.tenant.id, createdBy: ctx.user.id, createdAt: now, ...values }; database.knowledgeItems.push(item); }
    addAudit(database, ctx, 'knowledge.saved', 'knowledge', item.id, { type, name });
  });
  const sync = await syncTenantVoiceWorkflows(ctx.tenant.id);
  core.sendJson(res, 200, { item: publicKnowledgeItem(item), sync });
}

async function apiKnowledgeDelete(req, res, ctx) {
  const id = String((ctx.body || {}).id || '');
  const item = (core.db().knowledgeItems || []).find((row) => row.id === id && row.tenantId === ctx.tenant.id);
  if (!item) return core.sendJson(res, 404, { error: 'knowledge source not found', code: 'not_found' });
  await core.mutate((database) => { database.knowledgeItems = database.knowledgeItems.filter((row) => row.id !== id); addAudit(database, ctx, 'knowledge.deleted', 'knowledge', id); });
  const sync = await syncTenantVoiceWorkflows(ctx.tenant.id);
  core.sendJson(res, 200, { ok: true, sync });
}

function publicContact(contact) {
  return {
    id: contact.id, name: contact.name, phone: contact.phone, email: contact.email || '',
    company: contact.company || '', status: contact.status, source: contact.source || 'manual',
    notes: contact.notes || '', followUpAt: contact.followUpAt || null, createdAt: contact.createdAt, updatedAt: contact.updatedAt,
  };
}

function apiContactsList(req, res, ctx) {
  const contacts = (core.db().contacts || []).filter((item) => item.tenantId === ctx.tenant.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  core.sendJson(res, 200, { contacts: contacts.map(publicContact) });
}

async function apiContactSave(req, res, ctx) {
  const body = ctx.body || {};
  const name = String(body.name || '').trim().slice(0, 100);
  const phone = String(body.phone || '').trim().slice(0, 32);
  const statuses = new Set(['new', 'qualified', 'follow_up', 'customer', 'lost']);
  if (!name || !phone) return core.sendJson(res, 422, { error: 'name and phone are required', code: 'bad_contact' });
  let contact;
  await core.mutate((database) => {
    const now = new Date().toISOString();
    contact = body.id ? database.contacts.find((row) => row.id === String(body.id) && row.tenantId === ctx.tenant.id) : null;
    const values = {
      name, phone, email: String(body.email || '').trim().slice(0, 180), company: String(body.company || '').trim().slice(0, 120),
      status: statuses.has(String(body.status || '')) ? String(body.status) : 'new', source: String(body.source || 'manual').trim().slice(0, 60),
      notes: String(body.notes || '').trim().slice(0, 4000), followUpAt: body.followUpAt ? String(body.followUpAt).slice(0, 40) : null, updatedAt: now,
    };
    if (contact) Object.assign(contact, values);
    else { contact = { id: core.genId('contact_'), tenantId: ctx.tenant.id, createdBy: ctx.user.id, createdAt: now, ...values }; database.contacts.push(contact); }
    addAudit(database, ctx, 'contact.saved', 'contact', contact.id, { status: contact.status });
  });
  core.sendJson(res, 200, { contact: publicContact(contact) });
}

async function apiContactDelete(req, res, ctx) {
  const id = String((ctx.body || {}).id || '');
  const contact = (core.db().contacts || []).find((row) => row.id === id && row.tenantId === ctx.tenant.id);
  if (!contact) return core.sendJson(res, 404, { error: 'contact not found', code: 'not_found' });
  await core.mutate((database) => { database.contacts = database.contacts.filter((row) => row.id !== id); addAudit(database, ctx, 'contact.deleted', 'contact', id); });
  core.sendJson(res, 200, { ok: true });
}

function publicAutomation(rule) {
  return { id: rule.id, name: rule.name, trigger: rule.trigger, action: rule.action, agentId: rule.agentId || '', status: rule.status, config: rule.config || {}, createdAt: rule.createdAt, updatedAt: rule.updatedAt };
}

function apiAutomationsList(req, res, ctx) {
  const rules = (core.db().automationRules || []).filter((item) => item.tenantId === ctx.tenant.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  core.sendJson(res, 200, { rules: rules.map(publicAutomation) });
}

async function apiAutomationSave(req, res, ctx) {
  const body = ctx.body || {};
  const name = String(body.name || '').trim().slice(0, 100);
  const triggers = new Set(['call_completed', 'lead_qualified', 'appointment_requested', 'missed_call']);
  const actions = new Set(['create_follow_up', 'route_lead', 'book_appointment', 'send_webhook']);
  if (!name || !triggers.has(String(body.trigger)) || !actions.has(String(body.action))) return core.sendJson(res, 422, { error: 'name, trigger, and action are required', code: 'bad_automation' });
  let rule;
  await core.mutate((database) => {
    const now = new Date().toISOString();
    rule = body.id ? database.automationRules.find((row) => row.id === String(body.id) && row.tenantId === ctx.tenant.id) : null;
    const values = { name, trigger: String(body.trigger), action: String(body.action), agentId: String(body.agentId || ''), status: body.status === 'paused' ? 'paused' : 'active', config: { destination: String(body.destination || '').trim().slice(0, 500) }, updatedAt: now };
    if (rule) Object.assign(rule, values);
    else { rule = { id: core.genId('auto_'), tenantId: ctx.tenant.id, createdBy: ctx.user.id, createdAt: now, ...values }; database.automationRules.push(rule); }
    addAudit(database, ctx, 'automation.saved', 'automation', rule.id, { trigger: rule.trigger, action: rule.action });
  });
  core.sendJson(res, 200, { rule: publicAutomation(rule) });
}

async function apiAutomationDelete(req, res, ctx) {
  const id = String((ctx.body || {}).id || '');
  const rule = (core.db().automationRules || []).find((row) => row.id === id && row.tenantId === ctx.tenant.id);
  if (!rule) return core.sendJson(res, 404, { error: 'automation not found', code: 'not_found' });
  await core.mutate((database) => { database.automationRules = database.automationRules.filter((row) => row.id !== id); addAudit(database, ctx, 'automation.deleted', 'automation', id); });
  core.sendJson(res, 200, { ok: true });
}

async function collectTenantCalls(tenantId) {
  const agents = core.db().agents.filter((agent) => agent.tenantId === tenantId && agent.dograh);
  const targets = agents.flatMap((agent) => [
    { agent, workflowId: Number(agent.dograh.workflowId), source: 'agent' },
    { agent, workflowId: Number(agent.dograh.demoWorkflowId), source: 'demo' },
  ]).filter((target, index, all) => Number.isInteger(target.workflowId) && target.workflowId > 0 && all.findIndex((other) => other.workflowId === target.workflowId) === index);
  const results = await Promise.allSettled(targets.map(async ({ agent, workflowId, source }) => {
    const data = await dograh.request('GET', `/workflow/${workflowId}/runs?limit=100&sort_order=desc`);
    const outcomeSchema = agentOutcomeSchema(agent);
    const runs = await Promise.all((data.runs || []).map(async (listedRun) => {
      // Dograh's collection endpoint returns private artifact storage keys, but
      // public playback URLs are generated by the single-run endpoint. Resolve
      // details only for runs that actually have a retained artifact, keeping
      // empty/in-progress call history fast while making recordings playable.
      if (!listedRun.recording_public_url && (listedRun.recording_url || listedRun.transcript_url)) {
        try {
          return await dograh.request('GET', `/workflow/${workflowId}/runs/${listedRun.id}`);
        } catch (_) {
          return listedRun;
        }
      }
      return listedRun;
    }));
    return runs.map((run) => {
      const usage = run.usage_info || {};
      const duration = Number(usage.call_duration_seconds || usage.duration_seconds || run.duration_seconds || 0);
      const context = run.gathered_context && typeof run.gathered_context === 'object' ? run.gathered_context : {};
      const extracted = context.extracted_variables && typeof context.extracted_variables === 'object' ? context.extracted_variables : {};
      const collected = Object.fromEntries(outcomeSchema.map((field) => [field, context[field.key] !== undefined ? context[field.key] : extracted[field.key]])
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([field, value]) => [field.key, value]));
      return {
        id: String(run.id), workflowId, source, agentId: agent.id, agentName: agent.name, mode: source === 'demo' ? 'demo' : (run.mode || run.call_type || 'web'),
        status: run.is_completed ? 'completed' : 'in_progress', createdAt: run.created_at, durationSeconds: duration,
        disposition: String(run.disposition || context.disposition || extracted.disposition || context.outcome || extracted.outcome || (run.is_completed ? 'completed' : 'in_progress')),
        callerName: String(context.caller_name || extracted.caller_name || context.name || extracted.name || ''),
        phone: String(context.callback_number || extracted.callback_number || context.phone || extracted.phone || ''),
        transcriptUrl: run.transcript_public_url || '', recordingUrl: run.recording_public_url || '',
        userRecordingUrl: run.user_recording_public_url || '', botRecordingUrl: run.bot_recording_public_url || '',
        outcomeSchema, collected,
      };
    });
  }));
  const calls = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { calls, providerErrors: results.filter((result) => result.status === 'rejected').length };
}

async function apiCalls(req, res, ctx) {
  const data = await collectTenantCalls(ctx.tenant.id);
  const completed = data.calls.filter((call) => call.status === 'completed');
  const success = completed.filter((call) => /book|qualif|success|complete|customer/i.test(call.disposition)).length;
  const totalDuration = completed.reduce((sum, call) => sum + call.durationSeconds, 0);
  core.sendJson(res, 200, { ...data, stats: { total: data.calls.length, completed: completed.length, successRate: completed.length ? Math.round(success / completed.length * 100) : 0, averageDurationSeconds: completed.length ? Math.round(totalDuration / completed.length) : 0 } });
}

async function apiProductOverview(req, res, ctx) {
  const database = core.db();
  const [callData] = await Promise.all([collectTenantCalls(ctx.tenant.id)]);
  const agents = database.agents.filter((item) => item.tenantId === ctx.tenant.id);
  const contacts = (database.contacts || []).filter((item) => item.tenantId === ctx.tenant.id);
  const completed = callData.calls.filter((item) => item.status === 'completed');
  const averageDurationSeconds = completed.length ? Math.round(completed.reduce((sum, item) => sum + item.durationSeconds, 0) / completed.length) : 0;
  const activity = database.auditEvents.filter((item) => item.tenantId === ctx.tenant.id).slice(-8).reverse().map((item) => ({ id: item.id, action: item.action, createdAt: item.createdAt }));
  core.sendJson(res, 200, { stats: { totalCalls: callData.calls.length, activeAgents: agents.filter((item) => (item.dograh && item.dograh.status) !== 'archived').length, leadsCollected: contacts.length, averageDurationSeconds }, recentCalls: callData.calls.slice(0, 5), activity, providerErrors: callData.providerErrors });
}

async function apiTenantUpdate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  const color = String(b.color || '').trim();
  if (!name || !/^#[0-9a-fA-F]{6}$/.test(color)) return core.sendJson(res, 422, { error: 'valid tenant name and color required', code: 'bad_tenant' });
  let tenant;
  await core.mutate((store) => {
    tenant = store.tenants.find((row) => row.id === ctx.tenant.id);
    tenant.name = name; tenant.branding = { ...(tenant.branding || {}), color };
    addAudit(store, ctx, 'tenant.settings.updated', 'tenant', tenant.id);
  });
  core.sendJson(res, 200, { tenant: publicTenant(tenant) });
}

async function apiMemberRole(req, res, ctx) {
  const b = ctx.body || {};
  const role = String(b.role || '');
  if (!['owner', 'member'].includes(role)) return core.sendJson(res, 422, { error: 'tenant roles are owner or member', code: 'bad_role' });
  const target = core.db().users.find((u) => u.id === String(b.userId || '') && u.tenantId === ctx.tenant.id);
  if (!target) return core.sendJson(res, 404, { error: 'user not found', code: 'not_found' });
  await core.mutate((d) => { const u = d.users.find((x) => x.id === target.id); u.role = role; addAudit(d, ctx, 'member.role.updated', 'user', u.id, { role }); });
  core.sendJson(res, 200, { user: publicUser({ ...target, role }) });
}

function apiAdminOverview(req, res) {
  const d = core.db();
  const issued = d.invoices.filter((row) => row.status === 'issued' || row.status === 'paid');
  core.sendJson(res, 200, { totals: {
    tenants: d.tenants.length,
    activeTenants: d.tenants.filter((t) => (t.status || 'active') === 'active').length,
    closedTenants: d.tenants.filter((t) => t.status === 'closed').length,
    users: d.users.length,
    openTickets: d.supportTickets.filter((t) => t.status !== 'closed').length,
    walletPaise: d.wallets.reduce((n, w) => n + w.balancePaise, 0),
    calls: d.usage.reduce((n, u) => n + (u.calls || 0), 0),
    invoicedPaise: issued.reduce((n, row) => n + row.amountPaise, 0),
    outstandingPaise: d.invoices.filter((row) => row.status === 'issued').reduce((n, row) => n + row.amountPaise, 0),
  } });
}

function apiAdminTenants(req, res) {
  const d = core.db();
  core.sendJson(res, 200, { tenants: d.tenants.map((t) => ({
    ...publicTenant(t),
    users: d.users.filter((u) => u.tenantId === t.id).length,
    agents: d.agents.filter((a) => a.tenantId === t.id).length,
    calls: d.usage.filter((u) => u.tenantId === t.id).reduce((n, row) => n + Number(row.calls || 0), 0),
    lastApproachedAt: t.lastApproachedAt || null,
    outstandingPaise: d.invoices.filter((row) => row.tenantId === t.id && row.status === 'issued').reduce((n, row) => n + row.amountPaise, 0),
    wallet: publicWallet(d.wallets.find((w) => w.tenantId === t.id) || { id: null, tenantId: t.id, currency: 'INR', balancePaise: 0 }),
  })) });
}

async function apiAdminTenantCreate(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  const ownerEmail = String(b.ownerEmail || '').trim().toLowerCase().slice(0, 160);
  const password = String(b.password || '');
  if (!name) return core.sendJson(res, 422, { error: 'client workspace name required', code: 'bad_tenant' });
  if (ownerEmail && (!EMAIL_RE.test(ownerEmail) || password.length < 12)) return core.sendJson(res, 422, { error: 'a valid owner email and 12 character temporary password are required together', code: 'bad_owner' });
  if (!ownerEmail && password) return core.sendJson(res, 422, { error: 'owner email is required when a password is supplied', code: 'bad_owner' });
  if (ownerEmail && core.db().users.some((user) => user.email === ownerEmail)) return core.sendJson(res, 409, { error: 'owner email is already registered', code: 'email_taken' });
  let tenant; let user = null;
  await core.mutate((store) => {
    const now = new Date().toISOString();
    tenant = {
      id: core.genId('t_'), name, slug: makeSlug(name, new Set(store.tenants.map((t) => t.slug))),
      createdAt: now, branding: { color: '#B88A2D' }, providers: { ...DEFAULT_PROVIDERS },
      plan: 'studio', status: ownerEmail ? 'active' : 'onboarding', privacyMode: 'standard',
    };
    store.tenants.push(tenant);
    store.wallets.push({ id: core.genId('wal_'), tenantId: tenant.id, currency: 'INR', balancePaise: 0, createdAt: now, updatedAt: now });
    if (ownerEmail) {
      user = { id: core.genId('u_'), tenantId: tenant.id, email: ownerEmail, name: String(b.ownerName || 'Client Owner').trim().slice(0, 80), passHash: core.hashPassword(password), role: 'owner', status: 'active', createdAt: now };
      store.users.push(user);
    }
    store.clientActivities.push({ id: core.genId('act_'), tenantId: tenant.id, type: 'workspace_created', channel: 'internal', visibility: 'internal', summary: 'Client workspace created in LessRepeat.', actorUserId: ctx.user.id, createdAt: now });
    addAudit(store, ctx, 'admin.tenant.created', 'tenant', tenant.id, { ownerCreated: !!user });
  });
  core.sendJson(res, 201, { tenant: publicTenant(tenant), owner: user ? publicUser(user) : null, note: 'No email was sent.' });
}

function apiAdminUsers(req, res) { core.sendJson(res, 200, { users: core.db().users.map(publicUser) }); }

function apiAdminAudit(req, res) { core.sendJson(res, 200, { auditEvents: core.db().auditEvents.slice(-500).reverse() }); }

function apiAdminTickets(req, res) {
  const d = core.db();
  core.sendJson(res, 200, { tickets: d.supportTickets.map((t) => ({ ...t, messages: d.supportMessages.filter((m) => m.ticketId === t.id) })) });
}

function apiAdminPaymentEvents(req, res) { core.sendJson(res, 200, { events: core.db().paymentEvents.slice(-500).reverse() }); }

function apiAdminTenantDetail(req, res) {
  const url = new URL(req.url, 'http://localhost'); const tenantId = String(url.searchParams.get('tenantId') || ''); const d = core.db();
  const tenant = d.tenants.find((t) => t.id === tenantId);
  if (!tenant) return core.sendJson(res, 404, { error: 'tenant not found', code: 'not_found' });
  core.sendJson(res, 200, { tenant: publicTenant(tenant), users: d.users.filter((u) => u.tenantId === tenantId).map(publicUser), agents: d.agents.filter((a) => a.tenantId === tenantId).map(publicAgent), numbers: d.byonConnections.filter((x) => x.tenantId === tenantId).map((x) => ({ id: x.id, provider: x.provider, address: x.address, label: x.label, status: x.status, createdAt: x.createdAt })), usage: d.usage.filter((x) => x.tenantId === tenantId).slice(-100).reverse(), tickets: d.supportTickets.filter((x) => x.tenantId === tenantId), wallet: publicWallet(d.wallets.find((w) => w.tenantId === tenantId) || { id: null, tenantId, currency: 'INR', balancePaise: 0 }), ledger: d.ledger.filter((x) => x.tenantId === tenantId).slice(-100).reverse(), invoices: d.invoices.filter((x) => x.tenantId === tenantId).map(publicInvoice), activities: d.clientActivities.filter((x) => x.tenantId === tenantId).slice(-100).reverse(), statusEvents: d.tenantStatusEvents.filter((x) => x.tenantId === tenantId).slice(-100).reverse() });
}

async function apiAdminImpersonate(req, res, ctx) {
  if (ctx.impersonator) return core.sendJson(res, 409, { error: 'nested impersonation is not allowed', code: 'nested_impersonation' });
  const b = ctx.body || {}; const reason = String(b.reason || '').trim().slice(0, 240); const target = core.db().users.find((u) => u.id === String(b.userId || ''));
  if (!reason || !target) return core.sendJson(res, 422, { error: 'valid userId and reason required', code: 'bad_impersonation' });
  if (!core.verifyPassword(String(b.password || ''), ctx.user.passHash)) return core.sendJson(res, 401, { error: 'password re-authentication failed', code: 'reauth_failed' });
  if (target.role === 'super_admin' || target.status !== 'active') return core.sendJson(res, 403, { error: 'that account cannot be impersonated', code: 'impersonation_forbidden' });
  const tenant = core.db().tenants.find((t) => t.id === target.tenantId);
  if (!tenant || tenant.status !== 'active') return core.sendJson(res, 409, { error: 'target tenant is not active', code: 'target_inactive' });
  const token = await core.createImpersonationSession(ctx.user.id, target.id, tenant.id, reason);
  await core.mutate((d) => addAudit(d, ctx, 'admin.impersonation.started', 'user', target.id, { reason }));
  core.send(res, 200, JSON.stringify({ ok: true, user: publicUser(target), tenant: publicTenant(tenant) }), { 'Content-Type': 'application/json', 'Set-Cookie': core.sessionCookie(token) });
}

async function apiImpersonationExit(req, res, ctx) {
  if (!ctx.impersonator) return core.sendJson(res, 409, { error: 'not impersonating', code: 'not_impersonating' });
  const actor = ctx.impersonator; const tenant = core.db().tenants.find((t) => t.id === actor.tenantId); const token = await core.createSession(actor.id, actor.tenantId);
  await core.mutate((d) => addAudit(d, ctx, 'admin.impersonation.ended', 'user', ctx.user.id));
  core.send(res, 200, JSON.stringify({ ok: true, user: publicUser(actor), tenant: publicTenant(tenant) }), { 'Content-Type': 'application/json', 'Set-Cookie': core.sessionCookie(token) });
}

async function apiAdminTenantStatus(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const status = String(b.status || '');
  if (!['onboarding', 'active', 'suspended', 'closed'].includes(status)) return core.sendJson(res, 422, { error: 'invalid status', code: 'bad_status' });
  const tenant = core.db().tenants.find((t) => t.id === String(b.tenantId || ''));
  if (!tenant) return core.sendJson(res, 404, { error: 'tenant not found', code: 'not_found' });
  await core.mutate((d) => {
    const now = new Date().toISOString();
    d.tenants.find((t) => t.id === tenant.id).status = status;
    if (status !== 'active') d.sessions = d.sessions.filter((s) => s.tenantId !== tenant.id);
    d.tenantStatusEvents.push({ id: core.genId('tse_'), tenantId: tenant.id, fromStatus: tenant.status || 'active', toStatus: status, reason: String(b.reason || '').trim().slice(0, 240), actorUserId: ctx.user.id, createdAt: now });
    d.clientActivities.push({ id: core.genId('act_'), tenantId: tenant.id, type: status === 'closed' ? 'offboarded' : 'status_changed', channel: 'internal', visibility: 'internal', summary: `Client status changed from ${tenant.status || 'active'} to ${status}.`, actorUserId: ctx.user.id, createdAt: now });
    addAudit(d, ctx, 'admin.tenant.status', 'tenant', tenant.id, { status });
  });
  core.sendJson(res, 200, { tenant: publicTenant({ ...tenant, status }) });
}

async function apiAdminUserStatus(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const status = String(b.status || '');
  if (!['active', 'suspended', 'deleted'].includes(status)) return core.sendJson(res, 422, { error: 'invalid status', code: 'bad_status' });
  const user = core.db().users.find((u) => u.id === String(b.userId || ''));
  if (!user) return core.sendJson(res, 404, { error: 'user not found', code: 'not_found' });
  if (user.id === ctx.user.id) return core.sendJson(res, 409, { error: 'cannot change your own status', code: 'self_target' });
  await core.mutate((d) => { const u = d.users.find((x) => x.id === user.id); u.status = status; if (status === 'deleted') { u.email = `deleted-${u.id}@invalid.local`; u.name = 'Deleted user'; u.passHash = ''; } d.sessions = d.sessions.filter((s) => s.userId !== user.id); addAudit(d, ctx, 'admin.user.status', 'user', user.id, { status }); });
  core.sendJson(res, 200, { ok: true });
}

async function apiAdminUserRole(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const role = String(b.role || '');
  if (!['super_admin', 'admin', 'owner', 'member'].includes(role)) return core.sendJson(res, 422, { error: 'invalid role', code: 'bad_role' });
  const user = core.db().users.find((u) => u.id === String(b.userId || ''));
  if (!user) return core.sendJson(res, 404, { error: 'user not found', code: 'not_found' });
  if (user.id === ctx.user.id && role !== 'super_admin') return core.sendJson(res, 409, { error: 'cannot remove your own super admin role', code: 'self_target' });
  await core.mutate((d) => { d.users.find((u) => u.id === user.id).role = role; addAudit(d, ctx, 'admin.user.role', 'user', user.id, { role }); });
  core.sendJson(res, 200, { user: publicUser({ ...user, role }) });
}

async function apiAdminWalletAdjust(req, res, ctx) {
  if (rejectImpersonated(res, ctx)) return;
  const b = ctx.body || {};
  const amountPaise = Number(b.amountPaise);
  const tenantId = String(b.tenantId || '');
  if (!core.db().tenants.some((t) => t.id === tenantId) || !Number.isInteger(amountPaise) || amountPaise === 0 || Math.abs(amountPaise) > 100000000) return core.sendJson(res, 422, { error: 'valid tenantId and amountPaise required', code: 'bad_adjustment' });
  const idempotencyKey = String(b.idempotencyKey || '').trim().slice(0, 120);
  if (!idempotencyKey) return core.sendJson(res, 422, { error: 'idempotencyKey required', code: 'idempotency_required' });
  let entry;
  try { await core.mutate((d) => { entry = addLedgerEntry(d, tenantId, amountPaise, 'admin_adjustment', `admin:${idempotencyKey}`, ctx.user.id, { reason: String(b.reason || '').slice(0, 200) }); if (entry) addAudit(d, ctx, 'admin.wallet.adjusted', 'tenant', tenantId, { amountPaise, ledgerId: entry.id }); }); }
  catch (e) { return core.sendJson(res, 409, { error: e.message, code: 'wallet_rejected' }); }
  if (!entry) return core.sendJson(res, 200, { duplicate: true });
  core.sendJson(res, 201, { ledgerEntry: entry });
}

async function apiAdminTicketReply(req, res, ctx) {
  const b = ctx.body || {};
  const ticket = core.db().supportTickets.find((t) => t.id === String(b.ticketId || ''));
  const text = String(b.message || '').trim().slice(0, 5000);
  if (!ticket || !text) return core.sendJson(res, 422, { error: 'valid ticketId and message required', code: 'bad_reply' });
  const msg = { id: core.genId('msg_'), ticketId: ticket.id, tenantId: ticket.tenantId, authorUserId: ctx.user.id, body: text, internal: !!b.internal, createdAt: new Date().toISOString() };
  await core.mutate((d) => { d.supportMessages.push(msg); const t = d.supportTickets.find((x) => x.id === ticket.id); t.status = b.status === 'closed' ? 'closed' : 'waiting_on_customer'; t.updatedAt = msg.createdAt; addAudit(d, ctx, 'admin.ticket.replied', 'ticket', ticket.id, { status: t.status }); });
  core.sendJson(res, 201, { message: msg });
}

async function apiAdminTicketUpdate(req, res, ctx) {
  const b = ctx.body || {}; const ticket = core.db().supportTickets.find((t) => t.id === String(b.ticketId || ''));
  if (!ticket) return core.sendJson(res, 404, { error: 'ticket not found', code: 'not_found' });
  const status = ['open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed'].includes(String(b.status || '')) ? String(b.status) : ticket.status;
  const priority = ['low', 'normal', 'high', 'urgent'].includes(String(b.priority || '')) ? String(b.priority) : ticket.priority;
  await core.mutate((d) => { const t = d.supportTickets.find((x) => x.id === ticket.id); t.status = status; t.priority = priority; t.assignedTo = b.assignedTo ? String(b.assignedTo) : t.assignedTo || ctx.user.id; t.updatedAt = new Date().toISOString(); addAudit(d, ctx, 'admin.ticket.updated', 'ticket', ticket.id, { status, priority, assignedTo: t.assignedTo }); });
  core.sendJson(res, 200, { ok: true });
}

// GET /api/providers -> the registry so Settings can render active vs available.
function apiProviders(req, res) {
  core.sendJson(res, 200, providers.describeProviders());
}

// GET /api/health -> readiness + which provider keys are present.
function apiHealth(req, res) {
  const described = providers.describeProviders();
  const providerHealth = (layer) => Object.fromEntries((described[layer] || []).map((item) => [item.id, item.live]));
  const selected = (layer) => (described[layer] || []).find((item) => item.selected) || (described[layer] || [])[0] || {};
  const selectedStt = selected('stt'); const selectedTts = selected('tts'); const selectedLlm = selected('llm'); const selectedTelephony = selected('telephony');
  core.sendJson(res, 200, {
    ok: true,
    providers: {
      stt: providerHealth('stt'),
      tts: providerHealth('tts'),
      llm: providerHealth('llm'),
      telephony: providerHealth('telephony'),
    },
    models: { stt: selectedStt.model, llm: selectedLlm.model, tts: selectedTts.model },
    selected: {
      stt: { provider: selectedStt.id, model: selectedStt.model },
      tts: { provider: selectedTts.id, model: selectedTts.model },
      llm: { provider: selectedLlm.id, model: selectedLlm.model },
      telephony: { provider: selectedTelephony.id },
    },
  });
}

/* ==========================================================================
   Map a ProviderError (or anything) to a clean JSON HTTP response.
   ========================================================================== */
function handleProviderError(res, e) {
  if (e instanceof providers.ProviderError) {
    return core.sendJson(res, e.status || 502, {
      error: e.message,
      code: e.code || 'provider_error',
      detail: e.detail,
    });
  }
  core.sendJson(res, 502, { error: String((e && e.message) || e), code: 'upstream' });
}

/* ==========================================================================
   Router
   ========================================================================== */

const server = http.createServer(async (req, res) => {
  const ip = requestRateKey(req);
  const route = (req.url || '/').split('?')[0];

  try {
    if (route.startsWith('/api/')) {
      if (!core.rateOk(ip)) return core.sendJson(res, 429, { error: 'rate limited', code: 'rate' });

      const payuInbound = route === '/api/payu/callback' || route === '/api/payu/webhook' || route === '/api/payu/return';
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method || '') && !payuInbound && !requestOriginAllowed(req)) {
        return core.sendJson(res, 403, { error: 'cross-origin request blocked', code: 'bad_origin' });
      }
      const requestContentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method || '') && !payuInbound && requestContentType && requestContentType !== 'application/json') {
        return core.sendJson(res, 415, { error: 'application/json required', code: 'bad_content_type' });
      }

      if ((route === '/api/payu/callback' || route === '/api/payu/webhook' || route === '/api/payu/return') && req.method === 'POST') {
        let form;
        try { form = await readForm(req); }
        catch (e) { return core.sendJson(res, 400, { error: e.message, code: 'bad_form' }); }
        return (route.endsWith('/callback') || route.endsWith('/webhook')) ? apiPayuCallback(req, res, form) : apiPayuReturn(req, res, form);
      }

      // ---- Public GET routes ----
      if (route === '/api/health' && req.method === 'GET') return apiHealth(req, res);
      if (route === '/api/providers' && req.method === 'GET') return apiProviders(req, res);
      if (route.startsWith('/api/public/demo/') && req.method === 'GET') {
        const token = decodeURIComponent(route.slice('/api/public/demo/'.length));
        if (token.includes('/')) return core.sendJson(res, 404, { error: 'demo link not found', code: 'not_found' });
        return apiPublicDemoMeta(req, res, token);
      }

      // ---- Authed GET routes ----
      if (req.method === 'GET') {
        if (route === '/api/me') return core.requireAuth(req, res, apiMe);
        if (route === '/api/agents') return core.requireAuth(req, res, apiAgentsList);
        if (route === '/api/usage') return core.requireAuth(req, res, apiUsage);
        if (route === '/api/telephony/status') return core.requireAuth(req, res, apiTelephonyStatus);
        if (route === '/api/presets') return core.requireAuth(req, res, apiPresets);
        if (route === '/api/wallet') return core.requireAuth(req, res, apiWallet);
        if (route === '/api/payment-intents') return core.requireAuth(req, res, apiPaymentIntents);
        if (route === '/api/support/tickets') return core.requireAuth(req, res, apiSupportList);
        if (route === '/api/byon') return core.requireAuth(req, res, apiByonList);
        if (route === '/api/privacy') return core.requireAuth(req, res, apiPrivacyGet);
        if (route === '/api/members') return core.requireRole(req, res, 'owner', apiMembers);
        if (route === '/api/audit') return core.requireRole(req, res, 'owner', apiAudit);
        if (route === '/api/agency/overview') return core.requireRole(req, res, 'owner', apiAgencyOverview);
        if (route === '/api/agency/prompt') return core.requireRole(req, res, 'owner', apiAgencyPromptGet);
        if (route === '/api/custom-voices') return core.requireAuth(req, res, apiCustomVoices);
        if (route === '/api/product/overview') return core.requireAuth(req, res, apiProductOverview);
        if (route === '/api/calls') return core.requireAuth(req, res, apiCalls);
        if (route === '/api/knowledge') return core.requireAuth(req, res, apiKnowledgeList);
        if (route === '/api/contacts') return core.requireAuth(req, res, apiContactsList);
        if (route === '/api/automations') return core.requireAuth(req, res, apiAutomationsList);
        if (route === '/api/invoices') return core.requireRole(req, res, 'owner', apiInvoices);
        if (route === '/api/integrations') return core.requireRole(req, res, 'owner', apiIntegrations);
        if (route === '/api/demo-links') return core.requireRole(req, res, 'owner', apiDemoLinksList);
        if (route === '/api/admin/overview') return core.requireRole(req, res, 'super_admin', apiAdminOverview);
        if (route === '/api/admin/tenants') return core.requireRole(req, res, 'super_admin', apiAdminTenants);
        if (route === '/api/admin/users') return core.requireRole(req, res, 'super_admin', apiAdminUsers);
        if (route === '/api/admin/audit') return core.requireRole(req, res, 'admin', apiAdminAudit);
        if (route === '/api/admin/tickets') return core.requireRole(req, res, 'admin', apiAdminTickets);
        if (route === '/api/admin/tenant-detail') return core.requireRole(req, res, 'super_admin', apiAdminTenantDetail);
        if (route === '/api/admin/payment-events') return core.requireRole(req, res, 'admin', apiAdminPaymentEvents);
        if (route === '/api/hvac/desk') return core.requireAuth(req, res, apiHvacDesk);
        if (route === '/api/hvac/event-types') return core.requireAuth(req, res, apiHvacEventTypes);
        if (route === '/api/hvac/slots') return core.requireAuth(req, res, apiHvacSlots);
        return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
      }

      if (req.method !== 'POST') {
        return core.sendJson(res, 405, { error: 'method not allowed', code: 'method' });
      }

      // ---- POST routes: read the body once, with a bigger cap for STT audio ----
      let body;
      try {
        body = await core.readBody(req, route === '/api/stt' ? 12 * 1024 * 1024 : route === '/api/knowledge' ? 4 * 1024 * 1024 : 64 * 1024);
      } catch (e) {
        const tooBig = /too large/.test(String(e.message));
        return core.sendJson(res, tooBig ? 413 : 400, {
          error: e.message, code: tooBig ? 'too_large' : 'bad_body',
        });
      }

      // Public POST (auth) routes.
      if (route === '/api/internal/gemini-tts/v1/audio/speech') return apiInternalGeminiTts(req, res, body);
      if (route === '/api/auth/signup') return apiSignup(req, res, body);
      if (route === '/api/auth/login') return apiLogin(req, res, body);
      if (route === '/api/auth/logout') return apiLogout(req, res);
      if (route === '/api/auth/impersonation/exit') return core.requireAuth(req, res, apiImpersonationExit, body);
      if (route.startsWith('/api/public/demo/') && route.endsWith('/session')) {
        const token = decodeURIComponent(route.slice('/api/public/demo/'.length, -'/session'.length));
        if (token.includes('/') || !core.rateOk(`demo-start:${ip}`, 5, 5)) return core.sendJson(res, token.includes('/') ? 404 : 429, { error: token.includes('/') ? 'demo link not found' : 'too many demo starts, try again shortly', code: token.includes('/') ? 'not_found' : 'demo_rate' });
        return apiPublicDemoSession(req, res, token);
      }
      if (route.startsWith('/api/public/demo/') && route.endsWith('/tts')) {
        const token = decodeURIComponent(route.slice('/api/public/demo/'.length, -'/tts'.length));
        if (token.includes('/') || !core.rateOk(`demo-tts:${ip}`, 20, 60)) return core.sendJson(res, token.includes('/') ? 404 : 429, { error: token.includes('/') ? 'demo link not found' : 'too many voice requests, try again shortly', code: token.includes('/') ? 'not_found' : 'demo_rate' });
        return apiPublicDemoTts(req, res, token, body);
      }

      // Authed POST routes (tenant scoped through requireAuth).
      if (route === '/api/agents') return core.requireAuth(req, res, apiAgentsCreate, body);
      if (route === '/api/agents/update') return core.requireAuth(req, res, apiAgentsUpdate, body);
      if (route === '/api/agents/delete') return core.requireAuth(req, res, apiAgentsDelete, body);
      if (route === '/api/tts') return core.requireAuth(req, res, apiTts, body);
      if (route === '/api/agents/tts') return core.requireAuth(req, res, apiAgentTts, body);
      if (route === '/api/ws-connect') return core.requireAuth(req, res, apiWsConnect, body);
      if (route === '/api/chat') return core.requireAuth(req, res, apiChat, body);
      if (route === '/api/stt') return core.requireAuth(req, res, apiStt, body);
      if (route === '/api/voice/session') return core.requireAuth(req, res, apiVoiceSession, body);
      if (route === '/api/demo-links') return core.requireRole(req, res, 'owner', apiDemoLinksCreate, body);
      if (route === '/api/demo-links/revoke') return core.requireRole(req, res, 'owner', apiDemoLinksRevoke, body);
      if (route === '/api/telephony/dial') return core.requireAuth(req, res, apiTelephonyDial, body);
      if (route === '/api/payment-intents') return core.requireAuth(req, res, apiPaymentIntentCreate, body);
      if (route === '/api/support/tickets') return core.requireAuth(req, res, apiSupportCreate, body);
      if (route === '/api/support/tickets/reply') return core.requireAuth(req, res, apiSupportReply, body);
      if (route === '/api/byon') return core.requireRole(req, res, 'owner', apiByonSave, body);
      if (route === '/api/privacy') return core.requireRole(req, res, 'owner', apiPrivacyMode, body);
      if (route === '/api/tenant/update') return core.requireRole(req, res, 'owner', apiTenantUpdate, body);
      if (route === '/api/members/role') return core.requireRole(req, res, 'owner', apiMemberRole, body);
      if (route === '/api/invoices') return core.requireRole(req, res, 'admin', apiInvoiceCreate, body);
      if (route === '/api/invoices/status') return core.requireRole(req, res, 'admin', apiInvoiceStatus, body);
      if (route === '/api/integrations/request') return core.requireRole(req, res, 'owner', apiIntegrationRequest, body);
      if (route === '/api/agency/prompt') return core.requireRole(req, res, 'owner', apiAgencyPromptSave, body);
      if (route === '/api/custom-voices') return core.requireAuth(req, res, apiCustomVoiceSave, body);
      if (route === '/api/custom-voices/delete') return core.requireAuth(req, res, apiCustomVoiceDelete, body);
      if (route === '/api/knowledge') return core.requireAuth(req, res, apiKnowledgeSave, body);
      if (route === '/api/knowledge/delete') return core.requireAuth(req, res, apiKnowledgeDelete, body);
      if (route === '/api/contacts') return core.requireAuth(req, res, apiContactSave, body);
      if (route === '/api/contacts/delete') return core.requireAuth(req, res, apiContactDelete, body);
      if (route === '/api/automations') return core.requireAuth(req, res, apiAutomationSave, body);
      if (route === '/api/automations/delete') return core.requireAuth(req, res, apiAutomationDelete, body);
      if (route === '/api/admin/client-approach') return core.requireRole(req, res, 'admin', apiClientApproach, body);
      if (route === '/api/admin/tenants') return core.requireRole(req, res, 'super_admin', apiAdminTenantCreate, body);
      if (route === '/api/admin/tenants/status') return core.requireRole(req, res, 'super_admin', apiAdminTenantStatus, body);
      if (route === '/api/admin/users/status') return core.requireRole(req, res, 'super_admin', apiAdminUserStatus, body);
      if (route === '/api/admin/users/role') return core.requireRole(req, res, 'super_admin', apiAdminUserRole, body);
      if (route === '/api/admin/wallet/adjust') return core.requireRole(req, res, 'admin', apiAdminWalletAdjust, body);
      if (route === '/api/admin/tickets/reply') return core.requireRole(req, res, 'admin', apiAdminTicketReply, body);
      if (route === '/api/admin/tickets/update') return core.requireRole(req, res, 'admin', apiAdminTicketUpdate, body);
      if (route === '/api/admin/impersonations') return core.requireRole(req, res, 'super_admin', apiAdminImpersonate, body);
      if (route === '/api/hvac/jobs') return core.requireAuth(req, res, apiHvacJobSave, body);
      if (route === '/api/hvac/book') return core.requireAuth(req, res, apiHvacBook, body);

      return core.sendJson(res, 404, { error: 'no such endpoint', code: 'not_found' });
    }

    if (req.method === 'GET' && route.startsWith('/demo/')) {
      req.url = '/demo.html';
    }
    if (['GET', 'HEAD'].includes(req.method || '') && route === '/console.html') {
      res.writeHead(302, { Location: '/app.html', 'Cache-Control': 'no-store' });
      return res.end();
    }
    // Everything else is a static file from public/.
    core.serveStatic(req, res);
  } catch (e) {
    core.sendJson(res, 500, { error: String((e && e.message) || e), code: 'server' });
  }
});

/* ==========================================================================
   Authenticated Deepgram live transcription proxy.

   The browser sends MediaRecorder chunks to this same-origin socket. The
   permanent Deepgram API key remains server side, while Deepgram's interim and
   final Results events are relayed unchanged for word-by-word UI updates.
   ========================================================================== */

const sttWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

function rejectUpgrade(socket, status, label) {
  if (!socket.writable) return socket.destroy();
  socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

server.on('upgrade', async (req, socket, head) => {
  const route = (req.url || '').split('?')[0];
  if (route !== '/api/stt/stream') return rejectUpgrade(socket, 404, 'Not Found');
  if (!requestOriginAllowed(req)) return rejectUpgrade(socket, 403, 'Forbidden');

  const ip = requestRateKey(req);
  if (!core.rateOk(ip)) return rejectUpgrade(socket, 429, 'Too Many Requests');

  try {
    const ctx = await core.getSession(req);
    if (!ctx) return rejectUpgrade(socket, 401, 'Unauthorized');
    sttWss.handleUpgrade(req, socket, head, (client) => {
      sttWss.emit('connection', client, req, ctx);
    });
  } catch (_) {
    rejectUpgrade(socket, 500, 'Internal Server Error');
  }
});

sttWss.on('connection', (client) => {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    client.send(JSON.stringify({ type: 'ProxyError', message: 'Deepgram is not configured.' }));
    return client.close(1011, 'Deepgram unavailable');
  }

  const query = new URLSearchParams({
    model: providers.stt.model,
    language: 'multi',
    smart_format: 'true',
    punctuate: 'true',
    interim_results: 'true',
    endpointing: '300',
    utterance_end_ms: '1000',
    vad_events: 'true',
  });
  const upstream = new WebSocket(`wss://api.deepgram.com/v1/listen?${query}`, {
    headers: { Authorization: `Token ${key}` },
    maxPayload: 1024 * 1024,
  });
  let upstreamReady = false;
  let closed = false;

  const closeBoth = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepAlive);
    if (client.readyState === WebSocket.OPEN) client.close();
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
  };

  const keepAlive = setInterval(() => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type: 'KeepAlive' }));
  }, 4000);

  upstream.on('open', () => {
    upstreamReady = true;
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'ProxyReady', provider: 'deepgram', model: providers.stt.model }));
    }
  });
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on('error', () => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'ProxyError', message: 'Deepgram live stream failed.' }));
    }
    closeBoth();
  });
  upstream.on('close', () => closeBoth());

  client.on('message', (data, isBinary) => {
    if (!upstreamReady || upstream.readyState !== WebSocket.OPEN) return;
    if (isBinary) upstream.send(data, { binary: true });
    else upstream.send(data.toString());
  });
  client.on('error', () => closeBoth());
  client.on('close', () => closeBoth());
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  PORT ${PORT} is already in use. Stop the other process or set PORT to a free port, for example: PORT=8788 node server.js\n`);
    process.exit(1);
  }
  console.error('  server error:', e.message);
  process.exit(1);
});

// Boot then listen.
boot().then(() => {
  server.listen(PORT, () => {
    const live = providers.describeProviders();
    const flag = (layer, id) => (live[layer].find((p) => p.id === id) || {}).live ? 'ok' : 'MISSING';
    console.log('\n  LessRepeat  ready');
    console.log(`  Marketing : http://localhost:${PORT}/`);
    console.log(`  Console   : http://localhost:${PORT}/app.html`);
    if (DEMO_EMAIL) console.log('  Test login: configured');
    console.log(`  Providers : deepgram ${flag('stt', 'deepgram')}  groq ${flag('llm', 'groq')}  kokoro ${flag('tts', 'kokoro')}  rumik ${flag('tts', 'rumik')}  vobiz ${flag('telephony', 'vobiz')}\n`);
  });
}).catch((e) => {
  console.error('  boot failed:', e.message);
  process.exit(1);
});
