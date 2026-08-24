const mongoose = require('mongoose');
const logger = require('../utils/logger');

let localMongoRetryTimer = null;
let localMongoRetrying = false;

const isLocalMongoUri = (uri) => {
  if (!uri) return false;

  try {
    const { hostname, port } = new URL(uri);
    return ['localhost', '127.0.0.1', '::1'].includes(hostname) && (!port || port === '27017');
  } catch (error) {
    return uri.includes('localhost:27017') || uri.includes('127.0.0.1:27017');
  }
};

const scheduleLocalMongoRetry = (mongoUri) => {
  if (localMongoRetryTimer) return;

  console.error('[DB DEBUG] Backend will keep running and retry local MongoDB every 5 seconds.');
  logger.warn('Local MongoDB unavailable; backend will retry connection every 5 seconds');

  localMongoRetryTimer = setInterval(async () => {
    if (localMongoRetrying || mongoose.connection.readyState === 1) return;
    localMongoRetrying = true;

    try {
      await mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: 3000,
        socketTimeoutMS: 60000,
        heartbeatFrequencyMS: 10000,
      });
      clearInterval(localMongoRetryTimer);
      localMongoRetryTimer = null;
      logger.info('MongoDB connected after retry');
      console.log('[DB DEBUG] Local MongoDB connected after retry');
    } catch (retryError) {
      console.error(`[DB DEBUG] MongoDB retry failed: ${retryError.message}`);
    } finally {
      localMongoRetrying = false;
    }
  }, 5000);
};

const connectDB = async () => {
  // ── DEBUG: Print the full connection config ──────────────────────
  const rawUri = process.env.MONGODB_URI || '';
  // Mask the password for safety but show everything else
  const maskedUri = rawUri.replace(/:([^@]+)@/, ':****@');
  console.log(`[DB DEBUG] MONGODB_URI (masked): ${maskedUri}`);
  console.log(`[DB DEBUG] URI length: ${rawUri.length}`);

  // Parse the database name from the URI
  // MongoDB SRV URIs without a explicit DB name default to "test"
  let dbName = 'test'; // default when no DB in URI
  try {
    const urlObj = new URL(rawUri);
    const pathDb = urlObj.pathname.replace('/', '');
    if (pathDb) {
      dbName = pathDb;
    } else {
      // Check for authSource (this is NOT the write database)
      const authSource = urlObj.searchParams.get('authSource');
      console.log(`[DB DEBUG] authSource from URI: ${authSource || 'none'}`);
      console.log(`[DB DEBUG] No explicit database in URI — will default to: "${dbName}"`);
      console.log(`[DB DEBUG] Data will be written to database: "${dbName}"`);
      console.log(`[DB DEBUG] IMPORTANT: In Atlas UI, look for database "${dbName}", NOT "${authSource || 'admin'}"`);
    }
  } catch (e) {
    console.log(`[DB DEBUG] Could not parse URI for DB name: ${e.message}`);
  }

  let mongoUri = process.env.MONGODB_URI || process.env.MONGO_URL || process.env.DATABASE_URL;

  try {
    if (!mongoUri) {
      // In development, avoid crashing the whole process when Mongo isn't configured.
      // Schedule retries against a sensible local fallback and continue running.
      if (process.env.NODE_ENV !== 'production') {
        const fallback = 'mongodb://localhost:27017/brain_shadow_dev';
        console.warn('[DB DEBUG] No MongoDB URI provided — scheduling retries against local fallback:', fallback);
        logger.warn('No MongoDB URI provided; scheduling retries against local fallback');
        scheduleLocalMongoRetry(fallback);
        return null;
      }
      throw new Error('Missing MongoDB connection string. Set MONGODB_URI, MONGO_URL, or DATABASE_URL.');
    }

    const conn = await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 60000,
      heartbeatFrequencyMS: 10000,
    });

    // ── DEBUG: Print actual connection details ─────────────────────
    const actualHost = conn.connection.host;
    const actualDb   = conn.connection.db?.databaseName || 'UNKNOWN';
    const actualPort = conn.connection.port;
    console.log(`[DB DEBUG] Connection established to: ${actualHost}:${actualPort}`);
    console.log(`[DB DEBUG] Actual database name after connect: "${actualDb}"`);
    console.log(`[DB DEBUG] Connection readyState: ${conn.connection.readyState} (1=connected)`);
    console.log(`[DB DEBUG] Mongoose version: ${mongoose.version}`);

    // ── DEBUG: List existing databases (if possible) ───────────────
    try {
      const admin = conn.connection.db.admin();
      const dbList = await admin.listDatabases();
      console.log(`[DB DEBUG] Databases on cluster: ${dbList.databases.map(d => d.name).join(', ')}`);
    } catch (e) {
      console.log(`[DB DEBUG] Could not list databases (may lack admin privileges): ${e.message}`);
    }

    // ── DEBUG: Check if conversations collection exists ────────────
    const collections = await conn.connection.db.listCollections().toArray();
    console.log(`[DB DEBUG] Existing collections in "${actualDb}": ${collections.length === 0 ? 'NONE (fresh database)' : collections.map(c => c.name).join(', ')}`);

    // ── DEBUG: Test a write operation ──────────────────────────────
    try {
      const testResult = await conn.connection.db.collection('_debug_health').insertOne({
        _test: true,
        timestamp: new Date(),
        database: actualDb,
        purpose: 'connectivity-check'
      });
      console.log(`[DB DEBUG] Test write succeeded! Inserted _id: ${testResult.insertedId}`);
      console.log(`[DB DEBUG] This confirms writes to Atlas work on database "${actualDb}"`);

      // Clean up test document
      await conn.connection.db.collection('_debug_health').deleteOne({ _test: true });
      console.log(`[DB DEBUG] Test document cleaned up`);
    } catch (writeErr) {
      console.error(`[DB DEBUG] !!! TEST WRITE FAILED !!!`);
      console.error(`[DB DEBUG] Error: ${writeErr.message}`);
      console.error(`[DB DEBUG] Full error: ${writeErr.stack}`);
    }

    // ── Migration: Fix legacy externalId-only unique index ─────────
    const collectionExists = collections.some(c => c.name === 'conversations');
    if (collectionExists) {
      const conversations = conn.connection.collection('conversations');
      const indexes = await conversations.indexes();
      const legacyIndex = indexes.find(index =>
        index.unique &&
        Object.keys(index.key).length === 1 &&
        index.key.externalId === 1
      );
      if (legacyIndex) {
        await conversations.dropIndex(legacyIndex.name);
        logger.info('Removed legacy externalId-only unique index');
      }
      await conversations.createIndex(
        { platform: 1, externalId: 1 },
        { unique: true, name: 'platform_1_externalId_1' }
      );
      console.log(`[DB DEBUG] Index migration completed`);
    } else {
      console.log(`[DB DEBUG] No conversations collection yet — will be created on first insert`);
    }

    logger.info(`MongoDB Connected: ${actualHost} | Database: "${actualDb}"`);

    mongoose.connection.on('disconnected', () => {
      logger.warn('MongoDB disconnected — will auto-reconnect');
    });
    mongoose.connection.on('reconnected', () => {
      logger.info('MongoDB reconnected');
    });
    mongoose.connection.on('error', (err) => {
      logger.error(`MongoDB error: ${err.message}`);
    });
  } catch (error) {
    console.error(`[DB DEBUG] !!! CONNECTION FAILED !!!`);
    console.error(`[DB DEBUG] Error: ${error.message}`);
    console.error(`[DB DEBUG] Full stack: ${error.stack}`);
    if (isLocalMongoUri(mongoUri)) {
      console.error('[DB DEBUG] Local MongoDB is not reachable on port 27017.');
      console.error('[DB DEBUG] Start it with: npm.cmd run db:up');
      console.error('[DB DEBUG] Or run the backend and database together with: npm.cmd run dev:with-db');
      if (process.env.NODE_ENV !== 'production') {
        scheduleLocalMongoRetry(mongoUri);
        return null;
      }
    }
    logger.error(`Error connecting to MongoDB: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
