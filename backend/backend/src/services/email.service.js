const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

let transporter;

function getTransporter() {
  if (transporter) return transporter;
  const user = process.env.JJ_EMAIL;
  const pass = process.env.JJ_EMAIL_PASS;
  if (!user || !pass) throw new Error('Gmail SMTP is not configured');

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    auth: { user, pass },
  });
  return transporter;
}

function layout(name, body) {
  return `<div style="margin:0;background:#f2f5f7;padding:32px 12px;font-family:Arial,sans-serif;color:#17212b"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #dce3e8;border-radius:8px;overflow:hidden"><div style="padding:22px 28px;background:#102b35;color:#fff;font-size:18px;font-weight:700">Brain Shadow</div><div style="padding:28px"><p style="margin:0 0 18px">Hi ${escapeHtml(name || 'there')},</p>${body}<p style="margin:24px 0 0;color:#66747e;font-size:12px">Brain Shadow<br>Universal AI Knowledge Management Platform</p></div></div></div>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

async function send({ to, subject, html }) {
  const from = process.env.JJ_EMAIL;
  const mailer = getTransporter();
  try {
    await mailer.sendMail({ from: `Brain Shadow <${from}>`, to, subject, html });
  } catch (error) {
    logger.error(`[EMAIL] Delivery failed: ${error.message}`);
    throw new Error('Email delivery failed');
  }
}

function actionLink(label, url) {
  return `<p style="margin:22px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#167c80;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:700">${label}</a></p><p style="font-size:12px;color:#66747e;word-break:break-all">If the button does not work, open: ${escapeHtml(url)}</p>`;
}

async function sendVerificationEmail({ to, name, verificationUrl }) {
  await send({
    to,
    subject: 'Verify your Brain Shadow email',
    html: layout(name, `<p>Confirm your email address to finish creating your Brain Shadow account.</p>${actionLink('Verify email', verificationUrl)}<p style="font-size:12px;color:#66747e">This link expires in 24 hours. If you did not create this account, you can ignore this email.</p>`),
  });
}

async function sendWelcomeEmail({ to, name, method }) {
  const signInMethod = method === 'google'
    ? 'Continue with Google to sign in to your account.'
    : 'Use your email and password to sign in. You can use Forgot Password if you need to reset it.';
  await send({
    to,
    subject: 'Welcome to Brain Shadow',
    html: layout(name, `<p>Your Brain Shadow account is ready.</p><p>Account email: <strong>${escapeHtml(to)}</strong></p><p>${signInMethod}</p>`),
  });
}

async function sendPasswordResetEmail({ to, name, resetUrl }) {
  await send({
    to,
    subject: 'Reset your Brain Shadow password',
    html: layout(name, `<p>We received a request to reset the password for <strong>${escapeHtml(to)}</strong>.</p>${actionLink('Reset password', resetUrl)}<p style="font-size:12px;color:#66747e">This link expires in 20 minutes and can be used once. If you did not request a reset, ignore this email.</p>`),
  });
}

module.exports = { sendVerificationEmail, sendWelcomeEmail, sendPasswordResetEmail };
