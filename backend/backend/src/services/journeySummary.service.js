'use strict';

/**
 * Code-based Journey Summary Service
 *
 * Mirrors the n8n journey-summary workflow in pure Node.js.
 * Uses the same Groq → Cerebras fallback pattern as enrichment.service.js
 * so it keeps working when either provider has an invalid/rate-limited key.
 *
 * N8N IS NOT TOUCHED. This runs on: POST /api/conversations/search/code-summary
 */

const OpenAI  = require('openai');
const logger  = require('../utils/logger');
const config  = require('../config/groq');

// ── Provider clients (lazy, same as groq.service.js approach) ──────────────
const groqClient = config.apiKeyChat
  ? new OpenAI({ apiKey: config.apiKeyChat, baseURL: config.baseUrl, timeout: 30000 })
  : null;

const cerebrasClient = process.env.CEREBRAS_API_KEY
  ? new OpenAI({
      apiKey:  process.env.CEREBRAS_API_KEY,
      baseURL: 'https://api.cerebras.ai/v1',
      timeout: 30000,
    })
  : null;

// gpt-oss-120b is the Cerebras-hosted model that n8n uses for the journey summary.
// Confirmed available via GET /v1/models (other models like llama-3.3-70b are gone).
const CEREBRAS_JOURNEY_MODEL = 'gpt-oss-120b';

// ── System prompt (exact replica of n8n workflow) ──────────────────────────
const SYSTEM_PROMPT = `You are the Journey Summary Generator for Brain Shadow, a personal AI memory system.

Your task is to generate a meaningful summary of the user's stored conversation history based primarily on the user's CURRENT SEARCH QUERY.

CORE RULE:
The user's current query is the PRIMARY FOCUS of the summary.

Do NOT generate a generic summary of all retrieved conversations. First understand exactly what the user is asking, then use the relevant conversation history to answer that query through a synthesized journey summary.

SUMMARY BEHAVIOR:
1. Understand the intent of the current user query before generating the summary.
2. Select and synthesize only the conversation information relevant to that query.
3. The same conversations may produce different summaries for different queries.
4. The summary must change according to the user's current search intent.
5. If the user asks about what they learned, focus on their knowledge, learning, concepts, and progression.
6. If the user asks how or where they used something, focus on their implementation, usage, decisions, and practical application.
7. If the user asks about a project, feature, technology, or concept, focus specifically on that subject.
8. If the query asks about progression, explain how the user's understanding or work developed over time.
9. Combine related questions and answers into one coherent story instead of listing individual conversations.
10. Do not simply copy or repeat questions, answers, or conversation text.
11. Do not include unrelated information just because it appears in the retrieved conversations.
12. Do not invent, assume, or infer information that is not supported by the provided conversations.
13. Resolve repeated discussions into one clear explanation rather than repeating the same information.
14. Prioritize concrete knowledge, decisions, implementations, problems solved, and meaningful progress.
15. The summary should feel like a useful explanation of what the user's memory contains about the searched topic.

LENGTH:
* Generate a minimum of 8 lines and a maximum of 15 lines.
* Decide the exact number of lines yourself based on the amount and importance of relevant information.
* Use fewer lines when the relevant information is limited, but NEVER below 8 lines.
* Use more lines when the query requires more context, but NEVER above 15 lines.
* Do not add meaningless or repetitive content just to reach the required minimum.
* Each line should contain meaningful information.
* Keep the summary concise, natural, and easy to understand.

HEADING:
* Generate a short heading of approximately 3–4 words.
* The heading must represent the specific topic or intent of the user's current query.
* Do not use generic headings such as "Conversation Summary", "User History", or "Search Results".

WRITING STYLE:
* Write in third person using "The user..." when appropriate.
* Describe the user's knowledge journey, development, decisions, or implementation naturally.
* Use past tense when describing completed learning or work.
* Avoid phrases such as "According to the conversations", "Based on the retrieved data", "The search results show", or "The AI said".
* Do not mention n8n, databases, retrieval, prompts, or the internal Brain Shadow search process.
* Do not use bullet points or numbered lists inside the summary.
* Make the summary read as one connected narrative.

IMPORTANT QUERY-FOCUS EXAMPLE:
If the query is:
"What do I know about LLM?"
Focus on the user's LLM knowledge, concepts learned, understanding, and progression.

If the query is:
"Where did I use LLM in Brain Shadow?"
Focus specifically on how and where LLMs were used in Brain Shadow, including relevant implementation and purpose.
Even if both queries retrieve some of the same conversations, their summaries MUST be different because their intents are different.

OUTPUT FORMAT:
Heading:
[3–4 word heading]

Summary:
[8–15 meaningful lines, with the exact number of lines decided by you according to the available relevant information]`;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a stringified context payload (mirrors what n8n receives).
 */
function buildContext(query, scored) {
  const conversations = scored.map(({ conv }) => {
    const msgs = (conv.messages || []).slice(0, 20);
    const messages = msgs
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({
        role:    m.role === 'user' ? 'user' : 'assistant',
        content: (m.content || '').slice(0, m.role === 'user' ? 400 : 300).trim(),
      }))
      .filter(m => m.content.length > 0);

    return {
      conversationId: conv._id ? conv._id.toString() : (conv.conversationId || 'unknown'),
      platform:       conv.platform || 'unknown',
      title:          conv.title   || '',
      messages,
    };
  });

  return JSON.stringify({ query, conversations }, null, 2);
}

/**
 * Parse the LLM response text into { heading, summary }.
 * Tolerates missing labels and extra whitespace around them.
 */
function parseResponse(text) {
  const headingMatch = text.match(/Heading:\s*/i);
  const summaryMatch = text.match(/Summary:\s*/i);

  let heading = '';
  let summary = text;

  if (headingMatch && summaryMatch && headingMatch.index < summaryMatch.index) {
    heading = text.substring(headingMatch.index + headingMatch[0].length, summaryMatch.index).trim();
    summary = text.substring(summaryMatch.index + summaryMatch[0].length).trim();
  } else if (headingMatch && !summaryMatch) {
    heading = text.substring(headingMatch.index + headingMatch[0].length).trim();
    summary = '';
  } else if (!headingMatch && summaryMatch) {
    heading = text.substring(0, summaryMatch.index).trim();
    summary = text.substring(summaryMatch.index + summaryMatch[0].length).trim();
  }

  // Last-resort: whole text becomes the summary
  if (!summary && !heading) {
    logger.warn('[CodeSummary] Model did not follow Heading/Summary format — using raw text.');
    return { heading: 'Journey Summary', summary: text };
  }

  return { heading, summary };
}

/**
 * Call a provider (groq or cerebras) and return raw text.
 */
async function callProvider(client, model, messages) {
  const response = await client.chat.completions.create({
    model,
    messages,
    max_tokens:  2000,
    temperature: 0.7,
  });
  return response.choices[0].message.content || '';
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a journey summary using the exact n8n system prompt.
 * Falls back from Groq to Cerebras automatically.
 *
 * @param {string} query   - The user's original search query.
 * @param {Array}  scored  - Scored conversations: [{ conv, score, relevantMsgs }]
 * @returns {Promise<{ heading: string, summary: string } | null>}
 */
async function generateJourneySummary(query, scored) {
  if (!query || !scored || scored.length === 0) {
    logger.warn('[CodeSummary] generateJourneySummary called with empty query or conversations.');
    return null;
  }

  const contextStr = buildContext(query, scored);
  const userContent = `CURRENT USER QUERY:\n${query}\n\nRELEVANT CONVERSATION CONTEXT:\n${contextStr}`;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: userContent },
  ];

  // Provider preference: Groq first (if key present), then Cerebras
  const providers = [];
  if (groqClient)     providers.push({ name: 'groq',     client: groqClient,     model: config.model });
  if (cerebrasClient) providers.push({ name: 'cerebras', client: cerebrasClient, model: CEREBRAS_JOURNEY_MODEL });

  if (providers.length === 0) {
    logger.error('[CodeSummary] No LLM provider configured (no GROQ_API_KEY or CEREBRAS_API_KEY).');
    return null;
  }

  for (const { name, client, model } of providers) {
    try {
      logger.info(`[CodeSummary] Calling ${name} (model=${model}) for query="${query}"`);
      const text = await callProvider(client, model, messages);

      if (!text || text.trim().length === 0) {
        logger.warn(`[CodeSummary] ${name} returned empty text — trying next provider.`);
        continue;
      }

      const result = parseResponse(text.trim());
      logger.info(`[CodeSummary] ${name} succeeded. heading="${result.heading}"`);
      return result;

    } catch (err) {
      logger.warn(`[CodeSummary] ${name} failed: ${err.message} — trying next provider.`);
    }
  }

  logger.error('[CodeSummary] All providers failed.');
  return null;
}

module.exports = { generateJourneySummary };
