import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  accountConversationKey,
  applyConversationCapture,
  applySyncResult,
  completedProgress,
  conversationsForUser,
  createInitialProgress,
  createSerialQueue,
  deriveConversationMeta,
  deriveDashboardStats,
  getTokenUserId,
  mergeSessionProgress,
  normalizePlatform,
  pendingConversationsForUser,
  recordCaptureResult,
  recordScrapeSync,
} = require('../scrape-state.js');

function makeConversation(platform, externalId, messageCount, suffix = '') {
  return {
    platform,
    external_id: externalId,
    title: `${platform} ${externalId}`,
    messages: Array.from({ length: messageCount }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      content: `message-${index}${suffix}`,
    })),
  };
}

test('scrape progress advances for every attempted conversation, including failures and skips', () => {
  const initial = createInitialProgress('run', 'start', 'user-a');
  assert.equal(initial.current, 0);
  assert.equal(initial.total, 0);

  const firstTotal = 40;
  assert.deepEqual(completedProgress(0, firstTotal), { current: 0, pct: 0 });
  assert.deepEqual(completedProgress(1, firstTotal), { current: 1, pct: 3 });
  assert.deepEqual(completedProgress(2, firstTotal), { current: 2, pct: 5 });

  let counts = { current: 0, savedCount: 0, syncedCount: 0, failedCount: 0, skipped: 0 };
  counts = recordCaptureResult(counts, { status: 'saved', synced: true });
  assert.deepEqual(counts, { current: 1, savedCount: 1, syncedCount: 1, failedCount: 0, skipped: 0 });
  counts = recordCaptureResult(counts, { status: 'skipped' });
  assert.deepEqual(counts, { current: 2, savedCount: 1, syncedCount: 1, failedCount: 0, skipped: 1 });
  counts = recordCaptureResult(counts, { status: 'error' });
  assert.deepEqual(counts, { current: 3, savedCount: 1, syncedCount: 1, failedCount: 1, skipped: 1 });

  counts = recordScrapeSync({ syncedCount: 1 });
  assert.equal(counts.syncedCount, 2);
});

test('platform scrape progress remains independent', () => {
  const sessions = {};
  for (const platform of ['chatgpt', 'claude']) {
    sessions[platform] = mergeSessionProgress(
      createInitialProgress(`${platform}-run`),
      { phase: 'scrape', current: 0, total: 2, pct: 0 },
    );
  }

  sessions.chatgpt = mergeSessionProgress(sessions.chatgpt, completedProgress(1, 2));
  assert.equal(sessions.chatgpt.current, 1);
  assert.equal(sessions.claude.current, 0);
  assert.equal(sessions.claude.total, 2);
});

test('captured totals count unique conversations and replace message contributions on update', () => {
  let store = {};
  let capture = applyConversationCapture(store, makeConversation('chatgpt', 'chat-1', 5), 'bulk', 'user-a', 't1');
  assert.equal(capture.status, 'saved');
  assert.equal(capture.created, true);
  store = capture.conversations;
  assert.deepEqual(capture.meta, {
    total_conversations: 1,
    total_messages: 5,
    platforms: { chatgpt: 1 },
  });

  capture = applyConversationCapture(store, makeConversation('chatgpt', 'chat-1', 5), 'bulk', 'user-a', 't2');
  assert.equal(capture.status, 'skipped');
  assert.equal(capture.meta.total_conversations, 1);
  assert.equal(capture.meta.total_messages, 5);

  capture = applyConversationCapture(store, makeConversation('chatgpt', 'chat-2', 7), 'bulk', 'user-a', 't3');
  store = capture.conversations;
  assert.equal(capture.meta.total_conversations, 2);
  assert.equal(capture.meta.total_messages, 12);

  capture = applyConversationCapture(
    store,
    makeConversation('chatgpt', 'chat-1', 3, '-updated'),
    'bulk',
    'user-a',
    't4',
  );
  store = capture.conversations;
  assert.equal(capture.status, 'saved');
  assert.equal(capture.created, false);
  assert.equal(capture.meta.total_conversations, 2);
  assert.equal(capture.meta.total_messages, 10);

  capture = applyConversationCapture(store, makeConversation('claude', 'claude-1', 4), 'bulk', 'user-a', 't5');
  assert.equal(capture.meta.total_conversations, 3);
  assert.equal(capture.meta.total_messages, 14);
  assert.deepEqual(capture.meta.platforms, { chatgpt: 2, claude: 1 });
});

test('discovery does not increment captured dashboard counters before extraction', () => {
  const stats = deriveDashboardStats(
    { total_conversations: 0, total_messages: 0, platforms: {} },
    { sessions: { chatgpt: { running: true, discovered: 40, total: 40 } } },
  );
  assert.deepEqual(stats, {
    totalConversations: 0,
    totalMessages: 0,
    totalPlatforms: 0,
    platforms: {},
  });
});

test('all supported adapters share platform normalization and counted capture flow', () => {
  const platforms = ['chatgpt', 'claude', 'gemini', 'deepseek', 'perplexity', 'blackbox', 'copilot', 'grok'];
  let store = {};
  for (const [index, platform] of platforms.entries()) {
    const capture = applyConversationCapture(
      store,
      makeConversation(platform, `conversation-${index}`, 1),
      'bulk',
      'user-a',
      `t${index}`,
    );
    store = capture.conversations;
  }
  const meta = deriveConversationMeta(store, 'user-a');
  assert.equal(meta.total_conversations, platforms.length);
  assert.equal(meta.total_messages, platforms.length);
  assert.equal(Object.keys(meta.platforms).length, platforms.length);
});

test('same-length content changes update the record while unchanged recaptures deduplicate', () => {
  const first = applyConversationCapture({}, makeConversation('chatgpt', 'id', 2), 'realtime', 'user-a', 't1');
  const changed = applyConversationCapture(
    first.conversations,
    makeConversation('chatgpt', 'id', 2, '-changed'),
    'realtime',
    'user-a',
    't2',
  );
  assert.equal(changed.status, 'saved');
  assert.equal(changed.created, false);
  assert.equal(changed.conversation.synced, false);
  assert.equal(changed.conversation.syncAttempts, 0);
  const duplicate = applyConversationCapture(
    changed.conversations,
    makeConversation('chatgpt', 'id', 2, '-changed'),
    'bulk',
    'user-a',
    't3',
  );
  assert.equal(duplicate.status, 'skipped');
  assert.equal(duplicate.meta.total_messages, 2);
});

test('account partitioning prevents cross-user visibility and retry reassignment', () => {
  let store = {};
  for (const ownerUserId of ['user-a', 'user-b']) {
    const capture = applyConversationCapture(
      store,
      makeConversation('chatgpt', 'same-external-id', 2),
      'bulk',
      ownerUserId,
      ownerUserId,
    );
    store = capture.conversations;
  }
  assert.notEqual(
    accountConversationKey('user-a', 'chatgpt', 'same-external-id'),
    accountConversationKey('user-b', 'chatgpt', 'same-external-id'),
  );
  assert.equal(conversationsForUser(store, 'user-a').length, 1);
  assert.equal(conversationsForUser(store, 'user-b').length, 1);
  assert.equal(conversationsForUser(store, null).length, 0);

  const pending = pendingConversationsForUser(store, 'user-a');
  assert.equal(pending.length, 1);
  const failed = applySyncResult(pending[0][1], { ok: false, error: 'offline' });
  assert.equal(failed.synced, false);
  assert.equal(failed.syncStatus, 'failed');
  assert.equal(failed.syncAttempts, 1);
  assert.equal(pendingConversationsForUser({ item: failed }, 'user-b').length, 0);
  const synced = applySyncResult(failed, { ok: true });
  assert.equal(synced.synced, true);
  assert.equal(synced.syncStatus, 'synced');
  assert.equal(synced.syncError, null);
});

test('signed token user ID is used only for local account partitioning', () => {
  const payload = btoa(JSON.stringify({ userId: 'user-a' }))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  assert.equal(getTokenUserId(`header.${payload}.signature`), 'user-a');
  assert.equal(getTokenUserId('not-a-token'), null);
});

test('platform aliases normalize to one distinct platform', () => {
  assert.equal(normalizePlatform('chat.openai.com'), 'chatgpt');
  assert.equal(normalizePlatform('githubCopilot'), 'copilot');
  assert.equal(normalizePlatform('Microsoft Copilot'), 'copilot');
  assert.equal(normalizePlatform('www.perplexity.ai'), 'perplexity');
});

test('serialized progress mutations reject stale runs and preserve newer counts', async () => {
  const enqueue = createSerialQueue();
  let session = createInitialProgress('run-1');

  await Promise.all([
    enqueue(async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      session = mergeSessionProgress(session, { runId: 'run-1', current: 2, discovered: 4 });
    }),
    enqueue(async () => {
      session = mergeSessionProgress(session, { runId: 'run-1', current: 1, discovered: 2 });
    }),
  ]);
  assert.equal(session.current, 2);
  assert.equal(session.discovered, 4);

  const nextRun = mergeSessionProgress(session, createInitialProgress('run-2'));
  assert.equal(nextRun.runId, 'run-2');
  assert.equal(nextRun.current, 0);
  assert.equal(mergeSessionProgress(nextRun, { runId: 'run-1', current: 40 }), nextRun);
});
