(() => {
  // ── DOM refs ──────────────────────────────────────────────────────────
  const socket      = io();
  const tbody       = document.getElementById('reads-body');
  const countEl     = document.getElementById('read-count');
  const searchMode  = document.getElementById('search-mode');
  const statusDot   = document.getElementById('status-dot');
  const statusLabel = document.getElementById('status-label');
  const pauseChk    = document.getElementById('chk-pause');

  const qPlate = document.getElementById('q-plate');
  const qState = document.getElementById('q-state');
  const qMake  = document.getElementById('q-make');
  const qModel = document.getElementById('q-model');
  const qColor = document.getElementById('q-color');

  // ── State ─────────────────────────────────────────────────────────────
  let allReads = [];
  let paused   = false;
  const readMap = new Map();

  let sortCol = 'timestamp';
  let sortDir = 'desc';

  const PAGE_SIZES = [10, 25, 50, 100, 250, 500];
  let pageSize    = 25;
  let currentPage = 1;

  const mkDefaultFrom = () => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const mkDefaultTo   = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  let dateFrom = mkDefaultFrom();
  let dateTo   = mkDefaultTo();

  // Location filter — empty Set means "all"
  let locFilter = new Set();

  // ── Session storage ───────────────────────────────────────────────────
  const SS_KEY = 'lpr_filters';

  function saveState() {
    try {
      sessionStorage.setItem(SS_KEY, JSON.stringify({
        plate:     qPlate.value,
        state:     qState.value,
        make:      qMake.value,
        model:     qModel.value,
        color:     qColor.value,
        dateFrom:  dateFrom ? dateFrom.getTime() : null,
        dateTo:    dateTo   ? dateTo.getTime()   : null,
        locations: [...locFilter],
      }));
    } catch {}
  }

  function loadState() {
    try {
      const s = JSON.parse(sessionStorage.getItem(SS_KEY) || 'null');
      if (!s) return;
      if (s.plate) qPlate.value = s.plate;
      if (s.state) qState.value = s.state;
      if (s.make)  qMake.value  = s.make;
      if (s.model) qModel.value = s.model;
      if (s.color) qColor.value = s.color;
      if (s.dateFrom) { dateFrom = new Date(s.dateFrom); fpFrom.setDate(dateFrom, true); }
      if (s.dateTo)   { dateTo   = new Date(s.dateTo);   fpTo.setDate(dateTo,   true); }
      if (Array.isArray(s.locations)) s.locations.forEach(c => locFilter.add(c));
    } catch {}
  }

  // ── Flatpickr date pickers ────────────────────────────────────────────
  const fpFrom = flatpickr('#q-date-from', {
    enableTime: true, time_24hr: false,
    dateFormat: 'M j Y, h:i K',
    defaultDate: dateFrom,
    onChange: dates => { dateFrom = dates[0] ?? null; saveState(); },
  });
  const fpTo = flatpickr('#q-date-to', {
    enableTime: true, time_24hr: false,
    dateFormat: 'M j Y, h:i K',
    defaultDate: dateTo,
    onChange: dates => { dateTo = dates[0] ?? null; saveState(); },
  });

  // Restore session state (after flatpickr is ready)
  loadState();

  // ── Sort helpers ──────────────────────────────────────────────────────
  const SORT_KEY = {
    timestamp:           r => new Date(r.timestamp).getTime(),
    license_plate:       r => r.license_plate,
    license_plate_state: r => r.license_plate_state,
    make:                r => r.make.toLowerCase(),
    model:               r => r.model.toLowerCase(),
    color:               r => r.color.toLowerCase(),
    location:            r => (r.location_code || r.location).toLowerCase(),
  };

  function applySortAndFilter() {
    const fn  = SORT_KEY[sortCol] ?? SORT_KEY.timestamp;
    const dir = sortDir === 'asc' ? 1 : -1;
    return allReads
      .filter(matchesFilters)
      .sort((a, b) => {
        const av = fn(a), bv = fn(b);
        if (av < bv) return -dir;
        if (av > bv) return  dir;
        return 0;
      });
  }

  function updateSortHeaders() {
    document.querySelectorAll('th.sortable').forEach(th => {
      th.classList.remove('sort-active', 'sort-asc', 'sort-desc');
      if (th.dataset.sort === sortCol)
        th.classList.add('sort-active', sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    });
  }

  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (sortCol === col) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortCol = col;
        sortDir = col === 'timestamp' ? 'desc' : 'asc';
      }
      currentPage = 1;
      refreshView();
    });
  });

  // ── Filters ───────────────────────────────────────────────────────────
  function matchesFilters(r) {
    const plate = qPlate.value.trim().toUpperCase();
    const state = qState.value.trim().toUpperCase();
    const make  = qMake.value.trim().toLowerCase();
    const model = qModel.value.trim().toLowerCase();
    const color = qColor.value.trim().toLowerCase();

    if (plate && !r.license_plate.includes(plate)) return false;
    if (state && r.license_plate_state !== state)  return false;
    if (make  && !r.make.toLowerCase().includes(make))   return false;
    if (model && !r.model.toLowerCase().includes(model)) return false;
    if (color && !r.color.toLowerCase().includes(color)) return false;

    const ts = new Date(r.timestamp).getTime();
    if (dateFrom && ts < dateFrom.getTime()) return false;
    if (dateTo   && ts > dateTo.getTime())   return false;

    if (locFilter.size > 0 && !locFilter.has(r.location_code || r.location)) return false;

    return true;
  }

  function hasActiveFilters() {
    return !!(qPlate.value.trim() || qState.value.trim() || qMake.value.trim() ||
              qModel.value.trim() || qColor.value.trim() || locFilter.size > 0);
  }

  // ── Pagination bars ───────────────────────────────────────────────────
  function buildPaginationHtml(total, totalPages) {
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

  function renderPaginationBars(total) {
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const html = buildPaginationHtml(total, totalPages);
    ['pagination-top', 'pagination-bottom'].forEach(id => {
      const bar = document.getElementById(id);
      bar.innerHTML = html;
      bar.querySelector('.pg-prev').addEventListener('click', () => {
        if (currentPage > 1) { currentPage--; refreshView(); }
      });
      bar.querySelector('.pg-next').addEventListener('click', () => {
        if (currentPage < totalPages) { currentPage++; refreshView(); }
      });
      bar.querySelector('.pg-size').addEventListener('change', e => {
        pageSize = parseInt(e.target.value);
        currentPage = 1;
        refreshView();
      });
    });
  }

  // ── Main refresh ──────────────────────────────────────────────────────
  function refreshView() {
    const list       = applySortAndFilter();
    const total      = list.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (currentPage > totalPages) currentPage = totalPages;

    const start = (currentPage - 1) * pageSize;
    renderAll(list.slice(start, start + pageSize));
    countEl.textContent = `${total.toLocaleString()} read${total !== 1 ? 's' : ''}`;
    searchMode.classList.toggle('hidden', !hasActiveFilters());
    renderPaginationBars(total);
    updateSortHeaders();
  }

  // ── Table rendering ───────────────────────────────────────────────────
  function renderAll(list) {
    tbody.innerHTML = '';
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">
        <strong>No reads yet</strong>
        <p>POST to /api/reads to ingest data</p>
      </div></td></tr>`;
      return;
    }
    const frag = document.createDocumentFragment();
    list.forEach(r => frag.appendChild(buildRow(r, false)));
    tbody.appendChild(frag);
  }

  function buildRow(r, flash) {
    const tr = document.createElement('tr');
    if (flash) tr.classList.add('new-row');
    tr.dataset.guid = r.guid;
    tr.addEventListener('click', () => { const read = readMap.get(tr.dataset.guid); if (read) openModal(read); });
    tr.innerHTML = `
      <td class="time-cell">${formatTime(r.timestamp)}</td>
      <td class="plate-cell">${esc(r.license_plate)}</td>
      <td><span class="state-badge">${esc(r.license_plate_state)}</span></td>
      <td>${esc(r.make)}</td>
      <td>${esc(r.model)}</td>
      <td>${esc(r.color)}</td>
      <td class="location-cell" title="${esc(r.location_code || r.location)}">${esc(r.location_code || r.location)}</td>`;
    return tr;
  }

  // ── Search / Clear ────────────────────────────────────────────────────
  document.getElementById('btn-search').addEventListener('click', () => {
    currentPage = 1;
    refreshView();
    saveState();
  });

  [qPlate, qState, qMake, qModel, qColor].forEach(el =>
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') { currentPage = 1; refreshView(); saveState(); }
    })
  );

  document.getElementById('btn-clear').addEventListener('click', () => {
    qPlate.value = ''; qState.value = '';
    qMake.value  = ''; qModel.value = ''; qColor.value = '';
    fpFrom.setDate(mkDefaultFrom(), true);
    fpTo.setDate(mkDefaultTo(), true);
    locFilter.clear();
    updateLocBtn();
    syncCheckboxes();
    currentPage = 1;
    refreshView();
    saveState();
  });

  // ── Pause live feed ───────────────────────────────────────────────────
  pauseChk.addEventListener('change', () => { paused = pauseChk.checked; });

  // ── Socket ────────────────────────────────────────────────────────────
  socket.on('connect',    () => { statusDot.className = 'dot connected';    statusLabel.textContent = 'Live'; });
  socket.on('disconnect', () => { statusDot.className = 'dot disconnected'; statusLabel.textContent = 'Disconnected'; });

  socket.on('new_read', read => {
    if (!readMap.has(read.guid)) {
      readMap.set(read.guid, read);
      allReads.unshift(read);
      if (allReads.length > 10000) readMap.delete(allReads.pop().guid);
      // Add to dropdown if it's a new location code
      if (read.location_code) addLocOption(read.location_code);
    }
    if (!paused) refreshView();
    else countEl.textContent = `${allReads.filter(matchesFilters).length.toLocaleString()} reads`;
  });

  // S3 upload completed — swap photo URL in readMap and in the open modal/lightbox
  socket.on('photo_updated', ({ guid, photo_url }) => {
    const read = readMap.get(guid);
    if (read) read.photo_url = photo_url;

    if (currentModalGuid === guid) {
      // Silently swap the img src — no spinner flash needed, image is already showing
      const updated = new Image();
      updated.onload = () => {
        modalPhoto.src = photo_url;
        // Also update lightbox if it's open on this image
        if (!lightbox.classList.contains('hidden')) lightboxImg.src = photo_url;
      };
      updated.src = photo_url;
    }
  });

  // ── Initial load ──────────────────────────────────────────────────────
  fetch('/api/reads?limit=500')
    .then(r => r.json())
    .then(data => {
      allReads = data;
      allReads.forEach(r => readMap.set(r.guid, r));
      buildLocDropdown();
      refreshView();
      // Auto-open modal if ?guid= is in URL (e.g. from BOLO notification email link)
      const guidParam = new URLSearchParams(location.search).get('guid');
      if (guidParam) {
        const read = readMap.get(guidParam);
        if (read) openModal(read);
      }
    });

  // ── Location dropdown ─────────────────────────────────────────────────
  let locCodes = []; // sorted list of unique codes from loaded data

  function buildLocDropdown() {
    const seen = new Set();
    allReads.forEach(r => { if (r.location_code) seen.add(r.location_code); });
    locCodes = [...seen].sort();

    const list = document.getElementById('loc-dd-list');
    list.innerHTML = '';
    locCodes.forEach(code => {
      const label = document.createElement('label');
      label.className = 'loc-dd-option';
      label.innerHTML = `<input type="checkbox" value="${esc(code)}"${locFilter.has(code) ? ' checked' : ''}> ${esc(code)}`;
      label.querySelector('input').addEventListener('change', onLocChange);
      list.appendChild(label);
    });
    updateLocBtn();
  }

  function addLocOption(code) {
    if (locCodes.includes(code)) return;
    locCodes.push(code);
    locCodes.sort();
    const list = document.getElementById('loc-dd-list');
    // Insert in sorted position
    const label = document.createElement('label');
    label.className = 'loc-dd-option';
    label.innerHTML = `<input type="checkbox" value="${esc(code)}"> ${esc(code)}`;
    label.querySelector('input').addEventListener('change', onLocChange);
    const idx = locCodes.indexOf(code);
    const existing = list.querySelectorAll('.loc-dd-option');
    if (idx >= existing.length) { list.appendChild(label); }
    else { list.insertBefore(label, existing[idx]); }
  }

  function onLocChange(e) {
    if (e.target.checked) locFilter.add(e.target.value);
    else locFilter.delete(e.target.value);
    updateLocBtn();
    currentPage = 1;
    refreshView();
    saveState();
  }

  function updateLocBtn() {
    const btn = document.getElementById('loc-dd-btn');
    if (locFilter.size === 0) {
      btn.textContent = 'All locations ▾';
    } else {
      btn.textContent = `${locFilter.size} location${locFilter.size !== 1 ? 's' : ''} ▾`;
    }
  }

  function syncCheckboxes() {
    document.querySelectorAll('#loc-dd-list input[type=checkbox]').forEach(cb => {
      cb.checked = locFilter.has(cb.value);
    });
  }

  // Open/close helpers
  function openLocDd() {
    document.getElementById('loc-dd-menu').classList.remove('hidden');
    document.getElementById('loc-dd-search').focus();
  }
  function closeLocDd() {
    document.getElementById('loc-dd-menu').classList.add('hidden');
    document.getElementById('loc-dd-search').value = '';
    applyLocSearch();
  }

  document.getElementById('loc-dd-btn').addEventListener('click', e => {
    e.stopPropagation();
    const menu = document.getElementById('loc-dd-menu');
    menu.classList.contains('hidden') ? openLocDd() : closeLocDd();
  });

  document.getElementById('loc-dd-close').addEventListener('click', e => {
    e.stopPropagation();
    closeLocDd();
  });

  // Select All / None
  // "All" = check every visible (filtered) option; if search is empty, check all
  document.getElementById('loc-select-all').addEventListener('click', e => {
    e.stopPropagation();
    document.querySelectorAll('#loc-dd-list .loc-dd-option:not(.hidden) input').forEach(cb => {
      cb.checked = true;
      locFilter.add(cb.value);
    });
    // If all codes are now selected, treat the same as "no filter"
    if (locFilter.size >= locCodes.length) locFilter.clear();
    syncCheckboxes();
    updateLocBtn();
    currentPage = 1;
    refreshView();
    saveState();
  });

  // "None" = uncheck all, clear filter → shows everything
  document.getElementById('loc-clear-all').addEventListener('click', e => {
    e.stopPropagation();
    locFilter.clear();
    syncCheckboxes();
    updateLocBtn();
    currentPage = 1;
    refreshView();
    saveState();
  });

  // Search within dropdown
  document.getElementById('loc-dd-search').addEventListener('input', e => {
    e.stopPropagation();
    applyLocSearch();
  });
  document.getElementById('loc-dd-search').addEventListener('click', e => e.stopPropagation());

  function applyLocSearch() {
    const q = document.getElementById('loc-dd-search').value.trim().toLowerCase();
    document.querySelectorAll('#loc-dd-list .loc-dd-option').forEach(label => {
      const code = label.querySelector('input').value.toLowerCase();
      label.classList.toggle('hidden', q.length > 0 && !code.includes(q));
    });
  }

  // Close on outside click or Escape
  document.addEventListener('click', e => {
    if (!document.getElementById('loc-dd').contains(e.target)) closeLocDd();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!document.getElementById('loc-dd-menu').classList.contains('hidden')) {
        closeLocDd();
        e.stopPropagation();
      }
    }
  });

  // ── Modal ─────────────────────────────────────────────────────────────
  const backdrop        = document.getElementById('modal-backdrop');
  const modalPhoto      = document.getElementById('modal-photo');
  const modalSpinner    = document.getElementById('modal-spinner');
  const modalPhotoError = document.getElementById('modal-photo-error');
  const modalFields     = document.getElementById('modal-fields');

  let currentModalGuid = null;

  function openModal(read) {
    currentModalGuid = read.guid;
    modalPhoto.style.display = 'none';
    modalSpinner.style.display = 'block';
    modalPhotoError.classList.add('hidden');
    const img = new Image();
    img.onload  = () => { modalSpinner.style.display = 'none'; modalPhoto.src = img.src; modalPhoto.style.display = 'block'; };
    img.onerror = () => { modalSpinner.style.display = 'none'; modalPhotoError.classList.remove('hidden'); };
    img.src = read.photo_url;
    modalFields.innerHTML =
      field('Plate',    esc(read.license_plate), 'plate') +
      field('State',    esc(read.license_plate_state)) +
      field('Make',     esc(read.make)) +
      field('Model',    esc(read.model)) +
      field('Color',    esc(read.color)) +
      field('Time',     esc(formatTime(read.timestamp))) +
      field('Received', esc(formatTime(read.received_at))) +
      field('Location', esc(read.location_code || read.location), 'full-width');
    backdrop.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    backdrop.classList.add('hidden');
    document.body.style.overflow = '';
    modalPhoto.src = '';
    currentModalGuid = null;
  }

  function field(label, value, extra = '') {
    return `<div class="modal-field ${extra}"><label>${label}</label><div class="val">${value || '—'}</div></div>`;
  }

  document.getElementById('modal-close').addEventListener('click', closeModal);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(); });

  // ── Lightbox ──────────────────────────────────────────────────────────
  const lightbox     = document.getElementById('lightbox');
  const lightboxImg  = document.getElementById('lightbox-img');

  function openLightbox(src) {
    lightboxImg.src = src;
    lightbox.classList.remove('hidden');
    // Don't change body overflow — detail modal already locked it
  }

  function closeLightbox() {
    lightbox.classList.add('hidden');
    lightboxImg.src = '';
  }

  // Click photo in detail modal → open lightbox
  modalPhoto.addEventListener('click', () => {
    if (modalPhoto.src) openLightbox(modalPhoto.src);
  });

  // Close lightbox: × button, click backdrop (outside image), or Escape
  document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', e => { if (e.target === lightbox) closeLightbox(); });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!lightbox.classList.contains('hidden')) { closeLightbox(); return; }
      closeModal();
    }
  });

  // ── Helpers ───────────────────────────────────────────────────────────
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch { return ts; }
  }
})();
