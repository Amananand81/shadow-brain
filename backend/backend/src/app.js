const express      = require('express');
const cors         = require('cors');
const morgan       = require('morgan');
const cookieParser = require('cookie-parser');
const helmet       = require('helmet');
const logger  = require('./utils/logger');
const { errorHandler } = require('./middleware/error.middleware');

const conversationRoutes = require('./routes/conversation.routes');
const importRoutes       = require('./routes/import.routes');
const chatRoutes         = require('./routes/chat.routes');
const healthRoutes       = require('./routes/health.routes');
const authRoutes         = require('./routes/auth.routes');

const app = express();

// Respect trust proxy when configured (used by many hosting providers)
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

// Allow deployed frontend(s), localhost, and all Chrome extensions.
// Prefer `CORS_ORIGINS` but keep legacy `FRONTEND_URL` for backwards compatibility.
const allowedOrigins = (process.env.CORS_ORIGINS || process.env.FRONTEND_URL || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        origin.startsWith('chrome-extension://') ||
        origin.startsWith('http://localhost') ||
        origin.startsWith('http://127.0.0.1') ||
        allowedOrigins.includes(origin)
      ) {
        callback(null, true);
      } else {
        callback(new Error('CORS: origin not allowed'));
      }
    },
    credentials: true,
  })
);
// Note: CORS is deliberately permissive for localhost and chrome-extension
// while remaining strict for production origins supplied via env.

// HTTPS redirect middleware (only in production when explicitly enabled)
if (process.env.NODE_ENV === 'production' && (process.env.ENFORCE_HTTPS === 'true' || process.env.HTTPS_REDIRECT === 'true')) {
  app.use((req, res, next) => {
    // If request already secure, continue. Respect X-Forwarded-Proto for proxies.
    const forwardedProto = (req.headers['x-forwarded-proto'] || '').toLowerCase();
    const isSecure = req.secure || forwardedProto === 'https';
    if (!isSecure) {
      const host = req.headers.host;
      // Preserve path and query
      return res.redirect(301, `https://${host}${req.originalUrl}`);
    }
    next();
  });
}

// Helmet / security headers
// Keep CSP permissive enough to avoid breaking Next.js, extensions, or external LLM connections.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https:'],
        connectSrc: ["'self'", 'https:', 'wss:'],
        imgSrc: ["'self'", 'data:', 'https:'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https:'],
        fontSrc: ["'self'", 'data:', 'https:'],
      },
    },
    // Allow cross-origin resources for extension compatibility and external APIs
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // HSTS will be applied by the platform or when HTTPS is enabled; allow opt-out.
    hsts: process.env.ENABLE_HSTS === 'false' ? false : { maxAge: 60 * 60 * 24 * 365 * 2, includeSubDomains: true, preload: true },
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(morgan('dev'));

// Log every incoming request so we can see if extension data arrives
app.use((req, res, next) => {
  if (req.method === 'POST') {
    console.log(`\n[REQUEST] ═══════════════════════════════════════════════`);
    console.log(`[REQUEST] ${req.method} ${req.originalUrl}`);
    console.log(`[REQUEST] Origin: ${req.headers.origin || 'none'}`);
    console.log(`[REQUEST] Content-Type: ${req.headers['content-type'] || 'none'}`);
    console.log(`[REQUEST] X-API-KEY: ${req.headers['x-api-key'] ? 'PRESENT (' + req.headers['x-api-key'].substring(0, 10) + '...)' : 'MISSING'}`);
    console.log(`[REQUEST] User-Agent: ${(req.headers['user-agent'] || '').substring(0, 80)}`);
    console.log(`[REQUEST] Body size: ${JSON.stringify(req.body || {}).length} bytes`);
    console.log(`[REQUEST] Body keys: ${req.body ? Object.keys(req.body).join(', ') : 'EMPTY'}`);
    if (req.body?.platform) console.log(`[REQUEST] Platform: ${req.body.platform}`);
    if (req.body?.title) console.log(`[REQUEST] Title: ${(req.body.title || '').substring(0, 60)}`);
    if (req.body?.messages) console.log(`[REQUEST] Message count: ${(req.body.messages || []).length}`);
    if (req.body?.conversations) console.log(`[REQUEST] Bulk count: ${(req.body.conversations || []).length}`);
    console.log(`[REQUEST] ═══════════════════════════════════════════════`);
  }
  next();
});

// Routes
app.use('/api/conversations', conversationRoutes);  // authenticated CRUD
app.use('/api/import',        importRoutes);         // extension ingest — no auth
app.use('/api/chat',          chatRoutes);           // frontend chat — no auth
app.use('/api/health',        healthRoutes);
app.use('/api/auth',          authRoutes);           // Google sign-in

// Top-level health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.use(errorHandler);

module.exports = app;
