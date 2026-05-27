const express  = require('express');
const bcrypt   = require('bcrypt');
const pool     = require('../lib/db');
const sendEmail = require('../lib/email');
const { requireRole } = require('../middleware/auth');
const { validatePassword } = require('./auth');
const router   = express.Router();

router.use(requireRole('admin', 'manager'));

// ── GET /api/users ───────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, email, first_name, last_name, role, two_fa_method,
            phone, notify_enabled, notify_sms, notify_email,
            created_at, updated_at, last_login_at
     FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC`
  );
  res.json(rows);
});

// ── POST /api/users ──────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { email, first_name, last_name, role, password } = req.body;
    if (!email || !first_name || !last_name || !role)
      return res.status(400).json({ error: 'email, first_name, last_name, and role are required' });
    if (!['admin','manager','basic'].includes(role))
      return res.status(400).json({ error: 'Invalid role' });
    // Managers cannot create admins
    if (req.session.userRole === 'manager' && role === 'admin')
      return res.status(403).json({ error: 'Managers cannot create admin users' });

    const pw = password || generateTempPassword();
    const err = validatePassword(pw);
    if (err) return res.status(400).json({ error: err });

    const hash = await bcrypt.hash(pw, 12);
    const now  = Math.floor(Date.now() / 1000);
    const [result] = await pool.query(
      'INSERT INTO users (email, password_hash, first_name, last_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [email.toLowerCase().trim(), hash, first_name.trim(), last_name.trim(), role, now, now]
    );

    // Send welcome email with password
    const base = process.env.BASE_URL || 'http://localhost:3000';
    await sendEmail({
      to: email.toLowerCase().trim(),
      subject: 'MetaTraffic LPR — Account Created',
      html: `<p>Hello ${first_name},</p>
             <p>An account has been created for you at MetaTraffic LPR.</p>
             <p><strong>Email:</strong> ${email.toLowerCase().trim()}<br>
                <strong>Temporary password:</strong> ${pw}</p>
             <p>Please log in at <a href="${base}/login">${base}/login</a> and set up two-factor authentication on first login.</p>`,
    });

    res.status(201).json({ id: result.insertId, email: email.toLowerCase().trim() });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A user with that email already exists' });
    console.error('[users POST]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PUT /api/users/:id ───────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const { first_name, last_name, email, role, phone, reset_2fa,
            notify_enabled, notify_sms, notify_email } = req.body;
    const id = parseInt(req.params.id);
    if (!first_name || !last_name || !email || !role)
      return res.status(400).json({ error: 'first_name, last_name, email, and role are required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
      return res.status(400).json({ error: 'Invalid email address' });
    if (phone && !/^\+[1-9]\d{7,14}$/.test(phone))
      return res.status(400).json({ error: 'Phone must be in E.164 format, e.g. +12125551234' });
    if (!['admin','manager','basic'].includes(role))
      return res.status(400).json({ error: 'Invalid role' });
    if (req.session.userRole === 'manager' && role === 'admin')
      return res.status(403).json({ error: 'Managers cannot assign admin role' });

    // Check email uniqueness (excluding this user)
    const [dup] = await pool.query(
      'SELECT id FROM users WHERE email=? AND id!=? AND deleted_at IS NULL',
      [email.toLowerCase().trim(), id]
    );
    if (dup.length) return res.status(409).json({ error: 'That email is already in use' });

    const now = Math.floor(Date.now() / 1000);
    let query, params;
    const ne  = notify_enabled ? 1 : 0;
    const ns  = notify_sms     ? 1 : 0;
    const nem = notify_email   ? 1 : 0;
    if (reset_2fa) {
      query  = 'UPDATE users SET first_name=?, last_name=?, email=?, role=?, phone=?, two_fa_method=?, totp_secret=NULL, sms_code=NULL, notify_enabled=?, notify_sms=?, notify_email=?, updated_at=? WHERE id=? AND deleted_at IS NULL';
      params = [first_name.trim(), last_name.trim(), email.toLowerCase().trim(), role, phone?.trim() || null, 'none', ne, ns, nem, now, id];
    } else {
      query  = 'UPDATE users SET first_name=?, last_name=?, email=?, role=?, phone=?, notify_enabled=?, notify_sms=?, notify_email=?, updated_at=? WHERE id=? AND deleted_at IS NULL';
      params = [first_name.trim(), last_name.trim(), email.toLowerCase().trim(), role, phone?.trim() || null, ne, ns, nem, now, id];
    }
    const [result] = await pool.query(query, params);
    if (!result.affectedRows) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That email is already in use' });
    console.error('[users PUT]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/users/:id ────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.session.userId)
    return res.status(400).json({ error: 'You cannot delete your own account' });

  const now = Math.floor(Date.now() / 1000);
  const [result] = await pool.query(
    'UPDATE users SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL',
    [now, now, id]
  );
  if (!result.affectedRows) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

// ── POST /api/users/:id/reset-password ───────────────────────────────────
router.post('/:id/reset-password', async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM users WHERE id=? AND deleted_at IS NULL', [req.params.id]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const crypto  = require('crypto');
  const token   = crypto.randomBytes(32).toString('hex');
  const expires = Math.floor(Date.now() / 1000) + 3600;
  await pool.query('UPDATE users SET password_reset_token=?, password_reset_expires=?, updated_at=? WHERE id=?',
    [token, expires, Math.floor(Date.now() / 1000), user.id]);

  const base = process.env.BASE_URL || 'http://localhost:3000';
  await sendEmail({
    to: user.email,
    subject: 'MetaTraffic LPR — Password Reset',
    html: `<p>Hello ${user.first_name},</p>
           <p>An administrator has requested a password reset for your account.</p>
           <p><a href="${base}/reset-password?token=${token}">Click here to set a new password</a> (expires in 1 hour).</p>`,
  });
  res.json({ ok: true });
});

function generateTempPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pw = '';
  for (let i = 0; i < 12; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw + 'A1'; // ensure uppercase + digit
}

module.exports = router;
