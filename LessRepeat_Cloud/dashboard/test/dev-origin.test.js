'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {isOnboardingLocalOrigin}=require('../lib/dev-origin');
const env={NODE_ENV:'development',ONBOARDING_SANDBOX:'true',PUBLIC_ORIGIN:'http://127.0.0.1:8788'};
const request=(host,origin,peer='127.0.0.1')=>({headers:{host,origin},socket:{remoteAddress:peer}});
test('development preview accepts localhost and 127.0.0.1 on its own port',()=>{
 for(const host of ['localhost:8788','127.0.0.1:8788'])assert.equal(isOnboardingLocalOrigin(request(host,'http://'+host),env),true);
 assert.equal(isOnboardingLocalOrigin(request('localhost:8788','http://localhost:8788','::ffff:127.0.0.1'),env),true);
});
test('local preview exception excludes production, foreign origins, other ports and forwarded host spoofing',()=>{
 const good=request('localhost:8788','http://localhost:8788');
 assert.equal(isOnboardingLocalOrigin(good,{...env,NODE_ENV:'production'}),false);
 assert.equal(isOnboardingLocalOrigin(good,{...env,ONBOARDING_SANDBOX:'false'}),false);
 for(const origin of ['http://localhost:8787','http://localhost:9999','https://example.invalid','null','http://localhost.evil:8788','http://user@localhost:8788','http://localhost:8788/path'])assert.equal(isOnboardingLocalOrigin(request('localhost:8788',origin),env),false,origin);
 assert.equal(isOnboardingLocalOrigin(request('localhost:8788','http://localhost:8788','192.168.1.5'),env),false);
 assert.equal(isOnboardingLocalOrigin({...request('127.0.0.1:8788','http://localhost:8788'),headers:{host:'127.0.0.1:8788',origin:'http://localhost:8788','x-forwarded-host':'localhost:8788'}},env),false);
});
