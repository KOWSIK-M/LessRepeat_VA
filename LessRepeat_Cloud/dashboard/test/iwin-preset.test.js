'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const preset = require('../presets/iwin-admissions.json');
const {buildAgentConfiguration,buildDograhWorkflowDefinition} = require('../lib/agent-workflow');

test('I-WIN preset fits admin limits and preserves its business scope in the workflow', () => {
  assert.ok(preset.persona.length <= 1500);
  assert.ok(preset.greeting.length <= 300);
  assert.ok(preset.guardrails.length <= 15);
  assert.ok(preset.guardrails.every(s => s.length <= 200));
  assert.equal(preset.visibility, 'private');
  assert.equal(preset.language, 'te-IN');
  assert.match(preset.greeting, /[\u0C00-\u0C7F]/);
  assert.equal(preset.tts.provider, 'rumik');
  const config = buildAgentConfiguration({},preset);
  const workflow = JSON.stringify(buildDograhWorkflowDefinition(config));
  assert.equal(config.outcomeSchema.length,15);
  assert.equal(config.outcomeSchema.find(f=>f.key==='callback_consent').type,'boolean');
  assert.ok(workflow.includes('I-WIN'));
  assert.ok(workflow.includes('Never guarantee ranks'));
  assert.ok(workflow.includes('Do not ask class, name, exam or phone again'));
  assert.ok(workflow.includes('not automatically sent to I-WIN'));
  assert.ok(workflow.includes('Telugu is the primary and default language'));
  assert.ok(workflow.includes('LANGUAGE PRIORITY'));
  for(const field of config.outcomeSchema) assert.ok(workflow.includes(field.key));
});
