const conversationService = require('../services/conversation.service');
const enrichmentService = require('../services/enrichment.service');
const groqService = require('../services/groq.service');
const logger = require('../utils/logger');

// Roles that should never be treated as conversation content.
const BANNED_ROLE_MARKERS = [
  'the user asked',
  'the user started',
  'the user wanted to know',
  'the user explored',
  'the user then',
  'the ai responded',
  'the assistant explained',
  'the ai provided',
  'the conversation shifted',
  'the conversation started',
  'the user received',
  'the user was given',
];

// Labels that indicate surrounding text is metadata/search output rather than
// real conversation content.
const BANNED_LABELS = [
  'title:',
  'platform:',
  'topic:',
  'summary:',
  'relevant messages:',
  'conversation 1',
  'conversation 2',
  ': document',
  'pasted text',
];

// Given a raw message content string, strip obvious filenames, search-result
// labels, and previously-generated summary phrasing so none of that leaks into
// either the LLM context or the fallback output.
function sanitizeMessageContent(raw = '') {
  if (!raw) return '';
  let text = String(raw);

  // Replace a bare "Text(...).txt"-style filename with nothing.
  text = text.replace(/\bText\([\d-]+\)\.txt\b/gi, ' ');
  // Remove any trailing ".txt" (e.g. "chat.txt", "Pasted text.txt").
  text = text.replace(/\.txt\b/gi, ' ');

  // Drop lines that are pure metadata labels (e.g. "Title:", "Platform:").
  const lines = text.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim().toLowerCase();
    return !BANNED_LABELS.some((label) => trimmed.startsWith(label));
  });

  return lines.join('\n').replace(/\s+/g, ' ').trim();
}

// Remove messages whose content is really a filename, an empty paste stub, or
// a previously generated summary rather than an actual conversation exchange.
function isMetadataOnlyMessage(content = '') {
  const c = (content || '').trim();
  if (!c) return true;

  const lower = c.toLowerCase();
  // Looks like just a filename.
  if (lower.endsWith('.txt')) return true;
  // Only search-result labels / summary phrasing, no real dialogue.
  if (BANNED_LABELS.some((label) => lower.startsWith(label))) return true;
  // A one-word title-like stub ("Document", "Pasted text").
  if (/^(document|pasted text)/i.test(c)) return true;
  // A message that is purely a previously-generated recap line.
  if (BANNED_ROLE_MARKERS.some((marker) => lower.includes(marker))) return true;

  return false;
}

const createConversation = async (req, res, next) => {
  const startTime = Date.now();
  try {
    console.log(`\n[JWT-STEP-8] ═══ createConversation START ═══`);
    console.log(`[JWT-STEP-8]   Timestamp: ${new Date().toISOString()}`);
    console.log(`[JWT-STEP-8]   req.user: ${JSON.stringify(req.user)}`);
    console.log(`[JWT-STEP-8]   req.user.userId: ${req.user?.userId || 'MISSING'}`);
    console.log(`[JWT-STEP-8]   req.user.email: ${req.user?.email || 'MISSING'}`);

    if (!req.user?.userId) {
      console.error(`[JWT-STEP-8] ❌ FAIL — req.user.userId is missing. Middleware did not set req.user.`);
      return res.status(401).json({ message: 'User not authenticated' });
    }

    console.log(`[JWT-STEP-8] ✅ PASS — req.user.userId = "${req.user.userId}"`);

    if (!req.body || Object.keys(req.body).length === 0) {
      console.error(`[JWT-STEP-8] ❌ FAIL — Empty request body`);
      return res.status(400).json({ message: 'Empty request body' });
    }

    const { platform, external_id, title, messages } = req.body;
    console.log(`[JWT-STEP-8]   platform: "${platform}"`);
    console.log(`[JWT-STEP-8]   external_id: "${external_id}"`);
    console.log(`[JWT-STEP-8]   title: "${(title || '').substring(0, 60)}"`);
    console.log(`[JWT-STEP-8]   messages count: ${(messages || []).length}`);
    console.log(`[JWT-STEP-8]   MongoDB save will use userId: "${req.user.userId}"`);

    // Validate platform enum before hitting the service
    const VALID_PLATFORMS = ['chatgpt', 'claude', 'gemini', 'deepseek', 'blackbox', 'copilot', 'mscopilot', 'perplexity', 'grok'];
    const normalizedPlatform = platform ? platform.toLowerCase() : 'chatgpt';
    if (!VALID_PLATFORMS.includes(normalizedPlatform)) {
      console.error(`[JWT-STEP-8] ❌ FAIL — INVALID PLATFORM: "${platform}"`);
      return res.status(400).json({
        message: `Invalid platform: "${platform}". Valid: ${VALID_PLATFORMS.join(', ')}`
      });
    }

    console.log(`[JWT-STEP-8]   Calling conversationService.createOrUpdate(data, "${req.user.userId}")...`);
    const conversation = await conversationService.createOrUpdate(req.body, req.user.userId);
    console.log(`[JWT-STEP-8] ✅ PASS — MongoDB save confirmed`);
    console.log(`[JWT-STEP-8]   _id: ${conversation._id}`);
    console.log(`[JWT-STEP-8]   platform: ${conversation.platform}`);
    console.log(`[JWT-STEP-8]   userId in doc: ${conversation.userId}`);
    console.log(`[JWT-STEP-8]   messages: ${conversation.messages?.length}`);
    console.log(`[JWT-STEP-8]   DB write in ${Date.now() - startTime}ms`);
    
    // Trigger enrichment immediately (no queue)
    setImmediate(() => {
      console.log(`[JWT-STEP-8]   Triggering enrichment for ${conversation._id}`);
      enrichmentService.process(conversation._id).catch(err => {
        console.error(`[JWT-STEP-8]   Background enrichment failed: ${err.message}`);
      });
    });

    const responseBody = {
      message: 'Conversation received and enrichment started',
      id: conversation._id,
      status: 'PENDING'
    };
    console.log(`[JWT-STEP-8]   Sending 202 response`);
    console.log(`[JWT-STEP-8] ═══ createConversation END (success) ═══\n`);
    res.status(202).json(responseBody);
  } catch (error) {
    console.error(`[JWT-STEP-8] ❌ FAIL — createConversation error: ${error.message}`);
    console.error(`[JWT-STEP-8]   Stack: ${error.stack}`);
    next(error);
  }
};

const bulkCreateConversations = async (req, res, next) => {
  const startTime = Date.now();
  try {
    console.log(`\n[CONTROLLER] ─── bulkCreateConversations START ───`);
    const { conversations } = req.body;
    console.log(`[CONTROLLER] Bulk payload: ${Array.isArray(conversations) ? conversations.length + ' items' : 'NOT AN ARRAY'}`);
    
    if (!Array.isArray(conversations)) {
      console.error(`[CONTROLLER] conversations is not an array: ${typeof conversations}`);
      return res.status(400).json({ message: 'conversations must be an array' });
    }

    const results = [];
    const errors = [];
    for (let i = 0; i < conversations.length; i++) {
      const convoData = conversations[i];
      console.log(`[CONTROLLER] Bulk item ${i + 1}/${conversations.length}: platform="${convoData.platform}", external_id="${convoData.external_id}", title="${(convoData.title || '').substring(0, 40)}"`);
      try {
        const convo = await conversationService.createOrUpdate(convoData, req.user.userId);
        console.log(`[CONTROLLER] Bulk item ${i + 1} OK: _id=${convo._id}`);
        
        setImmediate(() => {
          enrichmentService.process(convo._id).catch(err => {
            console.error(`[CONTROLLER] Bulk enrichment failed for ${convo._id}: ${err.message}`);
          });
        });
        results.push(convo._id);
      } catch (itemError) {
        console.error(`[CONTROLLER] Bulk item ${i + 1} FAILED: ${itemError.message}`);
        console.error(`[CONTROLLER] Item error stack: ${itemError.stack}`);
        errors.push({ index: i, error: itemError.message, platform: convoData.platform });
      }
    }

    console.log(`[CONTROLLER] Bulk complete: ${results.length} success, ${errors.length} failed, ${Date.now() - startTime}ms`);
    console.log(`[CONTROLLER] ─── bulkCreateConversations END ───\n`);
    res.status(202).json({
      message: `Received ${results.length} conversations, enrichment started`,
      ids: results,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error(`[CONTROLLER] ─── bulkCreateConversations ERROR ───`);
    console.error(`[CONTROLLER] Error: ${error.message}`);
    console.error(`[CONTROLLER] Stack: ${error.stack}`);
    next(error);
  }
};

const listConversations = async (req, res, next) => {
  try {
    const { page, limit, platform } = req.query;
    const query = platform ? { platform, userId: req.user.userId } : { userId: req.user.userId };
    const conversations = await conversationService.list(query, { page: Number(page), limit: Number(limit) });
    res.json(conversations);
  } catch (error) {
    next(error);
  }
};

const getConversationById = async (req, res, next) => {
  try {
    const conversation = await conversationService.getById(req.params.id, req.user.userId);
    if (!conversation) return res.status(404).json({ message: 'Not found' });
    res.json(conversation);
  } catch (error) {
    next(error);
  }
};

const getConversationStatus = async (req, res, next) => {
  try {
    const conversation = await conversationService.getById(req.params.id, req.user.userId);
    if (!conversation) return res.status(404).json({ message: 'Not found' });
    res.json({
      id: conversation._id,
      status: conversation.status,
      error: conversation.error
    });
  } catch (error) {
    next(error);
  }
};

const buildFallbackAnswer = (query, scored) => {
  // Build the fallback from CLEAN raw messages, never from old enrichment
  // summaries (which contain "The user asked..." / filenames / metadata).
  const parts = [];
  for (const { conv } of scored.slice(0, 3)) {
    const messages = (conv.messages || []);
    const userMsgs = messages.filter(m => m.role === 'user' && !isMetadataOnlyMessage(m.content));
    const aiMsgs = messages.filter(m => m.role !== 'user' && !isMetadataOnlyMessage(m.content));

    const firstUser = (userMsgs[0]?.content || '').slice(0, 300);
    const firstAi = (aiMsgs[0]?.content || '').slice(0, 300);

    const cleanUser = sanitizeMessageContent(firstUser);
    const cleanAi = sanitizeMessageContent(firstAi);

    if (cleanUser && cleanAi) {
      parts.push(`${cleanUser} ${cleanAi}`);
    } else if (cleanUser) {
      parts.push(cleanUser);
    }
  }

  const joined = parts.filter(Boolean).join(' ');
  if (joined) {
    return joined;
  }

  return `No usable conversation content was found for "${query}". The related conversations could not be summarized automatically.`;
};

// Normalize a search query for relevance matching: lowercase, strip punctuation,
// collapse whitespace, and drop trivial stopwords. Returns the meaningful
// terms (the topic/keywords) that must appear in the user's messages.
const STOPWORDS = new Set([
  'what', 'is', 'are', 'the', 'a', 'an', 'do', 'does', 'did', 'how', 'why',
  'when', 'where', 'which', 'who', 'with', 'for', 'and', 'or', 'of', 'to',
  'in', 'on', 'at', 'i', 'me', 'my', 'you', 'your', 'we', 'from', 'by', 'this',
  'that', 'about', 'want', 'wanting', 'wants', 'start', 'starting', 'learn',
  'learning', 'explain', 'explain', 'explain', 'tell', 'give', 'show', 'need',
  'help', 'please', 'can', 'could', 'would', 'should', 'so', 'please', 'please',
]);

function extractSearchTerms(query) {
  return String(query || '')
    .toLowerCase()
    // collapse punctuation into spaces (handles "SQL?", "learn - SQL", etc.)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
}

// Build word-boundary regexes (case-insensitive) so "sql" never matches inside
// e.g. "postgresql" / "mssql", while still matching whole topic words.
function buildTermRegexes(terms) {
  return terms.map(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi'));
}

const searchConversations = async (req, res, next) => {
  try {
    const { query, platforms } = req.body;
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ message: 'query is required' });
    }

    const terms = extractSearchTerms(query);
    if (terms.length === 0) {
      return res.json({ answer: 'Please provide a more specific query.', sources: [] });
    }

    const termRegexes = buildTermRegexes(terms);

    const dbFilter = { userId: req.user.userId };
    if (Array.isArray(platforms) && platforms.length > 0) {
      dbFilter.platform = { $in: platforms };
    }
    const allConvs = await conversationService.list(dbFilter, { limit: 200 });

    const scored = allConvs
      .map(conv => {
        // Relevance is based ONLY on the actual USER messages. Assistant
        // responses, titles, metadata, summaries, and keywords are ignored so
        // a passing occurrence in an AI answer never surfaces a conversation.
        const userMsgs = (conv.messages || []).filter(m => m.role === 'user');

        const scoredMsgs = userMsgs.map(m => {
          const content = m.content || '';
          const hits = termRegexes.reduce((acc, re) => {
            re.lastIndex = 0;
            return acc + (content.match(re) || []).length;
          }, 0);
          return { msg: m, hits };
        });

        const relevantMsgs = scoredMsgs.filter(x => x.hits > 0);
        if (relevantMsgs.length === 0) return null;

        // A conversation is relevant only when at least one USER message
        // actually contains a searched topic term.
        const totalScore = relevantMsgs.reduce((a, x) => a + x.hits, 0);
        return { conv, score: totalScore, relevantMsgs: relevantMsgs.map(x => x.msg) };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    if (scored.length === 0) {
      return res.json({
        answer: `No conversations found related to "${query}". Try different keywords or make sure your conversations have been imported.`,
        sources: []
      });
    }

    const context = scored.map(({ conv }, index) => {
      const msgs = conv.messages.slice(0, 12)
        .map(m => {
          if (isMetadataOnlyMessage(m.content)) return null;
          const role = m.role === 'user' ? 'USER' : 'ASSISTANT';
          const content = sanitizeMessageContent(m.content);
          if (!content) return null;
          return `${role}: ${content.slice(0, 500)}`;
        })
        .filter(Boolean)
        .join('\n\n');

      return `--- CONVERSATION ${index + 1} ---\n${msgs}`;
    }).filter(Boolean).join('\n\n\n');

    const systemPrompt = `You are an expert conversation-memory summarization system.
Your task is to analyze a set of related conversations together, identify the user's underlying journey and intent, and produce ONE concise, meaningful summary paragraph.

### INSTRUCTIONS

1. Analyze ALL provided related conversations together as one continuous journey or problem space.
2. Prioritize USER messages to understand intent: What does the user want? Why are they exploring this? What are they trying to achieve?
3. Use ASSISTANT responses only as supporting context to understand the concepts discussed. Do NOT treat the AI response as the user's intention.
4. Identify the common theme and the user's overall goal. Determine if the user is learning, building, debugging, researching, planning, or solving a problem.
5. Merge related concepts into higher-level themes and remove repetitive information across conversations.
6. Ignore any irrelevant conversations or stray topics that do not fit the main intent.

### DESIRED INTERNAL REASONING

Before generating the final output, you MUST output a JSON block inside \`\`\`json \`\`\` reasoning about the following structure (this helps you synthesize):

\`\`\`json
{
  "mainTopic": "...",
  "userIntent": "...",
  "conceptsOrProblems": ["...", "..."],
  "overallGoal": "...",
  "journey": "..."
}
\`\`\`

### FINAL OUTPUT

After your JSON reasoning, provide the final summary.

The final output MUST be exactly ONE natural, flowing paragraph (approx. 2-4 sentences).

The summary MUST answer: "What was this user mainly exploring or working on across these conversations, and what were they trying to achieve?"

Do NOT:
- Do NOT simply concatenate or rewrite user questions or AI responses.
- Do NOT summarize each conversation independently.
- Do NOT produce a chronological transcript ("First the user asked... Then the AI...").
- Do NOT mention every individual question or error unless it is necessary to explain the overall goal.
- Do NOT hallucinate goals, technologies, or projects that aren't mentioned.
- Do NOT start sentences with "The user asked", "The user wanted to know", or "The AI responded".

Example of BAD output (transcript style):
The user asked what RAG is. Then they asked for an LLM roadmap. Later they wanted to know how to integrate LLM into Brain Shadow and asked about embeddings.

Example of GOOD output (synthesized):
The user is learning about Large Language Models (LLMs) from basic concepts to practical implementation. Their discussions progressed from understanding fundamentals like embeddings and RAG toward integrating these capabilities into the Brain Shadow project. Overall, they are focused on building a strong understanding of LLM technology to apply it successfully to their application.`;

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

    let answer;
    try {
      const result = await groqService.chat(
        [{ role: 'user', content: `SEARCH QUERY:\n${query}\n\nCONVERSATIONS:\n${context}` }],
        systemPrompt
      );
      
      let rawContent = result.content || "";
      
      // Extract the JSON block from the final output (and ignore it for the frontend)
      const jsonRegex = /\`\`\`json[\s\S]*?\`\`\`/i;
      const match = rawContent.match(jsonRegex);
      
      if (match) {
        // Remove the json block, then trim leading/trailing whitespace
        answer = rawContent.replace(jsonRegex, '').trim();
        // Remove any residual markdown markers that might have been left behind
        answer = answer.replace(/^\s*```[\s\S]*?```\s*/, '').trim();
      } else {
        answer = rawContent.trim();
      }
      
      // If the LLM ONLY output the JSON block and nothing else, or if the stripping failed.
      if (!answer || answer.startsWith('{')) {
        // the LLM might have messed up and output raw JSON without markdown.
        // As a fallback, try parsing or regenerating the fallback.
        try {
           const parsed = JSON.parse(rawContent.replace(/\`\`\`json/i, '').replace(/\`\`\`/i, '').trim());
           if (parsed.journey || parsed.overallGoal) {
             answer = parsed.journey || parsed.overallGoal || buildFallbackAnswer(query, scored);
           }
        } catch(e) {
           answer = buildFallbackAnswer(query, scored);
        }
      }
    } catch (groqErr) {
      logger.error(`[Search] Groq failed: ${groqErr.message}`);
      answer = buildFallbackAnswer(query, scored);
    }

    res.json({ answer, sources });
  } catch (err) {
    logger.error(`[Search] ${err.message}`);
    next(err);
  }
};

module.exports = {
  createConversation,
  bulkCreateConversations,
  listConversations,
  getConversationById,
  getConversationStatus,
  searchConversations,
};
