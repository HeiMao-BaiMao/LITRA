/* Dependency-free contract tests for the preview adapter, not browser/WASM QA. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, 'tauri-fixture.js'), 'utf8');
const providers = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config/default-providers.json'), 'utf8')).providers;

function fixture(mode = 'populated', kind = 'main') {
  const warnings = [];
  const handlers = new Map();
  const context = {
    URL, URLSearchParams, Map, Set, Promise, structuredClone,
    location: { href: `http://127.0.0.1:4173/current/?fixture=${mode}`, search: `?fixture=${mode}` },
    document: { body: { dataset: { rustWindow: kind } } },
    console: { warn: (...args) => warnings.push(args), log() {}, error() {} },
    // Preserve async ordering, but avoid waiting for decorative streaming delays.
    setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, 2)),
    clearTimeout, crypto: webcrypto, performance, devicePixelRatio: 1, innerWidth: 1440, innerHeight: 900,
    addEventListener: (name, callback) => handlers.set(name, callback),
    window: { __LITRA_PREVIEW_PROVIDERS__: structuredClone(providers) }
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'tauri-fixture.js' });
  return { api: context.window.__TAURI__, diagnostics: context.window.__LITRA_PREVIEW__, warnings, handlers };
}

test('main mount command contract returns populated fictional documents', async () => {
  const { api, diagnostics } = fixture();
  const invoke = api.core.invoke;
  const catalog = await invoke('ai_provider_catalog');
  assert.equal(catalog.length, providers.length);
  assert.equal(catalog[0].defaultModel, providers[0].defaultModel);
  const settings = await invoke('ai_settings_snapshot');
  assert.equal(settings.apiKey, '');
  assert.equal((await invoke('ai_runtime_config', { role: 'chat' })).model, settings.chatModel);
  assert.equal((await invoke('load_webdav_sync_config')).enabled, false);
  assert.equal(await invoke('load_window_bounds', { label: 'main' }), null);
  assert.equal(await invoke('load_window_detached', { label: 'chat' }), false);
  const projects = await invoke('project_list');
  assert.equal(projects.length, 2);
  assert.equal((await invoke('project_load', { projectId: projects[0].id })).title, '夜明けの図書館');
  const episodes = await invoke('project_list_episodes', { projectId: projects[0].id });
  assert.equal(episodes.length, 3);
  assert.match(await invoke('project_read_episode', { fileName: episodes[0].fileName }), /雨がやんだ/);
  for (const kind of ['summaries', 'memos', 'chat', 'relationships']) assert.ok(await invoke('project_read_document', { kind }));
  assert.equal((await invoke('list_characters')).characters.length, 2);
  assert.equal((await invoke('list_world_entries')).entries.length, 2);
  assert.equal((await invoke('list_project_memos')).length, 2);
  assert.equal(await invoke('secret_get', { key: 'apikey:openai' }), null);
  assert.equal(await invoke('oauth_credential_status', { provider: 'codex' }), false);
  assert.equal(await invoke('plugin:updater|check'), null);
  assert.equal((await invoke('ai_list_models', { request: { provider: settings.provider } })).length, providers[0].models.length);
  assert.equal(diagnostics.unsupported.length, 0);
  assert.ok(diagnostics.calls.every(c => Object.keys(c).sort().join(',') === 'at,command'));
});

test('settings and editor saves are memory-only, support serde Map arguments and reset', async () => {
  const { api } = fixture();
  const original = await api.core.invoke('ai_settings_snapshot');
  await api.core.invoke('ai_settings_save', new Map([['settings', new Map([['provider', 'anthropic'], ['apiKey', 'fictional-test-value']])]]));
  assert.equal((await api.core.invoke('ai_settings_snapshot')).provider, 'anthropic');
  await api.core.invoke('ai_settings_reset');
  assert.equal((await api.core.invoke('ai_settings_snapshot')).provider, original.provider);
  await api.core.invoke('project_write_episode', { fileName: 'ep-1.txt', content: 'preview-only edit' });
  assert.equal(await api.core.invoke('project_read_episode', { fileName: 'ep-1.txt' }), 'preview-only edit');
  const fresh = fixture();
  assert.match(await fresh.api.core.invoke('project_read_episode', { fileName: 'ep-1.txt' }), /雨がやんだ/);
  assert.equal((await fresh.api.core.invoke('ai_settings_snapshot')).apiKey, '');
});

test('empty and error modes exercise native UI entry points without network', async () => {
  const empty = fixture('empty');
  assert.equal((await empty.api.core.invoke('project_list')).length, 0);
  assert.equal(await empty.api.core.invoke('load_last_project_id'), null);
  const error = fixture('error');
  await assert.rejects(error.api.core.invoke('ai_list_models', { request: { provider: 'openai' } }), /プレビュー用エラー/);
  await assert.rejects(error.api.core.invoke('ai_stream_text', { request: {}, onEvent: {} }), /プレビュー用エラー/);
});

test('normal stream emits fixed deltas and a finished event', async () => {
  const { api } = fixture();
  const events = [];
  await api.core.invoke('ai_stream_text', { request: { requestId: 'fixture-stream' }, onEvent: { onmessage: event => events.push(event) } });
  assert.equal(events.filter(e => e.type === 'text_delta').length, 3);
  assert.match(events[0].delta, /固定応答/);
  assert.equal(events.at(-1).type, 'finished');
  assert.equal(events.at(-1).finish_reason, 'stop');
});

test('loading mode remains pending until cancellation and reports cancelled', async () => {
  const { api } = fixture('loading');
  const events = [];
  let settled = false;
  const stream = api.core.invoke('ai_stream_text', { request: { requestId: 'fixture-loading' }, onEvent: { onmessage: event => events.push(event) } }).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  await api.core.invoke('ai_cancel', { requestId: 'fixture-loading' });
  await stream;
  assert.equal(settled, true);
  assert.equal(events.at(-1).type, 'cancelled');
  let modelsSettled = false;
  api.core.invoke('ai_list_models', { request: { provider: 'openai' } }).then(() => { modelsSettled = true; });
  await Promise.resolve();
  assert.equal(modelsSettled, false);
});

test('detached seed is delivered through the actual event interface', async () => {
  const { api } = fixture('populated', 'chat');
  let chat;
  const unsubscribe = await api.event.listen('chat-sync', event => { chat = event.payload; });
  await api.event.emit('chat-ready', new Map());
  assert.equal(chat.messages.length, 2);
  assert.equal(chat.isGenerating, false);
  unsubscribe();
  await api.event.emit('chat-sync', { messages: [] });
  assert.equal(chat.messages.length, 2);
});

test('unknown commands warn and fail rather than imply native success', async () => {
  const { api, warnings, diagnostics } = fixture();
  await assert.rejects(api.core.invoke('start_codex_browser_auth'), /does not implement/);
  assert.equal(warnings.length, 1);
  assert.equal(diagnostics.unsupported[0], 'start_codex_browser_auth');
  await assert.rejects(api.opener.openUrl('https://example.com'), /disabled/);
});
