const express  = require('express');
const path     = require('path');
const multer   = require('multer');
const pool     = require('../lib/db');
const { checkAndNotify } = require('../lib/notify');
const { requireAuth } = require('../middleware/auth');
const router  = express.Router();

const MAX_READS    = 10000;
const PHOTO_BASE   = (process.env.PHOTO_BASE_URL || 'http://localhost:3000/photos').replace(/\/$/, '');
const PHOTOS_DIR   = path.join(__dirname, '../photos');

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const storage = multer.diskStorage({
  destination: PHOTOS_DIR,
  filename: (req, file, cb) => cb(null, `${req.params.guid}.jpg`),
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/jpeg') return cb(null, true);
    cb(Object.assign(new Error('Only JPEG files are accepted'), { code: 'INVALID_TYPE' }));
  },
});

// In-memory store (shared via module-level singleton)
const reads      = [];
const readsByGuid = new Map();

let io; // injected by server.js
router.setIO = (ioInstance) => { io = ioInstance; };
router.reads      = reads;
router.readsByGuid = readsByGuid;

// Load existing reads from MySQL on startup
async function loadReads() {
  const [rows] = await pool.query(
    `SELECT r.*, l.location_code
     FROM lpr_reads r
     LEFT JOIN locations l ON l.id = r.location_id AND l.deleted_at IS NULL
     ORDER BY r.received_at DESC LIMIT ?`, [MAX_READS]
  );
  for (const row of rows) {
    reads.push(row);
    readsByGuid.set(row.guid, row);
  }
  console.log(`Loaded ${rows.length} reads from MySQL`);
}
router.loadReads = loadReads;

// ── POST /api/reads ───────────────────────────────────────────────────────
// Ingest endpoint — no auth required (LPR devices post here)
router.post('/reads', async (req, res) => {
  const { guid, license_plate, license_plate_state, make, model, color, timestamp, location } = req.body;

  if (!guid || typeof guid !== 'string' || !guid.trim())
    return res.status(400).json({ error: 'guid is required' });
  if (!license_plate || !license_plate_state)
    return res.status(400).json({ error: 'license_plate and license_plate_state are required' });

  const normalizedGuid = guid.trim();
  if (readsByGuid.has(normalizedGuid))
    return res.status(409).json({ error: 'duplicate guid' });

  // Resolve location_code → location_id + location_code
  let locationId   = null;
  let locationCode = null;
  if (location) {
    const [locs] = await pool.query(
      'SELECT id, location_code FROM locations WHERE location_code=? AND deleted_at IS NULL LIMIT 1',
      [location.trim()]
    );
    if (locs.length) { locationId = locs[0].id; locationCode = locs[0].location_code; }
  }

  const read = {
    guid:                normalizedGuid,
    license_plate:       license_plate.toUpperCase().trim(),
    license_plate_state: license_plate_state.toUpperCase().trim(),
    make:                make  || '',
    model:               model || '',
    color:               color || '',
    timestamp:           timestamp || new Date().toISOString(),
    location:            location  || '',
    location_id:         locationId,
    location_code:       locationCode,
    received_at:         new Date().toISOString(),
    photo_url:           `${PHOTO_BASE}/${encodeURIComponent(normalizedGuid)}.jpg`,
  };

  try {
    await pool.query(
      `INSERT INTO lpr_reads
         (guid, license_plate, license_plate_state, make, model, color, timestamp, location, location_id, received_at, photo_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [read.guid, read.license_plate, read.license_plate_state, read.make, read.model,
       read.color, read.timestamp, read.location, read.location_id, read.received_at, read.photo_url]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'duplicate guid' });
    console.error('[api/reads POST]', err.message);
    return res.status(500).json({ error: 'database error' });
  }

  readsByGuid.set(normalizedGuid, read);
  reads.unshift(read);
  if (reads.length > MAX_READS) readsByGuid.delete(reads.pop().guid);

  if (io) io.emit('new_read', read);
  res.status(201).json(read);

  // BOLO check — fire-and-forget (don't block the response)
  checkAndNotify(read).catch(e => console.error('[BOLO]', e.message));
});

// ── GET /api/reads ────────────────────────────────────────────────────────
router.get('/reads', requireAuth, async (req, res) => {
  const { plate, state, make, model, color, limit } = req.query;
  let results = reads;

  // Filter by user's mapped locations (non-admin users with locations assigned)
  if (req.session.userRole !== 'admin') {
    const [mapped] = await pool.query(
      'SELECT location_id FROM mapping_user_location WHERE user_id=? AND deleted_at IS NULL',
      [req.session.userId]
    );
    if (mapped.length > 0) {
      const ids = new Set(mapped.map(r => r.location_id));
      results = results.filter(r => r.location_id != null && ids.has(Number(r.location_id)));
    }
  }

  if (plate)  { const p = plate.toUpperCase();  results = results.filter(r => r.license_plate.includes(p)); }
  if (state)  { const s = state.toUpperCase();  results = results.filter(r => r.license_plate_state === s); }
  if (make)   { const m = make.toLowerCase();   results = results.filter(r => r.make.toLowerCase().includes(m)); }
  if (model)  { const m = model.toLowerCase();  results = results.filter(r => r.model.toLowerCase().includes(m)); }
  if (color)  { const c = color.toLowerCase();  results = results.filter(r => r.color.toLowerCase().includes(c)); }

  const n = Math.min(parseInt(limit) || 500, 1000);
  res.json(results.slice(0, n));
});

// ── Photo upload handler (shared by both routes below) ───────────────────
function handlePhotoUpload(req, res) {
  const { guid } = req.params;
  if (!GUID_RE.test(guid)) return res.status(400).json({ error: 'Invalid GUID format' });

  upload.single('photo')(req, res, err => {
    if (err?.code === 'INVALID_TYPE') return res.status(400).json({ error: 'Only JPEG files are accepted' });
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File exceeds 10 MB limit' });
    if (err) return res.status(500).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded — use field name "photo"' });

    const url = `${PHOTO_BASE}/${encodeURIComponent(guid)}.jpg`;
    res.status(201).json({ ok: true, url });
  });
}

// ── POST /api/photo/:guid  (canonical) ───────────────────────────────────
// Photo upload — no auth required (LPR devices post here)
// Content-Type: multipart/form-data  field name: photo
router.post('/photo/:guid', handlePhotoUpload);

// ── POST /api/photos/:guid (alias — kept for backwards compatibility) ─────
router.post('/photos/:guid', handlePhotoUpload);

module.exports = router;
