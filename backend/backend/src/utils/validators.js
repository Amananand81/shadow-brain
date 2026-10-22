const VALID_CATEGORIES = [
  'Technical', 'Business', 'Education', 'Creative',
  'Troubleshooting', 'Question', 'Research', 'Planning',
  'Implementation', 'Review', 'Other',
];

function validateMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { valid: false, errors: ['Metadata must be an object'] };
  }

  const errors = [];
  if (typeof metadata.topic !== 'string' || !metadata.topic.trim()) {
    errors.push('topic must be a non-empty string');
  }
  if (typeof metadata.category !== 'string' || !VALID_CATEGORIES.includes(metadata.category)) {
    errors.push('category must be a supported category');
  }
  if (typeof metadata.summary !== 'string' || metadata.summary.trim().length < 5) {
    errors.push('summary must be a string of at least 5 characters');
  }
  if (!Array.isArray(metadata.keywords) || metadata.keywords.length === 0
    || metadata.keywords.some(keyword => typeof keyword !== 'string' || !keyword.trim())) {
    errors.push('keywords must be a non-empty array of non-empty strings');
  }
  if (!Array.isArray(metadata.entities)
    || metadata.entities.some(entity => typeof entity !== 'string' || !entity.trim())) {
    errors.push('entities must be an array of non-empty strings');
  }
  if (!Number.isInteger(metadata.importance_score)
    || metadata.importance_score < 1 || metadata.importance_score > 5) {
    errors.push('importance_score must be an integer from 1 to 5');
  }

  return { valid: errors.length === 0, errors };
}

function parseJsonResponse(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Empty AI response');

  const trimmed = text.trim();
  try { return JSON.parse(text.trim()); } catch (_) {}

  // Accept a single complete JSON code fence, not prose containing a fenced block.
  const fenceMatch = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch (_) {}
  }

  throw new Error('Failed to parse AI JSON response');
}

function cleanConversationText(text) {
  if (!text) return '';
  return text.trim().replace(/\s+/g, ' ').slice(0, 10000);
}

module.exports = {
  validateMetadata,
  parseJsonResponse,
  cleanConversationText,
};
