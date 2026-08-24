import test from 'node:test';
import assert from 'node:assert/strict';

// Test 1: URL Regex Matching for All Platforms
test('ChatGPT convUrlRe matching', () => {
  const re = /\/(?:c|share|g\/[^\/]+\/c)\/([a-zA-Z0-9_\-]{4,})/;
  assert.ok(re.test('https://chatgpt.com/c/67b12345-abcd'));
  assert.ok(re.test('https://chatgpt.com/share/67b12345-abcd'));
  assert.ok(re.test('https://chatgpt.com/g/g-2DQbup18W-custom-gpt/c/67b12345-abcd'));
});

test('Claude convUrlRe matching', () => {
  const re = /\/(?:chat|c|conversation|project\/[^\/]+\/chat)\/([a-zA-Z0-9_\-]{4,})/;
  assert.ok(re.test('https://claude.ai/chat/01928374-5678'));
  assert.ok(re.test('https://claude.ai/c/01928374-5678'));
});

test('DeepSeek convUrlRe matching', () => {
  const re = /\/(?:chat\/s|s|c|chat)\/([a-zA-Z0-9_\-]{4,})/;
  assert.ok(re.test('https://chat.deepseek.com/s/123456789'));
  assert.ok(re.test('https://chat.deepseek.com/chat/s/123456789'));
  assert.ok(re.test('https://chat.deepseek.com/c/123456789'));
});

test('Grok convUrlRe matching', () => {
  const re = /\/(?:chat|c|conversation|conversations)\/([a-zA-Z0-9_\-]{4,})|\?conversation=([a-zA-Z0-9_\-]{4,})/;
  assert.ok(re.test('https://grok.com/chat/123456'));
  assert.ok(re.test('https://x.com/i/grok?conversation=123456'));
});

// Test 2: Role deduplication and content merging
test('deduplicateConsecutiveRoles merges consecutive same-role text blocks', () => {
  function deduplicateConsecutiveRoles(messages) {
    if (!messages.length) return messages;
    const out = [messages[0]];
    for (let i = 1; i < messages.length; i++) {
      const prev = out[out.length - 1];
      const curr = messages[i];
      if (curr.role === prev.role) {
        if (curr.content === prev.content) continue;
        if (prev.content.includes(curr.content)) continue;
        if (curr.content.includes(prev.content)) {
          out[out.length - 1] = curr;
        } else {
          prev.content = `${prev.content}\n\n${curr.content}`;
        }
      } else {
        out.push(curr);
      }
    }
    return out;
  }

  const input = [
    { role: 'user', content: 'Write a python function' },
    { role: 'assistant', content: 'Here is the function:' },
    { role: 'assistant', content: '```python\ndef foo(): pass\n```' },
  ];

  const result = deduplicateConsecutiveRoles(input);
  assert.equal(result.length, 2);
  assert.equal(result[0].role, 'user');
  assert.equal(result[1].role, 'assistant');
  assert.equal(result[1].content, 'Here is the function:\n\n```python\ndef foo(): pass\n```');
});

// Test 3: UI Noise Cleaning
test('cleanMessageText removes copy and action button noise', () => {
  function cleanMessageText(text) {
    if (!text) return '';
    const lines = text.split('\n');
    const actionRegex = /^(Copy|Copy code|Retry|Share|Edit|Good response|Bad response|Read aloud|Export to Docs|Modify response|Thought for \d+ seconds?|Thinking\.\.\.|\d+\s*\/\s*\d+)$/i;
    const filtered = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (actionRegex.test(line)) continue;
      filtered.push(lines[i]);
    }
    return filtered.join('\n').trim();
  }

  const rawText = "Here is the code output\nCopy code\nprint('hello')\nCopy\nRetry";
  const cleaned = cleanMessageText(rawText);
  assert.equal(cleaned, "Here is the code output\nprint('hello')");
});
