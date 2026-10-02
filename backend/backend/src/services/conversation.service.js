const Conversation = require('../models/conversation.model');
const logger = require('../utils/logger');
const { validateSearchInput } = require('../utils/keyword-extractor');

const SEARCH_BATCH_LIMIT = 100;

class ConversationService {
  async createOrUpdate(data, userId) {
    const { platform, external_id, title, messages, saved_at, captured_at, url } = data;

    logger.info(`DEBUG: [BEFORE DB SAVE] ExternalId: ${external_id}, Platform: ${platform}, UserId: ${userId}`);

    const normalizedPlatform = platform ? platform.toLowerCase() : 'chatgpt';

    const newMessages = (messages || []).map(m => ({
      role: m.role,
      content: m.content || '',
      timestamp: m.timestamp || new Date().toISOString()
    }));

    // Only overwrite existing messages if the new capture has actual content.
    // Re-imports that fire while the page is still loading can send empty content
    // and would otherwise destroy the previously captured text.
    const newHasContent = newMessages.some(m => (m.content || '').trim().length > 0);

    const conversationData = {
      userId,
      externalId: external_id,
      platform: normalizedPlatform,
      title: title || 'Untitled Conversation',
      error: null,
      metadata: {
        savedAtExtension: saved_at || captured_at,
        url: url
      }
    };

    // messages must appear in $set OR $setOnInsert — never both (MongoDB rejects that)
    const setOnInsert = {};
    if (newHasContent) {
      conversationData.messages = newMessages;
      conversationData.status = 'PENDING';
    } else {
      setOnInsert.status = 'PENDING';
      setOnInsert.messages = newMessages;
    }

    try {
      const result = await Conversation.findOneAndUpdate(
        { externalId: external_id, platform: normalizedPlatform, userId },
        {
          $set: conversationData,
          $setOnInsert: setOnInsert,
        },
        { upsert: true, returnDocument: 'after', runValidators: true }
      );
      logger.info(`DEBUG: [AFTER DB SAVE SUCCESS] Doc ID: ${result._id}`);
      return result;
    } catch (error) {
      logger.error(`DEBUG: [DB SAVE ERROR] ${error.message}`);
      throw error;
    }
  }

  async getById(id, userId) {
    const filter = { _id: id };
    if (userId) filter.userId = userId;
    return await Conversation.findOne(filter);
  }

  async getByExternalId(externalId, platform, userId) {
    const filter = { externalId, platform };
    if (userId) filter.userId = userId;
    return await Conversation.findOne(filter);
  }

  async updateStatus(id, status, error = null) {
    const update = { status };
    if (error === null) {
      update.error = null;
    } else if (error) {
      update.error = error;
    }
    return await Conversation.findByIdAndUpdate(id, { $set: update }, { returnDocument: 'after' });
  }

  async updateEnrichment(id, enrichment) {
    logger.info(`DEBUG: [BEFORE METADATA SAVE] for ${id}`);

    const updateData = {
      status: 'COMPLETED',
      // Populate the enrichment subdocument (camelCase field names per schema)
      'enrichment.topic':           enrichment.topic,
      'enrichment.category':        enrichment.category,
      'enrichment.summary':         enrichment.summary,
      'enrichment.keywords':        enrichment.keywords,
      'enrichment.entities':        enrichment.entities,
      'enrichment.importanceScore': enrichment.importance_score,
      'enrichment.enrichedAt':      enrichment.enriched_at,
      'enrichment.version':         enrichment.enrichment_version,
      'enrichment.messageCountAtEnrichment': enrichment.message_count,
      // Also write to metadata (snake_case) for backward compat
      'metadata.topic':               enrichment.topic,
      'metadata.category':            enrichment.category,
      'metadata.summary':             enrichment.summary,
      'metadata.keywords':            enrichment.keywords,
      'metadata.entities':            enrichment.entities,
      'metadata.importance_score':    enrichment.importance_score,
      'metadata.enriched_at':         enrichment.enriched_at,
      'metadata.enrichment_version':  enrichment.enrichment_version,
      'metadata.status':              'COMPLETED',
      error: null,
    };

    const result = await Conversation.findByIdAndUpdate(
      id,
      { $set: updateData },
      { returnDocument: 'after' }
    );

    logger.info(`DEBUG: [AFTER METADATA SAVE] for ${id}`);
    return result;
  }

  async list(query = {}, options = {}) {
    const { limit = 20, page = 1, sort = { createdAt: -1 } } = options;
    return await Conversation.find(query)
      .sort(sort)
      .limit(limit)
      .skip((page - 1) * limit);
  }

  async searchByKeywords(keywords, userId, platforms) {
    const validation = validateSearchInput(keywords.join(' '));
    if (!validation.valid) {
      logger.warn(`[searchByKeywords] Invalid search input: ${validation.reason}`);
      return { results: [], searchedAt: new Date().toISOString(), keywordSource: 'none' };
    }

    const userQuery = validation.sanitizedInput;
    const kw = userQuery.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    if (kw.length === 0) {
      return { results: [], searchedAt: new Date().toISOString(), keywordSource: 'user_input' };
    }

    const wordRegexes = kw.map(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi'));

    const dbFilter = { userId };
    if (Array.isArray(platforms) && platforms.length > 0) {
      dbFilter.platform = { $in: platforms };
    }

    const allConvs = await this.list(dbFilter, { limit: SEARCH_BATCH_LIMIT });

    const scored = allConvs
      .map(conv => {
        const metaText = [
          conv.title || '',
          conv.enrichment?.topic || '',
          conv.enrichment?.summary || '',
          ...(conv.enrichment?.keywords || []),
        ].join(' ');

        const scoredMsgs = conv.messages.map(m => {
          const content = m.content || '';
          const hits = wordRegexes.reduce((acc, re) => {
            re.lastIndex = 0;
            return acc + (content.match(re) || []).length;
          }, 0);
          return { msg: m, hits };
        });

        const metaScore = wordRegexes.reduce((acc, re) => {
          re.lastIndex = 0;
          return acc + (metaText.match(re) || []).length;
        }, 0);

        const totalScore = metaScore + scoredMsgs.reduce((a, x) => a + x.hits, 0);
        const relevantMsgs = scoredMsgs.filter(x => x.hits > 0).map(x => x.msg);

        return { conv, score: totalScore, relevantMsgs };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    const context = scored.map(({ conv, relevantMsgs }, i) => {
      const topic = conv.enrichment?.topic ? `Topic: ${conv.enrichment.topic}` : '';
      const summary = conv.enrichment?.summary ? `Summary: ${conv.enrichment.summary}` : '';
      const msgs = relevantMsgs.slice(0, 10)
        .map(m => `${m.role === 'user' ? 'User' : 'AI'}: ${(m.content || '').slice(0, 500)}`)
        .join('\n');

      return [
        `CONVERSATION ${i + 1}:`,
        `Title: ${conv.title || 'Untitled'}`,
        `Platform: ${conv.platform}`,
        topic, summary,
        msgs ? 'Relevant messages:' : '',
        msgs,
      ].filter(Boolean).join('\n');
    }).join('\n\n---\n\n');

    const sources = [];
    for (const { conv, relevantMsgs } of scored) {
      if (relevantMsgs.length > 0) {
        for (const msg of relevantMsgs.slice(0, 4)) {
          sources.push({
            id: msg._id?.toString() || conv._id.toString(),
            convId: conv._id.toString(),
            title: conv.title || 'Untitled',
            platform: conv.platform || 'unknown',
            role: msg.role,
            snippet: (msg.content || '').slice(0, 200),
            keywords: conv.enrichment?.keywords || [],
            summary: conv.enrichment?.summary || null,
          });
        }
      } else {
        sources.push({
          id: conv._id.toString(),
          convId: conv._id.toString(),
          title: conv.title || 'Untitled',
          platform: conv.platform || 'unknown',
          role: null,
          snippet: null,
          keywords: conv.enrichment?.keywords || [],
          summary: conv.enrichment?.summary || null,
        });
      }
    }

    logger.info(`[searchByKeywords] Found ${scored.length} results for keywords: ${keywords.join(', ')}`, {
      userQuery,
      resultCount: scored.length,
      keywordSource: 'user_input',
    });

    return { results: scored, context, sources, searchedAt: new Date().toISOString(), keywordSource: 'user_input', userQuery };
  }
}

module.exports = new ConversationService();
