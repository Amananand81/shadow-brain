const logger = require('./logger');

const STOP_WORDS = new Set([
  'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your',
  'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her',
  'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their', 'theirs',
  'themselves', 'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'having', 'do', 'does', 'did', 'doing', 'a', 'an', 'the', 'and', 'but', 'if',
  'or', 'because', 'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with',
  'about', 'against', 'between', 'through', 'during', 'before', 'after', 'above',
  'below', 'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under',
  'again', 'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
  'how', 'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 's',
  't', 'can', 'will', 'just', 'don', 'should', 'now', 'd', 'll', 'm', 'o',
  're', 've', 'y', 'ain', 'aren', 'couldn', 'didn', 'doesn', 'hadn', 'hasn',
  'haven', 'isn', 'ma', 'mightn', 'mustn', 'needn', 'shan', 'shouldn', 'wasn',
  'weren', 'won', 'wouldn', 'also', 'would', 'can', 'did', 'may', 'might',
]);

const TECH_KEYWORDS = [
  'javascript', 'typescript', 'python', 'java', 'react', 'node', 'css', 'html',
  'sql', 'database', 'api', 'server', 'deploy', 'git', 'github', 'aws', 'docker',
  'kubernetes', 'react', 'angular', 'vue', 'next', 'nodejs', 'express', 'mongodb',
  'mongoose', 'postgres', 'redis', 'graphql', 'rest', 'oauth', 'jwt', 'ssl',
  'http', 'https', 'websocket', 'typescript', 'python', 'rust', 'golang',
  'machine learning', 'ai', 'artificial intelligence', 'llm', 'rag',
  'vector', 'embedding', 'search', 'memory', 'brain', 'shadow',
  'chrome', 'extension', 'browser', 'mobile', 'desktop',
];

function extractKeywordsFromUserMessage(message) {
  if (!message || typeof message !== 'string') {
    logger.warn('[KeywordExtractor] Received non-string or empty message');
    return { keywords: [], rawText: '', keywordSource: 'none' };
  }

  const rawText = message.trim();
  if (rawText.length === 0) {
    logger.warn('[KeywordExtractor] Empty message after trim');
    return { keywords: [], rawText: '', keywordSource: 'none' };
  }

  const words = rawText
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  const keywordCounts = {};
  for (const word of words) {
    keywordCounts[word] = (keywordCounts[word] || 0) + 1;
  }

  const sortedKeywords = Object.entries(keywordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([keyword]) => keyword);

  const techMatches = TECH_KEYWORDS.filter(kw =>
    rawText.toLowerCase().includes(kw) && !sortedKeywords.includes(kw)
  );
  const finalKeywords = [...sortedKeywords, ...techMatches.slice(0, 5)];

  logger.info(`[KeywordExtractor] Extracted ${finalKeywords.length} keywords from user message`, {
    rawTextLength: rawText.length,
    keywords: finalKeywords,
  });

  return {
    keywords: finalKeywords,
    rawText,
    keywordSource: 'user_input',
  };
}

function validateSearchInput(input) {
  if (!input || typeof input !== 'string') {
    return { valid: false, reason: 'Input is not a string', sanitizedInput: null };
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { valid: false, reason: 'Input is empty after trim', sanitizedInput: null };
  }

  if (trimmed.length > 10000) {
    return { valid: false, reason: 'Input exceeds maximum length of 10000 characters', sanitizedInput: null };
  }

  const suspiciousPatterns = [
    /<script/i,
    /javascript:/i,
    /on\w+\s*=/i,
    /DROP\s+TABLE/i,
    /DELETE\s+FROM/i,
    /INSERT\s+INTO/i,
    /SELECT\s+.*\s+FROM/i,
  ];

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(trimmed)) {
      return { valid: false, reason: 'Input contains potentially malicious content', sanitizedInput: null };
    }
  }

  return { valid: true, reason: 'Valid user input', sanitizedInput: trimmed };
}

function isAIResponse(content) {
  if (!content || typeof content !== 'string') return false;
  const aiIndicators = [
    'I am an AI',
    'I am a large language model',
    'As an AI assistant',
    'As an AI,',
    "I don't have access",
    'I was designed to',
    'I am not able to',
    'I am an AI assistant',
    'I am an artificial intelligence',
  ];
  return aiIndicators.some(indicator => content.includes(indicator));
}

function ensureNotAIResponse(content, label = 'search input') {
  if (isAIResponse(content)) {
    logger.error(`[KeywordExtractor] SAFEGUARD TRIGGERED: ${label} appears to be an AI response, rejecting it`);
    throw new Error(`Refusing to use AI response as ${label}`);
  }
  return content;
}

module.exports = {
  extractKeywordsFromUserMessage,
  validateSearchInput,
  isAIResponse,
  ensureNotAIResponse,
  STOP_WORDS,
  TECH_KEYWORDS,
};
