import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const require = createRequire(import.meta.url);
const scrapeState = require('../scrape-state.js');
const backgroundSource = readFileSync(
  new URL('../background.js', import.meta.url),
  'utf8',
);

function createBackground(fetchImplementation) {
  const storage = {};
  const alarms = [];
  let messageListener;
  let alarmListener;
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const names = typeof keys === 'string' ? [keys] : keys;
          return Object.fromEntries(names.map(key => [key, structuredClone(storage[key])]));
        },
        async set(values) {
          Object.assign(storage, structuredClone(values));
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
        },
      },
    },
    runtime: {
      lastError: null,
      onMessage: { addListener(listener) { messageListener = listener; } },
    },
    alarms: {
      create(name, info) { alarms.push({ name, info }); },
      onAlarm: { addListener(listener) { alarmListener = listener; } },
    },
    action: {
      setBadgeText() {},
      setBadgeBackgroundColor() {},
    },
  };
  const context = {
    AbortSignal,
    atob,
    btoa,
    chrome,
    crypto: webcrypto,
    fetch: fetchImplementation,
    importScripts() { context.BrainShadowScrapeState = scrapeState; },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console: { log() {}, warn() {}, error() {} },
  };
  runInNewContext(backgroundSource, context);

  return {
    alarms,
    storage,
    async dispatch(message) {
      return new Promise((resolve, reject) => {
        try {
          const handled = messageListener(message, {}, resolve);
          if (!handled) reject(new Error(`Unhandled message: ${message.type}`));
        } catch (error) {
          reject(error);
        }
      });
    },
    fireAlarm(name) {
      alarmListener({ name });
    },
  };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Timed out waiting for background state');
}

function tokenFor(userId) {
  const payload = btoa(JSON.stringify({ userId }))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `header.${payload}.signature`;
}

test('captured conversations are automatically synchronized using the authenticated account', async () => {
  const requests = [];
  const worker = createBackground(async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 202,
      async json() { return { id: 'saved-on-backend', status: 'PENDING' }; },
    };
  });

  await worker.dispatch({ type: 'SET_BACKEND_URL', url: 'https://sync.example.test' });
  await worker.dispatch({ type: 'SET_JWT', token: tokenFor('user-a') });
  const result = await worker.dispatch({
    type: 'SAVE_CONVERSATION',
    source: 'bulk',
    payload: {
      external_id: 'chat-1',
      platform: 'chatgpt',
      title: 'Imported chat',
      messages: [{ role: 'user', content: 'hello' }],
    },
  });

  assert.equal(result.status, 'saved');
  await waitFor(() => {
    const conversation = Object.values(worker.storage.brain_shadow_conversations || {})[0];
    return conversation?.synced === true;
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://sync.example.test/api/import/capture');
  assert.match(requests[0].options.headers.Authorization, /^Bearer /);
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.external_id, 'chat-1');
  assert.equal(payload.userId, undefined);
  assert.equal(payload.ownerUserId, undefined);

  const meta = await worker.dispatch({ type: 'GET_META' });
  assert.deepEqual(
    JSON.parse(JSON.stringify(meta)),
    { total_conversations: 1, total_messages: 1, platforms: { chatgpt: 1 }, last_updated: meta.last_updated },
  );
});

test('failed synchronization retains local capture and a retry can confirm persistence', async () => {
  let shouldFail = true;
  const worker = createBackground(async () => {
    if (shouldFail) {
      return {
        ok: false,
        status: 503,
        statusText: 'Unavailable',
        async text() { return 'temporarily unavailable'; },
      };
    }
    return {
      ok: true,
      status: 202,
      async json() { return { id: 'saved-on-backend', status: 'PENDING' }; },
    };
  });

  await worker.dispatch({ type: 'SET_BACKEND_URL', url: 'https://sync.example.test' });
  await worker.dispatch({ type: 'SET_JWT', token: tokenFor('user-a') });
  await worker.dispatch({
    type: 'SAVE_CONVERSATION',
    source: 'bulk',
    payload: {
      external_id: 'chat-2',
      platform: 'claude',
      title: 'Retained chat',
      messages: [{ role: 'assistant', content: 'still local' }],
    },
  });

  await waitFor(() => {
    const conversation = Object.values(worker.storage.brain_shadow_conversations || {})[0];
    return conversation?.syncStatus === 'failed';
  });
  const failed = Object.values(worker.storage.brain_shadow_conversations)[0];
  assert.equal(failed.ownerUserId, 'user-a');
  assert.equal(failed.synced, false);
  assert.equal(failed.syncAttempts, 1);
  assert.equal(failed.messages.length, 1);

  shouldFail = false;
  worker.fireAlarm('brain_shadow_sync_retry');
  await waitFor(() => Object.values(worker.storage.brain_shadow_conversations)[0].synced === true);
  assert.equal(Object.values(worker.storage.brain_shadow_conversations)[0].syncStatus, 'synced');
});
