// tmp/test_journey_summary.js
'use strict';

// Load .env first (same order as server.js)
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const journeySummaryService = require('../src/services/journeySummary.service');

const MOCK_SCORED = [
  {
    conv: {
      _id: 'conv1',
      platform: 'chatgpt',
      title: 'LLM Concepts and Brain Shadow',
      messages: [
        { role: 'user', content: 'What is a Large Language Model and how does it work?' },
        { role: 'assistant', content: 'An LLM is a model trained on massive text corpora using transformer architecture. It predicts the next token to generate coherent language.' },
        { role: 'user', content: 'How did I use LLMs specifically in Brain Shadow?' },
        { role: 'assistant', content: 'In Brain Shadow you integrated Groq LLMs for: (1) enrichment — extracting metadata from imported conversations; (2) search — generating semantic journey summaries from retrieved conversations; and (3) chat — an interactive memory assistant.' }
      ]
    },
    score: 5,
    relevantMsgs: []
  },
  {
    conv: {
      _id: 'conv2',
      platform: 'claude',
      title: 'React and Next.js Learning',
      messages: [
        { role: 'user', content: 'I want to start learning React from scratch. Where should I begin?' },
        { role: 'assistant', content: 'Begin with core concepts: components, props, state, and hooks. Then move to routing with React Router, and later Next.js for SSR.' },
        { role: 'user', content: 'I built the Brain Shadow frontend using Next.js 15. Can you help me understand the App Router?' },
        { role: 'assistant', content: 'The App Router shifts from pages/ to app/, uses React Server Components by default, and introduces layouts and loading states as nested files.' }
      ]
    },
    score: 4,
    relevantMsgs: []
  }
];

const QUERIES = [
  'What do I know about LLM?',
  'Where did I use LLM in Brain Shadow?',
  'What did I learn about React?',
  'How did I implement search in Brain Shadow?',
  'Tell me about cooking recipes',  // No relevant context
];

async function main() {
  console.log('\n=== JOURNEY SUMMARY SERVICE — LIVE TEST ===\n');

  for (const query of QUERIES) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`QUERY: "${query}"`);
    console.log('─'.repeat(60));

    try {
      const result = await journeySummaryService.generateJourneySummary(query, MOCK_SCORED);
      if (!result) {
        console.log('❌ result was null (all providers failed or no conversations)');
      } else {
        console.log(`\n📌 HEADING:\n${result.heading}`);
        console.log(`\n📄 SUMMARY:\n${result.summary}`);
      }
    } catch (err) {
      console.error(`❌ Error: ${err.message}`);
    }
  }

  console.log('\n\n=== TEST COMPLETE ===');
  process.exit(0);
}

main();
