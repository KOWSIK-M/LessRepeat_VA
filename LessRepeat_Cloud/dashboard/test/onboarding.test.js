'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {spawn}=require('node:child_process'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {draftFromBrief}=require('../lib/onboarding');
test('draft compiler uses the business brief without inventing business facts',()=>{
 const d=draftFromBrief({businessName:'Sunrise Academy',industry:'education',language:'hi-IN',brief:'Help parents with course enquiries and ask our team to call them back.'});
 assert.match(d.name,/Sunrise/);assert.match(d.persona,/Help parents/);assert.match(d.greeting,/नमस्ते/);assert.ok(d.outcomeSchema.some(f=>f.key==='course_interest'));assert.ok(d.persona.length<=1500);
 assert.throws(()=>draftFromBrief({businessName:'X'}));
});
test('business signup, resume, scoped presets and retry-safe agent creation',{timeout:60000},async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'lessrepeat-onboarding-'));let child,failedEmbed=true,creates=0;const flows=new Map();
 const upstream=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const b=raw?JSON.parse(raw):{};let out={};
 if(req.url==='/api/v1/workflow/create/definition'){out={id:++creates,status:'active',...b};flows.set(creates,out);}
 else if(/embed-token$/.test(req.url)){if(failedEmbed){res.statusCode=503;out={detail:'Mock voice provider unavailable'};}else out={token:'test-embed'};}
 else if(/fetch\/\d+$/.test(req.url))out=flows.get(Number(req.url.split('/').at(-1)));
 else if(req.method==='PUT'){const id=Number(req.url.split('/').at(-1));out={...flows.get(id),...b};flows.set(id,out);}
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify(out));});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const base='http://127.0.0.1:'+port;let logs='';
 const env={...process.env,NODE_ENV:'test',PORT:String(port),HOST:'127.0.0.1',RAPIDX_DB_FILE:path.join(dir,'db.json'),SESSION_COOKIE_NAME:'test_onboarding_session',ENABLE_SELF_SERVE_ONBOARDING:'true',ALLOW_PUBLIC_SIGNUP:'true',ONBOARDING_SANDBOX:'false',TEST_USER_EMAIL:'',TEST_USER_PASSWORD:'',DOGRAH_BASE_URL:'http://127.0.0.1:'+upstream.address().port,DOGRAH_API_KEY:'test-only',PUBLIC_ORIGIN:base};
 async function stop(){if(child&&child.exitCode===null){const ended=new Promise(r=>child.once('exit',r));child.kill();await ended;}}
 async function start(){child=spawn(process.execPath,['server.js'],{cwd:path.join(__dirname,'..'),env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok)return;}catch{}if(child.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,40));}throw Error(logs);}
 t.after(async()=>{await stop();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));await fs.rm(dir,{recursive:true,force:true});});
 await start();
 async function request(route,body,cookie=''){const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const signup={name:'QA Owner',email:'owner@example.test',password:'QA-only-onboarding-123!'};
 const race=await Promise.all([request('/api/auth/signup',signup),request('/api/auth/signup',signup)]);assert.deepEqual(race.map(r=>r.status).sort(),[201,409]);const owner=race.find(r=>r.status===201),cookie=owner.cookie;assert.match(cookie,/^test_onboarding_session=/);assert.equal(owner.data.user.role,'owner');assert.equal(owner.data.tenant.plan,'trial');assert.equal(owner.data.tenant.onboardingRequired,true);
 const other=await request('/api/auth/signup',{...signup,email:'other@example.test',role:'super_admin',tenantId:owner.data.tenant.id});assert.equal(other.data.user.role,'owner');assert.notEqual(other.data.tenant.id,owner.data.tenant.id);
 assert.equal((await request('/api/me',undefined,cookie.replace('test_onboarding_session','lessrepeat_session'))).status,401);
 assert.equal((await request('/api/admin/console/overview',undefined,cookie)).status,403);
 assert.equal((await request('/api/onboarding')).status,401);
 const business={businessName:'QA Academy',industry:'education',language:'en-IN'};
 assert.equal((await request('/api/onboarding/business',business,cookie)).status,200);
 const info=await request('/api/onboarding',undefined,cookie);assert.equal(info.data.examples.length,6);assert.ok(!JSON.stringify(info.data.examples).includes('I-WIN'));
 const draft=await request('/api/onboarding/draft',{...business,brief:'Answer our admission enquiries and collect a callback request from interested parents.'},cookie);assert.equal(draft.status,200);assert.equal(draft.data.onboarding.status,'review');
 assert.equal((await request('/api/onboarding',undefined,other.cookie)).data.onboarding.draft,undefined);
 await stop();await start();assert.equal((await request('/api/onboarding',undefined,cookie)).data.onboarding.status,'review','Saved draft and session survive restart');
 const failed=await request('/api/onboarding/create',{},cookie);assert.equal(failed.status,502);assert.equal((await request('/api/onboarding',undefined,cookie)).data.onboarding.status,'review');assert.equal(creates,1);
 failedEmbed=false;
 const created=await Promise.all([request('/api/onboarding/create',{},cookie),request('/api/onboarding/create',{},cookie)]);assert.ok(created.some(r=>r.status===200));assert.ok(created.every(r=>[200,409].includes(r.status)));assert.equal(creates,1,'Retry reuses the provisioned workflow');
 const agent=created.find(r=>r.status===200).data.agent;assert.equal((await request('/api/agents',undefined,cookie)).data.agents.length,1);
 assert.equal((await request('/api/onboarding/create',{},cookie)).data.agent.id,agent.id,'Repeat submit returns original agent');assert.equal((await request('/api/me',undefined,cookie)).data.tenant.onboardingRequired,false);
 assert.equal((await request('/api/agents',undefined,other.cookie)).data.agents.length,0);
 await stop();env.ONBOARDING_SANDBOX='true';await start();
 await request('/api/onboarding/draft',{...business,businessName:'Other Business',brief:'Answer enquiries using our approved information and ask permission to call back.'},other.cookie);
 const local=await request('/api/onboarding/create',{},other.cookie);assert.equal(local.status,200);assert.equal(local.data.agent.dograh,null);assert.equal(creates,1,'Sandbox must not call the voice provider');
 const disk=JSON.parse(await fs.readFile(path.join(dir,'db.json'),'utf8'));assert.equal(disk.users.length,2);assert.equal(disk.agents.length,2);assert.equal(JSON.stringify(disk).includes(signup.password),false);
});
