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

function tokenFor(userId) {
  const payload = btoa(JSON.stringify({ userId }))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `header.${payload}.signature`;
}

function createBackground(platformChats, captureStatuses) {
  const storage = {
    brain_shadow_jwt_token: tokenFor('user-a'),
    brain_shadow_conversations: {},
  };
  const progressWrites = [];
  const updateListeners = new Set();
  const tabsById = new Map();
  let nextTabId = 1;
  let messageListener;

  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const names = typeof keys === 'string' ? [keys] : keys;
          return Object.fromEntries(names.map(key => [key, structuredClone(storage[key])]));
        },
        async set(values) {
          Object.assign(storage, structuredClone(values));
          if (values.brain_shadow_scrape_progress) {
            progressWrites.push(structuredClone(values.brain_shadow_scrape_progress));
          }
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
    alarms: { create() {}, onAlarm: { addListener() {} } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    tabs: {
      onUpdated: {
        addListener(listener) { updateListeners.add(listener); },
        removeListener(listener) { updateListeners.delete(listener); },
      },
      create({ url }, callback) {
        const id = nextTabId++;
        const host = new URL(url).hostname;
        const platform = Object.entries(platformChats).find(([, chats]) =>
          chats.some(chat => new URL(chat.url).hostname === host),
        )?.[0];
        tabsById.set(id, { url, platform });
        setTimeout(() => {
          for (const listener of updateListeners) listener(id, { status: 'complete' });
        }, 0);
        callback({ id });
      },
      update(id, { url }, callback) {
        if (url) {
          const host = new URL(url).hostname;
          const platform = Object.entries(platformChats).find(([, chats]) =>
            chats.some(chat => new URL(chat.url).hostname === host),
          )?.[0];
          Object.assign(tabsById.get(id), { url, platform });
        }
        setTimeout(() => {
          for (const listener of updateListeners) listener(id, { status: 'complete' });
        }, 0);
        callback?.({});
      },
      remove(id) {
        tabsById.delete(id);
        return Promise.resolve();
      },
      sendMessage(id, message, callback) {
        const platform = tabsById.get(id)?.platform;

        if (message.type === 'PING') {
          callback({ pong: true, messageCount: 1 });
          return;
        }
        if (message.type === 'DISCOVERY_POLL') {
          callback({ done: true, total: platformChats[platform].length });
          return;
        }
        if (message.type === 'GET_DISCOVERED_CHATS') {
          callback({ done: true, chats: platformChats[platform] });
          return;
        }
        if (message.type === 'CAPTURE_CURRENT') {
          const chat = platformChats[platform].find(item => item.url === tabsById.get(id)?.url);
          const status = captureStatuses[chat.external_id];
          if (status === 'error') {
            captureAttempts[chat.external_id] = (captureAttempts[chat.external_id] || 0) + 1;
            callback({ status: 'error', error: 'capture failed' });
            return;
          }
          dispatch({
            type: 'SAVE_CONVERSATION',
            source: 'bulk',
            ownerUserId: message.ownerUserId,
            payload: {
              platform,
              external_id: chat.external_id,
              title: chat.title,
              url: chat.url,
              messages: [{ role: 'user', content: `message-${chat.external_id}` }],
            },
          }).then(callback);
          return;
        }
        callback({ ok: true });
      },
    },
  };
  const captureAttempts = {};

  function dispatch(message) {
    return new Promise((resolve, reject) => {
      try {
        const handled = messageListener(message, {}, resolve);
        if (!handled) reject(new Error(`Unhandled message: ${message.type}`));
      } catch (error) {
        reject(error);
      }
    });
  }

  const context = {
    AbortSignal,
    atob,
    btoa,
    chrome,
    crypto: webcrypto,
    fetch: async () => ({
      ok: true,
      status: 202,
      statusText: 'Accepted',
      async json() { return { id: 'saved-on-backend', status: 'PENDING' }; },
    }),
    importScripts() { context.BrainShadowScrapeState = scrapeState; },
    setTimeout(callback, delay, ...args) {
      return setTimeout(callback, Math.min(delay, 20), ...args);
    },
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
    console: { log() {}, warn() {}, error() {} },
  };
  runInNewContext(backgroundSource, context);

  return { captureAttempts, dispatch, progressWrites, storage };
}

async function waitFor(predicate, details) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Timed out waiting for background progress: ${details?.() || 'no details'}`);
}

test('background reports complete-queue progress and separate live counters per platform', async () => {
  const chatgptChats = [
    { external_id: 'already-saved', title: 'Existing', url: 'https://chatgpt.com/c/already-saved' },
    { external_id: 'failed', title: 'Fails', url: 'https://chatgpt.com/c/failed' },
    { external_id: 'captured', title: 'Captured', url: 'https://chatgpt.com/c/captured' },
  ];
  const claudeChats = [
    { external_id: 'claude-captured', title: 'Claude capture', url: 'https://claude.ai/chat/claude-captured' },
  ];
  const worker = createBackground(
    { chatgpt: chatgptChats, claude: claudeChats },
    { failed: 'error', captured: 'saved', 'claude-captured': 'saved' },
  );
  const key = scrapeState.accountConversationKey('user-a', 'chatgpt', 'already-saved');
  worker.storage.brain_shadow_conversations[key] = {
    ownerUserId: 'user-a',
    platform: 'chatgpt',
    external_id: 'already-saved',
    url: chatgptChats[0].url,
    saved_at: new Date().toISOString(),
    messages: [{ role: 'user', content: 'existing' }],
    synced: true,
  };

  await Promise.all([
    worker.dispatch({
      type: 'START_PLATFORM_IMPORT',
      platform: 'chatgpt',
      baseUrl: 'https://chatgpt.com',
    }),
    worker.dispatch({
      type: 'START_PLATFORM_IMPORT',
      platform: 'claude',
      baseUrl: 'https://claude.ai',
    }),
  ]);

  await waitFor(() => {
    const sessions = worker.storage.brain_shadow_scrape_progress?.sessions || {};
    return sessions.chatgpt?.done && sessions.claude?.done
      && sessions.chatgpt.syncedCount === 1 && sessions.claude.syncedCount === 1;
  }, () => JSON.stringify({
    sessions: worker.storage.brain_shadow_scrape_progress?.sessions,
    writes: worker.progressWrites.slice(-8),
    attempts: worker.captureAttempts,
  }));

  const chatgptScrapeStart = worker.progressWrites.find(progress =>
    progress.sessions?.chatgpt?.phase === 'scrape'
    && progress.sessions.chatgpt.current === 0,
  );
  assert.equal(chatgptScrapeStart.sessions.chatgpt.total, 3);

  const chatgptProgress = worker.progressWrites
    .map(progress => progress.sessions?.chatgpt)
    .filter(session => session?.phase === 'scrape')
    .map(session => session.current);
  assert.deepEqual(
    chatgptProgress.filter((current, index) => index === 0 || current !== chatgptProgress[index - 1]),
    [0, 1, 2, 3],
  );

  const sessions = worker.storage.brain_shadow_scrape_progress.sessions;
  assert.deepEqual(
    {
      current: sessions.chatgpt.current,
      total: sessions.chatgpt.total,
      savedCount: sessions.chatgpt.savedCount,
      syncedCount: sessions.chatgpt.syncedCount,
      failedCount: sessions.chatgpt.failedCount,
      skipped: sessions.chatgpt.skipped,
    },
    { current: 3, total: 3, savedCount: 1, syncedCount: 1, failedCount: 1, skipped: 1 },
  );
  assert.deepEqual(
    {
      current: sessions.claude.current,
      total: sessions.claude.total,
      savedCount: sessions.claude.savedCount,
      syncedCount: sessions.claude.syncedCount,
      failedCount: sessions.claude.failedCount,
      skipped: sessions.claude.skipped,
    },
    { current: 1, total: 1, savedCount: 1, syncedCount: 1, failedCount: 0, skipped: 0 },
  );
  assert.equal(worker.captureAttempts.failed, 3);
});
