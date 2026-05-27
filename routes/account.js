const express  = require('express');
const bcrypt   = require('bcrypt');
const pool     = require('../lib/db');
const audit    = require('../lib/audit');
const { requireAuth } = require('../middleware/auth');
const { validatePassword } = require('./auth');
const router   = express.Router();

router.use(requireAuth);

// ── GET /api/account/me ──────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  const [rows] = await pool.query(
    'SELECT id, email, first_name, last_name, role, two_fa_method, phone, notify_enabled, notify_sms, notify_email FROM users WHERE id=? AND deleted_at IS NULL',
    [req.session.userId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
});

// ── PUT /api/account/profile ─────────────────────────────────────────────
router.put('/profile', async (req, res) => {
  const { first_name, last_name, phone } = req.body;
  if (!first_name?.trim()) return res.status(400).json({ error: 'First name is required' });
  if (!last_name?.trim())  return res.status(400).json({ error: 'Last name is required' });
  if (phone && !/^\+[1-9]\d{7,14}$/.test(phone))
    return res.status(400).json({ error: 'Phone must be in E.164 format, e.g. +12125551234' });

  const now = Math.floor(Date.now() / 1000);
  await pool.query(
    'UPDATE users SET first_name=?, last_name=?, phone=?, updated_at=? WHERE id=?',
    [first_name.trim(), last_name.trim(), phone?.trim() || null, now, req.session.userId]
  );
  req.session.firstName = first_name.trim();
  req.session.lastName  = last_name.trim();
  res.json({ ok: true });
});

// ── PUT /api/account/notifications ──────────────────────────────────────
router.put('/notifications', async (req, res) => {
  const { notify_enabled, notify_sms, notify_email } = req.body;
  const ne  = notify_enabled ? 1 : 0;
  const ns  = notify_sms     ? 1 : 0;
  const nem = notify_email   ? 1 : 0;
  const now = Math.floor(Date.now() / 1000);
  await pool.query(
    'UPDATE users SET notify_enabled=?, notify_sms=?, notify_email=?, updated_at=? WHERE id=?',
    [ne, ns, nem, now, req.session.userId]
  );
  res.json({ ok: true });
});

// ── PUT /api/account/password ────────────────────────────────────────────
router.put('/password', async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password)
    return res.status(400).json({ error: 'Current and new passwords are required' });

  const [rows] = await pool.query('SELECT password_hash FROM users WHERE id=?', [req.session.userId]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });

  const match = await bcrypt.compare(current_password, rows[0].password_hash);
  if (!match) return res.status(401).json({ error: 'Current password is incorrect' });

  const err = validatePassword(new_password);
  if (err) return res.status(400).json({ error: err });

  const hash = await bcrypt.hash(new_password, 12);
  const now  = Math.floor(Date.now() / 1000);
  await pool.query('UPDATE users SET password_hash=?, updated_at=? WHERE id=?', [hash, now, req.session.userId]);
  await audit({ userId: req.session.userId, email: req.session.userEmail, eventType: 'password_changed', req });
  res.json({ ok: true });
});

module.exports = router;
