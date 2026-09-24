'use strict';

/**
 * n8n Journey Summary Service
 *
 * Responsible ONLY for:
 *  1. Building the structured payload from Express-scored conversations
 *  2. POSTing to N8N_SUMMARY_WEBHOOK_URL
 *  3. Validating the response
 *  4. Returning null on any failure so the caller falls back to Groq
 *
 * n8n NEVER touches MongoDB. Express pre-filters to the current user's
 * relevant conversations before this service is called.
 */

const logger = require('../utils/logger');

const WEBHOOK_URL = process.env.N8N_SUMMARY_WEBHOOK_URL;
const TIMEOUT_MS = 25_000; // 25 s — generous enough for cold-start LLM calls

/**
 * Build the structured payload that n8n expects.
 *
 * @param {string} query - The user's original search query.
 * @param {Array}  scored - The scored conversation objects from searchConversations.
 *                          Each element is { conv, score, relevantMsgs }.
 * @returns {{ query: string, conversations: Array }}
 */
function buildPayload(query, scored) {
  const conversations = scored.map(({ conv }) => {
    // Use up to 20 messages (same limit as the Groq path).
    const msgs = (conv.messages || []).slice(0, 20);

    const messages = msgs
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        // Trim content so the n8n payload stays manageable.
        content: (m.content || '').slice(0, m.role === 'user' ? 400 : 300).trim(),
      }))
      .filter(m => m.content.length > 0);

    return {
      conversationId: conv._id.toString(),
      platform: conv.platform || 'unknown',
      title: conv.title || '',
      messages,
    };
  });

  return { query, conversations };
}

/**
 * Call the n8n webhook and return the generated journey summary.
 *
 * Returns an object `{ summary, heading }` on success, or `null` on any
 * failure (timeout, network error, bad response, success: false).
 *
 * @param {string} query
 * @param {Array}  scored
 * @returns {Promise<{ summary: string, heading: string } | null>}
 */
async function generateJourneySummary(query, scored) {
  if (!WEBHOOK_URL) {
    // n8n not configured — caller falls back to Groq.
    return null;
  }

  if (!scored || scored.length === 0) {
    return null;
  }

  const payload = buildPayload(query, scored);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    logger.info(`[n8n] Calling webhook for query="${query}" conversations=${payload.conversations.length}`);

    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      logger.warn(`[n8n] Webhook returned HTTP ${response.status} — falling back to Groq`);
      return null;
    }

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      logger.warn(`[n8n] Failed to parse webhook response JSON: ${parseErr.message}`);
      return null;
    }

    // n8n returns an array: [{ output: "..." }]. Unwrap to first element.
    // Also handle the plain object case { output: "..." } for safety.
    const raw = Array.isArray(data) ? data[0] : data;
    console.log('[n8n DEBUG] raw response type:', Array.isArray(data) ? 'array' : 'object');
    console.log('[n8n DEBUG] raw:', JSON.stringify(raw).slice(0, 300));

    // n8n AI Agent wraps the result in a top-level "output" field.
    // That field may be a JSON string or an already-parsed object.
    let parsedPayload = raw;
    if (raw && raw.output !== undefined) {
      if (typeof raw.output === 'string') {
        try {
          parsedPayload = JSON.parse(raw.output);
          console.log('[n8n DEBUG] parsed output string → heading:', parsedPayload.heading, '| summary length:', (parsedPayload.summary || '').length);
        } catch (jsonErr) {
          logger.warn(`[n8n] raw.output is not valid JSON, parsing as plain text format.`);
          
          const text = raw.output.trim();
          let extractedHeading = '';
          let extractedSummary = text;

          const headingMatch = text.match(/Heading:\s*/i);
          const summaryMatch = text.match(/Summary:\s*/i);

          if (headingMatch && summaryMatch && headingMatch.index < summaryMatch.index) {
            extractedHeading = text.substring(headingMatch.index + headingMatch[0].length, summaryMatch.index).trim();
            extractedSummary = text.substring(summaryMatch.index + summaryMatch[0].length).trim();
          } else if (headingMatch && !summaryMatch) {
            extractedHeading = text.substring(headingMatch.index + headingMatch[0].length).trim();
            extractedSummary = '';
          } else if (!headingMatch && summaryMatch) {
            extractedSummary = text.substring(summaryMatch.index + summaryMatch[0].length).trim();
            extractedHeading = text.substring(0, summaryMatch.index).trim();
          }

          parsedPayload = { heading: extractedHeading, summary: extractedSummary };
        }
      } else if (typeof raw.output === 'object' && raw.output !== null) {
        parsedPayload = raw.output;
        console.log('[n8n DEBUG] output is already an object → heading:', parsedPayload.heading);
      }
    } else {
      console.log('[n8n DEBUG] no output field found, using raw directly. Keys:', Object.keys(raw || {}));
    }

    // Validate the expected response shape from the unwrapped payload.
    if (!parsedPayload || parsedPayload.success === false) {
      logger.warn('[n8n] Webhook payload invalid or success=false');
      return null;
    }

    const summary = (parsedPayload.summary || '').trim();
    const heading = (parsedPayload.heading || '').trim();

    console.log('[n8n DEBUG] FINAL → heading:', heading, '| summary:', summary.slice(0, 80));

    if (!summary) {
      logger.warn('[n8n] Webhook returned empty summary');
      return null;
    }

    logger.info(`[n8n] Journey summary generated successfully (heading="${heading}")`);
    return { summary, heading };

  } catch (err) {
    clearTimeout(timer);

    if (err.name === 'AbortError') {
      logger.warn(`[n8n] Webhook timed out after ${TIMEOUT_MS}ms — falling back to Groq`);
    } else {
      logger.warn(`[n8n] Webhook call failed: ${err.message} — falling back to Groq`);
    }

    return null;
  }
}

module.exports = { generateJourneySummary };
