'use strict';
const core = require('./core');
const dograh = require('./dograh');
const pending = new Map();
const updated = new Map();
function legacyDemoDeadline(run) {
  const context = run.initial_context || {};
  const maximum = Number(context.max_session_seconds);
  if (context.source !== 'public_demo' || !Number.isFinite(maximum) || maximum <= 0) return null;
  const deadline = Date.parse(run.created_at) + (Math.min(maximum,3600) + 120) * 1000;
  return Number.isFinite(deadline) ? deadline : null;
}

async function refresh(tenantId, force = false) {
  if (!force && Date.now() - (updated.get(tenantId) || 0) < 10000) return;
  if (pending.has(tenantId)) return pending.get(tenantId);
  const work = (async () => {
    const ids = [...new Set(core.db().agents.filter(a => a.tenantId === tenantId).flatMap(a => [a.dograh && a.dograh.workflowId, a.dograh && a.dograh.demoWorkflowId]).filter(Boolean))];
    const month = new Date().toISOString().slice(0, 7);
    const calls = [];
    for (const id of ids) {
      for (let page = 1; ; page += 1) {
        const result = await dograh.request('GET', `/workflow/${id}/runs?limit=100&page=${page}&sort_by=created_at&sort_order=desc`);
        const rows = result.runs || [];
        calls.push(...rows.filter(r => String(r.created_at).slice(0, 7) >= month).map(r => ({...r, workflowId:id})));
        if (rows.length < 100 || rows.some(r => String(r.created_at).slice(0, 7) < month)) break;
      }
    }
    await core.mutate(d => {
      for (const run of calls) {
        const usage=run.usage_info||{};
        const seconds=Number(usage.call_duration_seconds??usage.duration_seconds??run.cost_info?.call_duration_seconds??run.duration_seconds??0);
        const entry={tenantId,runId:String(run.id),workflowId:run.workflowId,createdAt:run.created_at,durationSeconds:Number.isFinite(seconds)?Math.max(0,seconds):0,completed:!!run.is_completed,failed:/failed|error/i.test(String(run.state||''))};
        const old=d.callMeter.find(r=>r.runId===entry.runId&&r.workflowId===entry.workflowId);
        if(old)Object.assign(old,entry);else d.callMeter.push(entry);
        if(entry.completed)d.callLeases=d.callLeases.filter(l=>!(String(l.workflowRunId)===entry.runId&&Number(l.workflowId)===Number(entry.workflowId)));
        // Older demos reserved a slot for an hour, even when signaling never
        // connected. Bound their lifetime to the demo duration plus setup grace.
        const deadline = legacyDemoDeadline(run);
        if (deadline !== null) {
          for (const lease of d.callLeases) if (!lease.browserTokenHash && lease.tenantId === tenantId && String(lease.workflowRunId) === entry.runId && Number(lease.workflowId) === Number(entry.workflowId)) {
            if (Number.isFinite(deadline)) lease.expiresAt = Math.min(lease.expiresAt, deadline);
          }
        }
      }
    });
    updated.set(tenantId,Date.now());
  })();
  pending.set(tenantId,work);
  try { await work; } finally {pending.delete(tenantId);}
}
module.exports={refresh,legacyDemoDeadline};
