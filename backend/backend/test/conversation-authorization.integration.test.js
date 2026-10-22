process.env.JWT_SECRET = 'conversation-scope-test-secret';

const mockConversations = [
  {
    _id: 'conversation-a',
    userId: 'user-a',
    title: 'Private A',
    messages: [{ role: 'user', content: 'I like JavaScript' }],
  },
  {
    _id: 'conversation-b',
    userId: 'user-b',
    title: 'Private B',
    messages: [{ role: 'user', content: 'I like JavaScript' }],
  },
];

jest.mock('../src/models/user.model', () => ({
  findById: jest.fn(async (id) => ({ _id: id, email: `${id}@example.com` })),
}));

jest.mock('../src/services/conversation.service', () => ({
  createOrUpdate: jest.fn(async (data, userId) => ({
    _id: 'captured-conversation',
    userId,
    platform: data.platform,
    messages: data.messages,
  })),
  list: jest.fn(async (filter) => mockConversations.filter((conversation) => conversation.userId === filter.userId)),
  getById: jest.fn(async (id, userId) =>
    mockConversations.find((conversation) => conversation._id === id && conversation.userId === userId) || null,
  ),
}));

jest.mock('../src/services/enrichment.service', () => ({ process: jest.fn(() => Promise.resolve()) }));
jest.mock('../src/services/groq.service', () => ({}));
jest.mock('../src/services/n8n.service', () => ({}));
jest.mock('../src/services/journeySummary.service', () => ({}));

const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const conversationService = require('../src/services/conversation.service');
const conversationRoutes = require('../src/routes/conversation.routes');
const importRoutes = require('../src/routes/import.routes');

const app = express();
app.use(express.json());
app.use('/api/conversations', conversationRoutes);
app.use('/api/import', importRoutes);

function tokenFor(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET);
}

afterAll(() => {
  delete process.env.JWT_SECRET;
});

test('conversation list and search use the MongoDB user resolved from the signed token', async () => {
  const authToken = tokenFor('user-a');

  const list = await request(app)
    .get('/api/conversations')
    .set('Authorization', `Bearer ${authToken}`);
  expect(list.status).toBe(200);
  expect(list.body.map((conversation) => conversation._id)).toEqual(['conversation-a']);
  expect(conversationService.list).toHaveBeenCalledWith(
    { userId: 'user-a' },
    expect.objectContaining({ page: 1 }),
  );

  const search = await request(app)
    .post('/api/conversations/search')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ query: 'not-in-user-messages' });
  expect(search.status).toBe(200);
  expect(conversationService.list).toHaveBeenLastCalledWith(
    { userId: 'user-a' },
    expect.objectContaining({ limit: 1000 }),
  );

  const privateConversation = await request(app)
    .get('/api/conversations/conversation-b')
    .set('Authorization', `Bearer ${authToken}`);
  expect(privateConversation.status).toBe(404);
});

test('protected conversation routes reject unauthenticated requests', async () => {
  const response = await request(app).get('/api/conversations');
  expect(response.status).toBe(401);
});

test('extension capture persists through the authenticated identity, not a payload-supplied user ID', async () => {
  const payload = {
    external_id: 'chat-123',
    platform: 'chatgpt',
    title: 'Imported chat',
    messages: [{ role: 'user', content: 'hello' }],
    userId: 'user-b',
  };
  const response = await request(app)
    .post('/api/import/capture')
    .auth(tokenFor('user-a'), { type: 'bearer' })
    .send(payload);

  expect(response.status).toBe(202);
  expect(response.body).toMatchObject({
    id: 'captured-conversation',
    status: 'PENDING',
  });
  expect(conversationService.createOrUpdate).toHaveBeenCalledWith(payload, 'user-a');
});

test('extension capture rejects missing authentication before persistence', async () => {
  conversationService.createOrUpdate.mockClear();
  const response = await request(app)
    .post('/api/import/capture')
    .send({ external_id: 'chat-123', platform: 'chatgpt', messages: [] });

  expect(response.status).toBe(401);
  expect(conversationService.createOrUpdate).not.toHaveBeenCalled();
});
