const {
  parseJsonResponse,
  validateMetadata,
} = require('../src/utils/validators');

const VALID_METADATA = {
  topic: 'Database connection setup',
  category: 'Technical',
  summary: 'The conversation explains how to configure a database connection.',
  keywords: ['database', 'configuration'],
  entities: ['MongoDB'],
  importance_score: 4,
};

describe('AI metadata response validation', () => {
  test('accepts complete direct JSON', () => {
    expect(parseJsonResponse(JSON.stringify(VALID_METADATA))).toEqual(VALID_METADATA);
    expect(validateMetadata(VALID_METADATA).valid).toBe(true);
  });

  test('accepts complete JSON in a Markdown code fence', () => {
    const response = `\`\`\`json\n${JSON.stringify(VALID_METADATA)}\n\`\`\``;
    expect(parseJsonResponse(response)).toEqual(VALID_METADATA);
  });

  test.each([
    ['invalid JSON', '{"topic":'],
    ['arbitrary brace-delimited text', `Here is the result: ${JSON.stringify(VALID_METADATA)}`],
    ['prose around a fenced response', `Result:\n\`\`\`json\n${JSON.stringify(VALID_METADATA)}\n\`\`\``],
  ])('rejects %s', (_description, response) => {
    expect(() => parseJsonResponse(response)).toThrow('Failed to parse AI JSON response');
  });

  test.each([
    ['missing required field', { ...VALID_METADATA, summary: undefined }],
    ['empty required field', { ...VALID_METADATA, topic: '  ' }],
    ['invalid field type', { ...VALID_METADATA, keywords: 'database' }],
    ['invalid category', { ...VALID_METADATA, category: 'Unknown' }],
    ['invalid importance score', { ...VALID_METADATA, importance_score: '4' }],
  ])('rejects metadata with %s', (_description, metadata) => {
    expect(validateMetadata(metadata).valid).toBe(false);
  });
});

describe('provider fallback', () => {
  let mockCerebrasCreate;
  let mockGroqExtract;
  let mockOpenAI;
  let mockLogger;
  let mockConversationService;
  let service;
  let originalGroqApiKey;
  let originalCerebrasApiKey;

  const conversation = {
    _id: 'conversation-1',
    title: 'Database setup',
    status: 'PENDING',
    messages: [
      { role: 'user', content: 'How should I configure a database connection?' },
      { role: 'assistant', content: 'Use the connection string and credentials.' },
    ],
  };

  function loadService({ groqResult, cerebrasResults }) {
    jest.resetModules();
    process.env.GROQ_API_KEY = 'test-groq-key';
    process.env.CEREBRAS_API_KEY = 'test-cerebras-key';
    mockGroqExtract = jest.fn().mockResolvedValue({ content: groqResult });
    mockCerebrasCreate = jest.fn();
    for (const result of cerebrasResults) {
      mockCerebrasCreate.mockImplementationOnce(async () => {
        if (result instanceof Error) throw result;
        return { choices: [{ message: { content: result } }] };
      });
    }
    mockOpenAI = jest.fn().mockImplementation(() => ({
      chat: { completions: { create: mockCerebrasCreate } },
    }));
    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    mockConversationService = {
      getById: jest.fn().mockResolvedValue({ ...conversation }),
      updateStatus: jest.fn().mockResolvedValue(undefined),
      updateEnrichment: jest.fn().mockResolvedValue(undefined),
    };

    jest.doMock('openai', () => mockOpenAI);
    jest.doMock('../src/services/groq.service', () => ({ extractMetadata: mockGroqExtract }));
    jest.doMock('../src/services/conversation.service', () => mockConversationService);
    jest.doMock('../src/utils/logger', () => mockLogger);
    service = require('../src/services/enrichment.service');
  }

  beforeEach(() => {
    originalGroqApiKey = process.env.GROQ_API_KEY;
    originalCerebrasApiKey = process.env.CEREBRAS_API_KEY;
  });

  afterEach(() => {
    if (originalGroqApiKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalGroqApiKey;
    if (originalCerebrasApiKey === undefined) delete process.env.CEREBRAS_API_KEY;
    else process.env.CEREBRAS_API_KEY = originalCerebrasApiKey;
    jest.dontMock('openai');
    jest.dontMock('../src/services/groq.service');
    jest.dontMock('../src/services/conversation.service');
    jest.dontMock('../src/utils/logger');
    jest.resetModules();
  });

  test.each([
    ['malformed JSON', '{"topic":'],
    ['incomplete metadata', JSON.stringify({ topic: VALID_METADATA.topic })],
    ['invalid field type', JSON.stringify({ ...VALID_METADATA, entities: 'MongoDB' })],
  ])('falls through to Cerebras after Groq returns %s', async (_description, groqContent) => {
    loadService({ groqResult: groqContent, cerebrasResults: [JSON.stringify(VALID_METADATA)] });

    await service.process(conversation._id);

    expect(mockGroqExtract).toHaveBeenCalledTimes(1);
    expect(mockCerebrasCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'qwen-3.8-27b',
    }));
    expect(mockOpenAI).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: 'https://api.cerebras.ai/v1',
    }));
    expect(mockConversationService.updateEnrichment).toHaveBeenCalledWith(
      conversation._id,
      expect.objectContaining({ enrichment_version: '1.0.0-cerebras' }),
    );
  });

  test('uses local enrichment when both AI providers fail', async () => {
    loadService({ groqResult: 'not JSON', cerebrasResults: ['also not JSON'] });

    await service.process(conversation._id);

    expect(mockConversationService.updateEnrichment).toHaveBeenCalledWith(
      conversation._id,
      expect.objectContaining({ enrichment_version: 'local-1.0', status: 'COMPLETED' }),
    );
  });

  test('logs sanitized provider failure details', async () => {
    const error = new Error('Invalid API key gsk_sensitive-secret');
    error.status = 401;
    error.code = 'invalid_api_key';
    loadService({ groqResult: 'unused', cerebrasResults: [error] });
    mockGroqExtract.mockRejectedValueOnce(error);

    await service.process(conversation._id);

    const warningText = mockLogger.warn.mock.calls.flat().join(' ');
    expect(warningText).toContain('status=401');
    expect(warningText).toContain('code=invalid_api_key');
    expect(warningText).not.toContain('gsk_sensitive-secret');
  });
});
