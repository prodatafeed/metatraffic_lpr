const express = require('express');
const pool    = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const router  = express.Router();

// ── GET /api/locations?search=xxx ─────────────────────────────────────────
// Autocomplete search — available to any authenticated user
router.get('/', requireAuth, async (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const limit  = Math.min(parseInt(req.query.limit) || 20, 100);
    let rows;
    if (search) {
      const like = `%${search}%`;
      [rows] = await pool.query(
        `SELECT id, location_code, address1, address2, city, state, zip
         FROM locations WHERE deleted_at IS NULL
         AND (location_code LIKE ? OR address1 LIKE ? OR city LIKE ?)
         ORDER BY location_code LIMIT ?`,
        [like, like, like, limit]
      );
    } else {
      [rows] = await pool.query(
        `SELECT id, location_code, address1, address2, city, state, zip
         FROM locations WHERE deleted_at IS NULL ORDER BY location_code LIMIT ?`,
        [limit]
      );
    }
    res.json(rows);
  } catch (e) {
    console.error('[locations GET]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/locations/user/:userId ───────────────────────────────────────
router.get('/user/:userId', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT mul.id AS mapping_id, l.id, l.location_code, l.address1, l.address2, l.city, l.state, l.zip
       FROM mapping_user_location mul
       JOIN locations l ON l.id = mul.location_id
       WHERE mul.user_id = ? AND mul.deleted_at IS NULL AND l.deleted_at IS NULL
       ORDER BY l.location_code`,
      [req.params.userId]
    );
    res.json(rows);
  } catch (e) {
    console.error('[locations/user GET]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/locations/user/:userId ──────────────────────────────────────
router.post('/user/:userId', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { location_id } = req.body;
    const userId = parseInt(req.params.userId);
    if (!location_id) return res.status(400).json({ error: 'location_id is required' });

    // Check location exists
    const [loc] = await pool.query('SELECT id FROM locations WHERE id=? AND deleted_at IS NULL', [location_id]);
    if (!loc.length) return res.status(404).json({ error: 'Location not found' });

    // Check not already mapped
    const [existing] = await pool.query(
      'SELECT id FROM mapping_user_location WHERE user_id=? AND location_id=? AND deleted_at IS NULL',
      [userId, location_id]
    );
    if (existing.length) return res.status(409).json({ error: 'Location already mapped to this user' });

    const now = Math.floor(Date.now() / 1000);
    await pool.query(
      'INSERT INTO mapping_user_location (user_id, location_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [userId, location_id, now, now]
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error('[locations/user POST]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/locations/user/:userId/:mappingId ─────────────────────────
router.delete('/user/:userId/:mappingId', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const now = Math.floor(Date.now() / 1000);
    const [result] = await pool.query(
      'UPDATE mapping_user_location SET deleted_at=?, updated_at=? WHERE id=? AND user_id=? AND deleted_at IS NULL',
      [now, now, req.params.mappingId, req.params.userId]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Mapping not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[locations/user DELETE]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/locations/user-info/:userId ──────────────────────────────────
// Returns basic user info for the manage-locations page header
router.get('/user-info/:userId', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, first_name, last_name, email, role FROM users WHERE id=? AND deleted_at IS NULL',
      [req.params.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
