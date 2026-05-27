const pool = require('./db');

module.exports = async function auditLog({ userId = null, email, eventType, req = null, details = null }) {
  const now = Math.floor(Date.now() / 1000);
  const ip  = req ? (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null) : null;
  const ua  = req ? (req.headers['user-agent'] || null) : null;
  try {
    await pool.query(
      `INSERT INTO authentication_audit_log
         (user_id, email, event_type, ip_address, user_agent, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, email, eventType, ip, ua, details ? JSON.stringify(details) : null, now]
    );
  } catch (e) {
    console.error('[audit] write failed:', e.message);
  }
};
