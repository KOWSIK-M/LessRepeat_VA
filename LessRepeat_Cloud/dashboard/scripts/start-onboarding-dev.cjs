// Isolated local preview: never imports the main workspace's data or API keys.
const path=require('node:path');
Object.assign(process.env,{
 NODE_ENV:'development',HOST:'127.0.0.1',PORT:'8788',
 ENABLE_SELF_SERVE_ONBOARDING:'true',ALLOW_PUBLIC_SIGNUP:'true',ONBOARDING_SANDBOX:'true',
 LESSREPEAT_DATABASE_URL:'',RAPIDX_DB_FILE:path.join(__dirname,'../data/onboarding-dev.json'),
 SESSION_COOKIE_NAME:'lessrepeat_onboarding_session',
 TEST_USER_EMAIL:'',TEST_USER_PASSWORD:'',TEST_USER_SUPER_ADMIN:'false',
 DOGRAH_BASE_URL:'',DOGRAH_API_KEY:'',DOGRAH_EMBED_TOKEN:'',
 GROQ_API_KEY:'',GEMINI_API_KEY:'',DEEPGRAM_API_KEY:'',RUMIK_API_KEY:'',
 PAYU_KEY:'',PAYU_SALT:'',CALCOM_API_KEY:'',KOKORO_BASE_URL:'',
 PUBLIC_ORIGIN:'http://127.0.0.1:8788',RAPIDX_PUBLIC_URL:'http://127.0.0.1:8788',
});
console.log('Onboarding development sandbox: http://127.0.0.1:8788/start.html');
console.log('Agents are saved as local drafts. No live calls, email or payment actions are made.');
require('../server');
