const conversationService = require('../services/conversation.service');
const enrichmentService = require('../services/enrichment.service');
const groqService = require('../services/groq.service');
const n8nService = require('../services/n8n.service');
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

    // Build the context with USER and ASSISTANT turns in clearly labelled sections.
    // An optional TOPIC HINT from enrichment metadata anchors each block so the LLM
    // can identify per-conversation meaning before it reads every message.
    const context = scored.map(({ conv }, index) => {
      const allMsgs = conv.messages.slice(0, 20);

      const userLines = allMsgs
        .filter(m => m.role === 'user')
        .map(m => {
          if (isMetadataOnlyMessage(m.content)) return null;
          const content = sanitizeMessageContent(m.content);
          return content ? `  MSG: ${content.slice(0, 400)}` : null;
        })
        .filter(Boolean);

      const aiLines = allMsgs
        .filter(m => m.role !== 'user')
        .map(m => {
          if (isMetadataOnlyMessage(m.content)) return null;
          const content = sanitizeMessageContent(m.content);
          return content ? `  MSG: ${content.slice(0, 300)}` : null;
        })
        .filter(Boolean);

      if (!userLines.length) return null;

      // Optional topic hint from enrichment so the LLM has a semantic anchor.
      const topicHint = conv.enrichment?.topic || conv.title || '';

      let block = `=== CONVERSATION ${index + 1}${topicHint ? ` [${topicHint}]` : ''} ===`;
      block += `\n-- USER MESSAGES (intent/goals/problems/experience — primary source) --\n${userLines.join('\n')}`;
      if (aiLines.length) {
        block += `\n-- ASSISTANT MESSAGES (topic context only — NEVER treat as user intent) --\n${aiLines.join('\n')}`;
      }
      return block;
    }).filter(Boolean).join('\n\n');

    const systemPrompt = `You are a conversation-memory summarization system that works in three mandatory phases.

Do NOT skip any phase. Do NOT jump to the final output immediately.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HOW TO READ THE INPUT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Every conversation block is split into two labelled sections:

  -- USER MESSAGES --
  -- ASSISTANT MESSAGES --

Read them with different purposes:

USER MESSAGES — read to understand:
  - What the user is trying to learn, build, or solve
  - What goals or decisions the user expresses
  - What problems or errors the user describes
  - What experience the user mentions
  - The direction the user is heading

ASSISTANT MESSAGES — read to understand:
  - What specific concepts were explained
  - What technical details were discussed
  - What problems were diagnosed or addressed
  - What context helps explain the user's situation
  - What progression or solution approach was discussed

CRITICAL ATTRIBUTION RULE:
  NEVER write "the user learned X" or "the user decided to use X" based on the AI saying it.
  The user's intent comes from USER messages.
  The AI provides context, detail, and depth — not proof of user intent.

Example:
  USER: I want to learn React.
  ASSISTANT: You should study components, props, state, hooks, and routing.

  Correct: The user wants to learn React. The conversations cover components, props, state, and hooks.
  Wrong:   The user wants to learn components, props, state, hooks, and routing.
  (The list came from the AI recommendation, not from what the user stated.)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE A — UNDERSTAND EACH CONVERSATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

For EVERY conversation block, produce one structured entry.
Read USER MESSAGES first. Then read ASSISTANT MESSAGES for deeper context.

Output a JSON array tagged phase-a:

` + '```' + `phase-a
[
  {
    "conv": 1,
    "isRelevant": true,
    "userIntent": "What the user wants or is trying to do — from USER messages only",
    "userGoal": "Specific goal stated by the USER (empty string if none)",
    "userProblem": "Problem or error the USER explicitly describes (empty string if none)",
    "aiContext": "Key concepts explained / problems addressed / approaches discussed by the ASSISTANT",
    "combinedMeaning": "One sentence combining user intent + AI context to capture what this conversation is really about",
    "journeyStage": "learning / exploring / implementing / debugging / applying / planning"
  }
]
` + '```' + `

Rules for Phase A:
  - userIntent, userGoal, userProblem — from USER messages ONLY
  - aiContext — from ASSISTANT messages; capture the specific concepts, terms, and techniques discussed
  - combinedMeaning — one specific sentence merging intent + context
    BAD:  "User asked about state in React."
    GOOD: "User is learning how React manages component state using useState and the re-render cycle."
  - isRelevant — false if the conversation is clearly off-topic for the search query
  - Do NOT copy the user's exact question verbatim. Convert it to meaning.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE B — SYNTHESIZE ACROSS CONVERSATIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Look at ALL combinedMeaning entries where isRelevant is true.
Find the overall pattern, progression, and goal.

Output a JSON object tagged phase-b:

` + '```' + `phase-b
{
  "mainTopic": "The central subject the relevant conversations cluster around",
  "userPrimaryActivity": "learning / building / debugging / researching / planning",
  "journeyTitle": "3-5 word title describing the actual journey (NOT just the keyword)",
  "keyTopics": ["Specific concept or topic — use real technical terms"],
  "keyProblems": ["Specific problem the USER explicitly described"],
  "progression": "How the conversations connect and evolve — the narrative thread",
  "practicalContext": "Real-world application or project context mentioned by the user (empty string if none)",
  "overallGoal": "One sentence: what the user is ultimately trying to accomplish",
  "irrelevantConvs": []
}
` + '```' + `

Rules for Phase B:
  - Only use conversations where isRelevant is true
  - journeyTitle: 3-5 words that NAME the actual journey, not just the keyword
    Good: "React Learning Journey", "LLM Learning to Implementation",
          "JWT Authentication Debugging", "Brain Shadow LLM Integration",
          "Semantic Search Development", "Full-Stack MERN Journey"
    Bad:  "React", "LLM", "Learning", "Technical Issues", "Programming"
  - keyTopics: preserve real technical terms (useState, JWT, RAG, embeddings, CORS, etc.)
    Do NOT replace specific terms with vague phrases like "AI concepts" or "technical issues"
  - progression: describe how conversations relate — what led to what, how understanding evolved
  - If conversations represent clearly different journeys, focus on the dominant one

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE C — WRITE THE FINAL OUTPUT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

For EACH conversation where isRelevant is true in Phase A, write exactly ONE concise summary.

FORMAT — each summary must follow this exact two-part structure:
  [3-5 word Topic Title] — [one clear sentence describing what was discussed, learned, decided, or built]

Separate each summary with a line containing exactly: ||| <conv_number>
Use the same conv_number as the conversation block in the input.

FORMAT (use exactly this structure):

  ||| 1
  [Topic Title] — [One clear sentence.]

  ||| 2
  [Topic Title] — [One clear sentence.]

  ... one entry per relevant conversation.

SUMMARY RULES:
  - The Topic Title: 3-5 words that name the specific subject (not just the search keyword)
    GOOD: "React Learning Journey", "MERN Stack Setup", "Resume Update for React Roles", "Brain Shadow Backend Work"
    BAD:  "MERN", "Learning", "Code", "Discussion", "Conversation"
  - The sentence: describe what was ACTUALLY discussed, worked on, learned, or decided
  - NEVER copy the user's raw message text or the first sentence of a conversation
  - NEVER use filler phrases: "Hey", "Absolutely", "Listen", "This conversation is about..."
  - NEVER attribute AI recommendations to the user as their stated goals
  - NEVER hallucinate — only use facts present in the conversation
  - Preserve real technical terms (useState, JWT, MERN, RAG, CORS, etc.)
  - Only include conversations where isRelevant is true
  - Use only conv_numbers from the input (do not invent numbers)

EXAMPLES:
  BAD:  "hey want to start learn react from today Absolutely, Aman. Since you already know..."
  GOOD: "React Learning Journey — Started learning React to strengthen frontend and MERN skills, building on existing HTML, CSS, and JavaScript knowledge."

  BAD:  "This is a chat No listen, listen, I mostly worked in Brain Shadow..."
  GOOD: "Brain Shadow Development Experience — Discussed primarily working on the Brain Shadow backend, along with Chrome extension development and frontend/backend integration."

  BAD:  "Motivated Machine Learning Developer with hands-on experience..."
  GOOD: "Software Engineer Resume Update — Updated the professional summary to emphasize React, Node.js, Python, full-stack development, and AI application experience."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMPLETE WORKED EXAMPLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Search query: LLM

Phase C final output:

||| 1
RAG Architecture Overview — Explored how Retrieval-Augmented Generation combines vector search with LLM generation to produce context-aware, grounded answers.

||| 2
Brain Shadow LLM Integration — Focused on integrating an LLM into the Brain Shadow project using embeddings and a vector store for semantic memory search.

||| 3
LLM Learning Roadmap — Mapped out the full learning path from NLP fundamentals through transformers, fine-tuning, RAG, and agent systems.

||| 4
Prompt Engineering Deep Dive — Studied how system and user messages shape LLM output and how to guide model behavior through structured instructions.

||| 5
Embeddings and Semantic Search — Examined how text is converted to numerical vectors for similarity matching and retrieval in LLM-powered pipelines.`;
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
    let answerSections = [];
    let n8nHeading = '';
    let n8nSummaryText = '';
    let n8nUsed = false;



    // ── Step 1: Try n8n journey summary ─────────────────────────────────────
    try {
      const n8nResult = await n8nService.generateJourneySummary(query, scored);

      if (n8nResult) {
        // n8n returns { summary, heading }.
        // Keep heading and summary SEPARATE so the frontend can render them
        // distinctly (heading as title card, summary as body text).
        n8nHeading     = (n8nResult.heading  || '').trim();
        n8nSummaryText = (n8nResult.summary  || '').trim();

        const headingText = n8nHeading
          ? `${n8nHeading} — ${n8nSummaryText}`
          : n8nSummaryText;

        answer    = headingText;
        n8nUsed   = true;
        logger.info(`[Search] Answer generated via n8n (query="${query}")`);
      }
    } catch (n8nErr) {
      // Should not reach here (n8nService catches internally), but guard anyway.
      logger.warn(`[Search] n8n service threw unexpectedly: ${n8nErr.message}`);
    }
    // ─────────────────────────────────────────────────────────────────────────

    res.json({
      answer: n8nHeading && n8nSummaryText ? `${n8nHeading} — ${n8nSummaryText}` : n8nSummaryText,
      answerSections,
      sources,
      n8nSummary: n8nUsed ? { heading: n8nHeading, summary: n8nSummaryText } : null,
    });
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
