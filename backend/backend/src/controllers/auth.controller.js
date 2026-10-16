const jwt = require('jsonwebtoken');
const { createClerkClient, verifyToken } = require('@clerk/backend');
const User = require('../models/user.model');
const logger = require('../utils/logger');

const SESSION_COOKIE = 'shadowbrain_token';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const isProd = process.env.NODE_ENV === 'production';
const cookieOptions = {
  httpOnly: true,
  sameSite: isProd ? 'none' : 'lax',
  secure: isProd,
  path: '/',
};

function getClerkClient() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  return secretKey ? createClerkClient({ secretKey }) : null;
}

function getAuthorizedParties() {
  return (process.env.CLERK_AUTHORIZED_PARTIES || process.env.FRONTEND_URL || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function signSession(user) {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return jwt.sign(
    { userId: user._id.toString(), email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' },
  );
}

function writeSession(res, user) {
  const token = signSession(user);
  res.cookie(SESSION_COOKIE, token, {
    ...cookieOptions,
    maxAge: COOKIE_MAX_AGE_MS,
  });
  return token;
}

function primaryVerifiedEmail(clerkUser) {
  const primary = clerkUser.emailAddresses.find(
    (address) => address.id === clerkUser.primaryEmailAddressId,
  );
  if (!primary || primary.verification?.status !== 'verified') return null;
  return primary.emailAddress.trim().toLowerCase();
}

async function findEmailMatches(email) {
  return User.find({ email }).limit(2);
}

async function resolveClerkUser(clerkUser, email) {
  const matches = await findEmailMatches(email);
  if (matches.length > 1) {
    const error = new Error('Ambiguous existing account');
    error.code = 'AMBIGUOUS_EMAIL_MATCHES';
    error.emailMatchCount = matches.length;
    throw error;
  }

  const existingByClerk = await User.findOne({ clerkUserId: clerkUser.id });
  if (existingByClerk) {
    if (matches.length === 1 && matches[0]._id.toString() !== existingByClerk._id.toString()) {
      const error = new Error('Conflicting identity mapping');
      error.code = 'CLERK_IDENTITY_EMAIL_CONFLICT';
      error.emailMatchCount = matches.length;
      throw error;
    }
    existingByClerk.lastLoginAt = new Date();
    existingByClerk.emailVerified = true;
    existingByClerk.authProviders = [...new Set([...(existingByClerk.authProviders || []), 'clerk'])];
    await existingByClerk.save();
    return existingByClerk;
  }

  if (matches.length === 1) {
    const existing = matches[0];
    const linked = await User.findOneAndUpdate(
      {
        _id: existing._id,
        $or: [
          { clerkUserId: { $exists: false } },
          { clerkUserId: null },
          { clerkUserId: clerkUser.id },
        ],
      },
      {
        $set: {
          clerkUserId: clerkUser.id,
          emailVerified: true,
          lastLoginAt: new Date(),
        },
        $addToSet: { authProviders: 'clerk' },
      },
      { new: true, runValidators: true },
    );
    if (!linked) {
      const error = new Error('Conflicting identity mapping');
      error.code = 'IDENTITY_LINK_CONFLICT';
      error.emailMatchCount = matches.length;
      throw error;
    }
    return linked;
  }

  return User.create({
    clerkUserId: clerkUser.id,
    email,
    emailVerified: true,
    name: [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || undefined,
    avatar: clerkUser.imageUrl || undefined,
    authProviders: ['clerk'],
    lastLoginAt: new Date(),
  });
}

function getConflictReason(error) {
  if (error.code === 'AMBIGUOUS_EMAIL_MATCHES') return error.code;
  if (error.code === 'CLERK_IDENTITY_EMAIL_CONFLICT') return error.code;
  if (error.code === 'IDENTITY_LINK_CONFLICT') return error.code;
  if (error.code === 11000) {
    const duplicateFields = Object.keys(error.keyPattern || error.keyValue || {});
    if (duplicateFields.includes('email')) return 'EMAIL_ALREADY_CLAIMED';
    if (duplicateFields.includes('clerkUserId')) return 'CLERK_ID_ALREADY_LINKED';
    return 'DUPLICATE_IDENTITY_CONFLICT';
  }
  return null;
}

const clerkLogin = async (req, res) => {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const authorizedParties = getAuthorizedParties();
  if (!secretKey || !process.env.JWT_SECRET || !authorizedParties.length) {
    logger.error('[Auth] Clerk session exchange is missing server configuration');
    return res.status(503).json({ message: 'Authentication is not configured on this server.' });
  }

  const authorization = req.get('Authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const expectedSessionId = req.get('X-Clerk-Session-Id');
  if (!token || !expectedSessionId) return res.status(401).json({ message: 'Authentication required.' });

  let claims;
  try {
    claims = await verifyToken(token, { secretKey, authorizedParties });
  } catch {
    return res.status(401).json({ message: 'Invalid or expired Clerk session.' });
  }
  if (!claims.sub || !claims.sid || claims.sid !== expectedSessionId) {
    return res.status(401).json({ message: 'Invalid Clerk session.' });
  }

  const clerkClient = getClerkClient();
  if (!clerkClient) return res.status(503).json({ message: 'Authentication is not configured on this server.' });

  let clerkSession;
  try {
    clerkSession = await clerkClient.sessions.getSession(claims.sid);
  } catch {
    return res.status(401).json({ message: 'Invalid or expired Clerk session.' });
  }
  if (clerkSession.userId !== claims.sub || clerkSession.status !== 'active') {
    return res.status(401).json({ message: 'Invalid or expired Clerk session.' });
  }

  try {
    const clerkUser = await clerkClient.users.getUser(claims.sub);
    if (clerkUser.banned || clerkUser.locked) {
      return res.status(403).json({ message: 'This account is not permitted to sign in.' });
    }
    const email = primaryVerifiedEmail(clerkUser);
    if (!email) {
      return res.status(403).json({ message: 'A verified primary email is required.' });
    }

    const user = await resolveClerkUser(clerkUser, email);
    const token = writeSession(res, user);
    return res.json({
      token,
      user: {
        email: user.email,
        name: user.name,
        avatar: user.avatar,
      },
    });
  } catch (error) {
    const conflictReason = getConflictReason(error);
    if (conflictReason) {
      logger.warn('[Auth] Clerk account resolution conflict', {
        reasonCode: conflictReason,
        emailMatchCount: error.emailMatchCount,
      });
      return res.status(409).json({
        message: 'This verified email conflicts with an existing account. Contact support to recover access.',
        code: conflictReason,
      });
    }
    logger.error('[Auth] Clerk identity resolution failed', {
      errorCode: typeof error.code === 'string' || typeof error.code === 'number'
        ? error.code
        : 'UNKNOWN',
    });
    return res.status(502).json({ message: 'Could not verify your account with the application. Please try again.' });
  }
};

const me = async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE] ||
    (req.get('Authorization') || '').replace(/^Bearer /, '');
  if (!token || !process.env.JWT_SECRET) {
    return res.status(401).json({ message: 'Not signed in.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.userId) return res.status(401).json({ message: 'Not signed in.' });
    const user = await User.findById(decoded.userId);
    if (!user) return res.status(401).json({ message: 'Not signed in.' });
    return res.json({
      token,
      email: user.email,
      name: user.name,
      avatar: user.avatar,
    });
  } catch {
    return res.status(401).json({ message: 'Not signed in.' });
  }
};

const logout = (_req, res) => {
  res.clearCookie(SESSION_COOKIE, cookieOptions);
  return res.json({ ok: true });
};

module.exports = { clerkLogin, me, logout, resolveClerkUser };
