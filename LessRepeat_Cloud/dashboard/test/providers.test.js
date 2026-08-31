'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const providersPath = require.resolve('../lib/providers');
const corePath = require.resolve('../lib/core');
const originalEnv = { ...process.env };

function resetEnv(values = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv, values);
  for (const key of ['LLM_PROVIDER', 'LLM_MODEL', 'TTS_PROVIDER', 'TTS_MODEL', 'STT_PROVIDER',
    'GROQ_ALLOWED_MODELS', 'GEMINI_ALLOWED_MODELS', 'GEMINI_TTS_MODEL']) {
    if (!(key in values)) delete process.env[key];
  }
}

function loadProviders(httpsPost) {
  delete require.cache[providersPath];
  delete require.cache[corePath];
  const core = require(corePath);
  if (httpsPost) core.httpsPost = httpsPost;
  require.cache[corePath].exports = core;
  return require(providersPath);
}

test.afterEach(() => {
  resetEnv();
  delete require.cache[providersPath];
  delete require.cache[corePath];
});

test('registry advertises only implemented providers and keeps Deepgram as sole STT', () => {
  resetEnv();
  const providers = loadProviders();
  const described = providers.describeProviders();
  assert.deepEqual(described.stt.map((row) => row.id), ['deepgram']);
  assert.deepEqual(described.tts.map((row) => row.id), ['rumik', 'kokoro', 'gemini_tts']);
  assert.deepEqual(described.llm.map((row) => row.id), ['groq', 'gemini']);
  assert.deepEqual(described.telephony.map((row) => row.id), ['vobiz']);
  assert.equal(JSON.stringify(described).includes('API_KEY_VALUE'), false);
  assert.ok(Object.values(described).flat().every((row) => row.implemented === true));
});

test('Kokoro catalog exposes ten Indian voice presets including requested personas', () => {
  resetEnv();
  const providers = loadProviders();
  assert.equal(providers.KOKORO_VOICE_PRESETS.length, 10);
  assert.ok(providers.KOKORO_VOICES.has('hm_omega(2)+hm_psi(1)'));
  assert.ok(providers.KOKORO_VOICES.has('hm_omega(1)+hm_psi(2)'));
  assert.ok(providers.KOKORO_VOICES.has('hf_alpha(1)+hf_beta(2)'));
  assert.ok(providers.KOKORO_VOICE_PRESETS.every((voice) => voice.speed >= 0.75 && voice.speed <= 1.2));
});

test('environment selects an implemented LLM and model without tenant secrets', () => {
  resetEnv({ LLM_PROVIDER: 'gemini', LLM_MODEL: 'gemini-2.5-flash', GEMINI_API_KEY: 'server-only' });
  const providers = loadProviders();
  assert.equal(providers.llm.id, 'gemini');
  const choice = providers.resolveSelection('llm', { provider: 'gemini', model: 'gemini-2.5-flash' });
  assert.equal(choice.provider, 'gemini');
  assert.equal(choice.model, 'gemini-2.5-flash');
  assert.equal(choice.adapter.live, true);
  assert.throws(
    () => providers.resolveSelection('llm', { provider: 'gemini', apiKey: 'tenant-secret' }),
    (error) => error.code === 'unsafe_provider_selection',
  );
});

test('unknown providers and malformed model identifiers fail closed', () => {
  resetEnv();
  const providers = loadProviders();
  assert.throws(() => providers.get('llm', 'made-up'), (error) => error.code === 'unsupported_provider');
  assert.throws(
    () => providers.resolveSelection('llm', { provider: 'groq', model: '../secret' }),
    (error) => error.code === 'invalid_model',
  );
});

test('STT cannot be switched away from Deepgram', () => {
  resetEnv();
  const providers = loadProviders();
  assert.throws(
    () => providers.resolveSelection('stt', { provider: 'whisper', model: 'whisper-1' }),
    (error) => error.code === 'stt_provider_fixed',
  );
});

test('model allowlists validate tenant-selected models', () => {
  resetEnv({
    GROQ_ALLOWED_MODELS: 'llama-3.3-70b-versatile,openai/gpt-oss-20b',
    GEMINI_ALLOWED_MODELS: 'gemini-flash-latest,gemini-2.5-flash',
  });
  const providers = loadProviders();
  assert.equal(
    providers.resolveSelection('llm', { provider: 'groq', model: 'openai/gpt-oss-20b' }).model,
    'openai/gpt-oss-20b',
  );
  assert.throws(
    () => providers.resolveSelection('llm', { provider: 'groq', model: 'other-model' }),
    (error) => error.code === 'model_not_enabled',
  );
  assert.equal(
    providers.resolveSelection('llm', { provider: 'gemini', model: 'gemini-2.5-flash' }).model,
    'gemini-2.5-flash',
  );
  assert.throws(
    () => providers.resolveSelection('llm', { provider: 'gemini', model: 'gemini-3-unknown' }),
    (error) => error.code === 'model_not_enabled',
  );
});

test('registry contract accepts a complete mock TTS adapter and rejects incomplete adapters', async () => {
  resetEnv();
  const providers = loadProviders();
  assert.throws(
    () => providers.registerProvider('tts', { id: 'broken', layer: 'tts', synthesize: async () => ({}) }),
    (error) => error.code === 'invalid_provider_adapter',
  );
  const mock = {
    id: 'mock_tts', label: 'Mock TTS', layer: 'tts', needs: [], implemented: true,
    models: new Set(['mock-v1']), model: 'mock-v1', live: true,
    async synthesize({ text }) { return { buffer: Buffer.from(text), chars: text.length }; },
    async wsConnect() { return { ws_url: 'wss://example.test', token: 'ephemeral' }; },
  };
  providers.registerProvider('tts', mock);
  const selected = providers.resolveSelection('tts', { provider: 'mock_tts', model: 'mock-v1' });
  assert.equal(selected.adapter, mock);
  assert.equal((await selected.adapter.synthesize({ text: 'hello' })).chars, 5);
});

test('Groq adapter sends selected model and normalizes its response with mocked HTTP', async () => {
  resetEnv({ GROQ_API_KEY: 'groq-test', LLM_PROVIDER: 'groq' });
  let request;
  const providers = loadProviders(async (host, path, headers, body) => {
    request = { host, path, headers, payload: JSON.parse(body.toString('utf8')) };
    return {
      status: 200,
      headers: {},
      buffer: Buffer.from(JSON.stringify({ choices: [{ message: { content: 'Hello.' }, finish_reason: 'stop' }] })),
    };
  });
  const output = await providers.llm.chat({
    model: 'openai/gpt-oss-20b', messages: [{ role: 'user', text: 'Hi' }],
  });
  assert.equal(request.host, 'api.groq.com');
  assert.equal(request.path, '/openai/v1/chat/completions');
  assert.equal(request.payload.model, 'openai/gpt-oss-20b');
  assert.equal(request.headers.Authorization, 'Bearer groq-test');
  assert.equal(output.text, 'Hello.');
  assert.equal(output.provider, 'groq');
  assert.equal(output.model, 'openai/gpt-oss-20b');
});

test('environment dispatches the same LLM contract to the fully wired Gemini adapter', async () => {
  resetEnv({ GEMINI_API_KEY: 'gemini-test', LLM_PROVIDER: 'gemini' });
  let pathSeen = '';
  const providers = loadProviders(async (_host, path) => {
    pathSeen = path;
    return {
      status: 200,
      headers: {},
      buffer: Buffer.from(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'Namaste.' }] }, finishReason: 'STOP' }],
      })),
    };
  });
  const output = await providers.llm.chat({
    model: 'gemini-2.5-flash', messages: [{ role: 'user', text: 'Hi' }],
  });
  assert.match(pathSeen, /gemini-2\.5-flash:generateContent/);
  assert.equal(output.provider, 'gemini');
  assert.equal(output.model, 'gemini-2.5-flash');
  assert.equal(output.text, 'Namaste.');
});

test('Rumik adapter validates its model and synthesizes with mocked HTTP', async () => {
  resetEnv({ RUMIK_API_KEY: 'rumik-test' });
  let payload;
  const providers = loadProviders(async (_host, _path, _headers, body) => {
    payload = JSON.parse(body.toString('utf8'));
    return { status: 200, headers: { 'x-credits-used': '1' }, buffer: Buffer.from('RIFFmock') };
  });
  const output = await providers.get('tts', 'rumik').synthesize({ text: 'Hello', model: 'mulberry' });
  assert.equal(payload.model, 'mulberry');
  assert.equal(output.chars, 5);
  assert.throws(
    () => providers.resolveSelection('tts', { provider: 'rumik', model: 'unknown' }),
    (error) => error.code === 'unsupported_model',
  );
});

test('Gemini Telugu TTS sends the selected voice and wraps returned PCM as WAV', async () => {
  resetEnv({ GEMINI_API_KEY: 'gemini-test' });
  let request;
  const pcm = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0]);
  const providers = loadProviders(async (host, path, headers, body) => {
    request = { host, path, headers, payload: JSON.parse(body.toString('utf8')) };
    return {
      status: 200,
      headers: {},
      buffer: Buffer.from(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }] })),
    };
  });
  const output = await providers.get('tts', 'gemini_tts').synthesize({
    text: 'నమస్కారం', model: 'gemini-2.5-flash-preview-tts', speaker: 'Achird',
  });
  assert.equal(request.host, 'generativelanguage.googleapis.com');
  assert.match(request.path, /gemini-2\.5-flash-preview-tts:generateContent/);
  assert.equal(request.payload.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Achird');
  assert.match(request.payload.contents[0].parts[0].text, /నమస్కారం/);
  assert.equal(output.buffer.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(output.buffer.length, 44 + pcm.length);
});

test('Deepgram transcription remains the only mocked STT network path', async () => {
  resetEnv({ DEEPGRAM_API_KEY: 'deepgram-test' });
  let request;
  const providers = loadProviders(async (host, path, headers) => {
    request = { host, path, headers };
    return {
      status: 200,
      headers: {},
      buffer: Buffer.from(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: 'hello' }] }] } })),
    };
  });
  const output = await providers.stt.transcribe({ audio: Buffer.alloc(300).toString('base64'), mime: 'audio/webm' });
  assert.equal(request.host, 'api.deepgram.com');
  assert.match(request.path, /model=nova-3/);
  assert.equal(request.headers.Authorization, 'Token deepgram-test');
  assert.equal(output.provider, 'deepgram');
  assert.equal(output.text, 'hello');
});
