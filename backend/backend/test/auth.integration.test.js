process.env.JWT_SECRET = 'test-auth-secret';
process.env.GOOGLE_CLIENT_ID = 'test-google-client';
process.env.FRONTEND_URL = 'http://localhost:3000';

const crypto = require('crypto');
const mockUsers = [];
let mockGooglePayload = null;

jest.mock('../src/models/user.model', () => {
  class User {
    constructor(fields = {}) {
      Object.assign(this, fields);
      this._id = this._id || `user-${mockUsers.length + 1}`;
    }

    async save() {
      if (!mockUsers.includes(this)) mockUsers.push(this);
      return this;
    }

    static async create(fields) {
      const user = new User(fields);
      mockUsers.push(user);
      return user;
    }

    static findOne(filter) {
      const match = (user) => Object.entries(filter).every(([key, expected]) => {
        if (expected && typeof expected === 'object' && expected.$gt) {
          return user[key] && new Date(user[key]) > expected.$gt;
        }
        return user[key] === expected;
      });
      const promise = Promise.resolve(mockUsers.find(match) || null);
      const query = {
        select: () => query,
        then: (resolve, reject) => promise.then(resolve, reject),
      };
      return query;
    }

    static findById(id) {
      const promise = Promise.resolve(mockUsers.find((user) => user._id === id) || null);
      const query = {
        select: () => query,
        then: (resolve, reject) => promise.then(resolve, reject),
      };
      return query;
    }

    static async findOneAndUpdate(filter, update) {
      const user = mockUsers.find((candidate) => Object.entries(filter).every(([key, expected]) => {
        if (expected && typeof expected === 'object' && expected.$gt) {
          return candidate[key] && new Date(candidate[key]) > expected.$gt;
        }
        return candidate[key] === expected;
      }));
      if (!user) return null;
      Object.assign(user, update.$set || {});
      for (const [key, value] of Object.entries(update.$addToSet || {})) {
        user[key] = [...new Set([...(user[key] || []), value])];
      }
      for (const key of Object.keys(update.$unset || {})) delete user[key];
      return user;
    }

    static async deleteOne({ _id }) {
      const index = mockUsers.findIndex((user) => user._id === _id);
      if (index >= 0) mockUsers.splice(index, 1);
    }
  }
  return User;
});

jest.mock('../src/services/email.service', () => ({
  sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
  sendWelcomeEmail: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('google-auth-library', () => ({
  OAuth2Client: class {
    async verifyIdToken() {
      return { getPayload: () => mockGooglePayload };
    }
  },
}));

const express = require('express');
const request = require('supertest');
const User = require('../src/models/user.model');
const emailService = require('../src/services/email.service');
const authRoutes = require('../src/routes/auth.routes');

const app = express();
app.use(express.json());
app.use('/api/auth', authRoutes);

beforeEach(() => {
  mockUsers.splice(0, mockUsers.length);
  mockGooglePayload = null;
  jest.clearAllMocks();
});

afterAll(() => {
  delete process.env.JWT_SECRET;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.FRONTEND_URL;
});

describe('authentication lifecycle', () => {
  test('registers an unverified password account, verifies it, then logs in with a JWT', async () => {
    const registration = await request(app).post('/api/auth/register').send({
      name: 'Ada Lovelace',
      email: ' ADA@example.com ',
      password: 'StrongPass1!',
      confirmPassword: 'StrongPass1!',
    });

    expect(registration.status).toBe(201);
    expect(registration.body).toEqual({ message: expect.stringContaining('Check your email') });
    const user = mockUsers[0];
    expect(user.email).toBe('ada@example.com');
    expect(user.name).toBe('Ada Lovelace');
    expect(user.passwordHash).toMatch(/^\$2/);
    expect(user.passwordHash).not.toBe('StrongPass1!');
    expect(user.emailVerified).toBe(false);
    expect(user.authProviders).toEqual(['password']);
    expect(registration.headers['set-cookie']).toBeUndefined();

    const verificationUrl = emailService.sendVerificationEmail.mock.calls[0][0].verificationUrl;
    const verificationToken = new URL(verificationUrl).searchParams.get('token');
    const blockedLogin = await request(app).post('/api/auth/login').send({ email: user.email, password: 'StrongPass1!' });
    expect(blockedLogin.status).toBe(403);

    const verification = await request(app).post('/api/auth/verify-email').send({ token: verificationToken });
    expect(verification.status).toBe(200);
    expect(verification.body.user).toEqual({ email: user.email, name: user.name });
    expect(verification.body.token).toBeTruthy();
    expect(verification.headers['set-cookie'][0]).toMatch(/HttpOnly/i);
    expect(user.emailVerified).toBe(true);
    expect(user.emailVerificationTokenHash).toBeUndefined();
    expect(emailService.sendWelcomeEmail).toHaveBeenCalledWith(expect.objectContaining({ method: 'password' }));

    const login = await request(app).post('/api/auth/login').send({ email: user.email, password: 'StrongPass1!' });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();
    expect(login.body.user.email).toBe(user.email);
    expect(JSON.stringify(login.body)).not.toContain('passwordHash');

    const reusedVerification = await request(app).post('/api/auth/verify-email').send({ token: verificationToken });
    expect(reusedVerification.status).toBe(400);
  });

  test('forgot-password is enumeration-safe and reset links are single-use', async () => {
    const user = await User.create({
      email: 'ada@example.com',
      name: 'Ada',
      passwordHash: '$2a$10$existing-hash',
      emailVerified: true,
      authProviders: ['password'],
    });

    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: 'nobody@example.com' });
    const known = await request(app).post('/api/auth/forgot-password').send({ email: user.email });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual(known.body);

    const resetUrl = emailService.sendPasswordResetEmail.mock.calls[0][0].resetUrl;
    const token = new URL(resetUrl).searchParams.get('token');
    expect(user.passwordResetTokenHash).not.toBe(token);

    const reset = await request(app).post('/api/auth/reset-password').send({
      token,
      password: 'NewStrong2!',
      confirmPassword: 'NewStrong2!',
    });
    expect(reset.status).toBe(200);
    expect(user.passwordHash).toMatch(/^\$2/);
    expect(user.passwordResetTokenHash).toBeUndefined();

    const replay = await request(app).post('/api/auth/reset-password').send({
      token,
      password: 'AnotherStrong3!',
      confirmPassword: 'AnotherStrong3!',
    });
    expect(replay.status).toBe(400);
  });

  test('does not link an unverified password account to a Google identity', async () => {
    const user = await User.create({
      email: 'ada@example.com',
      passwordHash: '$2a$10$existing-hash',
      emailVerified: false,
      authProviders: ['password'],
    });
    mockGooglePayload = { sub: 'google-sub', email: user.email, email_verified: true, name: 'Ada' };

    const response = await request(app).post('/api/auth/google').send({ credential: 'verified-google-credential' });
    expect(response.status).toBe(409);
    expect(user.googleId).toBeUndefined();
    expect(emailService.sendWelcomeEmail).not.toHaveBeenCalled();
  });

  test('links a verified Google identity to the existing verified email account', async () => {
    const user = await User.create({
      email: 'ada@example.com',
      emailVerified: true,
      passwordHash: '$2a$10$existing-hash',
      authProviders: ['password'],
    });
    mockGooglePayload = { sub: 'google-sub', email: user.email, email_verified: true, name: 'Ada Lovelace' };

    const response = await request(app).post('/api/auth/google').send({ credential: 'verified-google-credential' });
    expect(response.status).toBe(200);
    expect(mockUsers).toHaveLength(1);
    expect(user.googleId).toBe('google-sub');
    expect(user.authProviders).toEqual(['password', 'google']);
    expect(response.body.user.email).toBe(user.email);
    expect(emailService.sendWelcomeEmail).not.toHaveBeenCalled();
  });

  test('creates a verified Google account and sends its welcome email once', async () => {
    mockGooglePayload = {
      sub: 'new-google-sub',
      email: 'new@example.com',
      email_verified: true,
      name: 'New User',
      picture: 'https://example.test/avatar.png',
    };

    const response = await request(app).post('/api/auth/google').send({ credential: 'verified-google-credential' });
    expect(response.status).toBe(200);
    expect(mockUsers).toHaveLength(1);
    expect(mockUsers[0].emailVerified).toBe(true);
    expect(mockUsers[0].authProviders).toEqual(['google']);
    expect(mockUsers[0].avatar).toBe(mockGooglePayload.picture);
    expect(emailService.sendWelcomeEmail).toHaveBeenCalledWith(expect.objectContaining({ method: 'google' }));
  });

  test('allows an authenticated Google user to link password sign-in', async () => {
    mockGooglePayload = { sub: 'google-sub', email: 'linked@example.com', email_verified: true, name: 'Linked User' };
    const googleLogin = await request(app).post('/api/auth/google').send({ credential: 'verified-google-credential' });
    expect(googleLogin.status).toBe(200);

    const linked = await request(app)
      .post('/api/auth/link-password')
      .set('Authorization', `Bearer ${googleLogin.body.token}`)
      .send({ password: 'LinkedPass1!', confirmPassword: 'LinkedPass1!' });
    expect(linked.status).toBe(200);
    expect(mockUsers[0].authProviders).toEqual(['google', 'password']);
    expect(mockUsers[0].passwordHash).toMatch(/^\$2/);

    const passwordLogin = await request(app).post('/api/auth/login').send({ email: mockUsers[0].email, password: 'LinkedPass1!' });
    expect(passwordLogin.status).toBe(200);
  });

  test('upgrades a legacy scrypt password hash after a successful verified login', async () => {
    const password = 'LegacyPass1!';
    const salt = 'legacy-salt';
    const legacyHash = crypto.scryptSync(password, salt, 64).toString('hex');
    const user = await User.create({
      email: 'legacy@example.com',
      emailVerified: true,
      passwordHash: `${salt}:${legacyHash}`,
      authProviders: [],
    });

    const response = await request(app).post('/api/auth/login').send({ email: user.email, password });
    expect(response.status).toBe(200);
    expect(user.passwordHash).toMatch(/^\$2/);
    expect(user.authProviders).toContain('password');
  });

  test('resends verification for legacy password users without provider metadata', async () => {
    await User.create({
      email: 'legacy-unverified@example.com',
      passwordHash: 'legacy-salt:legacy-hash',
      emailVerified: false,
      authProviders: [],
    });

    const response = await request(app).post('/api/auth/resend-verification').send({ email: 'legacy-unverified@example.com' });
    expect(response.status).toBe(200);
    expect(emailService.sendVerificationEmail).toHaveBeenCalledTimes(1);
    expect(mockUsers[0].authProviders).toContain('password');
  });
});
