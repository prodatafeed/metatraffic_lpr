const alertEl  = document.getElementById('alert');
const tbody    = document.getElementById('users-body');
const backdrop = document.getElementById('modal-backdrop');
let users         = [];
let deleteId      = null;
let currentUserId = null;

function showAlert(msg, type = 'error') {
  alertEl.textContent = msg;
  alertEl.className   = `alert ${type}`;
  setTimeout(() => { alertEl.className = 'alert'; }, 5000);
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function formatDate(unix) {
  if (!unix) return '—';
  return new Date(unix * 1000).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
}

async function loadUsers() {
  if (!currentUserId) {
    const me = await fetch('/api/auth/me');
    if (me.ok) currentUserId = (await me.json()).id;
  }
  const res = await fetch('/api/users');
  if (!res.ok) return showAlert('Failed to load users');
  users = await res.json();
  renderUsers();
}

function renderUsers() {
  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--muted)">No users found</td></tr>`;
    return;
  }
  const methods = { none:'—', totp:'Authenticator', sms:'SMS' };
  tbody.innerHTML = users.map(u => `
    <tr>
      <td>${esc(u.first_name)} ${esc(u.last_name)}</td>
      <td>${esc(u.email)}</td>
      <td><span class="role-badge role-${u.role}">${u.role}</span></td>
      <td style="color:var(--muted);font-size:12px">${methods[u.two_fa_method] || u.two_fa_method}</td>
      <td class="time-cell">${formatDate(u.created_at)}</td>
      <td class="time-cell">${formatDate(u.last_login_at)}</td>
      <td>
        <button class="btn-sm" onclick="openEditModal(${u.id})">Edit</button>
        ${u.role !== 'admin' ? `<a class="btn-sm" href="/users/${u.id}/locations">Locations</a>` : ''}
        ${u.id !== currentUserId ? `<button class="btn-sm danger" onclick="openDeleteModal(${u.id}, '${esc(u.first_name)} ${esc(u.last_name)}')">Delete</button>` : ''}
        <button class="btn-sm" onclick="resetPassword(${u.id})">Reset PW</button>
      </td>
    </tr>`).join('');
}

function setNotifyUI(enabled) {
  document.getElementById('modal-notify-enabled').checked = enabled;
  document.getElementById('modal-notify-channels').style.display = enabled ? '' : 'none';
}

document.getElementById('modal-notify-enabled').addEventListener('change', function() {
  document.getElementById('modal-notify-channels').style.display = this.checked ? '' : 'none';
});

function openCreateModal() {
  document.getElementById('modal-title').textContent = 'New User';
  document.getElementById('modal-user-id').value     = '';
  document.getElementById('modal-first-name').value  = '';
  document.getElementById('modal-last-name').value   = '';
  document.getElementById('modal-email').value       = '';
  document.getElementById('modal-role').value        = 'basic';
  document.getElementById('modal-phone').value       = '';
  document.getElementById('modal-password').value    = '';
  document.getElementById('modal-reset-2fa').checked = false;
  document.getElementById('email-field').style.display    = '';
  document.getElementById('password-field').style.display = '';
  document.getElementById('reset-2fa-field').style.display = 'none';
  setNotifyUI(false);
  document.getElementById('modal-notify-sms').checked   = false;
  document.getElementById('modal-notify-email').checked = false;
  backdrop.classList.remove('hidden');
}

function openEditModal(id) {
  const u = users.find(u => u.id === id);
  if (!u) return;
  document.getElementById('modal-title').textContent = 'Edit User';
  document.getElementById('modal-user-id').value     = id;
  document.getElementById('modal-first-name').value  = u.first_name;
  document.getElementById('modal-last-name').value   = u.last_name;
  document.getElementById('modal-email').value       = u.email;
  document.getElementById('modal-role').value        = u.role;
  document.getElementById('modal-phone').value       = u.phone || '';
  document.getElementById('modal-password').value    = '';
  document.getElementById('modal-reset-2fa').checked = false;
  document.getElementById('email-field').style.display    = '';
  document.getElementById('password-field').style.display = 'none';
  document.getElementById('reset-2fa-field').style.display = u.two_fa_method !== 'none' ? '' : 'none';
  setNotifyUI(!!u.notify_enabled);
  document.getElementById('modal-notify-sms').checked   = !!u.notify_sms;
  document.getElementById('modal-notify-email').checked = !!u.notify_email;
  backdrop.classList.remove('hidden');
}

function closeModal() {
  backdrop.classList.add('hidden');
  document.getElementById('modal-alert').className = 'alert';
}

function showModalAlert(msg) {
  const el = document.getElementById('modal-alert');
  el.textContent = msg;
  el.className = 'alert error';
}

function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v); }
function validPhone(v) { return /^\+[1-9]\d{7,14}$/.test(v); }

async function saveUser() {
  const id             = document.getElementById('modal-user-id').value;
  const first_name     = document.getElementById('modal-first-name').value.trim();
  const last_name      = document.getElementById('modal-last-name').value.trim();
  const email          = document.getElementById('modal-email').value.trim();
  const role           = document.getElementById('modal-role').value;
  const phone          = document.getElementById('modal-phone').value.trim();
  const password       = document.getElementById('modal-password').value;
  const reset_2fa      = document.getElementById('modal-reset-2fa').checked;
  const notify_enabled = document.getElementById('modal-notify-enabled').checked;
  const notify_sms     = document.getElementById('modal-notify-sms').checked;
  const notify_email   = document.getElementById('modal-notify-email').checked;

  if (!first_name || !last_name || !role) return showModalAlert('First name, last name, and role are required.');
  if (!email) return showModalAlert('Email is required.');
  if (!validEmail(email)) return showModalAlert('Please enter a valid email address.');
  if (phone && !validPhone(phone)) return showModalAlert('Phone must be in E.164 format, e.g. +12125551234');

  let res;
  if (id) {
    res = await fetch(`/api/users/${id}`, {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ email, first_name, last_name, role, phone: phone || null, reset_2fa,
                             notify_enabled, notify_sms, notify_email }),
    });
  } else {
    res = await fetch('/api/users', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ email, first_name, last_name, role, phone: phone || undefined, password: password || undefined }),
    });
  }
  const data = await res.json();
  if (!res.ok) return showModalAlert(data.error);
  closeModal();
  showAlert(id ? 'User updated.' : 'User created. A welcome email has been sent.', 'success');
  loadUsers();
}

function openDeleteModal(id, name) {
  deleteId = id;
  document.getElementById('del-name').textContent = name;
  document.getElementById('del-backdrop').classList.remove('hidden');
}

async function confirmDelete() {
  const res  = await fetch(`/api/users/${deleteId}`, { method: 'DELETE' });
  const data = await res.json();
  document.getElementById('del-backdrop').classList.add('hidden');
  if (!res.ok) return showAlert(data.error);
  showAlert('User deleted.', 'success');
  loadUsers();
}

async function resetPassword(id) {
  if (!confirm('Send a password reset email to this user?')) return;
  const res  = await fetch(`/api/users/${id}/reset-password`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) return showAlert(data.error);
  showAlert('Password reset email sent.', 'success');
}

// Close modal on backdrop click
document.getElementById('modal-backdrop').addEventListener('click', e => {
  if (e.target === backdrop) closeModal();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

loadUsers();
