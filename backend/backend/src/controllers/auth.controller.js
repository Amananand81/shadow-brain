const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const { createClerkClient } = require('@clerk/backend');
const User = require('../models/user.model');
const logger = require('../utils/logger');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
if (!GOOGLE_CLIENT_ID) {
  console.error('[Auth] ⚠️  GOOGLE_CLIENT_ID is not set — Google login will fail');
}
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
const clerkClient = CLERK_SECRET_KEY ? createClerkClient({ secretKey: CLERK_SECRET_KEY }) : null;
if (!CLERK_SECRET_KEY) {
  console.error('[Auth] ⚠️  CLERK_SECRET_KEY is not set — email/password login will fail');
}

const SESSION_COOKIE = 'shadowbrain_token';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const isProd = process.env.NODE_ENV === 'production';
// Cross-site (frontend and backend on different domains) requires SameSite=None + Secure (HTTPS-only).
// Locally, frontend/backend are same-site (both localhost) so Lax works over plain HTTP.
const cookieOptions = {
  httpOnly: true,
  sameSite: isProd ? 'none' : 'lax',
  secure: isProd,
};

function signSession(user) {
  return jwt.sign(
    { userId: user._id.toString(), email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}

const googleLogin = async (req, res, next) => {
  try {
    if (!googleClient) {
      console.error('[Auth] Google login attempted but GOOGLE_CLIENT_ID is not configured');
      return res.status(503).json({ message: 'Google sign-in is not configured on this server' });
    }

    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ message: 'Missing Google credential' });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    if (!payload?.email) {
      return res.status(401).json({ message: 'Google token did not include an email' });
    }

    const user = await User.findOneAndUpdate(
      { googleId: payload.sub },
      {
        googleId: payload.sub,
        email: payload.email,
        name: payload.name,
        avatar: payload.picture,
        lastLoginAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const token = signSession(user);
    console.log(`[AUTH-DEBUG] Step 1 — JWT generated for ${user.email}, length=${token.length}, preview=${token.slice(0,30)}...`);
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: COOKIE_MAX_AGE_MS });

    res.json({
      token,
      user: {
        email: user.email,
        name: user.name,
        avatar: user.avatar,
      },
    });
  } catch (error) {
    console.error(`[Auth] Google login error: ${error.message}`);
    console.error(`[Auth] Stack: ${error.stack}`);
    if (error.message.includes('Wrong number of segments')) {
      console.error('[Auth] Token format invalid — credential may be corrupt or truncated');
    }
    if (error.message.includes('Token used too early') || error.message.includes('Token used too late')) {
      console.error('[Auth] Token clock skew issue — check server time sync');
    }
    logger.error(`[Auth] Google login failed: ${error.message}`);
    res.status(401).json({ message: 'Google sign-in failed' });
  }
};

// Link a Clerk-authenticated identity to a Brain Shadow application user,
// reusing an existing user for the same email when present. This keeps a
// single application user per account even if that person also signs in
// through Google (email is the canonical key in this application).
//
// We deliberately do NOT store passwords here — Clerk is the source of
// truth for credentials. We only persist identity + profile fields.
async function upsertClerkUser(clerkUserId, email, profile) {
  const normalizedEmail = (email || '').trim().toLowerCase();

  const existingByClerk = normalizedEmail
    ? await User.findOne({ clerkUserId })
    : null;
  if (existingByClerk) {
    existingByClerk.authMethod = 'clerk';
    existingByClerk.lastLoginAt = new Date();
    if (profile.name) existingByClerk.name = profile.name;
    if (profile.avatar) existingByClerk.avatar = profile.avatar;
    await existingByClerk.save();
    return existingByClerk;
  }

  // Same person previously signed up via Google → link to that app user so
  // data and conversations stay together. email is unique across users.
  const existingByEmail = normalizedEmail
    ? await User.findOne({ email: normalizedEmail })
    : null;
  if (existingByEmail) {
    existingByEmail.clerkUserId = clerkUserId;
    existingByEmail.authMethod = 'clerk';
    existingByEmail.lastLoginAt = new Date();
    if (profile.name) existingByEmail.name = profile.name;
    if (profile.avatar) existingByEmail.avatar = profile.avatar;
    await existingByEmail.save();
    return existingByEmail;
  }

  return User.create({
    clerkUserId,
    authMethod: 'clerk',
    email: normalizedEmail,
    name: profile.name,
    avatar: profile.avatar,
    lastLoginAt: new Date(),
  });
}

const clerkLogin = async (req, res, next) => {
  try {
    if (!clerkClient) {
      return res.status(503).json({ message: 'Email/password login is not configured on this server' });
    }

    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ message: 'Missing Clerk session token' });
    }

    // Verify the Clerk short-lived (1h) session JWT the frontend obtained
    // from Clerk.getToken() (or useSignIn/useSignUp).
    let verified;
    try {
      const result = await clerkClient.verifyToken(token, {
        authorizedParties: [process.env.FRONTEND_URL].filter(Boolean),
      });
      verified = result;
    } catch (verifyErr) {
      logger.error(`[Auth] Clerk token verification failed: ${verifyErr.message}`);
      return res.status(401).json({ message: 'Invalid or expired Clerk session' });
    }

    const clerkUserId = verified.sub || verified.userId;
    if (!clerkUserId) {
      return res.status(401).json({ message: 'Invalid Clerk session' });
    }

    // Fetch authoritative details from Clerk's Backend API.
    let email = verified.email || '';
    let name;
    let avatar;
    try {
      const clerkUser = await clerkClient.users.getUser(clerkUserId);
      email = email || clerkUser.emailAddresses?.[0]?.emailAddress || '';
      name = name || clerkUser.firstName ? `${clerkUser.firstName} ${clerkUser.lastName || ''}`.trim() : (clerkUser.username || undefined);
      avatar = avatar || clerkUser.imageUrl;
    } catch (userErr) {
      logger.error(`[Auth] Could not fetch Clerk user ${clerkUserId}: ${userErr.message}`);
    }

    if (!email) {
      return res.status(401).json({ message: 'Clerk account has no verified email address' });
    }

    const user = await upsertClerkUser(clerkUserId, email, { name, avatar });

    const appToken = signSession(user);
    res.cookie(SESSION_COOKIE, appToken, { ...cookieOptions, maxAge: COOKIE_MAX_AGE_MS });

    res.json({
      token: appToken,
      user: {
        email: user.email,
        name: user.name,
        avatar: user.avatar,
      },
    });
  } catch (error) {
    logger.error(`[Auth] Clerk login failed: ${error.message}`);
    res.status(500).json({ message: 'Sign-in failed' });
  }
};

const me = async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE] || req.header('Authorization')?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Not signed in' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId || decoded.sub);
    if (!user) return res.status(401).json({ message: 'Not signed in' });
    res.json({ token, email: user.email, name: user.name, avatar: user.avatar });
  } catch {
    res.status(401).json({ message: 'Not signed in' });
  }
};

const logout = (req, res) => {
  res.clearCookie(SESSION_COOKIE, cookieOptions);
  res.json({ ok: true });
};

module.exports = { googleLogin, clerkLogin, me, logout };
