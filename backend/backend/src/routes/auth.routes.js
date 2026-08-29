const express = require('express');
const router = express.Router();
const authController = require('../controllers/auth.controller');

router.post('/google', authController.googleLogin);
router.post('/clerk', authController.clerkLogin);
router.get('/me', authController.me);
router.post('/logout', authController.logout);

module.exports = router;
