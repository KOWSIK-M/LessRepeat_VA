'use strict';

const crypto = require('crypto');
const core = require('./core');
const { normalizeOutcomeSchema } = require('./agent-workflow');
const now = () => new Date().toISOString();
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const text = (value, max = 120) => String(value || '').trim().slice(0, max);
const platform = user => ['admin', 'super_admin'].includes(user && user.role);
function fail(message, status = 422, code = 'invalid_input') { throw Object.assign(new Error(message), { status, code }); }
function audit(d, ctx, action, targetId, metadata = {}) {
  d.auditEvents.push({ id: core.genId('aud_'), tenantId: ctx.tenant.id, actorUserId: ctx.user.id, action, targetType: 'admin_console', targetId, metadata, createdAt: now() });
}
function canUsePreset(p, tenantId) {
  return p && p.status !== 'archived' && p.status !== 'draft' &&
    (p.visibility === 'private' ? (p.allowedTenantIds || []).includes(tenantId) : (p.isSystem || p.tenantId === tenantId));
}
function defaultPlans() {
  return [
    { id: 'trial', name: 'Trial', monthlyPricePaise: 0, includedMinutes: 100, maxAgents: 2, maxConcurrentCalls: 1, trialDays: 14, stopAtLimit: true },
    { id: 'studio', name: 'Studio', monthlyPricePaise: 0, includedMinutes: 1000, maxAgents: 10, maxConcurrentCalls: 2, trialDays: 0, stopAtLimit: true },
  ].map(p => ({ ...p, version: 1, status: 'active', pricingConfigured: false, createdAt: now() }));
}
async function seed() {
  await core.mutate(d => {
    for (const k of ['invitations', 'plans', 'callLeases', 'callMeter', 'agentReservations']) d[k] ||= [];
    if (!d.plans.length) d.plans.push(...defaultPlans());
    // Legacy workspaces receive a fixed snapshot too; editing the catalog must
    // never silently change a customer's existing allocation.
    for (const tenant of d.tenants) if (!tenant.planSnapshot) {
      tenant.planSnapshot = structuredClone(d.plans.find(p => p.id === tenant.plan) || d.plans.find(p => p.id === 'studio') || defaultPlans()[1]);
    }
  });
}
function planFor(d, tenant) { return tenant.planSnapshot || d.plans.find(p => p.id === tenant.plan) || defaultPlans()[1]; }
function usageFor(d, tenant) {
  const month = now().slice(0, 7);
  const records = (d.callMeter || []).filter(r => r.tenantId === tenant.id && String(r.createdAt).startsWith(month));
  return { minutes: Math.round(records.reduce((n, r) => n + Number(r.durationSeconds || 0), 0) / 60 * 100) / 100, calls: records.length,
    activeCalls: (d.callLeases || []).filter(r => r.tenantId === tenant.id && r.expiresAt > Date.now()).length,
    failedCalls: records.filter(r => r.failed).length, agents: d.agents.filter(a => a.tenantId === tenant.id).length, month };
}
function assertCallsAllowed(d, tenant) {
  if (!tenant || tenant.status !== 'active') fail('This workspace is not active. Contact your administrator.', 403, 'workspace_inactive');
  if (tenant.trialEndsAt && Date.parse(tenant.trialEndsAt) <= Date.now()) fail('Your trial has expired. Contact your administrator.', 403, 'trial_expired');
  const plan = planFor(d, tenant), usage = usageFor(d, tenant);
  if (plan.stopAtLimit !== false && usage.minutes >= plan.includedMinutes) fail('Your monthly minutes have been used. Contact your administrator.', 403, 'minutes_exhausted');
  if (usage.activeCalls >= plan.maxConcurrentCalls) fail('All concurrent call slots are in use. Try after a call ends.', 409, 'concurrency_limit');
}
async function reserveCall(tenantId, workflowId) {
  let lease;
  await core.mutate(d => {
    const tenant = d.tenants.find(t => t.id === tenantId);
    assertCallsAllowed(d, tenant);
    lease = { id: core.genId('lease_'), tenantId, workflowId, createdAt: now(), expiresAt: Date.now() + 120000 };
    d.callLeases.push(lease);
  });
  return lease;
}
async function bindCall(id, workflowRunId, workflowId) {
  await core.mutate(d => { const row = d.callLeases.find(r => r.id === id); if (row) Object.assign(row, { workflowRunId, workflowId, expiresAt: Date.now() + 3600000 }); });
}
async function releaseCall(id) { await core.mutate(d => { d.callLeases = d.callLeases.filter(r => r.id !== id); }); }
async function bindBrowserCall(id, workflowRunId, workflowId, maxSessionSeconds) {
  const token = crypto.randomBytes(32).toString('base64url');
  await core.mutate(d => {
    const row = d.callLeases.find(r => r.id === id);
    if (!row) fail('Call reservation expired. Please retry.', 410, 'lease_expired');
    Object.assign(row, { workflowRunId, workflowId, browserTokenHash: hash(token),
      phase: 'connecting', maxSessionSeconds: Math.min(3600, Math.max(30, Number(maxSessionSeconds) || 3600)),
      expiresAt: Date.now() + 120000 });
  });
  return token;
}
async function browserCallLifecycle(token, action) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token || '') || !['connected','ended'].includes(action)) fail('Invalid call lifecycle request', 422);
  await core.mutate(d => {
    const row = d.callLeases.find(r => r.browserTokenHash === hash(token));
    if (action === 'ended') { if (row) d.callLeases = d.callLeases.filter(r => r.id !== row.id); return; }
    if (!row || row.expiresAt <= Date.now()) fail('Call reservation expired. Please start again.', 410, 'lease_expired');
    if (row.phase === 'connecting') Object.assign(row, {phase: 'connected', expiresAt: Date.now() + (row.maxSessionSeconds + 30) * 1000});
  });
}
async function withAgentReservation(ctx, handler) {
  const id = core.genId('provision_');
  await core.mutate(d => {
    const tenant = d.tenants.find(t => t.id === ctx.tenant.id);
    if (!tenant || tenant.status !== 'active') fail('Workspace is not active', 403);
    const count = d.agents.filter(a => a.tenantId === tenant.id).length + d.agentReservations.filter(r => r.tenantId === tenant.id && r.expiresAt > Date.now()).length;
    if (count >= planFor(d, tenant).maxAgents) fail('Agent limit reached for this plan', 403, 'agent_limit');
    d.agentReservations.push({ id, tenantId: tenant.id, expiresAt: Date.now() + 120000 });
  });
  try { return await handler(); } finally { await core.mutate(d => { d.agentReservations = d.agentReservations.filter(r => r.id !== id); }); }
}
function safeUser(u) { return { id: u.id, name: u.name, email: u.email, role: u.role, status: u.status }; }
function clientRow(d, tenant) {
  const owner = d.users.find(u => u.tenantId === tenant.id && u.role === 'owner');
  const invitation = [...d.invitations].reverse().find(i => i.tenantId === tenant.id);
  return { id: tenant.id, name: tenant.name, status: tenant.status, plan: planFor(d, tenant), trialEndsAt: tenant.trialEndsAt || null,
    owner: owner ? safeUser(owner) : null, phone: tenant.contactPhone || '', industry: tenant.industry || '', notes: tenant.internalNotes || '',
    starterPresetId: tenant.starterPresetId || '', createdAt: tenant.createdAt, usage: usageFor(d, tenant),
    invitation: invitation ? { id: invitation.id, status: invitation.status === 'pending' && Date.parse(invitation.expiresAt) <= Date.now() ? 'expired' : invitation.status, expiresAt: invitation.expiresAt } : null };
}
function createInvite(d, tenant, user, ctx) {
  for (const invite of d.invitations) if (invite.userId === user.id && invite.status === 'pending') invite.status = 'revoked';
  const token = crypto.randomBytes(32).toString('base64url');
  const invitation = { id: core.genId('inv_'), tenantId: tenant.id, userId: user.id, tokenHash: hash(token), status: 'pending', createdAt: now(), expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() };
  d.invitations.push(invitation);
  audit(d, ctx, 'invitation.created', tenant.id, { invitationId: invitation.id });
  // Fragment keeps the secret out of HTTP request paths, referrers and access logs.
  return { path: '/invite#' + token, expiresAt: invitation.expiresAt, deliveryStatus: 'not_sent' };
}
function setPlan(d, tenant, planId) {
  const plan = d.plans.find(p => p.id === planId && p.status === 'active');
  if (!plan) fail('Select an active plan');
  tenant.plan = plan.id; tenant.planSnapshot = structuredClone(plan);
  tenant.trialEndsAt = plan.trialDays ? new Date(Date.now() + plan.trialDays * 86400000).toISOString() : null;
}
function validatePlan(b) {
  const p = { name: text(b.name, 60), status: b.status === 'archived' ? 'archived' : 'active', stopAtLimit: b.stopAtLimit !== false, pricingConfigured: true };
  if (!p.name) fail('Plan name is required');
  for (const [key, min, max] of [['monthlyPricePaise', 0, 100000000], ['includedMinutes', 1, 10000000], ['maxAgents', 1, 1000], ['maxConcurrentCalls', 1, 1000], ['trialDays', 0, 365]]) {
    const value = Number(b[key]); if (!Number.isInteger(value) || value < min || value > max) fail('Invalid ' + key); p[key] = value;
  }
  return p;
}
function createConsole(deps) {
  async function handle(req, res, route) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!['GET', 'POST'].includes(req.method)) fail('Method not allowed', 405);
      const b = req.method === 'POST' ? await core.readBody(req) : {};
      if (route === '/api/invitations/inspect' || route === '/api/invitations/accept') {
        if (req.method !== 'POST') fail('Method not allowed', 405);
        if (!/^[A-Za-z0-9_-]{43}$/.test(b.token || '')) fail('This invitation is invalid or expired', 410);
        const inspect = d => {
          const i = d.invitations.find(r => r.tokenHash === hash(b.token) && r.status === 'pending' && Date.parse(r.expiresAt) > Date.now());
          const tenant = i && d.tenants.find(t => t.id === i.tenantId && t.status === 'active');
          const user = i && d.users.find(u => u.id === i.userId && u.status === 'invited');
          if (!i || !tenant || !user) fail('This invitation is invalid, expired, or unavailable', 410, 'invitation_invalid');
          return { i, tenant, user };
        };
        if (route.endsWith('/inspect')) { const { tenant, user } = inspect(core.db()); return core.sendJson(res, 200, { businessName: tenant.name, name: user.name, email: user.email }); }
        if (String(b.password || '').length < 12 || String(b.password).length > 256) fail('Use a password between 12 and 256 characters');
        const passHash = core.hashPassword(b.password);
        await core.mutate(d => {
          const { i, tenant, user } = inspect(d);
          user.passHash = passHash; user.status = 'active'; i.status = 'accepted'; i.acceptedAt = now();
          audit(d, { tenant, user }, 'invitation.accepted', tenant.id);
        });
        return core.sendJson(res, 200, { ok: true, loginUrl: '/app' });
      }
      const ctx = await core.getSession(req);
      if (!ctx) fail('Please sign in', 401, 'no_session');
      ctx.body = b;
      if (route === '/api/workspace/plan') return core.sendJson(res, 200, { plan: planFor(core.db(), ctx.tenant), usage: usageFor(core.db(), ctx.tenant), trialEndsAt: ctx.tenant.trialEndsAt || null });
      if (!platform(ctx.user) || ctx.impersonator) fail('Platform administrator access required', 403, 'forbidden');
      const d = core.db(); const suffix = route.replace('/api/admin/console/', '');
      if (req.method === 'GET') {
        if (suffix === 'overview') {
          const clients = d.tenants.map(t => clientRow(d, t));
          return core.sendJson(res, 200, { clients, plans: d.plans, presets: d.presets, totals: {
            clients: clients.length, active: clients.filter(t => t.status === 'active').length,
            pendingInvitations: clients.filter(t => t.invitation && t.invitation.status === 'pending').length,
            agents: d.agents.length, calls: clients.reduce((n,t) => n + t.usage.calls,0), minutes: clients.reduce((n,t) => n + t.usage.minutes,0),
            failedCalls: clients.reduce((n,t) => n + t.usage.failedCalls,0),
          } });
        }
        if (suffix === 'audit') return core.sendJson(res, 200, { events: d.auditEvents.slice(-500).reverse().map(e => ({...e,
          actorName: d.users.find(u => u.id === e.actorUserId)?.name || e.actorUserId,
          targetName: [...d.tenants,...d.presets,...d.plans].find(row => row.id === e.targetId)?.name || e.targetId,
        })) });
        if (suffix === 'settings') return core.sendJson(res, 200, { storage: core.storageMode(), providers: deps.providers.describeProviders(),
          invitations: { mode: 'copy_link', emailDeliveryConfigured: false, expiresAfterDays: 7 },
          environment: process.env.NODE_ENV || 'development', telephony: 'Carrier credentials and end-to-end verification required.',
          limits: 'Admission limits cover calls started through LessRepeat. Direct Dograh/carrier ingress requires matching carrier and Dograh limits.',
          signupEnabled: process.env.ALLOW_PUBLIC_SIGNUP === 'true', billing: process.env.PAYU_ENV || 'test' });
        if (suffix === 'client') {
          const id = new URL(req.url, 'http://localhost').searchParams.get('id'); const tenant = d.tenants.find(t => t.id === id);
          if (!tenant) fail('Client not found', 404);
          return core.sendJson(res, 200, { client: clientRow(d, tenant), users: d.users.filter(u => u.tenantId === id).map(safeUser),
            agents: d.agents.filter(a => a.tenantId === id).map(deps.publicAgent), numbers: d.byonConnections.filter(n => n.tenantId === id).map(n => ({ label:n.label, address:n.address,status:n.status })),
            events: d.auditEvents.filter(e => e.targetId === id || e.tenantId === id).slice(-50).reverse() });
        }
      } else {
        if (suffix === 'clients/team') {
          const name=text(b.name,80),email=text(b.email,160).toLowerCase();
          if(!name||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!['owner','member'].includes(b.role))fail('Name, valid email and a client role are required');
          let output;
          await core.mutate(store=>{
            const tenant=store.tenants.find(t=>t.id===b.id&&t.status==='active');if(!tenant)fail('Active client workspace required',404);
            if(store.users.some(u=>u.email.toLowerCase()===email))fail('This email already has an account',409);
            const user={id:core.genId('u_'),tenantId:tenant.id,name,email,role:b.role,status:'invited',passHash:'',createdAt:now()};store.users.push(user);
            output={invitation:createInvite(store,tenant,user,ctx)};audit(store,ctx,'client.team.invited',tenant.id,{role:b.role});
          });return core.sendJson(res,201,output);
        }
        if (suffix === 'clients') {
          const name = text(b.name,80), ownerName = text(b.ownerName,80), email = text(b.ownerEmail,160).toLowerCase();
          if (!name || !ownerName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Business name, owner name and a valid email are required');
          let output;
          await core.mutate(store => {
            if (store.users.some(u => u.email.toLowerCase() === email)) fail('This email already has an account',409,'email_taken');
            const tenant = { id:core.genId('t_'), name, slug:core.genId('client-'), status:'active', privacyMode:'standard', createdAt:now(), branding:{color:'#a855f7'}, providers:{...deps.defaultProviders}, contactPhone:text(b.phone,30), industry:text(b.industry,60), starterPresetId:text(b.presetId) };
            setPlan(store, tenant, text(b.planId) || 'trial');
            if (tenant.starterPresetId && !canUsePreset(store.presets.find(p => p.id === tenant.starterPresetId), tenant.id)) fail('Select a public active starter preset');
            const user = { id:core.genId('u_'),tenantId:tenant.id,email,name:ownerName,role:'owner',status:'invited',passHash:'',createdAt:now() };
            store.tenants.push(tenant); store.users.push(user);
            store.clientActivities.push({id:core.genId('act_'),tenantId:tenant.id,type:'workspace_created',channel:'internal',visibility:'internal',summary:'Client workspace created with invitation.',actorUserId:ctx.user.id,createdAt:now()});
            store.wallets.push({ id:core.genId('wal_'),tenantId:tenant.id,currency:'INR',balancePaise:0,createdAt:now(),updatedAt:now() });
            const invitation = createInvite(store,tenant,user,ctx);
            audit(store,ctx,'client.created',tenant.id,{ plan:tenant.plan });
            output = { client:clientRow(store,tenant),invitation };
          });
          return core.sendJson(res,201,output);
        }
        if (suffix === 'clients/update' || suffix === 'clients/invite') {
          let output;
          await core.mutate(store => {
            const tenant=store.tenants.find(t=>t.id===b.id); if(!tenant) fail('Client not found',404);
            if(suffix.endsWith('/invite')) {
              const user=store.users.find(u=>u.tenantId===tenant.id&&u.status==='invited'&&(b.userId?u.id===b.userId:u.role==='owner'));
              if(!user) fail('This owner has already activated their account',409);
              if(tenant.status!=='active') fail('Reactivate the workspace before sending an invitation',409);
              output={invitation:createInvite(store,tenant,user,ctx)}; return;
            }
            if(b.name!==undefined) { if(!text(b.name))fail('Business name is required');tenant.name=text(b.name,80); }
            if(b.status!==undefined) {
              if(!['active','suspended','closed'].includes(b.status))fail('Invalid workspace status');
              if(tenant.id===ctx.tenant.id&&b.status!=='active')fail('You cannot suspend or archive your own workspace',409);
              tenant.status=b.status;
              if(b.status!=='active')store.sessions=store.sessions.filter(s=>s.tenantId!==tenant.id);
            }
            if(b.planId!==undefined)setPlan(store,tenant,text(b.planId));
            if(b.notes!==undefined)tenant.internalNotes=text(b.notes,3000);
            if(b.phone!==undefined)tenant.contactPhone=text(b.phone,30);
            audit(store,ctx,'client.updated',tenant.id,{status:tenant.status,plan:tenant.plan});
            output={client:clientRow(store,tenant)};
          });
          return core.sendJson(res,200,output);
        }
        if (suffix === 'clients/agent/update') {
          const tenant=d.tenants.find(t=>t.id===b.tenantId); if(!tenant)fail('Client not found',404);
          if(!d.agents.some(a=>a.id===b.id&&a.tenantId===tenant.id))fail('Agent not found in this workspace',404);
          await deps.updateAgent(req,res,{...ctx,tenant,body:b});
          if(res.statusCode<400)await core.mutate(store=>audit(store,ctx,'client.agent.updated',tenant.id,{agentId:b.id}));
          return;
        }
        if (suffix === 'clients/agent') {
          const tenant=d.tenants.find(t=>t.id===b.id); if(!tenant)fail('Client not found',404);
          if(!canUsePreset(d.presets.find(p=>p.id===b.presetId),tenant.id))fail('Preset not available to this client',403);
          await withAgentReservation({...ctx,tenant},()=>deps.createAgent(req,res,{...ctx,tenant,body:{presetId:b.presetId,name:text(b.name)||undefined}}));
          if(res.statusCode<400)await core.mutate(store=>audit(store,ctx,'client.agent.created',tenant.id,{presetId:b.presetId}));
          return;
        }
        if (suffix === 'plans') {
          const values=validatePlan(b);let plan;
          await core.mutate(store=>{
            plan=b.id?store.plans.find(p=>p.id===b.id):null;
            if(b.id&&!plan)fail('Plan not found',404);
            if(plan&&Number(b.version)!==plan.version)fail('Plan changed. Reload before saving.',409,'version_conflict');
            if(plan)Object.assign(plan,values,{version:plan.version+1,updatedAt:now()});
            else{plan={id:core.genId('plan_'),...values,version:1,createdAt:now()};store.plans.push(plan);}
            audit(store,ctx,'plan.saved',plan.id,{version:plan.version});
          });return core.sendJson(res,200,{plan});
        }
        if (suffix === 'presets') {
          if(!text(b.name)||!text(b.persona))fail('Preset name and agent instructions are required');
          const outcomeSchema=normalizeOutcomeSchema(b.outcomeSchema);
          const values={name:text(b.name,80),category:text(b.category,60)||'general',persona:text(b.persona,1500),greeting:text(b.greeting,300),language:text(b.language,20)||'en-IN',
            guardrails:Array.isArray(b.guardrails)?b.guardrails.map(s=>text(s,200)).filter(Boolean).slice(0,15):[],outcomeSchema,fields:outcomeSchema.map(f=>f.key),
            visibility:b.visibility==='private'?'private':'public',allowedTenantIds:Array.isArray(b.allowedTenantIds)?[...new Set(b.allowedTenantIds.map(String))]:[],
            status:['draft','active','archived'].includes(b.status)?b.status:'active',isSystem:true,tts:deps.normalizeTts(b.tts)};
          let preset;
          await core.mutate(store=>{
            if(values.allowedTenantIds.some(id=>!store.tenants.some(t=>t.id===id)))fail('Unknown client in preset visibility');
            preset=b.id?store.presets.find(p=>p.id===b.id):null;
            if(b.id&&!preset)fail('Preset not found',404);
            if(preset&&Number(b.version)!==Number(preset.version||1))fail('Preset changed. Reload before saving.',409,'version_conflict');
            if(preset)Object.assign(preset,values,{version:Number(preset.version||1)+1,updatedAt:now()});
            else{preset={id:core.genId('preset_'),...values,version:1,createdAt:now()};store.presets.push(preset);}
            audit(store,ctx,'preset.saved',preset.id,{version:preset.version,status:preset.status});
          });return core.sendJson(res,200,{preset});
        }
      }
      fail('Endpoint not found',404);
    }catch(error){ core.sendJson(res,error.status||500,{error:error.status?error.message:'Admin operation failed. Please retry.',code:error.code||'admin_error'}); }
  }
  return { handle };
}
module.exports={createConsole,seed,platform,canUsePreset,planFor,usageFor,assertCallsAllowed,reserveCall,bindCall,bindBrowserCall,browserCallLifecycle,releaseCall,withAgentReservation};
