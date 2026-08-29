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

    const context = scored.map(({ conv }) => {
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

      return msgs;
    }).filter(Boolean).join('\n\n\n');

    const systemPrompt = `You are a conversation-memory summarization system.

Your task is to read the user's search query and the retrieved conversation content, determine which conversations are genuinely relevant, understand their actual meaning, and produce ONE concise, natural summary.

IMPORTANT:
The final output must summarize the SUBJECT MATTER and MEANING of the conversations, NOT describe the conversations themselves.

### INPUT

You will receive:

1. SEARCH QUERY
${query}

2. CONVERSATION CONTENT
Conversation content may contain raw user/assistant messages, metadata, filenames, previous summaries, titles, platforms, or search-result formatting.

${context}

### STEP 1 — UNDERSTAND THE SEARCH QUERY

First determine what the user is actually looking for.

For example:

Search query:
"Brain Shadow LLM integration"

The goal is to identify conversations about:

* Brain Shadow development
* LLM integration
* LLM learning related to the project
* problems, solutions, architecture, APIs, authentication, scraping, deployment, or other work directly connected to Brain Shadow

Do NOT include a conversation just because it contains a keyword or passing mention.

### STEP 2 — FILTER IRRELEVANT CONTENT

Ignore conversations that are unrelated to the search topic.

A conversation is NOT relevant merely because:

* the filename contains a matching word
* the title contains a matching word
* a keyword appears once
* the conversation contains a passing mention
* the content is an unrelated resume discussion
* the content is an unrelated internship/job message
* the content is unrelated personal or general discussion

For example, if the search topic is "Brain Shadow", an unrelated internship advertisement must NOT be included.

### STEP 3 — IGNORE SEARCH-RESULT METADATA

Do NOT treat the following as meaningful conversation content:

* filenames such as "Pasted text(20260827-043958).txt"
* "Document"
* "Title:"
* "Platform:"
* "Topic:"
* "Summary:"
* "Relevant messages:"
* search-result labels
* conversation numbers
* result counts
* previously generated summaries
* phrases such as "The user started by asking..."
* phrases such as "The AI responded..."
* phrases such as "The user asked..."

Metadata may help identify a conversation internally, but it must NEVER appear in the final summary.

If both a previous summary and raw conversation messages are available, use the RAW CONVERSATION as the primary source of truth.

### STEP 4 — UNDERSTAND THE ACTUAL MEANING

For every relevant conversation, identify:

* What was being worked on?
* What problem was encountered?
* What was learned?
* What solution was implemented or discussed?
* What technical concepts were involved?
* How did the work progress?
* What important outcome came from the conversation?

Do NOT copy the user's questions and do NOT describe who asked or answered them.

Convert questions into meaningful statements.

Example:

BAD:
"The user asked what RAG is and the AI explained it."

GOOD:
"The discussion covered RAG and how retrieval can provide relevant information to improve AI responses."

BAD:
"The user asked why the Chrome extension received a 401 error."

GOOD:
"The Chrome extension's authentication flow was debugged after API requests returned 401 Unauthorized because the JWT was not being passed correctly in the Authorization header."

BAD:
"The user asked how to learn LLMs from basic concepts."

GOOD:
"LLM learning progressed from fundamentals such as tokens, embeddings, transformers, context windows, and semantic search toward practical integration with Brain Shadow."

Another concrete example:

Input messages about SQL:
USER: What is SQL?
ASSISTANT: SQL is a language used to work with relational databases.
USER: What is a JOIN?
ASSISTANT: JOIN combines rows from multiple tables.
USER: How do I use GROUP BY?
ASSISTANT: GROUP BY groups rows based on specified columns.

Do NOT output:
"The user asked what SQL is, then asked about JOINs, and later asked about GROUP BY. The AI explained each concept."

Instead output:
"SQL learning covered fundamental database concepts, including querying relational data, combining tables with JOIN operations, and grouping and analyzing records using GROUP BY."

### STEP 5 — SYNTHESIZE THE INFORMATION

Combine all genuinely relevant conversations into ONE coherent story.

Do not create one mini-summary for every conversation.

Instead, connect related information and show progression.

Remove duplicate information: if the same idea, concept, or learning appears in more than one conversation (including across different platforms), mention it ONCE and merge any extra details into that single mention. Do not repeat it for each conversation.

For example, instead of:

"The user learned about LLMs.
The user worked on JWT.
The user worked on scraping.
The user worked on deployment."

Write:

"Brain Shadow evolved into an AI-powered conversation memory system, with development covering multi-platform conversation scraping, JWT-based authentication, backend integration, deployment, and LLM-powered processing. The work also involved learning LLM fundamentals such as tokens, embeddings, semantic search, transformers, context windows, and RAG to improve how the system understands and summarizes stored conversations."

### STEP 6 — FINAL OUTPUT STYLE

Write ONE brief connected paragraph of 1 to 3 concise sentences.

The paragraph should:

1. Start with the overall subject or project.
2. Mention the most important areas of work or learning.
3. Show progression when possible.
4. Mention important problems and solutions when relevant.
5. End with the overall outcome or current direction.

Keep it to 1-3 sentences. If the conversations contain limited distinct information, 1 sentence is enough. Only exceed 3 sentences if the conversations genuinely cover many distinct, non-duplicate areas.

Do NOT use bullet points unless explicitly requested.

Do NOT mention the number of conversations.

Do NOT mention filenames.

Do NOT mention metadata.

Do NOT mention search results.

Do NOT mention the AI or assistant.

Do NOT mention that the user "asked", "started", "explored", "received a response", or "was told".

### ABSOLUTE BANNED PATTERNS

Never generate sentences beginning with or containing:

* "The user started by asking..."
* "The user asked..."
* "The user wanted to know..."
* "The user explored..."
* "The user then..."
* "The AI responded..."
* "The assistant explained..."
* "The AI provided..."
* "The conversation shifted..."
* "The conversation started..."
* "The user received..."
* "The user was given..."
* "Pasted text..."
* ".txt"
* "Document"
* "CONVERSATION 1"
* "CONVERSATION 2"
* "Title:"
* "Platform:"
* "Topic:"
* "Summary:"
* "Relevant messages:"

### IMPORTANT ANTI-RECURSION RULE

If the input contains text that already looks like a generated summary, do NOT summarize that summary's wording.

For example, if the input says:

"The user started by asking about JWT and the AI responded with..."

Do NOT reproduce or summarize that sentence.

Instead, look for the underlying technical information and convert it into a direct statement:

"JWT authentication was debugged after the Chrome extension failed to send the required token to the backend."

The final summary must always describe the underlying subject matter, not the structure or wording of previous summaries.

### EXAMPLE

Input:
"The user asked what an LLM is. The AI explained that LLMs process tokens and generate text. Later, the user learned about embeddings, transformers, context windows, and RAG for Brain Shadow."

Output:
"Brain Shadow's development expanded into practical LLM learning, covering core concepts such as tokens, embeddings, transformers, context windows, and RAG, with these concepts being connected to the system's goal of understanding and processing stored AI conversations."

### FINAL RULE

Think internally in this order:

SEARCH QUERY
→ FIND RELEVANT CONVERSATIONS
→ IGNORE METADATA
→ IGNORE PREVIOUS SUMMARY WORDING
→ UNDERSTAND RAW CONTENT
→ EXTRACT MEANING
→ CONNECT RELATED INFORMATION
→ WRITE ONE NATURAL SUMMARY

The final answer should read like a concise description of the actual knowledge, work, or project progression — not a description of the conversations.`;

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
      const result = await groqService.chat([{ role: 'user', content: query }], systemPrompt);
      answer = result.content;
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
