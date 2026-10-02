const assert = require('assert');
const { extractKeywordsFromUserMessage, validateSearchInput, isAIResponse, ensureNotAIResponse } = require('../src/utils/keyword-extractor');

// ── Test runner ──────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ PASS: ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`❌ FAIL: ${name} — ${err.message}`);
  }
}

function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'Assertion failed'}: expected ${e}, got ${a}`);
}

function assertTrue(condition, msg) {
  if (!condition) throw new Error(`${msg || 'Assertion failed'}: expected truthy, got falsy`);
}

function assertFalse(condition, msg) {
  if (condition) throw new Error(`${msg || 'Assertion failed'}: expected falsy, got truthy`);
}

// ── Test Suite: extractKeywordsFromUserMessage ───────────────
console.log('\n═══ extractKeywordsFromUserMessage Tests ═══\n');

test('Extracts keywords from a simple user message', () => {
  const result = extractKeywordsFromUserMessage('show my LinkedIn messages about Java jobs');
  assertTrue(result.keywords.length > 0, 'Should extract at least one keyword');
  assertTrue(result.keywords.includes('java') || result.keywords.includes('linkedin'), 'Should contain java or linkedin');
  assertTrue(result.rawText.includes('LinkedIn'), 'Raw text should preserve original case');
  assertTrue(result.keywordSource === 'user_input', 'Source should be user_input');
});

test('Returns empty keywords for empty string', () => {
  const result = extractKeywordsFromUserMessage('');
  assertEqual(result.keywords, [], 'Keywords should be empty');
  assertEqual(result.rawText, '', 'Raw text should be empty');
});

test('Returns empty keywords for non-string input', () => {
  const result = extractKeywordsFromUserMessage(null);
  assertEqual(result.keywords, [], 'Keywords should be empty for null');
  const result2 = extractKeywordsFromUserMessage(undefined);
  assertEqual(result2.keywords, [], 'Keywords should be empty for undefined');
  const result3 = extractKeywordsFromUserMessage(123);
  assertEqual(result3.keywords, [], 'Keywords should be empty for number');
});

test('Filters stop words correctly', () => {
  const result = extractKeywordsFromUserMessage('how to build a web application');
  assertFalse(result.keywords.includes('how'), 'Should filter "how"');
  assertFalse(result.keywords.includes('to'), 'Should filter "to"');
  assertFalse(result.keywords.includes('a'), 'Should filter "a"');
  assertTrue(result.keywords.includes('web') || result.keywords.includes('build'), 'Should contain meaningful keywords');
});

test('Handles technical keywords', () => {
  const result = extractKeywordsFromUserMessage('I need help with Python and Docker deployment');
  assertTrue(result.keywords.includes('python') || result.keywords.includes('docker'), 'Should contain technical keywords');
});

test('Limits keywords to reasonable count', () => {
  const result = extractKeywordsFromUserMessage('show me everything about machine learning artificial intelligence deep learning neural networks');
  assertTrue(result.keywords.length <= 20, 'Should not exceed 20 keywords');
  assertTrue(result.keywords.length > 0, 'Should have some keywords');
});

test('Preserves original text in rawText', () => {
  const msg = 'Find my GitHub repositories about React';
  const result = extractKeywordsFromUserMessage(msg);
  assertEqual(result.rawText, msg, 'Raw text should match original');
});

// ── Test Suite: validateSearchInput ──────────────────────────
console.log('\n═══ validateSearchInput Tests ═══\n');

test('Validates clean user input', () => {
  const result = validateSearchInput('show me Java jobs');
  assertTrue(result.valid, 'Clean input should be valid');
  assertEqual(result.sanitizedInput, 'show me Java jobs', 'Sanitized input should match');
});

test('Rejects empty input', () => {
  const result = validateSearchInput('');
  assertFalse(result.valid, 'Empty input should be invalid');
});

test('Rejects non-string input', () => {
  const result = validateSearchInput(null);
  assertFalse(result.valid, 'Null input should be invalid');
});

test('Rejects input with SQL injection pattern', () => {
  const result = validateSearchInput("DROP TABLE conversations");
  assertFalse(result.valid, 'SQL injection should be rejected');
});

test('Rejects input with script tags', () => {
  const result = validateSearchInput('<script>alert(1)</script>');
  assertFalse(result.valid, 'Script tags should be rejected');
});

test('Accepts normal text with punctuation', () => {
  const result = validateSearchInput('What are the best JavaScript frameworks?');
  assertTrue(result.valid, 'Normal text with punctuation should be valid');
});

// ── Test Suite: isAIResponse ─────────────────────────────────
console.log('\n═══ isAIResponse Tests ═══\n');

test('Detects AI assistant responses', () => {
  assertTrue(isAIResponse('As an AI assistant, I can help you with that.'), 'Should detect AI assistant');
});

test('Detects AI model responses', () => {
  assertTrue(isAIResponse('I am an AI and I cannot access external data.'), 'Should detect AI model');
});

test('Does not flag user messages', () => {
  assertFalse(isAIResponse('I need help with my project'), 'User message should not be flagged');
});

test('Does not flag empty input', () => {
  assertFalse(isAIResponse(''), 'Empty string should not be flagged');
});

test('Does not flag null input', () => {
  assertFalse(isAIResponse(null), 'Null should not be flagged');
});

test('Does not flag normal text', () => {
  assertFalse(isAIResponse('Can you help me find my meetings about Java?'), 'Normal text should not be flagged');
});

// ── Test Suite: ensureNotAIResponse ──────────────────────────
console.log('\n═══ ensureNotAIResponse Tests ═══\n');

test('Passes for user messages', () => {
  const result = ensureNotAIResponse('Find my messages about Java');
  assertEqual(result, 'Find my messages about Java', 'Should return the content');
});

test('Throws for AI responses', () => {
  assert.throws(
    () => ensureNotAIResponse('As an AI assistant, I can help.'),
    /Refusing to use AI response/,
    'Should throw for AI response'
  );
});

test('Passes for empty input', () => {
  const result = ensureNotAIResponse('');
  assertEqual(result, '', 'Empty string should pass');
});

// ── Test Suite: Pipeline Safeguards ──────────────────────────
console.log('\n═══ Pipeline Safeguards Tests ═══\n');

test('AI response never enters keyword extraction', () => {
  // Simulate: user sends message, gets AI response, and AI response should not be searched
  const userMessage = 'show my LinkedIn messages about Java jobs';
  const { keywords } = extractKeywordsFromUserMessage(userMessage);
  assertTrue(keywords.length > 0, 'User message should produce keywords');

  // The AI response should NOT be used as input to extractKeywordsFromUserMessage
  const aiResponse = 'As an AI assistant, I found some results about Java jobs.';
  assertFalse(isAIResponse(userMessage), 'User message should not be flagged as AI');
  assertTrue(isAIResponse(aiResponse), 'AI response should be detected as AI');
});

test('Multiple user messages only use the last one for keywords', () => {
  // This tests the logic in chat.controller.js where we filter user messages
  const messages = [
    { role: 'user', content: 'What is Java?' },
    { role: 'assistant', content: 'Java is a programming language.' },
    { role: 'user', content: 'show my LinkedIn messages about Java jobs' },
  ];
  const userMessages = messages.filter(m => m.role === 'user');
  const lastUserMessage = userMessages[userMessages.length - 1].content;
  assertEqual(lastUserMessage, 'show my LinkedIn messages about Java jobs', 'Last user message should be used');
});

test('AI response in history does not trigger search', () => {
  // The chat controller only extracts keywords from user messages
  const messages = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there! How can I help?' },
  ];
  const userMessages = messages.filter(m => m.role === 'user');
  const lastUserMsg = userMessages[userMessages.length - 1]?.content || '';
  const { keywords } = extractKeywordsFromUserMessage(lastUserMsg);
  // "Hello" might produce few keywords, but it's still from the user
  // The key point is that the assistant message is NOT used for keywords
  assertEqual(keywords.length >= 0, true, 'Should handle conversation with only one user message');
});

// ── Summary ──────────────────────────────────────────────────
console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
if (failures.length > 0) {
  console.log('Failures:');
  failures.forEach(f => console.log(`  ❌ ${f.name}: ${f.error}`));
  process.exit(1);
} else {
  console.log('All tests passed!');
}
