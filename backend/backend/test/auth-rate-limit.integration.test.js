process.env.NODE_ENV = 'production';

jest.mock('../src/controllers/auth.controller', () => ({
  clerkLogin: (req, res) => {
    const status = req.get('X-Test-Result') === 'success' ? 200 : 401;
    return res.status(status).json({ message: status === 200 ? 'ok' : 'invalid session' });
  },
  me: (_req, res) => res.sendStatus(200),
  logout: (_req, res) => res.sendStatus(200),
}));

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
const authRoutes = require('../src/routes/auth.routes');

const app = express();
app.use('/api/auth', authRoutes);

describe('Clerk session exchange rate limit', () => {
  test('does not count successful exchanges and returns retry details after repeated failures', async () => {
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const success = await request(app)
        .post('/api/auth/clerk')
        .set('X-Test-Result', 'success');
      expect(success.status).toBe(200);
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const failure = await request(app).post('/api/auth/clerk');
      expect(failure.status).toBe(401);
    }

    const limited = await request(app).post('/api/auth/clerk');
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({
      code: 'AUTH_RATE_LIMITED',
      message: 'Too many authentication attempts. Please try again later.',
    });
    expect(limited.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['ratelimit']).toBeDefined();
    expect(limited.headers['ratelimit-policy']).toBeDefined();
  });
});
