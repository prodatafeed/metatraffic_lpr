// Injected into all authenticated app pages.
// Fetches user info, renders the top nav, and handles logout.

// ── Session-expiry redirect ───────────────────────────────────────────────
// Intercept every fetch() on this page. Any 401 means the session has
// expired — show a brief toast and redirect to /login.
(function () {
  const _fetch = window.fetch.bind(window);
  let redirecting = false;

  window.fetch = async function (...args) {
    const res = await _fetch(...args);
    if (res.status === 401 && !redirecting) {
      // Don't trigger on the initial /api/auth/me call (handled below),
      // but do catch any mid-session 401 from API calls.
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
      if (!url.includes('/api/auth/me')) {
        redirecting = true;
        _showSessionToast();
        setTimeout(() => { location.href = '/login?reason=session'; }, 2000);
      }
    }
    return res;
  };

  function _showSessionToast() {
    const d = document.createElement('div');
    d.id = 'session-expired-toast';
    d.textContent = 'Your session has expired. Redirecting to login…';
    Object.assign(d.style, {
      position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
      background: '#b91c1c', color: '#fff', padding: '12px 24px',
      borderRadius: '8px', fontSize: '14px', fontWeight: '600',
      zIndex: '99999', boxShadow: '0 4px 16px rgba(0,0,0,.4)',
    });
    document.body.appendChild(d);
  }

  // Expose for the heartbeat below
  window._lprSessionRedirect = () => {
    if (redirecting) return;
    redirecting = true;
    _showSessionToast();
    setTimeout(() => { location.href = '/login?reason=session'; }, 2000);
  };
})();

// ── Nav bootstrap ─────────────────────────────────────────────────────────
(async () => {
  let user;
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) { location.href = '/login?reason=auth'; return; }
    user = await res.json();
  } catch { location.href = '/login?reason=auth'; return; }

  const page = location.pathname;

  const navItems = [
    { href: '/lpr',     label: 'Realtime LPR',    roles: ['admin','manager','basic'] },
    { href: '/users',   label: 'Manage Users',     roles: ['admin','manager'] },
    { href: '/bolo',    label: 'BOLO Management',  roles: ['admin','manager'] },
    { href: '/account', label: 'Account Settings', roles: ['admin','manager','basic'] },
  ]
  .filter(item => item.roles.includes(user.role))
  .map(item => `
    <a href="${item.href}" class="nav-link${page === item.href ? ' active' : ''}">${item.label}</a>
  `).join('');

  const header = document.getElementById('app-header');
  if (!header) return;

  header.innerHTML = `
    <div class="nav-brand">MetaTraffic LPR</div>
    <nav class="nav-links">${navItems}</nav>
    <div class="nav-user">
      <span class="nav-username">${esc(user.firstName)} ${esc(user.lastName)}</span>
      <span class="nav-role role-${user.role}">${user.role}</span>
      <button class="nav-logout" id="btn-logout">Logout</button>
    </div>`;

  document.getElementById('btn-logout').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    location.href = '/login';
  });

  // ── Heartbeat: ping /api/auth/me every 60 s ─────────────────────────────
  // Catches the case where the session expires while the page is idle
  // (no API calls being made) — e.g. the user walks away.
  setInterval(async () => {
    try {
      const r = await fetch('/api/auth/me');
      if (r.status === 401) window._lprSessionRedirect?.();
    } catch { /* network blip — don't redirect on transient errors */ }
  }, 60_000);

  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
})();
