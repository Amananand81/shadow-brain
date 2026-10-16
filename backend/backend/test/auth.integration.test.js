process.env.JWT_SECRET = 'test-auth-secret';
process.env.CLERK_SECRET_KEY = 'test-clerk-secret';
process.env.CLERK_AUTHORIZED_PARTIES = 'http://localhost:3000';

const validClerkAuthorization = `Bearer ${'valid-clerk-session-token'}`;
const mockUsers = [];
const mockClerkUsers = new Map();
let mockVerifyError = null;

function mockMakeUser(fields = {}) {
  return {
    ...fields,
    _id: fields._id || `user-${mockUsers.length + 1}`,
    async save() {
      if (!mockUsers.includes(this)) mockUsers.push(this);
      return this;
    },
  };
}

jest.mock('../src/models/user.model', () => ({
  create: jest.fn(async (fields) => {
    const user = mockMakeUser(fields);
    mockUsers.push(user);
    return user;
  }),
  findById: jest.fn(async (id) => mockUsers.find((user) => user._id.toString() === id.toString()) || null),
  findOne: jest.fn((filter) => {
    const promise = Promise.resolve(mockUsers.find((user) =>
      Object.entries(filter).every(([key, value]) => user[key] === value),
    ) || null);
    const query = {
      select: () => query,
      then: (resolve, reject) => promise.then(resolve, reject),
    };
    return query;
  }),
  find: jest.fn((filter) => ({
    limit: async (count) => mockUsers.filter((user) =>
      Object.entries(filter).every(([key, value]) => user[key] === value),
    ).slice(0, count),
  })),
  findOneAndUpdate: jest.fn(async (filter, update) => {
    const user = mockUsers.find((candidate) => {
      if (candidate._id.toString() !== filter._id.toString()) return false;
      return filter.$or.some((condition) => {
        if (condition.clerkUserId?.$exists === false) return !Object.hasOwn(candidate, 'clerkUserId');
        if (condition.clerkUserId === null) return candidate.clerkUserId == null;
        return candidate.clerkUserId === condition.clerkUserId;
      });
    });
    if (!user) return null;
    Object.assign(user, update.$set);
    user.authProviders = [...new Set([...(user.authProviders || []), update.$addToSet.authProviders])];
    return user;
  }),
}));

jest.mock('@clerk/backend', () => ({
  createClerkClient: jest.fn(() => ({
    sessions: {
      getSession: jest.fn(async (id) => ({
        id,
        userId: 'clerk-user-1',
        status: 'active',
      })),
    },
    users: {
      getUser: jest.fn(async (id) => {
        const user = mockClerkUsers.get(id);
        if (!user) throw new Error('Not found');
        return user;
      }),
    },
  })),
  verifyToken: jest.fn(async (token) => {
    if (mockVerifyError || token !== 'valid-clerk-session-token') throw mockVerifyError || new Error('Invalid token');
    return { sub: 'clerk-user-1', sid: 'clerk-session-1' };
  }),
}));

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const User = require('../src/models/user.model');
const { verifyToken } = require('@clerk/backend');
const logger = require('../src/utils/logger');
const authRoutes = require('../src/routes/auth.routes');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/auth', authRoutes);

function verifiedClerkUser(overrides = {}) {
  return {
    id: 'clerk-user-1',
    primaryEmailAddressId: 'email-1',
    emailAddresses: [{
      id: 'email-1',
      emailAddress: 'ada@example.com',
      verification: { status: 'verified' },
    }],
    firstName: 'Ada',
    lastName: 'Lovelace',
    imageUrl: 'https://example.test/avatar.png',
    banned: false,
    locked: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockUsers.splice(0);
  mockClerkUsers.clear();
  mockClerkUsers.set('clerk-user-1', verifiedClerkUser());
  mockVerifyError = null;
  jest.clearAllMocks();
});

afterAll(() => {
  delete process.env.JWT_SECRET;
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.CLERK_AUTHORIZED_PARTIES;
});

describe('Clerk authentication and application session', () => {
  test('creates a new MongoDB user only after the verified Clerk session reaches the backend', async () => {
    const response = await request(app)
      .post('/api/auth/clerk')
      .set('Authorization', 'Bearer valid-clerk-session-token')
      .set('X-Clerk-Session-Id', 'clerk-session-1');

    expect(response.status).toBe(200);
    expect(verifyToken).toHaveBeenCalledWith('valid-clerk-session-token', {
      secretKey: 'test-clerk-secret',
      authorizedParties: ['http://localhost:3000'],
    });
    expect(mockUsers).toHaveLength(1);
    expect(mockUsers[0]).toMatchObject({
      clerkUserId: 'clerk-user-1',
      email: 'ada@example.com',
      emailVerified: true,
      authProviders: ['clerk'],
    });
    expect(response.body.token).toBeTruthy();
    expect(response.body.user.email).toBe('ada@example.com');
    expect(response.headers['set-cookie'][0]).toMatch(/HttpOnly/i);
  });

  test('links an existing verified Clerk email without changing the MongoDB user ID or conversation owner', async () => {
    const existing = mockMakeUser({
      _id: 'original-mongo-id',
      email: 'ada@example.com',
      authProviders: ['password'],
      emailVerified: false,
      profileData: { preserved: true },
    });
    mockUsers.push(existing);
    const conversation = { _id: 'conversation-1', userId: 'original-mongo-id' };

    const response = await request(app)
      .post('/api/auth/clerk')
      .set('Authorization', 'Bearer valid-clerk-session-token')
      .set('X-Clerk-Session-Id', 'clerk-session-1');

    expect(response.status).toBe(200);
    expect(mockUsers).toHaveLength(1);
    expect(mockUsers[0]._id).toBe('original-mongo-id');
    expect(mockUsers[0].profileData).toEqual({ preserved: true });
    expect(mockUsers[0].authProviders).toEqual(['password', 'clerk']);
    expect(conversation.userId).toBe('original-mongo-id');
  });

  test('links a verified Clerk identity to a unique Google user without changing its ID or conversation ownership', async () => {
    const existing = mockMakeUser({
      _id: 'google-user-id',
      googleId: 'google-user-1',
      email: 'ada@example.com',
      authProviders: ['google'],
      emailVerified: true,
      profileData: { preserved: true },
    });
    mockUsers.push(existing);
    const conversation = { _id: 'google-conversation', userId: 'google-user-id' };

    const response = await request(app)
      .post('/api/auth/clerk')
      .set('Authorization', 'Bearer valid-clerk-session-token')
      .set('X-Clerk-Session-Id', 'clerk-session-1');

    expect(response.status).toBe(200);
    expect(mockUsers).toHaveLength(1);
    expect(mockUsers[0]).toMatchObject({
      _id: 'google-user-id',
      googleId: 'google-user-1',
      clerkUserId: 'clerk-user-1',
      authProviders: ['google', 'clerk'],
      profileData: { preserved: true },
    });
    expect(conversation.userId).toBe('google-user-id');
  });

  test('rejects invalid or expired Clerk tokens without creating users', async () => {
    mockVerifyError = new Error('invalid token');
    const response = await request(app)
      .post('/api/auth/clerk')
      .set('Authorization', 'Bearer expired-clerk-session-token')
      .set('X-Clerk-Session-Id', 'clerk-session-1');

    expect(response.status).toBe(401);
    expect(mockUsers).toHaveLength(0);
    expect(response.body.message).toMatch(/Invalid or expired/);
  });

  test('rejects a client session identifier that does not match the signed token', async () => {
    const response = await request(app)
      .post('/api/auth/clerk')
      .set('Authorization', 'Bearer valid-clerk-session-token')
      .set('X-Clerk-Session-Id', 'different-session');

    expect(response.status).toBe(401);
    expect(mockUsers).toHaveLength(0);
  });

  test('rejects a revoked Clerk session after token verification', async () => {
    const { createClerkClient } = require('@clerk/backend');
    createClerkClient.mockReturnValueOnce({
      sessions: {
        getSession: jest.fn(async (id) => ({
          id,
          userId: 'clerk-user-1',
          status: 'revoked',
        })),
      },
      users: { getUser: jest.fn() },
    });

    const response = await request(app)
      .post('/api/auth/clerk')
      .set('Authorization', 'Bearer valid-clerk-session-token')
      .set('X-Clerk-Session-Id', 'clerk-session-1');

    expect(response.status).toBe(401);
    expect(mockUsers).toHaveLength(0);
  });

  test('rejects a Clerk identity whose primary email is not verified', async () => {
    mockClerkUsers.set('clerk-user-1', verifiedClerkUser({
      emailAddresses: [{
        id: 'email-1',
        emailAddress: 'ada@example.com',
        verification: { status: 'unverified' },
      }],
    }));

    const response = await request(app)
      .post('/api/auth/clerk')
      .set('Authorization', 'Bearer valid-clerk-session-token')
      .set('X-Clerk-Session-Id', 'clerk-session-1');

    expect(response.status).toBe(403);
    expect(mockUsers).toHaveLength(0);
  });

  test('rejects ambiguous duplicate email records instead of linking either account', async () => {
    mockUsers.push(
      mockMakeUser({ _id: 'mongo-id-1', email: 'ada@example.com' }),
      mockMakeUser({ _id: 'mongo-id-2', email: 'ada@example.com' }),
    );

    const response = await request(app)
      .post('/api/auth/clerk')
      .set('Authorization', 'Bearer valid-clerk-session-token')
      .set('X-Clerk-Session-Id', 'clerk-session-1');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('AMBIGUOUS_EMAIL_MATCHES');
    expect(mockUsers.map((user) => user.clerkUserId)).toEqual([undefined, undefined]);
    expect(logger.warn).toHaveBeenCalledWith('[Auth] Clerk account resolution conflict', {
      reasonCode: 'AMBIGUOUS_EMAIL_MATCHES',
      emailMatchCount: 2,
    });
  });

  test('rejects a conflicting Clerk identity already attached to a different MongoDB user', async () => {
    mockUsers.push(
      mockMakeUser({ _id: 'mongo-id-1', clerkUserId: 'clerk-user-1', email: 'old@example.com' }),
      mockMakeUser({ _id: 'mongo-id-2', email: 'ada@example.com' }),
    );

    const response = await request(app)
      .post('/api/auth/clerk')
      .set('Authorization', 'Bearer valid-clerk-session-token')
      .set('X-Clerk-Session-Id', 'clerk-session-1');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('CLERK_IDENTITY_EMAIL_CONFLICT');
    expect(mockUsers[1].clerkUserId).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('[Auth] Clerk account resolution conflict', {
      reasonCode: 'CLERK_IDENTITY_EMAIL_CONFLICT',
      emailMatchCount: 1,
    });
  });

  test('reports a duplicate email key conflict without exposing the stored email', async () => {
    User.create.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), {
      code: 11000,
      keyPattern: { email: 1 },
    }));

    const response = await request(app)
      .post('/api/auth/clerk')
      .set('Authorization', validClerkAuthorization)
      .set('X-Clerk-Session-Id', 'clerk-session-1');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('EMAIL_ALREADY_CLAIMED');
    expect(JSON.stringify(response.body)).not.toContain('ada@example.com');
    expect(logger.warn).toHaveBeenCalledWith('[Auth] Clerk account resolution conflict', {
      reasonCode: 'EMAIL_ALREADY_CLAIMED',
      emailMatchCount: undefined,
    });
  });

  test('reuses the same identity mapping on repeated successful exchanges', async () => {
    const existing = mockMakeUser({
      _id: 'stable-id',
      clerkUserId: 'clerk-user-1',
      email: 'ada@example.com',
      authProviders: ['clerk'],
    });
    mockUsers.push(existing);

    const first = await request(app).post('/api/auth/clerk')
      .set('Authorization', 'Bearer valid-clerk-session-token')
      .set('X-Clerk-Session-Id', 'clerk-session-1');
    const second = await request(app).post('/api/auth/clerk')
      .set('Authorization', 'Bearer valid-clerk-session-token')
      .set('X-Clerk-Session-Id', 'clerk-session-1');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mockUsers).toHaveLength(1);
    expect(mockUsers[0]._id).toBe('stable-id');
  });

  test('restores a valid Brain Shadow application session and clears it on logout', async () => {
    const user = mockMakeUser({ _id: 'session-user', email: 'ada@example.com', name: 'Ada' });
    mockUsers.push(user);
    const appToken = jwt.sign({ userId: user._id }, process.env.JWT_SECRET);

    const restored = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${appToken}`);
    expect(restored.status).toBe(200);
    expect(restored.body.email).toBe(user.email);

    const invalid = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer invalid');
    expect(invalid.status).toBe(401);

    const logout = await request(app).post('/api/auth/logout');
    expect(logout.status).toBe(200);
    expect(logout.headers['set-cookie'][0]).toMatch(/shadowbrain_token=;/);
  });

  test('does not expose the removed password or Google authentication endpoints', async () => {
    for (const path of ['/login', '/register', '/google', '/forgot-password', '/reset-password']) {
      const response = await request(app).post(`/api/auth${path}`).send({});
      expect(response.status).toBe(404);
    }
  });
});
