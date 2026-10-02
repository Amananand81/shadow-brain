const jwt = require('jsonwebtoken');
const User = require('../models/user.model');

const jwtMiddleware = async (req, res, next) => {
  const authHeader = req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ')
    ? authHeader.slice(7)
    : req.cookies?.shadowbrain_token || req.cookies?.token;
  if (!token) return res.status(401).json({ message: 'Authentication required' });
  if (!process.env.JWT_SECRET) return res.status(500).json({ message: 'Server configuration error' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.userId) return res.status(401).json({ message: 'Invalid token payload' });

    const user = await User.findById(decoded.userId);
    if (!user) return res.status(401).json({ message: 'User not found. Please sign in again.' });
    req.user = { ...decoded, userId: user._id.toString(), email: user.email };
    return next();
  } catch (error) {
    if (error.name === 'TokenExpiredError' || error.name === 'JsonWebTokenError') {
      return res.status(401).json({ message: 'Invalid or expired token' });
    }
    return next(error);
  }
};

module.exports = jwtMiddleware;
