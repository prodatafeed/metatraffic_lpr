const express  = require('express');
const bcrypt   = require('bcrypt');
const crypto   = require('crypto');
const speakeasy = require('speakeasy');
const qrcode   = require('qrcode');
const pool     = require('../lib/db');
const audit    = require('../lib/audit');
const sendEmail = require('../lib/email');
const sendSMS  = require('../lib/sms');
const { requireAuth } = require('../middleware/auth');
const router   = express.Router();

// ── POST /api/auth/login ─────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const [rows] = await pool.query(
      'SELECT * FROM users WHERE email = ? AND deleted_at IS NULL',
      [email.toLowerCase().trim()]
    );
    const user = rows[0];
    const valid = user && await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      await audit({ email: email.toLowerCase().trim(), eventType: 'login_failed', req });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (user.two_fa_method === 'none') {
      req.session.pendingSetup = { userId: user.id, email: user.email };
      return res.json({ redirect: '/setup-2fa' });
    }

    if (user.two_fa_method === 'totp') {
      req.session.pendingAuth = { userId: user.id, email: user.email, method: 'totp' };
      return res.json({ redirect: '/2fa' });
    }

    if (user.two_fa_method === 'sms') {
      const code    = String(Math.floor(100000 + Math.random() * 900000));
      const expires = Math.floor(Date.now() / 1000) + 600;
      await pool.query('UPDATE users SET sms_code=?, sms_code_expires=? WHERE id=?', [code, expires, user.id]);
      await sendSMS(user.phone, `Your MetaTraffic LPR code is: ${code}. It expires in 10 minutes.`);
      req.session.pendingAuth = { userId: user.id, email: user.email, method: 'sms',
        phoneMask: user.phone.replace(/\d(?=\d{4})/g, '*') };
      return res.json({ redirect: '/2fa', phoneMask: req.session.pendingAuth.phoneMask });
    }
  } catch (e) {
    console.error('[auth/login]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/2fa ───────────────────────────────────────────────────
router.post('/2fa', async (req, res) => {
  try {
    const { code } = req.body;
    const pending  = req.session.pendingAuth;
    if (!pending) return res.status(401).json({ error: 'No pending authentication' });

    const [rows] = await pool.query('SELECT * FROM users WHERE id=? AND deleted_at IS NULL', [pending.userId]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'User not found' });

    let valid = false;
    if (pending.method === 'totp') {
      valid = speakeasy.totp.verify({ secret: user.totp_secret, encoding: 'base32', token: code, window: 1 });
    } else if (pending.method === 'sms') {
      const now = Math.floor(Date.now() / 1000);
      valid = user.sms_code === code && user.sms_code_expires > now;
      if (valid) await pool.query('UPDATE users SET sms_code=NULL, sms_code_expires=NULL WHERE id=?', [user.id]);
    }

    if (!valid) {
      await audit({ userId: user.id, email: user.email, eventType: '2fa_failed', req });
      return res.status(401).json({ error: 'Invalid or expired code' });
    }

    await completeLogin(req, user);
    await audit({ userId: user.id, email: user.email, eventType: 'login_success', req });
    res.json({ redirect: '/lpr' });
  } catch (e) {
    console.error('[auth/2fa]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/setup-totp/init ───────────────────────────────────────
router.post('/setup-totp/init', async (req, res) => {
  try {
    const ctx = getPendingContext(req);
    if (!ctx) return res.status(401).json({ error: 'Unauthorized' });

    const secret = speakeasy.generateSecret({ name: `MetaTraffic LPR (${ctx.email})`, length: 20 });
    req.session.totpSetupSecret = secret.base32;
    const qr = await qrcode.toDataURL(secret.otpauth_url);
    res.json({ secret: secret.base32, qr });
  } catch (e) {
    console.error('[auth/setup-totp/init]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/setup-totp/verify ────────────────────────────────────
router.post('/setup-totp/verify', async (req, res) => {
  try {
    const { code } = req.body;
    const ctx = getPendingContext(req);
    if (!ctx || !req.session.totpSetupSecret) return res.status(401).json({ error: 'Unauthorized' });

    const valid = speakeasy.totp.verify({
      secret: req.session.totpSetupSecret, encoding: 'base32', token: code, window: 1,
    });
    if (!valid) return res.status(400).json({ error: 'Invalid code — check your authenticator app' });

    const now = Math.floor(Date.now() / 1000);
    await pool.query(
      'UPDATE users SET two_fa_method=?, totp_secret=?, phone=NULL, sms_code=NULL, updated_at=? WHERE id=?',
      ['totp', req.session.totpSetupSecret, now, ctx.userId]
    );
    delete req.session.totpSetupSecret;

    if (req.session.pendingSetup) {
      const [rows] = await pool.query('SELECT * FROM users WHERE id=?', [ctx.userId]);
      await completeLogin(req, rows[0]);
      await audit({ userId: rows[0].id, email: rows[0].email, eventType: 'login_success', req, details: { setup: 'totp' } });
    }
    res.json({ ok: true, redirect: '/lpr' });
  } catch (e) {
    console.error('[auth/setup-totp/verify]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/setup-sms/init ───────────────────────────────────────
router.post('/setup-sms/init', async (req, res) => {
  try {
    const { phone } = req.body;
    const ctx = getPendingContext(req);
    if (!ctx) return res.status(401).json({ error: 'Unauthorized' });
    if (!phone || !/^\+?[\d\s\-().]{7,20}$/.test(phone.trim()))
      return res.status(400).json({ error: 'Invalid phone number. Use international format, e.g. +12125551234' });

    const code    = String(Math.floor(100000 + Math.random() * 900000));
    const expires = Math.floor(Date.now() / 1000) + 600;
    req.session.smsSetup = { phone: phone.trim(), code, expires };
    await sendSMS(phone.trim(), `Your MetaTraffic LPR setup code is: ${code}. It expires in 10 minutes.`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[auth/setup-sms/init]', e);
    const msg = e?.message || 'Failed to send SMS';
    res.status(500).json({ error: msg });
  }
});

// ── POST /api/auth/setup-sms/verify ─────────────────────────────────────
router.post('/setup-sms/verify', async (req, res) => {
  try {
    const { code } = req.body;
    const ctx = getPendingContext(req);
    const smsSetup = req.session.smsSetup;
    if (!ctx || !smsSetup) return res.status(401).json({ error: 'Unauthorized' });

    const now = Math.floor(Date.now() / 1000);
    if (smsSetup.code !== code || smsSetup.expires < now)
      return res.status(400).json({ error: 'Invalid or expired code' });

    await pool.query(
      'UPDATE users SET two_fa_method=?, phone=?, totp_secret=NULL, updated_at=? WHERE id=?',
      ['sms', smsSetup.phone, now, ctx.userId]
    );
    delete req.session.smsSetup;

    if (req.session.pendingSetup) {
      const [rows] = await pool.query('SELECT * FROM users WHERE id=?', [ctx.userId]);
      await completeLogin(req, rows[0]);
      await audit({ userId: rows[0].id, email: rows[0].email, eventType: 'login_success', req, details: { setup: 'sms' } });
    }
    res.json({ ok: true, redirect: '/lpr' });
  } catch (e) {
    console.error('[auth/setup-sms/verify]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/auth/logout ────────────────────────────────────────────────
router.post('/logout', requireAuth, async (req, res) => {
  await audit({ userId: req.session.userId, email: req.session.userEmail, eventType: 'logout', req });
  req.session.destroy(() => res.json({ redirect: '/login' }));
});

// ── GET /api/auth/pending ─────────────────────────────────────────────────
router.get('/pending', (req, res) => {
  const p = req.session.pendingAuth;
  if (!p) return res.status(401).json({ error: 'No pending authentication' });
  res.json({ method: p.method, phoneMask: p.phoneMask || null });
});

// ── GET /api/auth/me ─────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthenticated' });
  res.json({
    id:        req.session.userId,
    email:     req.session.userEmail,
    firstName: req.session.firstName,
    lastName:  req.session.lastName,
    role:      req.session.userRole,
  });
});

// ── POST /api/auth/forgot-password ───────────────────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const [rows] = await pool.query(
      'SELECT * FROM users WHERE email=? AND deleted_at IS NULL',
      [email.toLowerCase().trim()]
    );
    const user = rows[0];
    if (user) {
      const token   = crypto.randomBytes(32).toString('hex');
      const expires = Math.floor(Date.now() / 1000) + 3600;
      await pool.query(
        'UPDATE users SET password_reset_token=?, password_reset_expires=?, updated_at=? WHERE id=?',
        [token, expires, Math.floor(Date.now() / 1000), user.id]
      );
      const base = process.env.BASE_URL || 'http://localhost:3000';
      await sendEmail({
        to: user.email,
        subject: 'MetaTraffic LPR — Password Reset',
        html: `<p>Hello ${user.first_name},</p>
               <p>Click below to reset your password. This link expires in 1 hour.</p>
               <p><a href="${base}/reset-password?token=${token}">${base}/reset-password?token=${token}</a></p>
               <p>If you didn't request this, ignore this email.</p>`,
      });
      await audit({ userId: user.id, email: user.email, eventType: 'password_reset_requested', req });
    }
    res.json({ ok: true }); // always succeed to prevent email enumeration
  } catch (e) {
    console.error('[auth/forgot-password]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/auth/validate-reset-token/:token ────────────────────────────
router.get('/validate-reset-token/:token', async (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const [rows] = await pool.query(
    'SELECT email FROM users WHERE password_reset_token=? AND password_reset_expires>? AND deleted_at IS NULL',
    [req.params.token, now]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Invalid or expired reset link' });
  res.json({ ok: true, email: rows[0].email });
});

// ── POST /api/auth/reset-password ────────────────────────────────────────
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    const err = validatePassword(password);
    if (err) return res.status(400).json({ error: err });

    const now = Math.floor(Date.now() / 1000);
    const [rows] = await pool.query(
      'SELECT * FROM users WHERE password_reset_token=? AND password_reset_expires>? AND deleted_at IS NULL',
      [token, now]
    );
    const user = rows[0];
    if (!user) return res.status(400).json({ error: 'Invalid or expired reset link' });

    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      'UPDATE users SET password_hash=?, password_reset_token=NULL, password_reset_expires=NULL, updated_at=? WHERE id=?',
      [hash, now, user.id]
    );
    await audit({ userId: user.id, email: user.email, eventType: 'password_reset_completed', req });
    res.json({ ok: true });
  } catch (e) {
    console.error('[auth/reset-password]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────
function getPendingContext(req) {
  if (req.session.pendingSetup) return req.session.pendingSetup;
  if (req.session.userId) return { userId: req.session.userId, email: req.session.userEmail };
  return null;
}

async function completeLogin(req, user) {
  const now = Math.floor(Date.now() / 1000);
  await pool.query('UPDATE users SET last_login_at=? WHERE id=?', [now, user.id]);
  return new Promise((resolve, reject) => {
    req.session.regenerate(err => {
      if (err) return reject(err);
      req.session.userId       = user.id;
      req.session.userEmail    = user.email;
      req.session.firstName    = user.first_name;
      req.session.lastName     = user.last_name;
      req.session.userRole     = user.role;
      req.session.lastActivity = now;
      req.session.save(e => e ? reject(e) : resolve());
    });
  });
}

function validatePassword(pw) {
  if (pw.length < 8)          return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(pw))      return 'Password must contain an uppercase letter';
  if (!/[a-z]/.test(pw))      return 'Password must contain a lowercase letter';
  if (!/[0-9]/.test(pw))      return 'Password must contain a number';
  return null;
}

module.exports = router;
module.exports.validatePassword = validatePassword;
module.exports.completeLogin    = completeLogin;
