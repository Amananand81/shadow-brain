const groqService = require('../services/groq.service');
const conversationService = require('../services/conversation.service');
const { extractKeywordsFromUserMessage, ensureNotAIResponse } = require('../utils/keyword-extractor');
const logger = require('../utils/logger');

const CHAT_DEBUG = process.env.CHAT_DEBUG === 'true';

function debugLog(...args) {
  if (CHAT_DEBUG) console.log(...args);
}

function formatTimestampsForLog(obj) {
  return {
    ...obj,
    timestamp: new Date().toISOString(),
  };
}

const chat = async (req, res, next) => {
  try {
    const { messages, systemPrompt } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      logger.warn('[Chat] messages array is required or empty');
      return res.status(400).json({ error: 'messages array is required' });
    }

    // ── STEP 1: Validate user messages only ──────
    // Check that user message content doesn't look like an AI response
    // (which would indicate the AI was accidentally fed back as input)
    for (const msg of messages) {
      if (!msg || typeof msg.content !== 'string') {
        logger.warn('[Chat] Skipping invalid message', { role: msg?.role });
        continue;
      }
      // Only check user messages for AI response contamination
      if (msg.role === 'user') {
        try {
          ensureNotAIResponse(msg.content, `user message`);
        } catch (err) {
          logger.error(`[Chat] SAFEGUARD: ${err.message}`);
          return res.status(400).json({ error: 'Invalid message content detected' });
        }
      }
    }

    // ── STEP 2: Extract the LAST user message only ────────
    // This is the ONLY source for keyword extraction and search
    const userMessages = messages.filter(m => m.role === 'user');
    const lastUserMessage = userMessages.length > 0
      ? userMessages[userMessages.length - 1].content
      : (messages[messages.length - 1]?.content || '');

    const userQuery = lastUserMessage.trim();
    if (!userQuery) {
      logger.warn('[Chat] No user message content found');
      return res.status(400).json({ error: 'User message content is required' });
    }

    // ── STEP 3: Capture scraped_at timestamp ──────────────
    const scrapedAt = new Date().toISOString();
    debugLog(`[Chat] scraped_at: ${scrapedAt}`);

    // ── STEP 4: Extract keywords from user message ONLY ───
    const { keywords, rawText, keywordSource } = extractKeywordsFromUserMessage(userQuery);
    debugLog(`[Chat] Keywords extracted: ${keywords.join(', ')}`, { keywordSource, rawTextLength: rawText.length });

    // ── STEP 5: Search the database using ONLY user keywords ─
    let searchResults = null;
    let retrievedContext = '';
    let sources = [];

    try {
      searchResults = await conversationService.searchByKeywords(keywords, req.user?.userId, null);
      if (searchResults && searchResults.context) {
        retrievedContext = searchResults.context;
        sources = searchResults.sources || [];
      }
      debugLog(`[Chat] Search completed: ${searchResults.results?.length || 0} results`, {
        userQuery: searchResults.userQuery,
        keywordSource: searchResults.keywordSource,
      });
    } catch (searchErr) {
      logger.error(`[Chat] Search failed: ${searchErr.message}`);
      debugLog(`[Chat] Search error:`, searchErr);
    }

    // ── STEP 6: Build augmented system prompt ──────────────
    const retrievalNote = retrievedContext
      ? `\n\nRETRIEVED CONTEXT (from user search keywords "${keywords.join('", "')}"):\n${retrievedContext}\n\nUse the above retrieved context to answer the user's question. Do NOT use the AI response from any previous turn as a search query.`
      : '';

    const augmentedSystemPrompt = systemPrompt || `You are Brain Shadow, a helpful AI assistant. You have access to the user's captured conversations from various AI platforms. Be concise, clear, and helpful.`;

    const finalSystemPrompt = augmentedSystemPrompt + retrievalNote;

    // ── STEP 7: Send to AI with augmented context ──────────
    // The messages passed to Groq contain ONLY the conversation history
    // (user messages + previous AI responses), NOT the search results
    // The search results are injected via the system prompt instead
    let result;
    try {
      result = await groqService.chat(messages, finalSystemPrompt);
    } catch (groqErr) {
      logger.warn(`[Chat] Groq failed (${groqErr.message}), using fallback`, { scrapedAt });
      const fallbackContent = `I couldn't reach the AI backend (Groq API error). Your search was: "${userQuery}". Please configure a valid GROQ_API_KEY in the backend .env file to enable AI responses.`;
      result = { content: fallbackContent, usage: null };
    }

    const aiResponse = result.content;

    // ── STEP 8: Log safeguard ──────────────────────
    // The AI response is never fed back into search by design
    logger.info(`[Chat] SAFEGUARD: AI response excluded from search pipeline`, {
      aiResponseLength: aiResponse.length,
      scrapedAt,
    });

    debugLog(`[Chat] DEBUG PIPELINE:`, {
      Platform: 'chat',
      Record: 'user_request',
      RawTimestamp: scrapedAt,
      ParsedTimestamp: scrapedAt,
      UTCTimestamp: scrapedAt,
      Source: 'system_clock',
      Confidence: 'high',
      UserQuery: userQuery.slice(0, 100),
      Keywords: keywords,
      SearchResults: searchResults?.results?.length || 0,
      AIResponseLength: aiResponse.length,
      Safeguard: 'AI response excluded from search pipeline by design',
    });

    res.json({ content: result.content, usage: result.usage });
  } catch (err) {
    logger.error(`[Chat] ${err.message}`);
    debugLog(`[Chat] Error stack:`, err.stack);
    next(err);
  }
};

module.exports = { chat };
