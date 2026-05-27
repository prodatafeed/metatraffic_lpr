const alertEl = document.getElementById('alert');
let currentUser = null;
let totpQRLoaded = false;

function showAlert(msg, type = 'error') {
  alertEl.textContent = msg;
  alertEl.className   = `alert ${type}`;
  alertEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  setTimeout(() => { alertEl.className = 'alert'; }, 5000);
}

async function loadProfile() {
  const res  = await fetch('/api/account/me');
  const user = await res.json();
  currentUser = user;
  document.getElementById('first-name').value = user.first_name;
  document.getElementById('last-name').value  = user.last_name;
  document.getElementById('email').value      = user.email;
  document.getElementById('phone').value      = user.phone || '';

  const methods = { none: 'Not configured', totp: 'Google Authenticator (TOTP)', sms: 'SMS' };
  document.getElementById('tfa-current').textContent = `Current method: ${methods[user.two_fa_method] || user.two_fa_method}`;

  // Notifications
  const notifyEnabled = document.getElementById('notify-enabled');
  notifyEnabled.checked = !!user.notify_enabled;
  document.getElementById('notify-sms').checked   = !!user.notify_sms;
  document.getElementById('notify-email').checked = !!user.notify_email;
  document.getElementById('notify-channels').style.display = user.notify_enabled ? '' : 'none';
  notifyEnabled.addEventListener('change', () => {
    document.getElementById('notify-channels').style.display = notifyEnabled.checked ? '' : 'none';
  });
}

function validPhone(v) { return /^\+[1-9]\d{7,14}$/.test(v); }

async function saveProfile() {
  const first_name = document.getElementById('first-name').value.trim();
  const last_name  = document.getElementById('last-name').value.trim();
  const phone      = document.getElementById('phone').value.trim();

  if (!first_name) return showAlert('First name is required.');
  if (!last_name)  return showAlert('Last name is required.');
  if (phone && !validPhone(phone)) return showAlert('Phone must be in E.164 format, e.g. +12125551234');

  const res  = await fetch('/api/account/profile', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ first_name, last_name, phone: phone || null }),
  });
  const data = await res.json();
  if (!res.ok) return showAlert(data.error);
  showAlert('Profile updated.', 'success');
}

async function saveNotifications() {
  const notify_enabled = document.getElementById('notify-enabled').checked;
  const notify_sms     = document.getElementById('notify-sms').checked;
  const notify_email   = document.getElementById('notify-email').checked;
  const res  = await fetch('/api/account/notifications', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notify_enabled, notify_sms, notify_email }),
  });
  const data = await res.json();
  if (!res.ok) return showAlert(data.error);
  showAlert('Notification settings saved.', 'success');
}

async function changePassword() {
  const current_password = document.getElementById('pw-current').value;
  const new_password     = document.getElementById('pw-new').value;
  const confirm          = document.getElementById('pw-confirm').value;
  if (!current_password) return showAlert('Current password is required.');
  if (!new_password)     return showAlert('New password is required.');
  if (new_password.length < 8)          return showAlert('New password must be at least 8 characters.');
  if (!/[A-Z]/.test(new_password))      return showAlert('New password must contain an uppercase letter.');
  if (!/[a-z]/.test(new_password))      return showAlert('New password must contain a lowercase letter.');
  if (!/[0-9]/.test(new_password))      return showAlert('New password must contain a number.');
  if (new_password !== confirm)          return showAlert('New passwords do not match.');

  const res  = await fetch('/api/account/password', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current_password, new_password }),
  });
  const data = await res.json();
  if (!res.ok) return showAlert(data.error);
  showAlert('Password changed.', 'success');
  ['pw-current','pw-new','pw-confirm'].forEach(id => document.getElementById(id).value = '');
}

// ── 2FA change ───────────────────────────────────────────────────────────
function showChangeFA() {
  document.getElementById('change-2fa-panel').style.display = '';
  document.getElementById('btn-change-2fa').style.display   = 'none';
  if (!totpQRLoaded) loadFATotpQR();
}

function switch2faTab(tab) {
  ['totp','sms'].forEach(t => {
    document.querySelector(`[onclick="switch2faTab('${t}')"]`).classList.toggle('active', t === tab);
    document.getElementById(`fa-panel-${t}`).classList.toggle('active', t === tab);
  });
  if (tab === 'totp' && !totpQRLoaded) loadFATotpQR();
}

async function loadFATotpQR() {
  const res  = await fetch('/api/auth/setup-totp/init', { method: 'POST' });
  const data = await res.json();
  if (!res.ok) return showAlert(data.error);
  document.getElementById('fa-qr-wrap').innerHTML = `<img src="${data.qr}" alt="QR Code" style="border:4px solid #fff;border-radius:4px;width:160px;height:160px">`;
  document.getElementById('fa-secret-key').textContent = data.secret;
  totpQRLoaded = true;
}

async function verifyTotpChange() {
  const code = document.getElementById('fa-totp-code').value.trim();
  if (code.length !== 6) return showAlert('Enter all 6 digits');
  const res  = await fetch('/api/auth/setup-totp/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
  });
  const data = await res.json();
  if (!res.ok) return showAlert(data.error);
  showAlert('Switched to Google Authenticator.', 'success');
  document.getElementById('change-2fa-panel').style.display = 'none';
  document.getElementById('btn-change-2fa').style.display   = '';
  loadProfile();
  totpQRLoaded = false;
}

async function sendFASMS() {
  const phone = document.getElementById('fa-sms-phone').value.trim();
  if (!phone) return showAlert('Enter a phone number');
  try {
    const res  = await fetch('/api/auth/setup-sms/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }),
    });
    const data = await res.json();
    if (!res.ok) return showAlert(data.error);
    document.getElementById('fa-sms-phone-step').style.display = 'none';
    document.getElementById('fa-sms-code-step').style.display  = '';
    setupSMSInputs('#fa-sms-code-inputs input');
    showAlert('Code sent!', 'success');
  } catch (e) {
    showAlert('Network error — please try again.');
  }
}

async function verifySMSChange() {
  const inputs = Array.from(document.querySelectorAll('#fa-sms-code-inputs input'));
  const code   = inputs.map(el => el.value).join('');
  if (code.length !== 6) return showAlert('Enter all 6 digits');
  const res  = await fetch('/api/auth/setup-sms/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
  });
  const data = await res.json();
  if (!res.ok) return showAlert(data.error);
  showAlert('Switched to SMS.', 'success');
  document.getElementById('change-2fa-panel').style.display = 'none';
  document.getElementById('btn-change-2fa').style.display   = '';
  loadProfile();
}

function setupSMSInputs(selector) {
  const inputs = Array.from(document.querySelectorAll(selector));
  inputs.forEach((inp, i) => {
    inp.value = '';
    inp.addEventListener('input', () => {
      inp.value = inp.value.replace(/\D/g,'').slice(-1);
      if (inp.value && i < inputs.length-1) inputs[i+1].focus();
    });
    inp.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !inp.value && i > 0) inputs[i-1].focus();
    });
  });
  inputs[0].focus();
}

loadProfile();
