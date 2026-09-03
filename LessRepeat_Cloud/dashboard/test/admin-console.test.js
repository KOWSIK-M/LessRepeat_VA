'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {assertCallsAllowed,canUsePreset}=require('../lib/admin-console');
const {buildAgentConfiguration}=require('../lib/agent-workflow');

test('plan admission blocks inactive, expired, exhausted and concurrent workspaces',()=>{
  const tenant={id:'t',status:'active',planSnapshot:{includedMinutes:10,maxConcurrentCalls:1}};
  const d={plans:[],agents:[],callMeter:[],callLeases:[]};
  assert.doesNotThrow(()=>assertCallsAllowed(d,tenant));
  assert.throws(()=>assertCallsAllowed(d,{...tenant,status:'suspended'}),/not active/);
  assert.throws(()=>assertCallsAllowed(d,{...tenant,trialEndsAt:'2020-01-01'}),/expired/);
  d.callMeter.push({tenantId:'t',createdAt:new Date().toISOString(),durationSeconds:600});
  assert.throws(()=>assertCallsAllowed(d,tenant),/minutes/);
  d.callMeter=[];d.callLeases.push({tenantId:'t',expiresAt:Date.now()+1000});
  assert.throws(()=>assertCallsAllowed(d,tenant),/slots/);
});
test('private and archived templates fail closed and template instructions are copied',()=>{
  const p={name:'Clinic',isSystem:true,visibility:'private',allowedTenantIds:['a'],persona:'Use only clinic information.',language:'en-IN',fields:['name']};
  assert.equal(canUsePreset(p,'a'),true);assert.equal(canUsePreset(p,'b'),false);assert.equal(canUsePreset({...p,status:'archived'},'a'),false);
  const agent=buildAgentConfiguration({},p);p.persona='Changed template';assert.equal(agent.persona,'Use only clinic information.');
});

test('admin onboarding, invitations, presets, limits, permissions and suspension work end to end',{timeout:60000},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lessrepeat-admin-test-'));
  let nextId=100,runId=1000;
  const workflows=new Map(),runs=[],runPages=[];
  const upstream=http.createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;const b=raw?JSON.parse(raw):{};
    const url=new URL(req.url,'http://local');let out={};
    if(url.pathname==='/api/v1/workflow/create/definition'){const id=nextId++;out={id,status:'active',...b};workflows.set(id,out);}
    else if(/\/workflow\/\d+\/embed-token$/.test(url.pathname)){out={token:'mock-'+url.pathname.split('/')[4]};}
    else if(/\/workflow\/fetch\/\d+$/.test(url.pathname)){out=workflows.get(Number(url.pathname.split('/').at(-1)));}
    else if(/\/workflow\/\d+\/runs$/.test(url.pathname)){const page=Number(url.searchParams.get('page')||1);runPages.push(page);out={runs:runs.filter(r=>r.workflowId===Number(url.pathname.split('/')[4])).slice((page-1)*100,page*100)};}
    else if(req.method==='PUT'&&/\/workflow\/\d+$/.test(url.pathname)){const id=Number(url.pathname.split('/').at(-1));out={...workflows.get(id),...b};workflows.set(id,out);}
    else if(url.pathname==='/api/v1/public/embed/init'){const id=Number(b.token.replace('mock-',''));const run={id:runId++,workflowId:id,created_at:new Date().toISOString(),is_completed:false,usage_info:{}};runs.push(run);out={session_token:'test-session',workflow_run_id:run.id,config:{workflow_id:id}};}
    else if(url.pathname.includes('/turn-credentials/')){res.statusCode=503;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(out));
  });
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const base='http://127.0.0.1:'+port;
  const pass='Testing-admin-only-123!';
  const logs=[];const child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env:{...process.env,NODE_ENV:'test',PORT:String(port),RAPIDX_DB_FILE:path.join(dir,'db.json'),TEST_USER_EMAIL:'admin@example.test',TEST_USER_PASSWORD:pass,TEST_USER_SUPER_ADMIN:'true',PUBLIC_ORIGIN:base,ALLOW_PUBLIC_SIGNUP:'false',DEMO_LINK_ENCRYPTION_KEY:require('node:crypto').randomBytes(32).toString('hex'),DOGRAH_API_KEY:'test-only',DOGRAH_BASE_URL:'http://127.0.0.1:'+upstream.address().port},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>logs.push(String(b)));child.stderr.on('data',b=>logs.push(String(b)));
  t.after(async()=>{child.kill();await new Promise(r=>setTimeout(r,300));upstream.closeAllConnections();await new Promise(r=>upstream.close(r));await fs.rm(dir,{recursive:true,force:true});});
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)break;}catch(_){}if(child.exitCode!==null)throw Error(logs.join(''));await new Promise(r=>setTimeout(r,50));}
  async function req(pathname,body,cookie){const r=await fetch(base+pathname,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  const login=await req('/api/auth/login',{email:'admin@example.test',password:pass});assert.equal(login.status,200);const admin=login.cookie;
  assert.equal((await req('/api/admin/console/overview')).status,401);
  assert.equal((await req('/api/auth/signup',{email:'x@example.test',password:pass})).status,403);
  const plan=await req('/api/admin/console/plans',{name:'Pilot',monthlyPricePaise:10000,includedMinutes:1,maxAgents:1,maxConcurrentCalls:1,trialDays:0,stopAtLimit:true},admin);assert.equal(plan.status,200);
  async function client(name,email){const created=await req('/api/admin/console/clients',{name,ownerName:name,ownerEmail:email,planId:plan.data.plan.id},admin);assert.equal(created.status,201,JSON.stringify(created.data));return created.data;}
  const a=await client('Clinic A','a@example.test'),b=await client('Clinic B','b@example.test');
  const revisedPlan=await req('/api/admin/console/plans',{...plan.data.plan,maxAgents:50},admin);assert.equal(revisedPlan.status,200);
  assert.equal((await req('/api/admin/console/plans',{...plan.data.plan,maxAgents:60},admin)).status,409);
  assert.equal((await req('/api/admin/console/client?id='+a.client.id,undefined,admin)).data.client.plan.maxAgents,1,'Assigned limits do not change with catalog edits');
  assert.equal(a.client.owner.status,'invited');assert.equal(a.invitation.deliveryStatus,'not_sent');assert.equal(JSON.stringify(a).includes('passHash'),false);
  const duplicate=await req('/api/admin/console/clients',{name:'Duplicate',ownerName:'Owner',ownerEmail:'A@example.test',planId:'studio'},admin);assert.equal(duplicate.status,409);
  const oldToken=a.invitation.path.split('#')[1];const resend=await req('/api/admin/console/clients/invite',{id:a.client.id},admin);assert.equal(resend.status,200);
  assert.equal((await req('/api/invitations/inspect',{token:oldToken})).status,410);
  const token=resend.data.invitation.path.split('#')[1];
  assert.equal((await req('/api/invitations/accept',{token,password:'short'})).status,422);
  const race=await Promise.all([req('/api/invitations/accept',{token,password:pass}),req('/api/invitations/accept',{token,password:pass})]);assert.deepEqual(race.map(r=>r.status).sort(),[200,410]);
  await req('/api/invitations/accept',{token:b.invitation.path.split('#')[1],password:pass});
  const aLogin=await req('/api/auth/login',{email:'a@example.test',password:pass});const bLogin=await req('/api/auth/login',{email:'b@example.test',password:pass});
  assert.equal((await req('/api/admin/console/overview',undefined,aLogin.cookie)).status,403);
  assert.equal((await req('/api/admin/console/clients',{name:'Hacked'},aLogin.cookie)).status,403);
  const p=await req('/api/admin/console/presets',{name:'Private clinic',persona:'Collect clinic appointments only.',greeting:'Hello, how can I help?',language:'en-IN',visibility:'private',allowedTenantIds:[a.client.id],outcomeSchema:[{key:'caller_name',label:'Caller name',type:'string'}],status:'active'},admin);assert.equal(p.status,200);
  const presetId=p.data.preset.id;
  assert.ok((await req('/api/presets',undefined,aLogin.cookie)).data.presets.some(x=>x.id===presetId));
  assert.equal((await req('/api/presets',undefined,bLogin.cookie)).data.presets.some(x=>x.id===presetId),false);
  assert.equal((await req('/api/agents',{presetId},bLogin.cookie)).status,404);
  const agents=await Promise.all([req('/api/agents',{presetId},aLogin.cookie),req('/api/agents',{presetId},aLogin.cookie)]);assert.deepEqual(agents.map(r=>r.status).sort(),[200,403]);
  const agent=agents.find(r=>r.status===200).data.agent;
  const changed=await req('/api/admin/console/presets',{...p.data.preset,persona:'Changed for future agents.'},admin);assert.equal(changed.status,200);
  const existing=await req('/api/agents',undefined,aLogin.cookie);assert.equal(existing.data.agents[0].persona,'Collect clinic appointments only.');
  assert.equal((await req('/api/admin/console/presets',{...p.data.preset,persona:'stale version'},admin)).status,409);
  const demo=await req('/api/demo-links',{agentId:agent.id,label:'QA demo'},aLogin.cookie);assert.equal(demo.status,201,JSON.stringify(demo.data));
  const publicPath='/api/public'+demo.data.sharePath;
  const teluguUpdate=await req('/api/admin/console/clients/agent/update',{id:agent.id,tenantId:a.client.id,language:'te-IN'},admin);
  assert.equal(teluguUpdate.status,200);assert.equal(teluguUpdate.data.agent.language,'te-IN');
  assert.match(teluguUpdate.data.agent.greeting,/[\u0C00-\u0C7F]/);
  for(const flow of workflows.values())assert.match(JSON.stringify(flow),/Telugu is the primary and default language/);
  assert.equal((await req('/api/admin/console/clients/agent/update',{id:agent.id,tenantId:a.client.id,language:'en-IN'},bLogin.cookie)).status,403);
  assert.equal((await req('/api/admin/console/clients/agent/update',{id:agent.id,tenantId:b.client.id,language:'en-IN'},admin)).status,404);
  const firstCall=await req('/api/voice/session',{agentId:agent.id},aLogin.cookie);assert.equal(firstCall.status,200,JSON.stringify(firstCall.data));
  assert.equal(firstCall.data.voiceTransport,'dograh','Multilingual calls must not use the English-only preview synthesizer');
  const leaseToken=firstCall.data.leaseToken;assert.match(leaseToken,/^[A-Za-z0-9_-]{43}$/);
  assert.equal((await req('/api/voice/lease',{token:'invalid',action:'ended'})).status,422);
  assert.equal((await req('/api/voice/lease',{token:'x'.repeat(43),action:'connected'})).status,410);
  assert.equal((await req('/api/voice/lease',{token:leaseToken,action:'connected'})).status,200);
  const leaseState=JSON.parse(await fs.readFile(path.join(dir,'db.json'),'utf8')).callLeases;
  assert.equal(leaseState.length,1);assert.equal(leaseState[0].phase,'connected');
  assert.equal((await req('/api/voice/lease',{token:leaseToken,action:'connected'})).status,200);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir,'db.json'),'utf8')).callLeases[0].expiresAt,leaseState[0].expiresAt,'Repeated connected events cannot extend the reservation');
  assert.equal((await req('/api/voice/session',{agentId:agent.id},aLogin.cookie)).status,409);
  assert.equal((await req(publicPath+'/session',{})).status,409);
  assert.equal((await req('/api/voice/lease',{token:leaseToken,action:'ended'})).status,200);
  assert.equal((await req('/api/voice/lease',{token:leaseToken,action:'ended'})).status,200,'Cleanup is idempotent');
  assert.equal((await req('/api/workspace/plan',undefined,aLogin.cookie)).data.usage.activeCalls,0,'Ended calls immediately free their slot even with an incomplete upstream run');
  runs[0].is_completed=true;
  runs[0].gathered_context={extracted_variables:{caller_name:'రవి शर्मा',callback_number:'९८७६५४३२१०'}};
  const captured=await req('/api/calls',undefined,aLogin.cookie);
  assert.equal(captured.status,200);
  assert.equal(captured.data.calls[0].collected.caller_name,'రవి शर्मा');
  assert.equal(captured.data.calls[0].phone,'9876543210');
  assert.equal((await req('/api/calls',undefined,bLogin.cookie)).data.calls.length,0,'Mixed-language records remain tenant isolated');
  for(let i=0;i<100;i++)runs.push({id:runId++,workflowId:runs[0].workflowId,created_at:new Date().toISOString(),is_completed:true,cost_info:{call_duration_seconds:i===99?61:0}});
  const exhausted=await req('/api/voice/session',{agentId:agent.id},aLogin.cookie);assert.equal(exhausted.status,403);assert.equal(exhausted.data.code,'minutes_exhausted');
  assert.ok(runPages.includes(2),'Usage includes the second Dograh page');
  assert.equal((await req(publicPath+'/session',{})).status,403);
  const demoList=await req('/api/demo-links',undefined,aLogin.cookie);assert.equal(demoList.data.demoLinks[0].starts,0,'Rejected calls do not consume demo starts');
  assert.equal((await req('/api/voice/session',{agentId:agent.id},bLogin.cookie)).status,404);
  const staff=await req('/api/admin/console/clients/team',{id:a.client.id,name:'Staff',email:'staff@example.test',role:'member'},admin);assert.equal(staff.status,201);
  await req('/api/invitations/accept',{token:staff.data.invitation.path.split('#')[1],password:pass});
  const staffLogin=await req('/api/auth/login',{email:'staff@example.test',password:pass});
  assert.equal((await req('/api/agents/update',{id:agent.id,name:'Unauthorized'},staffLogin.cookie)).status,403);
  assert.equal((await req('/api/tenant/update',{name:'Unauthorized'},staffLogin.cookie)).status,403);
  const suspension=await req('/api/admin/console/clients/update',{id:a.client.id,status:'suspended'},admin);assert.equal(suspension.status,200);
  assert.equal((await req('/api/me',undefined,aLogin.cookie)).status,401);
  assert.equal((await req(publicPath)).status,404,'Suspension also blocks public demo links');
  assert.equal((await req('/api/admin/console/client?id='+a.client.id,undefined,admin)).data.agents.length,1);
  assert.equal((await req('/api/admin/console/clients/update',{id:login.data.tenant.id,status:'closed'},admin)).status,409);
  const audit=await req('/api/admin/console/audit',undefined,admin);assert.ok(audit.data.events.some(e=>e.action==='client.created'));assert.ok(audit.data.events.some(e=>e.action==='preset.saved'));
  const disk=await fs.readFile(path.join(dir,'db.json'),'utf8');assert.equal(disk.includes(token),false);assert.equal(disk.includes(pass),false);
  const settings=await req('/api/admin/console/settings',undefined,admin);assert.equal(settings.data.invitations.emailDeliveryConfigured,false);
});
