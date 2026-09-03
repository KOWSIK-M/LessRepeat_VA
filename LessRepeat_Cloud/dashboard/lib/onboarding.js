'use strict';
const core=require('./core');
const {buildAgentConfiguration}=require('./agent-workflow');
const {withAgentReservation}=require('./admin-console');
const enabled=()=>process.env.ENABLE_SELF_SERVE_ONBOARDING==='true'&&process.env.ALLOW_PUBLIC_SIGNUP==='true';
const sandbox=()=>process.env.ONBOARDING_SANDBOX==='true'&&process.env.NODE_ENV!=='production';
const LANGUAGES=[['en-IN','English'],['hi-IN','Hindi'],['te-IN','Telugu'],['ta-IN','Tamil'],['kn-IN','Kannada'],['ml-IN','Malayalam'],['mr-IN','Marathi'],['bn-IN','Bengali'],['gu-IN','Gujarati'],['hinglish','Hinglish']];
// Generic examples, never private customer presets or invented business facts.
const EXAMPLES=[
 {id:'education',name:'Admissions assistant',industry:'education',description:'Answer course enquiries and collect a counsellor callback request.',brief:'Help students and parents understand our courses. Ask which course they need and their current class. Collect their name and callback number with permission. Ask our counsellor to follow up; do not invent fees or promise admission.',fields:['caller_name','callback_number','course_interest','current_class','preferred_callback_time','callback_consent']},
 {id:'healthcare',name:'Clinic receptionist',industry:'healthcare',description:'Collect appointment requests and route urgent enquiries.',brief:'Help callers request an appointment at our clinic. Collect their name, callback number and preferred appointment time. Escalate urgent symptoms to human staff. Do not diagnose or claim an appointment is booked without confirmation.',fields:['caller_name','callback_number','appointment_reason','preferred_appointment','callback_consent']},
 {id:'restaurant',name:'Reservation assistant',industry:'restaurant',description:'Gather a table request without inventing availability.',brief:'Help guests request a table. Ask the date, time, party size and name. Collect a callback number with permission. Explain that our team confirms availability; do not promise a table before confirmation.',fields:['caller_name','callback_number','requested_date','requested_time','party_size','callback_consent']},
 {id:'real_estate',name:'Property enquiry assistant',industry:'real_estate',description:'Understand property needs and request a team callback.',brief:'Answer property enquiries using only our supplied information. Ask location, budget and property type. Collect contact details with permission and request a callback. Do not promise availability or investment returns.',fields:['caller_name','callback_number','location','budget','property_type','callback_consent']},
 {id:'services',name:'Service enquiry assistant',industry:'services',description:'Understand a customer request and arrange follow-up.',brief:'Help customers understand our services using our business information. Ask what they need and their preferred time for a callback. Collect their name and contact number with permission; do not invent prices or availability.',fields:['caller_name','callback_number','service_needed','preferred_callback_time','callback_consent']},
 {id:'general',name:'Business receptionist',industry:'general',description:'A flexible starting point for any business.',brief:'Greet callers, understand their enquiry and answer using only our approved business information. Collect their name, reason for calling and callback number with permission. Refer anything unknown to our team.',fields:['caller_name','callback_number','reason','next_step','callback_consent']},
];
function fail(message,status=422){throw Object.assign(new Error(message),{status});}
function text(value,max){return String(value||'').trim().slice(0,max);}
function validateBusiness(b){
 const businessName=text(b.businessName,80),industry=text(b.industry,40),language=text(b.language,20);
 if(businessName.length<2)fail('Enter your business name (at least 2 characters).');
 if(!EXAMPLES.some(x=>x.industry===industry))fail('Choose a business type.');
 if(!LANGUAGES.some(([id])=>id===language))fail('Choose an opening language.');
 return {businessName,industry,language};
}
function draftFromBrief(b){
 const business=validateBusiness(b),brief=text(b.brief,1000);
 if(brief.length<20)fail('Describe the agent’s job in at least 20 characters.');
 const example=EXAMPLES.find(x=>x.id===b.exampleId)||EXAMPLES.find(x=>x.industry===business.industry);
 const outcomeSchema=example.fields.map(key=>({key,label:key.replaceAll('_',' '),type:key==='callback_consent'?'boolean':key==='party_size'?'number':'string'}));
 const config=buildAgentConfiguration({name:text(`${business.businessName} assistant`,60),language:business.language,
  persona:`You are the AI receptionist for ${business.businessName}. Business type: ${business.industry}. Your job: ${brief}\nUse only approved business facts. Ask one relevant question at a time; do not repeat known answers. Obtain permission before requesting a callback. Never claim a booking or external action succeeded without tool confirmation. Offer human follow-up for unknown facts.`,
  greeting:`Hello, welcome to ${business.businessName}. I'm your AI assistant. How can I help you today?`,outcomeSchema});
 return {...config,industry:business.industry,tts:{provider:'rumik',model:'mulberry',speaker:'speaker_1'}};
}
function create(deps){
 async function signup(req,res,b){
  if(!enabled())return core.sendJson(res,403,{error:'Business signup is not enabled. Please request an invitation.'});
  const name=text(b.name,80),email=text(b.email,160).toLowerCase(),password=String(b.password||'');
  if(!name||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return core.sendJson(res,422,{error:'Your name and a valid email are required.'});
  if(password.length<12||password.length>256)return core.sendJson(res,422,{error:'Use a password between 12 and 256 characters.'});
  const passHash=core.hashPassword(password);let tenant,user;
  try{await core.mutate(d=>{
   if(d.users.some(u=>u.email.toLowerCase()===email))fail('This email is already registered. Please sign in.',409);
   const now=new Date().toISOString(),id=core.genId('t_'),plan=d.plans.find(p=>p.id==='trial'&&p.status==='active');
   if(!plan)fail('New workspaces are temporarily unavailable.',503);
   tenant={id,name:`${name}'s workspace`,slug:core.genId('business-'),status:'active',privacyMode:'standard',createdAt:now,providers:{...deps.defaultProviders},branding:{color:'#a855f7'},plan:plan.id,planSnapshot:structuredClone(plan),trialEndsAt:new Date(Date.now()+Math.max(1,plan.trialDays||14)*86400000).toISOString(),onboarding:{version:1,status:'business',createdAt:now}};
   user={id:core.genId('u_'),tenantId:id,name,email,passHash,role:'owner',status:'active',createdAt:now,emailVerified:false};
   d.tenants.push(tenant);d.users.push(user);d.wallets.push({id:core.genId('wal_'),tenantId:id,currency:'INR',balancePaise:0,createdAt:now,updatedAt:now});
   d.auditEvents.push({id:core.genId('aud_'),tenantId:id,actorUserId:user.id,action:'auth.self_serve_signup',targetId:id,createdAt:now});
  });const token=await core.createSession(user.id,tenant.id);return core.send(res,201,JSON.stringify({user:deps.publicUser(user),tenant:deps.publicTenant(tenant)}),{'Content-Type':'application/json','Cache-Control':'no-store','Set-Cookie':core.sessionCookie(token)});
  }catch(e){return core.sendJson(res,e.status||500,{error:e.status?e.message:'Could not create your workspace. Please retry.'});}
 }
 async function handle(req,res,ctx){
  if(!enabled())return core.sendJson(res,404,{error:'Business onboarding is not enabled.'});
  if(ctx.user.role!=='owner')return core.sendJson(res,403,{error:'Only a business owner can complete setup.'});
  const route=req.url.split('?')[0],b=ctx.body||{},tenant=core.db().tenants.find(t=>t.id===ctx.tenant.id);
  if(!tenant.onboarding)return core.sendJson(res,409,{error:'This workspace already uses the standard dashboard.'});
  try{
   if(req.method==='GET')return core.sendJson(res,200,{onboarding:tenant.onboarding,examples:EXAMPLES,languages:LANGUAGES,sandbox:sandbox()});
   if(route.endsWith('/create')){
    let job;
    await core.mutate(d=>{
     const t=d.tenants.find(t=>t.id===ctx.tenant.id),o=t.onboarding;
     if(o.agentId){const existing=d.agents.find(a=>a.id===o.agentId&&a.tenantId===t.id);if(!existing)fail('Your original agent was deleted. Create another from My Agents.',409);job={existing};return;}
     if(o.provisioningUntil>Date.now())fail('Your agent is already being created. Wait a moment, then retry.',409);
     if(!o.draft)fail('Describe your agent first.');
     const name=text(b.name||o.draft.name,60),persona=text(b.persona||o.draft.persona,1500),greeting=text(b.greeting||o.draft.greeting,300);
     if(!name||persona.length<20)fail('Your agent needs a name and clear instructions.');
     o.draft={...o.draft,name,persona,greeting};o.attempt=core.genId('setup_');o.provisioningUntil=Date.now()+120000;
     job={draft:structuredClone(o.draft),attempt:o.attempt};
    });
    if(job.existing)return core.sendJson(res,200,{agent:deps.publicAgent(job.existing),sandbox:sandbox(),existing:true});
    try{await withAgentReservation(ctx,()=>deps.createAgent(req,res,{...ctx,body:job.draft,onboardingAttempt:job.attempt,onboardingSandbox:sandbox()}));}
    finally{await core.mutate(d=>{const o=d.tenants.find(t=>t.id===ctx.tenant.id).onboarding;if(o.attempt===job.attempt)o.provisioningUntil=0;});}
    return;
   }
   if(tenant.onboarding.status==='complete')fail('Setup is complete. Edit your agent in My Agents.',409);
   const business=validateBusiness(b);
   const draft=route.endsWith('/draft')?draftFromBrief(b):null;
   if(!route.endsWith('/business')&&!route.endsWith('/draft'))fail('Unknown setup action.',404);
   await core.mutate(d=>{const t=d.tenants.find(t=>t.id===ctx.tenant.id),o=t.onboarding;if(o.provisioningUntil>Date.now()||o.status==='complete')fail('Agent creation is in progress or complete.',409);t.name=business.businessName;t.industry=business.industry;Object.assign(o,business,{status:draft?'review':'brief',updatedAt:new Date().toISOString()});if(draft)Object.assign(o,{brief:text(b.brief,1000),exampleId:text(b.exampleId,50),draft});else delete o.draft;});
   return core.sendJson(res,200,{onboarding:core.db().tenants.find(t=>t.id===ctx.tenant.id).onboarding});
  }catch(e){return core.sendJson(res,e.status||500,{error:e.status?e.message:'Setup could not be saved. Your previous progress is safe.'});}
 }
 return {signup,handle};
}
module.exports={create,enabled,sandbox,draftFromBrief,EXAMPLES,LANGUAGES};
