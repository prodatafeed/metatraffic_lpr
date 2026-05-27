const pool      = require('./db');
const sendSMS   = require('./sms');
const sendEmail = require('./email');

const BASE_URL = () => (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

// ── Match a single BOLO entry against a read ─────────────────────────────
function checkMatch(bolo, read) {
  // Plate/State match — either field can be set; all set fields must match
  const hasPlate = bolo.plate || bolo.state;
  if (hasPlate) {
    let ok = true;
    if (bolo.plate && bolo.plate.toUpperCase() !== (read.license_plate || '').toUpperCase()) ok = false;
    if (bolo.state && bolo.state.toUpperCase() !== (read.license_plate_state || '').toUpperCase()) ok = false;
    if (ok) return 'plate_state';
  }

  // Make/Model/Color match — all set fields must match (case-insensitive contains)
  const hasMMC = bolo.make || bolo.model || bolo.color;
  if (hasMMC) {
    let ok = true;
    if (bolo.make  && !(read.make  || '').toLowerCase().includes(bolo.make.toLowerCase()))  ok = false;
    if (bolo.model && !(read.model || '').toLowerCase().includes(bolo.model.toLowerCase())) ok = false;
    if (bolo.color && !(read.color || '').toLowerCase().includes(bolo.color.toLowerCase())) ok = false;
    if (ok) return 'make_model_color';
  }

  return null;
}

// ── Build notification message ────────────────────────────────────────────
function buildMessage(matchType, read) {
  const loc = read.location_code || read.location || 'Unknown';
  if (matchType === 'plate_state') {
    return `${loc} matched ${read.license_plate} ${read.license_plate_state}`;
  }
  return `${loc} matched ${read.make} ${read.model} ${read.color}`;
}

function buildEmailHtml(matchType, read, link) {
  const msg  = buildMessage(matchType, read);
  const loc  = read.location_code || read.location || '—';
  const time = new Date(read.timestamp || read.received_at).toLocaleString();
  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f1f5f9;margin:0;padding:24px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.08);overflow:hidden">
    <div style="background:#2563eb;padding:20px 28px">
      <div style="color:#fff;font-size:18px;font-weight:700">MetaTraffic LPR</div>
      <div style="color:#bfdbfe;font-size:12px;margin-top:2px">BOLO Alert Notification</div>
    </div>
    <div style="padding:24px 28px">
      <div style="font-size:20px;font-weight:700;color:#dc2626;margin-bottom:16px">⚠ BOLO Match Detected</div>
      <div style="font-size:15px;font-weight:600;color:#1e293b;margin-bottom:20px">${msg}</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;color:#334155">
        <tr><td style="padding:6px 0;color:#64748b;width:120px">Location</td><td style="font-weight:600">${loc}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Plate</td><td style="font-weight:600">${read.license_plate} (${read.license_plate_state})</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Vehicle</td><td>${read.color} ${read.make} ${read.model}</td></tr>
        <tr><td style="padding:6px 0;color:#64748b">Time</td><td>${time}</td></tr>
      </table>
      <div style="margin-top:24px">
        <a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:13px;font-weight:600">View Record →</a>
      </div>
    </div>
    <div style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8">
      MetaTraffic LPR System — automated BOLO alert. Do not reply to this email.
    </div>
  </div>
</body>
</html>`;
}

// ── Find users who should be notified for a given location ────────────────
async function findUsersToNotify(locationId) {
  const [rows] = await pool.query(`
    SELECT DISTINCT u.id, u.email, u.phone, u.notify_sms, u.notify_email, u.role
    FROM users u
    WHERE u.deleted_at IS NULL
      AND u.notify_enabled = 1
      AND (
        u.role = 'admin'
        OR EXISTS (
          SELECT 1 FROM mapping_user_location mul
          WHERE mul.user_id = u.id AND mul.location_id = ? AND mul.deleted_at IS NULL
        )
      )
  `, [locationId]);
  return rows;
}

// ── Main BOLO check called after each ingest ──────────────────────────────
async function checkAndNotify(read) {
  try {
    if (!read.location_id) return; // no resolved location, skip

    const [bolos] = await pool.query(`
      SELECT b.*, u.role AS uploader_role
      FROM bolo b
      JOIN users u ON u.id = b.uploaded_by
      WHERE b.deleted_at IS NULL
    `);
    if (!bolos.length) return;

    const usersToNotify = await findUsersToNotify(read.location_id);
    if (!usersToNotify.length) return;

    const now  = Math.floor(Date.now() / 1000);
    const link = `${BASE_URL()}/lpr?guid=${encodeURIComponent(read.guid)}`;

    for (const bolo of bolos) {
      // Manager-scoped: only match if read's location is in the uploader's mapped locations
      if (bolo.uploader_role === 'manager') {
        const [managerLocs] = await pool.query(
          'SELECT location_id FROM mapping_user_location WHERE user_id=? AND deleted_at IS NULL',
          [bolo.uploaded_by]
        );
        const managerLocIds = new Set(managerLocs.map(r => Number(r.location_id)));
        if (!managerLocIds.has(Number(read.location_id))) continue;
      }

      const matchType = checkMatch(bolo, read);
      if (!matchType) continue;

      const msg = buildMessage(matchType, read);
      console.log(`[BOLO] Match: ${msg}`);

      for (const user of usersToNotify) {
        const loc  = read.location_code || read.location || '';
        const auditBase = [
          read.guid, loc, read.license_plate, read.license_plate_state,
          read.make, read.model, read.color, bolo.id, matchType, user.id,
        ];

        // SMS
        if (user.notify_sms && user.phone) {
          let status = 'sent', errMsg = null;
          try {
            await sendSMS(user.phone, `MetaTraffic BOLO Alert\n${msg}\n${link}`);
          } catch (e) { status = 'failed'; errMsg = e.message?.slice(0, 512); }
          await pool.query(
            `INSERT INTO notification_audit
               (read_guid,location_code,license_plate,license_plate_state,make,model,color,bolo_id,match_type,notified_user_id,channel,status,error_message,sent_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [...auditBase, 'sms', status, errMsg, now]
          );
        }

        // Email
        if (user.notify_email && user.email) {
          let status = 'sent', errMsg = null;
          try {
            await sendEmail({
              to: user.email,
              subject: `MetaTraffic BOLO Alert — ${msg}`,
              html: buildEmailHtml(matchType, read, link),
            });
          } catch (e) { status = 'failed'; errMsg = e.message?.slice(0, 512); }
          await pool.query(
            `INSERT INTO notification_audit
               (read_guid,location_code,license_plate,license_plate_state,make,model,color,bolo_id,match_type,notified_user_id,channel,status,error_message,sent_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [...auditBase, 'email', status, errMsg, now]
          );
        }
      }
    }
  } catch (e) {
    console.error('[BOLO checkAndNotify]', e.message);
  }
}

module.exports = { checkAndNotify };
