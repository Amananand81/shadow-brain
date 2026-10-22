(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.BrainShadowScrapeState = api;
  }
})(globalThis, function () {
  function createSerialQueue() {
    let tail = Promise.resolve();
    return function run(operation) {
      const result = tail.then(operation, operation);
      tail = result.then(() => undefined, () => undefined);
      return result;
    };
  }

  function createExclusiveGuard() {
    const active = new Set();
    return {
      tryAcquire(key) {
        if (active.has(key)) return false;
        active.add(key);
        return true;
      },
      release(key) {
        active.delete(key);
      },
    };
  }

  function normalizePlatform(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return '';
    const compact = raw.replace(/[^a-z0-9]/g, '');
    const aliases = {
      chatgpt: 'chatgpt',
      chatgptcom: 'chatgpt',
      chatopenaicom: 'chatgpt',
      httpschatgptcom: 'chatgpt',
      httpschatopenaicom: 'chatgpt',
      openai: 'chatgpt',
      claude: 'claude',
      claudeai: 'claude',
      httpsclaudeai: 'claude',
      anthropic: 'claude',
      gemini: 'gemini',
      googlegemini: 'gemini',
      geminigooglecom: 'gemini',
      httpsgeminigooglecom: 'gemini',
      deepseek: 'deepseek',
      chatdeepseekcom: 'deepseek',
      httpschatdeepseekcom: 'deepseek',
      blackbox: 'blackbox',
      blackboxai: 'blackbox',
      wwwblackboxai: 'blackbox',
      copilot: 'copilot',
      mscopilot: 'copilot',
      microsoftcopilot: 'copilot',
      copilotmicrosoftcom: 'copilot',
      githubcopilot: 'copilot',
      githubcomcopilot: 'copilot',
      perplexity: 'perplexity',
      perplexityai: 'perplexity',
      wwwperplexityai: 'perplexity',
      httpsperplexityai: 'perplexity',
      httpswwwperplexityai: 'perplexity',
      grok: 'grok',
      grokcom: 'grok',
      xai: 'grok',
      x: 'grok',
      xcom: 'grok',
    };
    return aliases[compact] || raw.replace(/[\s.]+/g, '_').replace(/[^a-z0-9_-]/g, '');
  }

  function getTokenUserId(token) {
    try {
      const payload = String(token || '').split('.')[1];
      if (!payload || typeof globalThis.atob !== 'function') return null;
      const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      const decoded = globalThis.atob(base64.padEnd(base64.length + (4 - base64.length % 4) % 4, '='));
      const userId = JSON.parse(decoded).userId;
      return typeof userId === 'string' && userId ? userId : null;
    } catch {
      return null;
    }
  }

  function accountConversationKey(userId, platform, externalId) {
    const normalizedPlatform = normalizePlatform(platform);
    if (!normalizedPlatform || !externalId) return '';
    return `${userId || 'unassigned'}_${normalizedPlatform}_${externalId}`;
  }

  function conversationsForUser(conversations = {}, userId) {
    return Object.values(conversations).filter(conversation => userId
      ? conversation.ownerUserId === userId
      : !conversation.ownerUserId);
  }

  function deriveConversationMeta(conversations = {}, userId) {
    const accountConversations = conversationsForUser(conversations, userId);
    const platforms = {};
    let totalMessages = 0;
    for (const conversation of accountConversations) {
      const platform = normalizePlatform(conversation.platform);
      if (platform) platforms[platform] = (platforms[platform] || 0) + 1;
      totalMessages += Array.isArray(conversation.messages) ? conversation.messages.length : 0;
    }
    return {
      total_conversations: accountConversations.length,
      total_messages: totalMessages,
      platforms,
    };
  }

  function applyConversationCapture(conversations, data, source, ownerUserId, savedAt) {
    const platform = normalizePlatform(data?.platform);
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const key = accountConversationKey(ownerUserId, platform, data?.external_id);
    if (!key) throw new Error('Conversation platform and external ID are required');
    const existing = conversations[key];
    if (isUnchangedCapture(existing, { ...data, messages })) {
      return {
        conversations,
        key,
        created: false,
        status: 'skipped',
        meta: deriveConversationMeta(conversations, ownerUserId),
      };
    }

    const nextConversations = {
      ...conversations,
      [key]: {
        ...data,
        platform,
        messages,
        ownerUserId,
        saved_at: savedAt,
        message_count: messages.length,
        source,
        synced: false,
        syncStatus: 'pending',
        syncAttempts: 0,
        syncError: null,
      },
    };
    return {
      conversations: nextConversations,
      key,
      created: !existing,
      status: 'saved',
      conversation: nextConversations[key],
      meta: deriveConversationMeta(nextConversations, ownerUserId),
    };
  }

  function applySyncResult(conversation, result) {
    const attempts = conversation.syncAttempts || 0;
    return {
      ...conversation,
      synced: result.ok,
      syncStatus: result.ok ? 'synced' : 'failed',
      syncAttempts: result.ok ? attempts : attempts + 1,
      syncError: result.ok ? null : result.error,
    };
  }

  function pendingConversationsForUser(conversations = {}, userId, maxAttempts = 5) {
    if (!userId) return [];
    return Object.entries(conversations).filter(([, conversation]) =>
      conversation.ownerUserId === userId
      && conversation.synced !== true
      && (conversation.syncAttempts || 0) < maxAttempts
    );
  }

  function createInitialProgress(runId, startedAt = new Date().toISOString(), ownerUserId = null) {
    return {
      runId,
      ownerUserId,
      running: true,
      done: false,
      stopRequested: false,
      phase: 'init',
      current: 0,
      total: 0,
      pct: 0,
      savedCount: 0,
      syncedCount: 0,
      failedCount: 0,
      skipped: 0,
      emptyCount: 0,
      title: 'Opening background tab…',
      startedAt,
    };
  }

  function mergeSessionProgress(previous, update) {
    if (update.phase === 'init') return { ...update };
    if (update.runId && previous.runId && update.runId !== previous.runId) return previous;

    const next = { ...previous, ...update };
    const monotonicFields = [
      'current', 'total', 'pct', 'discovered', 'discoveredTotal',
      'savedCount', 'syncedCount', 'failedCount', 'skipped', 'skippedCount',
      'emptyCount', 'duplicateCount',
    ];
    for (const field of monotonicFields) {
      if (Number.isFinite(previous[field]) && Number.isFinite(update[field])) {
        next[field] = Math.max(previous[field], update[field]);
      }
    }
    return next;
  }

  function deriveDashboardStats(meta = {}) {
    const capturedPlatforms = {};
    for (const [platform, rawCount] of Object.entries(meta.platforms || {})) {
      const normalized = normalizePlatform(platform);
      const count = Number(rawCount);
      if (normalized && Number.isFinite(count) && count > 0) {
        capturedPlatforms[normalized] = (capturedPlatforms[normalized] || 0) + count;
      }
    }

    const capturedTotal = Number(meta.total_conversations);
    const platformTotal = Object.values(capturedPlatforms).reduce((sum, count) => sum + count, 0);
    const totalConversations = Math.max(
      Number.isFinite(capturedTotal) ? capturedTotal : 0,
      platformTotal,
    );
    const totalPlatforms = Object.values(capturedPlatforms).filter(count => count > 0).length;
    const totalMessages = Number(meta.total_messages);

    return {
      totalConversations,
      totalMessages: Number.isFinite(totalMessages) ? totalMessages : 0,
      totalPlatforms,
      platforms: capturedPlatforms,
    };
  }

  function recordCaptureResult(counts, result) {
    const next = { ...counts };
    next.current = (next.current || 0) + 1;
    switch (result?.status) {
      case 'saved':
        next.savedCount = (next.savedCount || 0) + 1;
        if (result.synced === true) next.syncedCount = (next.syncedCount || 0) + 1;
        break;
      case 'skipped':
        next.skipped = (next.skipped || 0) + 1;
        break;
      case 'empty':
        next.emptyCount = (next.emptyCount || 0) + 1;
        next.failedCount = (next.failedCount || 0) + 1;
        break;
      default:
        next.failedCount = (next.failedCount || 0) + 1;
        break;
    }
    return next;
  }

  function recordScrapeSync(counts) {
    return { ...counts, syncedCount: (counts.syncedCount || 0) + 1 };
  }

  function isUnchangedCapture(existing, incoming) {
    return !!existing
      && Array.isArray(existing.messages)
      && Array.isArray(incoming?.messages)
      && existing.messages.length === incoming.messages.length
      && existing.messages.every((message, index) =>
        message.role === incoming.messages[index]?.role
        && message.content === incoming.messages[index]?.content
      );
  }

  function completedProgress(completed, total) {
    return {
      current: completed,
      pct: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
  }

  return {
    createSerialQueue,
    createExclusiveGuard,
    normalizePlatform,
    getTokenUserId,
    accountConversationKey,
    conversationsForUser,
    deriveConversationMeta,
    applyConversationCapture,
    applySyncResult,
    pendingConversationsForUser,
    createInitialProgress,
    mergeSessionProgress,
    deriveDashboardStats,
    recordCaptureResult,
    recordScrapeSync,
    isUnchangedCapture,
    completedProgress,
  };
});
