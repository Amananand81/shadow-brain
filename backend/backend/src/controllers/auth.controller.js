const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const { createClerkClient } = require('@clerk/backend');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const User = require('../models/user.model');
const logger = require('../utils/logger');
const emailService = require('../services/email.service');
const { demoAuthCheck } = require('../middleware/demo-auth.middleware');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = GOOGLE_CLIENT_ID
  ? new OAuth2Client(GOOGLE_CLIENT_ID)
  : null;

const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
const clerkClient = CLERK_SECRET_KEY
  ? createClerkClient({ secretKey: CLERK_SECRET_KEY })
  : null;

if (!CLERK_SECRET_KEY) {
  console.error(
    '[Auth] ⚠️  CLERK_SECRET_KEY is not set — email/password login will fail'
  );
}

const SESSION_COOKIE = 'shadowbrain_token';
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const isProd = process.env.NODE_ENV === 'production';

const cookieOptions = {
  httpOnly: true,
  sameSite: isProd ? 'none' : 'lax',
  secure: isProd,
  path: '/',
};

const PASSWORD_PATTERN =
  /^(?=.*[A-Za-z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,128}$/;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function safeUser(user) {
  return {
    email: user.email,
    name: user.name,
    avatar: user.avatar,
  };
}

function signSession(user) {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured');
  }

  return jwt.sign(
    {
      userId: user._id.toString(),
      email: user.email,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '7d',
    }
  );
}

function setSession(res, user) {
  const token = signSession(user);

  res.cookie(SESSION_COOKIE, token, {
    ...cookieOptions,
    maxAge: COOKIE_MAX_AGE_MS,
  });

  return token;
}

function makeToken() {
  const token = crypto.randomBytes(32).toString('hex');

  return {
    token,
    hash: crypto
      .createHash('sha256')
      .update(token)
      .digest('hex'),
  };
}

async function verifyPassword(password, user) {
  if (!user.passwordHash) return false;

  if (user.passwordHash.startsWith('$2')) {
    return bcrypt.compare(password, user.passwordHash);
  }

  const [salt, expectedHex] = user.passwordHash.split(':');

  if (!salt || !/^[a-f0-9]{128}$/i.test(expectedHex || '')) {
    return false;
  }

  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, 'hex');

  return crypto.timingSafeEqual(actual, expected);
}

function normalizeEmail(email) {
  return typeof email === 'string'
    ? email.trim().toLowerCase()
    : '';
}

function validRegistration({
  name,
  email,
  password,
  confirmPassword,
}) {
  if (
    typeof name !== 'string' ||
    name.trim().length < 1 ||
    name.trim().length > 120
  ) {
    return 'Enter your full name.';
  }

  if (!EMAIL_PATTERN.test(email)) {
    return 'Enter a valid email address.';
  }

  if (
    typeof password !== 'string' ||
    Buffer.byteLength(password, 'utf8') > 72 ||
    !PASSWORD_PATTERN.test(password)
  ) {
    return 'Password must be 8-72 bytes and include a letter, a number, and a symbol.';
  }

  if (password !== confirmPassword) {
    return 'Passwords do not match.';
  }

  return null;
}

function frontendLink(path, token) {
  const frontendUrl = (process.env.FRONTEND_URL || '')
    .split(',')[0]
    .trim()
    .replace(/\/$/, '');

  if (!frontendUrl) {
    throw new Error('FRONTEND_URL is not configured');
  }

  const url = new URL(path, `${frontendUrl}/`);
  url.searchParams.set('token', token);

  return url.toString();
}

async function sendVerification(user, token) {
  await emailService.sendVerificationEmail({
    to: user.email,
    name: user.name,
    verificationUrl: frontendLink('/verify-email', token),
  });
}

const register = async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);

    const name =
      typeof req.body?.name === 'string'
        ? req.body.name.trim()
        : '';

    const { password, confirmPassword } = req.body || {};

    const validationError = validRegistration({
      name,
      email,
      password,
      confirmPassword,
    });

    if (validationError) {
      return res.status(400).json({
        message: validationError,
      });
    }

    const existing = await User.findOne({ email });

    if (existing) {
      return res.status(409).json({
        message: 'An account with this email already exists',
      });
    }

    const verification = makeToken();

    const user = await User.create({
      email,
      name,
      passwordHash: await bcrypt.hash(password, 12),
      authProviders: ['password'],
      emailVerified: false,
      emailVerificationTokenHash: verification.hash,
      emailVerificationExpiresAt: new Date(
        Date.now() + 24 * 60 * 60 * 1000
      ),
    });

    try {
      await sendVerification(user, verification.token);
    } catch (error) {
      await User.deleteOne({ _id: user._id });
      throw error;
    }

    return res.status(201).json({
      message:
        'Account created. Check your email to verify your address.',
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        message: 'An account with this email already exists',
      });
    }

    logger.error(
      `[AUTH] Registration failed: ${error.message}`
    );

    return res.status(500).json({
      message: 'Unable to create account right now',
    });
  }
};

const verifyEmail = async (req, res) => {
  try {
    const token =
      typeof req.body?.token === 'string'
        ? req.body.token
        : '';

    if (!token) {
      return res.status(400).json({
        message: 'Verification link is invalid or expired',
      });
    }

    const tokenHash = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

    const user = await User.findOneAndUpdate(
      {
        emailVerificationTokenHash: tokenHash,
        emailVerificationExpiresAt: { $gt: new Date() },
      },
      {
        $set: {
          emailVerified: true,
        },
        $unset: {
          emailVerificationTokenHash: 1,
          emailVerificationExpiresAt: 1,
        },
      },
      {
        new: true,
      }
    );

    if (!user) {
      return res.status(400).json({
        message: 'Verification link is invalid or expired',
      });
    }

    await emailService
      .sendWelcomeEmail({
        to: user.email,
        name: user.name,
        method: 'password',
      })
      .catch((error) =>
        logger.warn(
          `[AUTH] Password welcome email failed: ${error.message}`
        )
      );

    const sessionToken = setSession(res, user);

    return res.json({
      token: sessionToken,
      user: safeUser(user),
    });
  } catch (error) {
    logger.error(
      `[AUTH] Email verification failed: ${error.message}`
    );

    return res.status(500).json({
      message: 'Unable to verify email right now',
    });
  }
};

const login = async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;

    if (
      !EMAIL_PATTERN.test(email) ||
      typeof password !== 'string' ||
      !password
    ) {
      return res.status(400).json({
        message: 'Email and password are required',
      });
    }

    const user = await User.findOne({ email }).select(
      '+passwordHash'
    );

    const matches = user
      ? await verifyPassword(password, user)
      : false;

    if (!user || !matches) {
      return res.status(401).json({
        message: 'Invalid email or password',
      });
    }

    if (!user.emailVerified) {
      return res.status(403).json({
        message:
          'Please verify your email before signing in',
      });
    }

    user.lastLoginAt = new Date();

    user.authProviders = [
      ...new Set([
        ...(user.authProviders || []),
        'password',
      ]),
    ];

    if (
      user.passwordHash &&
      !user.passwordHash.startsWith('$2')
    ) {
      user.passwordHash = await bcrypt.hash(password, 12);
    }

    await user.save();

    return res.json({
      token: setSession(res, user),
      user: safeUser(user),
    });
  } catch (error) {
    logger.error(
      `[AUTH] Login failed: ${error.message}`
    );

    return res.status(500).json({
      message: 'Unable to sign in right now',
    });
  }
};

const forgotPassword = async (req, res) => {
  const email = normalizeEmail(req.body?.email);

  if (!EMAIL_PATTERN.test(email)) {
    return res.status(400).json({
      message: 'Enter a valid email address',
    });
  }

  try {
    const user = await User.findOne({ email }).select(
      '+passwordHash'
    );

    if (user?.passwordHash) {
      const reset = makeToken();

      user.passwordResetTokenHash = reset.hash;

      user.passwordResetExpiresAt = new Date(
        Date.now() + 20 * 60 * 1000
      );

      await user.save();

      try {
        await emailService.sendPasswordResetEmail({
          to: user.email,
          name: user.name,
          resetUrl: frontendLink(
            '/reset-password',
            reset.token
          ),
        });
      } catch (error) {
        logger.error(
          `[AUTH] Password reset email failed: ${error.message}`
        );

        user.passwordResetTokenHash = undefined;
        user.passwordResetExpiresAt = undefined;

        await user.save();
      }
    }

    return res.json({
      message:
        'If an account matches that email, password reset instructions have been sent.',
    });
  } catch (error) {
    logger.error(
      `[AUTH] Password reset request failed: ${error.message}`
    );

    return res.status(500).json({
      message: 'Unable to process the request right now',
    });
  }
};

const resetPassword = async (req, res) => {
  const { token, password, confirmPassword } =
    req.body || {};

  if (typeof token !== 'string' || !token) {
    return res.status(400).json({
      message: 'Reset link is invalid or expired',
    });
  }

  if (
    typeof password !== 'string' ||
    Buffer.byteLength(password, 'utf8') > 72 ||
    !PASSWORD_PATTERN.test(password)
  ) {
    return res.status(400).json({
      message:
        'Password must be 8-72 bytes and include a letter, a number, and a symbol.',
    });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({
      message: 'Passwords do not match',
    });
  }

  try {
    const tokenHash = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

    const passwordHash = await bcrypt.hash(password, 12);

    const user = await User.findOneAndUpdate(
      {
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: { $gt: new Date() },
      },
      {
        $set: {
          passwordHash,
        },
        $addToSet: {
          authProviders: 'password',
        },
        $unset: {
          passwordResetTokenHash: 1,
          passwordResetExpiresAt: 1,
        },
      },
      {
        new: true,
      }
    );

    if (!user) {
      return res.status(400).json({
        message: 'Reset link is invalid or expired',
      });
    }

    res.clearCookie(
      SESSION_COOKIE,
      cookieOptions
    );

    return res.json({
      message:
        'Password reset successfully. You can now sign in.',
    });
  } catch (error) {
    logger.error(
      `[AUTH] Password reset failed: ${error.message}`
    );

    return res.status(500).json({
      message: 'Unable to reset password right now',
    });
  }
};

const resendVerification = async (req, res) => {
  const email = normalizeEmail(req.body?.email);

  if (!EMAIL_PATTERN.test(email)) {
    return res.status(400).json({
      message: 'Enter a valid email address',
    });
  }

  try {
    const user = await User.findOne({ email }).select(
      '+passwordHash'
    );

    if (
      user &&
      !user.emailVerified &&
      user.passwordHash
    ) {
      const verification = makeToken();

      user.emailVerificationTokenHash =
        verification.hash;

      user.emailVerificationExpiresAt = new Date(
        Date.now() + 24 * 60 * 60 * 1000
      );

      user.authProviders = [
        ...new Set([
          ...(user.authProviders || []),
          'password',
        ]),
      ];

      await user.save();

      try {
        await sendVerification(
          user,
          verification.token
        );
      } catch (error) {
        logger.error(
          `[AUTH] Verification resend email failed: ${error.message}`
        );

        user.emailVerificationTokenHash =
          undefined;

        user.emailVerificationExpiresAt =
          undefined;

        await user.save();
      }
    }

    return res.json({
      message:
        'If the account can be verified, a new verification email has been sent.',
    });
  } catch (error) {
    logger.error(
      `[AUTH] Verification resend failed: ${error.message}`
    );

    return res.status(500).json({
      message:
        'Unable to resend verification right now',
    });
  }
};

const passwordAuth = async (req, res) => {
  const { mode } = req.body || {};

  if (mode === 'signup') {
    return register(req, res);
  }

  if (mode === 'login') {
    return login(req, res);
  }

  return res.status(400).json({
    message: 'Invalid authentication mode',
  });
};

const linkPassword = async (req, res) => {
  const { password, confirmPassword } =
    req.body || {};

  if (
    typeof password !== 'string' ||
    Buffer.byteLength(password, 'utf8') > 72 ||
    !PASSWORD_PATTERN.test(password)
  ) {
    return res.status(400).json({
      message:
        'Password must be 8-72 bytes and include a letter, a number, and a symbol.',
    });
  }

  if (password !== confirmPassword) {
    return res.status(400).json({
      message: 'Passwords do not match',
    });
  }

  try {
    const user = await User.findById(
      req.user.userId
    ).select('+passwordHash');

    if (!user || !user.emailVerified) {
      return res.status(401).json({
        message: 'A verified account is required',
      });
    }

    user.passwordHash = await bcrypt.hash(
      password,
      12
    );

    user.authProviders = [
      ...new Set([
        ...(user.authProviders || []),
        'password',
      ]),
    ];

    await user.save();

    return res.json({
      message:
        'Password sign-in is enabled for your account',
    });
  } catch (error) {
    logger.error(
      `[AUTH] Password link failed: ${error.message}`
    );

    return res.status(500).json({
      message:
        'Unable to enable password sign-in right now',
    });
  }
};

const googleLogin = async (req, res) => {
  try {
    if (!googleClient) {
      return res.status(503).json({
        message:
          'Google sign-in is not configured on this server',
      });
    }

    const credential = req.body?.credential;

    if (
      typeof credential !== 'string' ||
      !credential
    ) {
      return res.status(400).json({
        message: 'Missing Google credential',
      });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    if (
      !payload?.sub ||
      !payload.email ||
      payload.email_verified !== true
    ) {
      return res.status(401).json({
        message: 'Google sign-in failed',
      });
    }

    const email = normalizeEmail(payload.email);

    let user = await User.findOne({
      googleId: payload.sub,
    });

    let isNewUser = false;

    if (!user) {
      user = await User.findOne({ email }).select(
        '+passwordHash'
      );

      if (
        user &&
        !user.emailVerified &&
        user.passwordHash
      ) {
        return res.status(409).json({
          message:
            'Verify this email address and sign in with your password before linking Google.',
        });
      }

      if (!user) {
        user = new User({
          email,
          name:
            payload.name ||
            email.split('@')[0],
        });

        isNewUser = true;
      }

      user.googleId = payload.sub;
    }

    user.email = email;
    user.name = payload.name || user.name;
    user.avatar =
      payload.picture || user.avatar;
    user.emailVerified = true;

    user.authProviders = [
      ...new Set([
        ...(user.authProviders || []),
        'google',
      ]),
    ];

    user.lastLoginAt = new Date();

    await user.save();

    const token = setSession(res, user);

    if (isNewUser) {
      await emailService
        .sendWelcomeEmail({
          to: user.email,
          name: user.name,
          method: 'google',
        })
        .catch((error) =>
          logger.warn(
            `[AUTH] Google welcome email failed: ${error.message}`
          )
        );
    }

    return res.json({
      token,
      user: safeUser(user),
    });
  } catch (error) {
    logger.error(
      `[AUTH] Google login failed: ${error.message}`
    );

    return res.status(401).json({
      message: 'Google sign-in failed',
    });
  }
};

// Link a Clerk-authenticated identity to a Brain Shadow
// application user, reusing an existing user for the
// same email when present.
async function upsertClerkUser(
  clerkUserId,
  email,
  profile
) {
  const normalizedEmail = (email || '')
    .trim()
    .toLowerCase();

  const existingByClerk = normalizedEmail
    ? await User.findOne({ clerkUserId })
    : null;

  if (existingByClerk) {
    existingByClerk.authMethod = 'clerk';
    existingByClerk.lastLoginAt = new Date();

    if (profile.name) {
      existingByClerk.name = profile.name;
    }

    if (profile.avatar) {
      existingByClerk.avatar = profile.avatar;
    }

    await existingByClerk.save();

    return existingByClerk;
  }

  const existingByEmail = normalizedEmail
    ? await User.findOne({
      email: normalizedEmail,
    })
    : null;

  if (existingByEmail) {
    existingByEmail.clerkUserId = clerkUserId;
    existingByEmail.authMethod = 'clerk';
    existingByEmail.lastLoginAt = new Date();

    if (profile.name) {
      existingByEmail.name = profile.name;
    }

    if (profile.avatar) {
      existingByEmail.avatar = profile.avatar;
    }

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
      return res.status(503).json({
        message:
          'Email/password login is not configured on this server',
      });
    }

    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        message: 'Missing Clerk session token',
      });
    }

    let verified;

    try {
      const authorizedParties = (
        process.env.FRONTEND_URL || ''
      )
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean);

      const result =
        await clerkClient.verifyToken(token, {
          authorizedParties,
        });

      verified = result;
    } catch (verifyErr) {
      logger.error(
        `[Auth] Clerk token verification failed: ${verifyErr.message}`
      );

      return res.status(401).json({
        message: 'Invalid or expired Clerk session',
      });
    }

    const clerkUserId =
      verified.sub || verified.userId;

    if (!clerkUserId) {
      return res.status(401).json({
        message: 'Invalid Clerk session',
      });
    }

    let email = verified.email || '';
    let name;
    let avatar;

    try {
      const clerkUser =
        await clerkClient.users.getUser(
          clerkUserId
        );

      email =
        email ||
        clerkUser.emailAddresses?.[0]
          ?.emailAddress ||
        '';

      name =
        name ||
        (clerkUser.firstName
          ? `${clerkUser.firstName} ${clerkUser.lastName || ''
            }`.trim()
          : clerkUser.username || undefined);

      avatar =
        avatar || clerkUser.imageUrl;
    } catch (userErr) {
      logger.error(
        `[Auth] Could not fetch Clerk user ${clerkUserId}: ${userErr.message}`
      );
    }

    if (!email) {
      return res.status(401).json({
        message:
          'Clerk account has no verified email address',
      });
    }

    const user = await upsertClerkUser(
      clerkUserId,
      email,
      {
        name,
        avatar,
      }
    );

    const appToken = signSession(user);

    res.cookie(SESSION_COOKIE, appToken, {
      ...cookieOptions,
      maxAge: COOKIE_MAX_AGE_MS,
    });

    return res.json({
      token: appToken,
      user: {
        email: user.email,
        name: user.name,
        avatar: user.avatar,
      },
    });
  } catch (error) {
    logger.error(
      `[Auth] Clerk login failed: ${error.message}`
    );

    return res.status(500).json({
      message: 'Sign-in failed',
    });
  }
};

const me = async (req, res) => {
  const demoAuthResult = demoAuthCheck(req);

  if (demoAuthResult) {
    return res.json({
      email: demoAuthResult.user.email,
      name: demoAuthResult.user.name,
      avatar: undefined,
    });
  }

  const token =
    req.cookies?.[SESSION_COOKIE] ||
    req.header('Authorization')?.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      message: 'Not signed in',
    });
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    const user = await User.findById(
      decoded.userId || decoded.sub
    );

    if (!user) {
      return res.status(401).json({
        message: 'Not signed in',
      });
    }

    return res.json({
      token,
      ...safeUser(user),
    });
  } catch {
    return res.status(401).json({
      message: 'Not signed in',
    });
  }
};

const logout = (req, res) => {
  res.clearCookie(
    SESSION_COOKIE,
    cookieOptions
  );

  return res.json({
    ok: true,
  });
};

module.exports = {
  googleLogin,
  clerkLogin,
  passwordAuth,
  register,
  login,
  verifyEmail,
  resendVerification,
  forgotPassword,
  resetPassword,
  linkPassword,
  me,
  logout,
  validRegistration,
};