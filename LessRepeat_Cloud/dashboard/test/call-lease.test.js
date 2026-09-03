'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {legacyDemoDeadline}=require('../lib/call-meter');

test('abandoned legacy demos expire after their configured duration and connection grace, not an hour',()=>{
  const created='2026-09-03T11:27:10.797Z';
  const run={created_at:created,initial_context:{source:'public_demo',max_session_seconds:'300'}};
  assert.equal(legacyDemoDeadline(run),Date.parse(created)+420000);
  assert.ok(legacyDemoDeadline(run)<Date.parse('2026-09-03T11:35:33Z'));
  assert.equal(legacyDemoDeadline({...run,initial_context:{source:'phone',max_session_seconds:300}}),null);
  assert.equal(legacyDemoDeadline({...run,initial_context:{source:'public_demo',max_session_seconds:'invalid'}}),null);
  assert.equal(legacyDemoDeadline({...run,created_at:'invalid'}),null);
});
