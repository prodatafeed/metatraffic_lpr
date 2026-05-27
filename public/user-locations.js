const userId    = parseInt(location.pathname.split('/')[2]);
const alertEl   = document.getElementById('alert');
const mappedBody = document.getElementById('mapped-body');
let searchTimer = null;
let mapped = [];

function showAlert(msg, type = 'error') {
  alertEl.textContent = msg;
  alertEl.className   = `alert ${type}`;
  setTimeout(() => { alertEl.className = 'alert'; alertEl.textContent = ''; }, 5000);
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function loadUserInfo() {
  const res = await fetch(`/api/locations/user-info/${userId}`);
  if (!res.ok) return;
  const u = await res.json();
  document.getElementById('card-name').textContent  = `${u.first_name} ${u.last_name}`;
  document.getElementById('card-email').textContent = u.email;
  const roleBadge = document.getElementById('card-role');
  roleBadge.textContent = u.role;
  roleBadge.className   = `role-badge role-${u.role}`;
  document.getElementById('user-card').style.display = '';
}

async function loadMapped() {
  const res = await fetch(`/api/locations/user/${userId}`);
  if (!res.ok) { mappedBody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--muted)">Failed to load</td></tr>`; return; }
  mapped = await res.json();
  renderMapped();
}

function renderMapped() {
  if (!mapped.length) {
    mappedBody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--muted)">No locations assigned</td></tr>`;
    return;
  }
  mappedBody.innerHTML = mapped.map(m => `
    <tr>
      <td style="font-weight:600">${esc(m.location_code)}</td>
      <td>${esc(m.address1)}${m.address2 ? ' ' + esc(m.address2) : ''}</td>
      <td>${esc(m.city)}</td>
      <td>${esc(m.state)}</td>
      <td>${esc(m.zip)}</td>
      <td><button class="btn-sm danger" onclick="removeLocation(${m.mapping_id})">Remove</button></td>
    </tr>`).join('');
}

async function removeLocation(mappingId) {
  const res  = await fetch(`/api/locations/user/${userId}/${mappingId}`, { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) return showAlert(data.error);
  mapped = mapped.filter(m => m.mapping_id !== mappingId);
  renderMapped();
  showAlert('Location removed.', 'success');
}

async function addLocation(locationId, label) {
  const res  = await fetch(`/api/locations/user/${userId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location_id: locationId }),
  });
  const data = await res.json();
  hideSuggestions();
  document.getElementById('loc-search').value = '';
  if (!res.ok) return showAlert(data.error);
  showAlert(`${label} added.`, 'success');
  loadMapped();
}

function hideSuggestions() {
  document.getElementById('suggestions').style.display = 'none';
}

function onSearchInput() {
  clearTimeout(searchTimer);
  const q = document.getElementById('loc-search').value.trim();
  searchTimer = setTimeout(() => fetchSuggestions(q), 200);
}

async function fetchSuggestions(q) {
  const url = `/api/locations?search=${encodeURIComponent(q)}&limit=10`;
  const res  = await fetch(url);
  if (!res.ok) return;
  const locs = await res.json();
  renderSuggestions(locs);
}

function renderSuggestions(locs) {
  const box = document.getElementById('suggestions');
  if (!locs.length) { box.style.display = 'none'; return; }

  const mappedIds = new Set(mapped.map(m => m.id));
  const available = locs.filter(l => !mappedIds.has(l.id));

  if (!available.length) { box.style.display = 'none'; return; }

  box.innerHTML = available.map(l => {
    const label = `${esc(l.location_code)} — ${esc(l.address1)}, ${esc(l.city)}, ${esc(l.state)}`;
    return `<div class="suggestion-item" onmousedown="addLocation(${l.id}, '${esc(l.location_code)}')">${label}</div>`;
  }).join('');
  box.style.display = '';
}

document.addEventListener('click', e => {
  if (!document.getElementById('loc-search').contains(e.target)) hideSuggestions();
});

loadUserInfo();
loadMapped();
