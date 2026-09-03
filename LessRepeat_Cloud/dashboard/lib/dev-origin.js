'use strict';

// Accept a same-origin browser request through either local preview hostname.
// Never relax the configured origin for production, other ports or proxy hosts.
function isOnboardingLocalOrigin(req, env=process.env) {
  if(env.NODE_ENV==='production'||env.ONBOARDING_SANDBOX!=='true')return false;
  const peer=String(req.socket?.remoteAddress||'').replace(/^::ffff:/,'');
  if(!['127.0.0.1','::1'].includes(peer))return false;
  try {
    const origin=String(req.headers.origin||'').trim();
    const configured=new URL(env.PUBLIC_ORIGIN||'');
    if(configured.protocol!=='http:'||!['localhost','127.0.0.1'].includes(configured.hostname))return false;
    const port=configured.port?`:${configured.port}`:'';
    const localOrigins=new Set([`http://localhost${port}`,`http://127.0.0.1${port}`]);
    const requestOrigin=`${req.socket?.encrypted?'https':'http'}://${String(req.headers.host||'').trim()}`;
    return localOrigins.has(origin)&&origin===requestOrigin;
  } catch { return false; }
}

module.exports={isOnboardingLocalOrigin};
