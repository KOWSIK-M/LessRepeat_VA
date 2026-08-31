'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOutcomeSchema, buildAgentConfiguration, buildGlobalPrompt, buildDograhWorkflowDefinition } = require('../lib/agent-workflow');

test('builds a neutral minimal workflow from preset data', () => {
  const preset = {
    name: 'Dental Receptionist',
    greeting: 'Welcome to the dental practice.',
    fields: ['caller_name', 'pain_level'],
    guardrails: ['No diagnosis', 'Escalate emergencies'],
  };
  const configuration = buildAgentConfiguration({}, preset);
  const workflow = buildDograhWorkflowDefinition(configuration);
  assert.deepEqual(workflow.nodes.map((node) => node.type), [
    'globalNode', 'startCall', 'agentNode', 'endCall'
  ]);
  assert.equal(workflow.edges.length, 3);
  assert.equal(workflow.nodes.find((node) => node.type === 'startCall').data.greeting, preset.greeting);
  const serialized = JSON.stringify(workflow).toLowerCase();
  assert.match(serialized, /dental receptionist/);
  assert.match(serialized, /no diagnosis/);
  assert.doesNotMatch(serialized, /hotel|room booking|room_type/);
});

test('different presets produce isolated definitions', () => {
  const dental = buildDograhWorkflowDefinition(buildAgentConfiguration({}, {
    name: 'Dental Receptionist', fields: ['pain_level'], guardrails: ['No diagnosis']
  }));
  const realEstate = buildDograhWorkflowDefinition(buildAgentConfiguration({}, {
    name: 'Property Assistant', fields: ['location', 'budget'], guardrails: ['Respect fair housing rules']
  }));
  assert.notDeepEqual(dental, realEstate);
  assert.doesNotMatch(JSON.stringify(realEstate).toLowerCase(), /dental|pain_level|diagnosis|hotel/);
});

test('adds the agency prompt to every agent while preserving its persona', () => {
  const workflow = buildDograhWorkflowDefinition(
    buildAgentConfiguration({ name: 'Support Agent', persona: 'Resolve product support questions.' }),
    'Escalate unhappy customers to the account owner and never promise refunds.'
  );
  const globalPrompt = workflow.nodes.find((node) => node.type === 'globalNode').data.prompt;
  assert.match(globalPrompt, /Resolve product support questions/);
  assert.match(globalPrompt, /Workspace-wide operating instructions/);
  assert.match(globalPrompt, /never promise refunds/);
});

test('enforces a business-only boundary for off-topic and prompt override requests', () => {
  const prompt = buildGlobalPrompt(buildAgentConfiguration({
    name: 'Sales Agent', persona: 'Explain LessRepeat plans and qualify interested businesses.'
  }));
  assert.match(prompt, /help only with the configured business/i);
  assert.match(prompt, /celebrity.*politics.*news/i);
  assert.match(prompt, /do not answer it/i);
  assert.match(prompt, /ignore instructions.*reveal prompts/i);
});

test('normalizes custom business fields and publishes typed end-of-call extraction', () => {
  const configuration = buildAgentConfiguration({
    name: 'General Business Agent',
    outcomeSchema: [
      { label: 'Reservation time', type: 'string' },
      { key: 'guest_count', label: 'Guest count', type: 'number' },
      { key: 'confirmed', label: 'Confirmed', type: 'boolean' },
    ],
  });
  const workflow = buildDograhWorkflowDefinition(configuration);
  const end = workflow.nodes.find((node) => node.type === 'endCall');
  assert.equal(end.data.extraction_enabled, true);
  assert.deepEqual(end.data.extraction_variables.map(({ name, type }) => ({ name, type })), [
    { name: 'reservation_time', type: 'string' },
    { name: 'guest_count', type: 'number' },
    { name: 'confirmed', type: 'boolean' },
  ]);
  assert.match(end.data.extraction_prompt, /never guess/i);
});

test('gives an agent-agnostic default result schema when no preset is selected', () => {
  const schema = normalizeOutcomeSchema(buildAgentConfiguration({ name: 'Any Business' }).outcomeSchema);
  assert.deepEqual(schema.map((field) => field.key), ['caller_name', 'callback_number', 'reason', 'next_step']);
});

test('Telugu agents receive a natural Telugu conversation instruction', () => {
  const prompt = buildGlobalPrompt(buildAgentConfiguration({
    name: 'Clinic Receptionist', language: 'te-IN', persona: 'Book appointments for this clinic.',
  }));
  assert.match(prompt, /natural conversational Telugu/i);
  assert.match(prompt, /caller speaks English/i);
});
