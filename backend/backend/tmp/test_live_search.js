'use strict';
/**
 * Live test: POST /api/conversations/search with a real user JWT
 * Run from: backend/backend/   →  node tmp/test_live_search.js
 *
 * NOTE: This test uses a REAL user from MongoDB.
 * It reads the first userId from the conversations collection
 * and signs a JWT for that user so the request passes the middleware.
 */
require('dotenv').config({ path: '.env' });

const mongoose = require('mongoose');
const jwt      = require('jsonwebtoken');

const BACKEND_URL = 'http://localhost:8000';
const JWT_SECRET  = process.env.JWT_SECRET;
const MONGO_URI   = process.env.MONGODB_URI || 'mongodb://localhost:27017/shadowbrain';

async function main() {
  console.log('[TEST] Connecting to MongoDB…');
  await mongoose.connect(MONGO_URI);
  console.log('[TEST] Connected.');

  // Grab a real userId so JWT middleware passes
  const Conversation = mongoose.model('Conversation', new mongoose.Schema({}, { strict: false }), 'conversations');
  const sample = await Conversation.findOne({}).select('userId').lean();
  if (!sample || !sample.userId) {
    console.error('[TEST] No conversations found or no userId field. Add conversations first.');
    process.exit(1);
  }

  const userId = sample.userId.toString();
  console.log(`[TEST] Using userId=${userId}`);

  const token = jwt.sign({ userId, email: 'test@debug.com' }, JWT_SECRET, { expiresIn: '1h' });

  const QUERIES = ['react', 'llm', 'brain shadow', 'javascript'];

  for (const query of QUERIES) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`[TEST] Query: "${query}"`);
    console.log('─'.repeat(60));

    try {
      const res = await fetch(`${BACKEND_URL}/api/conversations/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ query }),
      });

      const data = await res.json();
      console.log(`[TEST] Status: ${res.status}`);
      console.log(`[TEST] answer length: ${(data.answer || '').length}`);
      console.log(`[TEST] sources count: ${(data.sources || []).length}`);

      if (data.n8nSummary) {
        console.log(`\n✅ n8nSummary PRESENT`);
        console.log(`   heading: "${data.n8nSummary.heading}"`);
        console.log(`   summary (first 200 chars): "${(data.n8nSummary.summary || '').slice(0, 200)}"`);
      } else {
        console.log(`\n❌ n8nSummary is NULL — summary will NOT show in UI`);
      }
    } catch (e) {
      console.error(`[TEST] Request failed: ${e.message}`);
    }
  }

  await mongoose.disconnect();
  console.log('\n[TEST] Done.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
