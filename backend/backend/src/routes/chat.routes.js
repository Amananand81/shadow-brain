const express = require('express');
const router  = express.Router();
const { chat } = require('../controllers/chat.controller');
const jwtAuth = require('../middleware/jwt.middleware');

router.use(jwtAuth);
router.post('/', chat);

module.exports = router;
