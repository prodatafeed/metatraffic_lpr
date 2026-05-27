const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');
const pool    = require('../lib/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const router  = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── Parse CSV buffer ──────────────────────────────────────────────────────
function parseCSV(buf) {
  const lines   = buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const entries = [];
  const errors  = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith('#')) continue;

    // Skip header row
    if (i === 0 && /^state\s*,/i.test(raw)) continue;

    const parts = raw.split(',').map(s => s.trim());
    const [state, plate, make, model, color] = parts;

    // At least one meaningful field required
    const entry = {
      state: state?.toUpperCase()  || null,
      plate: plate?.toUpperCase()  || null,
      make:  make  || null,
      model: model || null,
      color: color || null,
    };
    if (!entry.state && !entry.plate && !entry.make && !entry.model && !entry.color) {
      errors.push(`Line ${i + 1}: empty row skipped`);
      continue;
    }
    entries.push(entry);
  }
  return { entries, errors };
}

// ── POST /api/bolo/upload ─────────────────────────────────────────────────
router.post('/upload', requireRole('admin', 'manager'), upload.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded — use field name "csv"' });
  if (!req.file.originalname.toLowerCase().endsWith('.csv') &&
      req.file.mimetype !== 'text/csv' && req.file.mimetype !== 'application/vnd.ms-excel')
    return res.status(400).json({ error: 'File must be a CSV' });

  const { entries, errors } = parseCSV(req.file.buffer);
  if (!entries.length) return res.status(400).json({ error: 'No valid entries found in CSV', errors });

  const batchId = crypto.randomUUID();
  const now     = Math.floor(Date.now() / 1000);

  for (const e of entries) {
    await pool.query(
      'INSERT INTO bolo (batch_id, state, plate, make, model, color, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [batchId, e.state, e.plate, e.make, e.model, e.color, req.session.userId, now]
    );
  }

  res.status(201).json({ ok: true, batch_id: batchId, inserted: entries.length, warnings: errors });
});

// ── GET /api/bolo ─────────────────────────────────────────────────────────
// Returns active BOLO entries. Managers only see entries they uploaded.
router.get('/', requireRole('admin', 'manager'), async (req, res) => {
  try {
    let rows;
    if (req.session.userRole === 'admin') {
      [rows] = await pool.query(`
        SELECT b.*, u.first_name, u.last_name, u.email, u.role AS uploader_role
        FROM bolo b
        JOIN users u ON u.id = b.uploaded_by
        WHERE b.deleted_at IS NULL
        ORDER BY b.created_at DESC
      `);
    } else {
      [rows] = await pool.query(`
        SELECT b.*, u.first_name, u.last_name, u.email, u.role AS uploader_role
        FROM bolo b
        JOIN users u ON u.id = b.uploaded_by
        WHERE b.deleted_at IS NULL AND b.uploaded_by = ?
        ORDER BY b.created_at DESC
      `, [req.session.userId]);
    }
    res.json(rows);
  } catch (e) {
    console.error('[bolo GET]', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/bolo/batch/:batchId ──────────────────────────────────────
// Must be registered BEFORE /:id to avoid the wildcard swallowing "batch"
router.delete('/batch/:batchId', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const now = Math.floor(Date.now() / 1000);
    let result;
    if (req.session.userRole === 'admin') {
      [result] = await pool.query(
        'UPDATE bolo SET deleted_at=?, updated_at=? WHERE batch_id=? AND deleted_at IS NULL',
        [now, now, req.params.batchId]
      );
    } else {
      [result] = await pool.query(
        'UPDATE bolo SET deleted_at=?, updated_at=? WHERE batch_id=? AND uploaded_by=? AND deleted_at IS NULL',
        [now, now, req.params.batchId, req.session.userId]
      );
    }
    if (!result.affectedRows) return res.status(404).json({ error: 'Batch not found' });
    res.json({ ok: true, deleted: result.affectedRows });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── DELETE /api/bolo/:id ──────────────────────────────────────────────────
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const now = Math.floor(Date.now() / 1000);
    let result;
    if (req.session.userRole === 'admin') {
      [result] = await pool.query(
        'UPDATE bolo SET deleted_at=?, updated_at=? WHERE id=? AND deleted_at IS NULL',
        [now, now, req.params.id]
      );
    } else {
      [result] = await pool.query(
        'UPDATE bolo SET deleted_at=?, updated_at=? WHERE id=? AND uploaded_by=? AND deleted_at IS NULL',
        [now, now, req.params.id, req.session.userId]
      );
    }
    if (!result.affectedRows) return res.status(404).json({ error: 'Entry not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/bolo/audit ───────────────────────────────────────────────────
router.get('/audit', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;
    let rows;
    if (req.session.userRole === 'admin') {
      [rows] = await pool.query(`
        SELECT na.*, u.first_name, u.last_name, u.email AS notified_email
        FROM notification_audit na
        JOIN users u ON u.id = na.notified_user_id
        ORDER BY na.sent_at DESC LIMIT ? OFFSET ?
      `, [limit, offset]);
    } else {
      [rows] = await pool.query(`
        SELECT na.*, u.first_name, u.last_name, u.email AS notified_email
        FROM notification_audit na
        JOIN users u ON u.id = na.notified_user_id
        WHERE na.notified_user_id = ?
        ORDER BY na.sent_at DESC LIMIT ? OFFSET ?
      `, [req.session.userId, limit, offset]);
    }
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
