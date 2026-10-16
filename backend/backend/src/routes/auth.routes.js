const express = require('express');
const { rateLimit } = require('express-rate-limit');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const logger = require('../utils/logger');

const authLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: process.env.NODE_ENV === 'test' ? 100 : 10,
	standardHeaders: 'draft-8',
	legacyHeaders: false,
	skipSuccessfulRequests: true,
	message: {
		message: 'Too many authentication attempts. Please try again later.',
	},
	handler: (req, res) => {
		const { limit, used, remaining, resetTime } = req.rateLimit;
		const retryAfterSeconds = resetTime
			? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
			: 15 * 60;
		logger.warn('[Auth] Clerk session exchange rate limit exceeded', {
			requestCount: used,
			limit,
			remaining,
			retryAfterSeconds,
			statusCode: 429,
		});
		return res.status(429).json({
			message: 'Too many authentication attempts. Please try again later.',
			code: 'AUTH_RATE_LIMITED',
			retryAfterSeconds,
		});
	},
});

function logClerkExchangeResult(req, res, next) {
	const rateLimit = req.rateLimit;
	res.on('finish', () => {
		logger.info('[Auth] Clerk session exchange completed', {
			requestCount: rateLimit.used,
			limit: rateLimit.limit,
			remaining: rateLimit.remaining,
			statusCode: res.statusCode,
		});
	});
	next();
}

router.post('/clerk', authLimiter, logClerkExchangeResult, authController.clerkLogin);

router.get('/me', authController.me);
router.post('/logout', authController.logout);

module.exports = router;