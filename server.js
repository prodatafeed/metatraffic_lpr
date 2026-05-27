require('dotenv').config();

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const crypto   = require('crypto');
const bcrypt   = require('bcrypt');
const session  = require('express-session');
const MySQLStore = require('express-mysql-session')(session);

const pool     = require('./lib/db');
const audit    = require('./lib/audit');
const apiRouter       = require('./routes/api');
const authRouter      = require('./routes/auth');
const usersRouter     = require('./routes/users');
const accountRouter   = require('./routes/account');
const locationsRouter = require('./routes/locations');
const boloRouter      = require('./routes/bolo');
const pagesRouter     = require('./routes/pages');
const { run: syncLocations } = require('./sync-locations');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 3000;

// ── Session ──────────────────────────────────────────────────────────────
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('[warn] SESSION_SECRET not set — sessions reset on restart');

const sessionStore = new MySQLStore({
  createDatabaseTable: true,
  clearExpired: true,
  checkExpirationInterval: 15 * 60 * 1000,
  expiration: 24 * 60 * 60 * 1000,
}, pool);

const sessionMiddleware = session({
  key:    'lpr_session',
  secret: sessionSecret,
  store:  sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict' }, // no maxAge = expires on browser close
});

// ── Middleware ───────────────────────────────────────────────────────────
app.use(express.json());
app.use(sessionMiddleware);

// Share session with socket.io
io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  if (socket.request.session?.userId) return next();
  next(new Error('Unauthorized'));
});

// ── Routes (before static — so / is handled by pages router) ────────────
app.use('/', pagesRouter);
app.use('/api/auth',    authRouter);
app.use('/api',         apiRouter);  // POST /api/reads is open (LPR devices)
app.use('/api/users',     usersRouter);
app.use('/api/account',   accountRouter);
app.use('/api/locations', locationsRouter);
app.use('/api/bolo',      boloRouter);

// ── Admin: sync courts + locations from external API ─────────────────────
const { requireRole } = require('./middleware/auth');
app.post('/api/admin/sync-locations', requireRole('admin'), async (req, res) => {
  try {
    await syncLocations();
    res.json({ ok: true });
  } catch (e) {
    console.error('[sync-locations]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Static assets ────────────────────────────────────────────────────────
app.use('/photos', express.static(path.join(__dirname, 'photos')));
app.use(express.static(path.join(__dirname, 'public')));

// ── Socket.IO ────────────────────────────────────────────────────────────
apiRouter.setIO(io);

// ── Startup ──────────────────────────────────────────────────────────────
async function start() {
  await apiRouter.loadReads();
  await ensureDefaultAdmin();
  server.listen(PORT, () => console.log(`LPR server running on http://localhost:${PORT}`));
}

async function ensureDefaultAdmin() {
  const [rows] = await pool.query('SELECT COUNT(*) AS cnt FROM users WHERE deleted_at IS NULL');
  if (rows[0].cnt > 0) return;
  const now  = Math.floor(Date.now() / 1000);
  const hash = await bcrypt.hash('Meta2026$', 12);
  await pool.query(
    'INSERT INTO users (email, password_hash, first_name, last_name, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['jasonk@metatraffic.net', hash, 'Jason', 'K', 'admin', now, now]
  );
  console.log('Default admin created: jasonk@metatraffic.net / Meta2026$');
}

start().catch(e => { console.error('Startup failed:', e); process.exit(1); });
