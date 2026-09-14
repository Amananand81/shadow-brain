require('dotenv').config();
const { OpenAI } = require('openai');

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
  timeout: 30000,
});

async function runTest() {
  const query = "LLM learning";
  
  const context = `--- CONVERSATION 1 ---
USER: What is an LLM?
ASSISTANT: An LLM is a Large Language Model.

--- CONVERSATION 2 ---
USER: Give me an LLM roadmap.
ASSISTANT: Here is a learning path for LLMs.

--- CONVERSATION 3 ---
USER: How can I integrate LLM into Brain Shadow?
ASSISTANT: You can integrate it via backend APIs and web scrapers.

--- CONVERSATION 4 ---
USER: What is RAG?
ASSISTANT: RAG combines retrieval and generation to provide current context.

--- CONVERSATION 5 ---
USER: Which model/API should I use?
ASSISTANT: Comparing different models, GPT-4 is good, Groq is fast.`;

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
- Do NOT start sentences with "The user asked", "The user wanted to know", or "The AI responded".`;

  const result = await groq.chat.completions.create({
    model: 'llama-3.1-8b-instant', // fallback small model for test
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: \`SEARCH QUERY:\\n\${query}\\n\\nCONVERSATIONS:\\n\${context}\` }
    ],
    temperature: 0.7,
  });

  const rawContent = result.choices[0].message.content;
  console.log("=== RAW CONTENT ===");
  console.log(rawContent);
  
  const jsonRegex = /\`\`\`json[\\s\\S]*?\`\`\`/i;
  const match = rawContent.match(jsonRegex);
  
  let finalAnswer;
  if (match) {
    finalAnswer = rawContent.replace(jsonRegex, '').trim();
    finalAnswer = finalAnswer.replace(/^\\s*\`\`\`[\\s\\S]*?\`\`\`\\s*/, '').trim();
  } else {
    finalAnswer = rawContent.trim();
  }
  
  console.log("\\n=== EXTRACTED FINAL SUMMARY ===");
  console.log(finalAnswer);
}

runTest().catch(console.error);
