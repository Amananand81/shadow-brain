require('./config/env')();
const app        = require('./app');
const connectDB  = require('./config/db');
const logger     = require('./utils/logger');
const enrichment = require('./services/enrichment.service');

const PORT = process.env.PORT || 8000;
const USE_HTTPS = process.env.USE_HTTPS === 'true' || !!process.env.HTTPS_KEY || !!process.env.HTTPS_KEY_PATH;

// ── DEBUG: Print all environment variables (mask secrets) ────────
console.log(`\n[SERVER] ═══════════════════════════════════════════════`);
console.log(`[SERVER] Brain Shadow Backend — Starting up`);
console.log(`[SERVER] Timestamp: ${new Date().toISOString()}`);
console.log(`[SERVER] Node.js version: ${process.version}`);
console.log(`[SERVER] NODE_ENV: ${process.env.NODE_ENV}`);
console.log(`[SERVER] PORT: ${PORT}`);
console.log(`[SERVER] MONGODB_URI present: ${!!process.env.MONGODB_URI}`);
console.log(`[SERVER] MONGODB_URI length: ${(process.env.MONGODB_URI || '').length}`);
if (process.env.MONGODB_URI) {
  const masked = process.env.MONGODB_URI.replace(/:([^@]+)@/, ':****@');
  console.log(`[SERVER] MONGODB_URI (masked): ${masked}`);
}
console.log(`[SERVER] GROQ_API_KEY present: ${!!process.env.GROQ_API_KEY}`);
console.log(`[SERVER] CEREBRAS_API_KEY present: ${!!process.env.CEREBRAS_API_KEY}`);
console.log(`[SERVER] BACKEND_API_KEY present: ${!!process.env.BACKEND_API_KEY}`);
console.log(`[SERVER] GOOGLE_CLIENT_ID present: ${!!process.env.GOOGLE_CLIENT_ID}`);
if (process.env.GOOGLE_CLIENT_ID) {
  console.log(`[SERVER] GOOGLE_CLIENT_ID (last 6): ...${process.env.GOOGLE_CLIENT_ID.slice(-6)}`);
}
console.log(`[SERVER] JWT_SECRET present: ${!!process.env.JWT_SECRET}`);
console.log(`[SERVER] ═══════════════════════════════════════════════\n`);

// ── Validate required auth env vars ─────────────────────────────────
const requiredAuthVars = ['GOOGLE_CLIENT_ID', 'JWT_SECRET'];
const missingAuth = requiredAuthVars.filter((v) => !process.env[v]);
if (missingAuth.length > 0) {
  console.error(`[SERVER] ⚠️  MISSING REQUIRED AUTH ENV VARS: ${missingAuth.join(', ')}`);
  console.error(`[SERVER]   Google login will fail. Add them to Render → Environment.`);
  logger.error(`Missing required auth env vars: ${missingAuth.join(', ')}`);
}

// Last line of defense: an uncaught rejection anywhere (e.g. a transient
// MongoDB pool error surfacing from the driver's internal event handlers,
// outside any of our try/catch blocks) used to crash the whole process —
// silently taking down the API with no auto-restart. Log it instead.
process.on('unhandledRejection', (reason) => {
  console.error(`[UNHANDLED REJECTION] ${reason instanceof Error ? reason.stack : reason}`);
  logger.error(`[UNHANDLED REJECTION] ${reason instanceof Error ? reason.stack : reason}`);
});

process.on('uncaughtException', (err) => {
  console.error(`[UNCAUGHT EXCEPTION] ${err.stack}`);
  logger.error(`[UNCAUGHT EXCEPTION] ${err.stack}`);
});

const retryPendingSafely = () => {
  enrichment.retryPending().catch((err) => {
    console.error(`[RETRY] retryPending() failed: ${err.message}`);
    logger.error(`[RETRY] retryPending() failed: ${err.message}`);
  });
};

connectDB().then(() => {
  // If HTTPS materials are provided and USE_HTTPS true, start an HTTPS server.
  if (USE_HTTPS && process.env.NODE_ENV === 'production') {
    try {
      const fs = require('fs');
      const https = require('https');

      // Support direct key/cert via env or file paths
      const key = process.env.HTTPS_KEY || (process.env.HTTPS_KEY_PATH ? fs.readFileSync(process.env.HTTPS_KEY_PATH) : undefined);
      const cert = process.env.HTTPS_CERT || (process.env.HTTPS_CERT_PATH ? fs.readFileSync(process.env.HTTPS_CERT_PATH) : undefined);
      const ca = process.env.HTTPS_CA || (process.env.HTTPS_CA_PATH ? fs.readFileSync(process.env.HTTPS_CA_PATH) : undefined);

      if (!key || !cert) {
        console.warn('[SERVER] HTTPS enabled but missing key/cert; falling back to HTTP');
      } else {
        const credentials = { key, cert };
        if (ca) credentials.ca = ca;
        const server = https.createServer(credentials, app).listen(PORT, () => {
          console.log(`\n[SERVER] ═══════════════════════════════════════════════`);
          console.log(`[SERVER] HTTPS server listening on port ${PORT}`);
          console.log(`[SERVER] Environment: ${process.env.NODE_ENV}`);
          console.log(`[SERVER] Health check: https://localhost:${PORT}/health`);
          console.log(`[SERVER] Import endpoint: https://localhost:${PORT}/api/import/capture`);
          console.log(`[SERVER] Conversations endpoint: https://localhost:${PORT}/api/conversations`);
          console.log(`[SERVER] ═══════════════════════════════════════════════\n`);
          logger.info(`HTTPS server running in ${process.env.NODE_ENV} mode on port ${PORT}`);
        });

        // schedule retries
        setTimeout(retryPendingSafely, 3000);
        setInterval(retryPendingSafely, 5 * 60 * 1000);
        return;
      }
    } catch (err) {
      console.error(`[SERVER] Failed to start HTTPS server: ${err.message}`);
      logger.error(`[SERVER] Failed to start HTTPS server: ${err.stack}`);
    }
  }

  // Default: HTTP server (keeps existing behavior). When behind a proxy, use TRUST_PROXY env and HTTPS redirect in app.js.
  app.listen(PORT, () => {
    console.log(`\n[SERVER] ═══════════════════════════════════════════════`);
    console.log(`[SERVER] Server listening on port ${PORT}`);
    console.log(`[SERVER] Environment: ${process.env.NODE_ENV}`);
    console.log(`[SERVER] Health check: http://localhost:${PORT}/health`);
    console.log(`[SERVER] Import endpoint: http://localhost:${PORT}/api/import/capture`);
    console.log(`[SERVER] Conversations endpoint: http://localhost:${PORT}/api/conversations`);
    console.log(`[SERVER] ═══════════════════════════════════════════════\n`);
    logger.info(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`);

    // On startup: reset all FAILED → PENDING and enrich them
    setTimeout(retryPendingSafely, 3000);

    // Every 5 minutes: auto-retry any FAILED conversations
    setInterval(retryPendingSafely, 5 * 60 * 1000);
  });
});
