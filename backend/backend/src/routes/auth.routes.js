const express = require('express');
const { rateLimit } = require('express-rate-limit');
const router = express.Router();
const authController = require('../controllers/auth.controller');
const jwtAuth = require('../middleware/jwt.middleware');

const authLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: process.env.NODE_ENV === 'test' ? 100 : 10,
	standardHeaders: 'draft-8',
	legacyHeaders: false,
	message: {
		message: 'Too many authentication attempts. Please try again later.',
	},
});

router.post('/google', authLimiter, authController.googleLogin);
router.post('/clerk', authController.clerkLogin);

router.post('/password', authLimiter, authController.passwordAuth);
router.post('/register', authLimiter, authController.register);
router.post('/login', authLimiter, authController.login);
router.post('/verify-email', authLimiter, authController.verifyEmail);
router.post('/resend-verification', authLimiter, authController.resendVerification);
router.post('/forgot-password', authLimiter, authController.forgotPassword);
router.post('/reset-password', authLimiter, authController.resetPassword);
router.post('/link-password', authLimiter, jwtAuth, authController.linkPassword);

router.get('/me', authController.me);
router.post('/logout', authController.logout);

module.exports = router;