'use strict';
(async()=>{
  const token=location.hash.slice(1),form=document.getElementById('invite-form'),message=document.getElementById('invite-message');
  history.replaceState(null,'','/invite');
  async function request(path,body){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.error||'Request failed');return d;}
  try{const data=await request('/api/invitations/inspect',{token});document.getElementById('invite-title').textContent='Welcome to '+data.businessName;document.getElementById('invite-copy').textContent=data.name+', set your password for '+data.email+'.';form.hidden=false;}
  catch(e){document.getElementById('invite-title').textContent='Invitation unavailable';message.textContent=e.message+'. Ask your administrator for a new link.';}
  form.addEventListener('submit',async e=>{e.preventDefault();const password=document.getElementById('password').value;if(password!==document.getElementById('confirmation').value){message.textContent='Passwords must match.';return;}const button=form.querySelector('button');button.disabled=true;message.textContent='';try{await request('/api/invitations/accept',{token,password});form.hidden=true;document.getElementById('invite-title').textContent='Your account is ready';message.textContent='Sign in with your email and new password.';}catch(error){message.textContent=error.message;button.disabled=false;}});
})();
