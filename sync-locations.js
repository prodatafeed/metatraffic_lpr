require('dotenv').config();
const https = require('https');
const pool  = require('./lib/db');

const API_URL = 'https://court.metatraffic.net/locationmap/db5292454efd834674de8b75e031bf28';

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function run() {
  console.log('Fetching location map from API…');
  const json = await fetchJSON(API_URL);

  if (json.status !== 'SUCCESS') {
    console.error('API returned status:', json.status);
    process.exit(1);
  }

  const now = Math.floor(Date.now() / 1000);
  const courts = json.data;

  let courtCount = 0;
  let locCount   = 0;

  for (const key of Object.keys(courts)) {
    const c = courts[key];
    const courtId   = parseInt(c.court_id);
    const courtName = (c.court_name || '').trim().slice(0, 64);

    // Upsert court
    await pool.query(
      `INSERT INTO court (id, court_name, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE court_name=VALUES(court_name), updated_at=VALUES(updated_at)`,
      [courtId, courtName, now, now]
    );
    courtCount++;

    // Upsert locations
    for (const loc of (c.locations || [])) {
      const code   = (loc.location_code  || '').trim().slice(0, 16);
      const addr1  = (loc.cross_address  || '').trim().slice(0, 64);
      const addr2  = (loc.address        || '').trim().slice(0, 64) || null;
      const city   = (loc.city           || '').trim().slice(0, 64);
      const state  = (loc.state          || '').trim().toUpperCase().slice(0, 2);
      const zip    = (loc.zip            || '').trim().slice(0, 6);
      const school = loc.is_school_zone === 'Y' ? 'Y' : 'N';

      if (!code) continue;

      await pool.query(
        `INSERT INTO locations (location_code, address1, address2, city, state, zip, court_id, is_school_zone, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           address1=VALUES(address1), address2=VALUES(address2),
           city=VALUES(city), state=VALUES(state), zip=VALUES(zip),
           court_id=VALUES(court_id), is_school_zone=VALUES(is_school_zone),
           updated_at=VALUES(updated_at)`,
        [code, addr1, addr2, city, state, zip, courtId, school, now, now]
      );
      locCount++;
    }
  }

  console.log(`Synced ${courtCount} courts, ${locCount} locations`);
}

module.exports = { run };

if (require.main === module) {
  run().then(() => pool.end()).catch(e => { console.error(e); process.exit(1); });
}
