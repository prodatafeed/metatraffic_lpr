const alertEl = document.getElementById('alert');
let boloEntries = [];
let pendingBatchId  = null;
let pendingBatchCnt = 0;

// ── Pagination state ──────────────────────────────────────────────────────
const PAGE_SIZES = [10, 25, 50, 100, 250, 500];

let boloPageSize    = 25;
let boloCurrentPage = 1;

let auditPageSize    = 25;
let auditCurrentPage = 1;
let auditRows        = [];
let auditTotal       = 0;
let auditLoaded      = false;
const AUDIT_FETCH_LIMIT = 500; // fetch a large block, paginate client-side

// ── Alert ─────────────────────────────────────────────────────────────────
function showAlert(msg, type = 'error') {
  alertEl.textContent = msg;
  alertEl.className   = `alert ${type}`;
  alertEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  setTimeout(() => { alertEl.className = 'alert'; }, 6000);
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function formatDate(unix) {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ── Pagination bar builder ────────────────────────────────────────────────
function buildPaginationHtml(total, currentPage, pageSize) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const sizeOpts = PAGE_SIZES.map(n =>
    `<option value="${n}"${n === pageSize ? ' selected' : ''}>${n}</option>`
  ).join('');
  const from = total === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const to   = Math.min(currentPage * pageSize, total);
  const info = total === 0
    ? 'No records'
    : `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`;
  return `
    <div class="pg-left">
      Show <select class="pg-size">${sizeOpts}</select> per page
    </div>
    <div class="pg-center">${info} &nbsp;·&nbsp; Page ${currentPage} of ${totalPages}</div>
    <div class="pg-right">
      <button class="pg-btn pg-prev"${currentPage <= 1 ? ' disabled' : ''}>&#8249; Prev</button>
      <button class="pg-btn pg-next"${currentPage >= totalPages ? ' disabled' : ''}>Next &#8250;</button>
    </div>`;
}

function wirePaginationBars(topId, bottomId, getPage, setPage, getSize, setSize, onRefresh) {
  const totalPages = () => Math.max(1, Math.ceil(
    (topId.startsWith('bolo') ? boloEntries.length : auditTotal) / getSize()
  ));
  [topId, bottomId].forEach(id => {
    const bar = document.getElementById(id);
    if (!bar) return;
    bar.querySelector('.pg-prev')?.addEventListener('click', () => {
      if (getPage() > 1) { setPage(getPage() - 1); onRefresh(); }
    });
    bar.querySelector('.pg-next')?.addEventListener('click', () => {
      if (getPage() < totalPages()) { setPage(getPage() + 1); onRefresh(); }
    });
    bar.querySelector('.pg-size')?.addEventListener('change', e => {
      setSize(parseInt(e.target.value));
      setPage(1);
      onRefresh();
    });
  });
}

// ── Tabs ──────────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById('panel-active').style.display = tab === 'active' ? '' : 'none';
  document.getElementById('panel-audit').style.display  = tab === 'audit'  ? '' : 'none';
  document.getElementById('tab-active').classList.toggle('active', tab === 'active');
  document.getElementById('tab-audit').classList.toggle('active',  tab === 'audit');
  if (tab === 'audit' && !auditLoaded) loadAudit();
}

// ── Upload CSV ────────────────────────────────────────────────────────────
async function uploadCSV() {
  const fileEl   = document.getElementById('csv-file');
  const statusEl = document.getElementById('upload-status');
  const file = fileEl.files[0];
  if (!file) { showAlert('Please choose a CSV file first.'); return; }

  const fd = new FormData();
  fd.append('csv', file);
  statusEl.textContent = 'Uploading…';

  const res  = await fetch('/api/bolo/upload', { method: 'POST', body: fd });
  const data = await res.json();

  if (!res.ok) {
    statusEl.textContent = '';
    showAlert(data.error + (data.errors?.length ? ': ' + data.errors.join(', ') : ''));
    return;
  }

  fileEl.value = '';
  statusEl.textContent = `✓ Inserted ${data.inserted} entries (batch ${data.batch_id.slice(0,8)}…)`;
  if (data.warnings?.length) showAlert(`Uploaded with warnings: ${data.warnings.join('; ')}`, 'success');
  else showAlert(`Successfully uploaded ${data.inserted} BOLO entries.`, 'success');

  document.getElementById('upload-panel').classList.add('hidden');
  loadBolo();
}

// ── Load & render active BOLO entries ────────────────────────────────────
async function loadBolo() {
  const tbody = document.getElementById('bolo-body');
  const res   = await fetch('/api/bolo');
  if (!res.ok) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--danger)">Failed to load</td></tr>`;
    renderBoloPagination();
    return;
  }
  boloEntries = await res.json();
  boloCurrentPage = 1;
  renderBolo();
}

function renderBolo() {
  const tbody      = document.getElementById('bolo-body');
  const total      = boloEntries.length;
  const totalPages = Math.max(1, Math.ceil(total / boloPageSize));
  if (boloCurrentPage > totalPages) boloCurrentPage = totalPages;

  const start = (boloCurrentPage - 1) * boloPageSize;
  const page  = boloEntries.slice(start, start + boloPageSize);

  if (!total) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:40px;color:var(--muted)">No active BOLO entries</td></tr>`;
    renderBoloPagination();
    return;
  }

  // Batch counts (across all entries, not just this page)
  const batchCount = {};
  boloEntries.forEach(e => { batchCount[e.batch_id] = (batchCount[e.batch_id] || 0) + 1; });

  tbody.innerHTML = page.map(e => `
    <tr>
      <td>${esc(e.state) || '<span style="color:var(--muted)">—</span>'}</td>
      <td>${esc(e.plate) || '<span style="color:var(--muted)">—</span>'}</td>
      <td>${esc(e.make)  || '<span style="color:var(--muted)">—</span>'}</td>
      <td>${esc(e.model) || '<span style="color:var(--muted)">—</span>'}</td>
      <td>${esc(e.color) || '<span style="color:var(--muted)">—</span>'}</td>
      <td style="font-size:11px;color:var(--muted)" title="${esc(e.batch_id)}">${esc(e.batch_id.slice(0,8))}…</td>
      <td style="font-size:12px">${esc(e.first_name)} ${esc(e.last_name)}<br><span style="color:var(--muted);font-size:11px">${esc(e.email)}</span></td>
      <td class="time-cell">${formatDate(e.created_at)}</td>
      <td>
        <button class="btn-sm danger" onclick="deleteSingle(${e.id})">Remove</button>
        <button class="btn-sm" onclick="openDeleteBatch('${esc(e.batch_id)}', ${batchCount[e.batch_id]})">Delete Batch</button>
      </td>
    </tr>`).join('');

  renderBoloPagination();
}

function renderBoloPagination() {
  const total = boloEntries.length;
  const html  = buildPaginationHtml(total, boloCurrentPage, boloPageSize);
  ['bolo-pagination-top', 'bolo-pagination-bottom'].forEach(id => {
    const bar = document.getElementById(id);
    bar.innerHTML = html;
    bar.querySelector('.pg-prev')?.addEventListener('click', () => {
      if (boloCurrentPage > 1) { boloCurrentPage--; renderBolo(); }
    });
    bar.querySelector('.pg-next')?.addEventListener('click', () => {
      const totalPages = Math.ceil(total / boloPageSize);
      if (boloCurrentPage < totalPages) { boloCurrentPage++; renderBolo(); }
    });
    bar.querySelector('.pg-size')?.addEventListener('change', e => {
      boloPageSize = parseInt(e.target.value);
      boloCurrentPage = 1;
      renderBolo();
    });
  });
}

// ── Delete single entry ───────────────────────────────────────────────────
async function deleteSingle(id) {
  if (!confirm('Remove this BOLO entry?')) return;
  const res  = await fetch(`/api/bolo/${id}`, { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) return showAlert(data.error);
  showAlert('Entry removed.', 'success');
  loadBolo();
}

// ── Delete batch ─────────────────────────────────────────────────────────
function openDeleteBatch(batchId, count) {
  pendingBatchId  = batchId;
  pendingBatchCnt = count;
  document.getElementById('del-count').textContent = count;
  document.getElementById('del-backdrop').classList.remove('hidden');
}

async function confirmDeleteBatch() {
  document.getElementById('del-backdrop').classList.add('hidden');
  const res  = await fetch(`/api/bolo/batch/${pendingBatchId}`, { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) return showAlert(data.error);
  showAlert(`Deleted ${data.deleted} entries from batch.`, 'success');
  loadBolo();
}

document.getElementById('del-backdrop').addEventListener('click', e => {
  if (e.target === document.getElementById('del-backdrop'))
    document.getElementById('del-backdrop').classList.add('hidden');
});

// ── Audit log ─────────────────────────────────────────────────────────────
async function loadAudit() {
  auditLoaded = true;
  const tbody = document.getElementById('audit-body');
  tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:24px;color:var(--muted)">Loading…</td></tr>`;

  const res = await fetch(`/api/bolo/audit?limit=${AUDIT_FETCH_LIMIT}&offset=0`);
  if (!res.ok) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--danger)">Failed to load audit log</td></tr>`;
    return;
  }
  auditRows = await res.json();
  auditTotal = auditRows.length;
  auditCurrentPage = 1;
  renderAudit();
}

function renderAudit() {
  const tbody      = document.getElementById('audit-body');
  const totalPages = Math.max(1, Math.ceil(auditTotal / auditPageSize));
  if (auditCurrentPage > totalPages) auditCurrentPage = totalPages;

  const start = (auditCurrentPage - 1) * auditPageSize;
  const page  = auditRows.slice(start, start + auditPageSize);

  if (!auditTotal) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:40px;color:var(--muted)">No audit records found</td></tr>`;
    renderAuditPagination();
    return;
  }

  tbody.innerHTML = page.map(r => {
    const sentAt = r.sent_at ? new Date(r.sent_at * 1000).toLocaleString(undefined, {
      month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit',
    }) : '—';
    const statusStyle = r.status === 'sent' ? 'color:var(--success,#16a34a)' : 'color:var(--danger)';
    const matchBadge  = r.match_type === 'plate_state'
      ? '<span style="font-size:10px;background:#dbeafe;color:#1d4ed8;padding:2px 5px;border-radius:3px">Plate/State</span>'
      : '<span style="font-size:10px;background:#dcfce7;color:#15803d;padding:2px 5px;border-radius:3px">Vehicle</span>';
    return `
    <tr>
      <td class="time-cell">${esc(sentAt)}</td>
      <td>${esc(r.location_code) || '—'}</td>
      <td>${esc(r.license_plate) || '—'}</td>
      <td>${esc(r.license_plate_state) || '—'}</td>
      <td>${esc(r.make)  || '—'}</td>
      <td>${esc(r.model) || '—'}</td>
      <td>${esc(r.color) || '—'}</td>
      <td>${matchBadge}</td>
      <td style="font-size:12px">${esc(r.first_name)} ${esc(r.last_name)}<br><span style="color:var(--muted);font-size:11px">${esc(r.notified_email)}</span></td>
      <td style="text-transform:uppercase;font-size:11px">${esc(r.channel)}</td>
      <td style="${statusStyle};font-weight:600;font-size:12px">${esc(r.status)}</td>
    </tr>`;
  }).join('');

  renderAuditPagination();
}

function renderAuditPagination() {
  const html = buildPaginationHtml(auditTotal, auditCurrentPage, auditPageSize);
  ['audit-pagination-top', 'audit-pagination-bottom'].forEach(id => {
    const bar = document.getElementById(id);
    bar.innerHTML = html;
    bar.querySelector('.pg-prev')?.addEventListener('click', () => {
      if (auditCurrentPage > 1) { auditCurrentPage--; renderAudit(); }
    });
    bar.querySelector('.pg-next')?.addEventListener('click', () => {
      const totalPages = Math.ceil(auditTotal / auditPageSize);
      if (auditCurrentPage < totalPages) { auditCurrentPage++; renderAudit(); }
    });
    bar.querySelector('.pg-size')?.addEventListener('change', e => {
      auditPageSize = parseInt(e.target.value);
      auditCurrentPage = 1;
      renderAudit();
    });
  });
}

// ── Init ─────────────────────────────────────────────────────────────────
loadBolo();
