// Injected into all authenticated app pages.
// Fetches user info, renders the top nav, and handles logout.
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

  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
})();
