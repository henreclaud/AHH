// admin.js — runs on the admin page (admin.html).
// Shows all visits (from Google Calendar) and who has signed up (from Google Sheets).
// Requires a password; the token is stored in localStorage so the user stays
// logged in across page refreshes.

if (location.protocol === 'file:') {
  document.body.innerHTML =
    '<div class="setup-notice">' +
    '<h2>Almost there!</h2>' +
    '<p>Run <code>npm start</code> in your terminal, then open ' +
    '<code>http://localhost:3000/admin.html</code> in your browser.</p>' +
    '</div>';
  throw new Error('Opened via file:// — server not running.');
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const authGate   = document.getElementById('auth-gate');
const adminMain  = document.getElementById('admin-main');
const loginForm  = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const logoutBtn  = document.getElementById('logout-btn');
const adminShifts = document.getElementById('admin-shifts');
const adminStatus = document.getElementById('admin-status');

// ── Auth helpers ──────────────────────────────────────────────────────────────
const TOKEN_KEY = 'aah_admin_token';

function getToken()          { return localStorage.getItem(TOKEN_KEY) || ''; }
function saveToken(t)        { localStorage.setItem(TOKEN_KEY, t); }
function clearToken()        { localStorage.removeItem(TOKEN_KEY); }

function showGate(msg) {
  loginError.textContent = msg || '';
  loginForm.reset();
  authGate.hidden  = false;
  adminMain.hidden = true;
}

function showAdmin() {
  authGate.hidden  = true;
  adminMain.hidden = false;
}

// ── Boot: try the saved token first ──────────────────────────────────────────
async function init() {
  const token = getToken();
  if (token) {
    // Probe the API — if it returns 401 the token is stale.
    const ok = await loadAdminShifts(token);
    if (ok) { showAdmin(); return; }
    clearToken();
  }
  showGate();
}

// ── Login form ────────────────────────────────────────────────────────────────
loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  loginError.textContent = '';
  const password = document.getElementById('admin-password').value;

  try {
    const res  = await fetch('/api/admin/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password }),
    });
    const data = await res.json();
    if (!res.ok) {
      loginError.textContent = data.error || 'Incorrect password. Try again.';
      return;
    }
    saveToken(data.token);
    showAdmin();
    loadAdminShifts(data.token);
  } catch {
    loginError.textContent = 'Could not reach the server. Please try again.';
  }
});

// ── Logout ────────────────────────────────────────────────────────────────────
logoutBtn.addEventListener('click', () => {
  clearToken();
  showGate();
});

// ── Admin data ────────────────────────────────────────────────────────────────

// Returns true if the fetch succeeded (200), false on 401 / error.
async function loadAdminShifts(token) {
  adminStatus.textContent = 'Loading…';
  adminShifts.innerHTML   = '';

  try {
    const res = await fetch('/api/admin/shifts', {
      headers: { 'Authorization': 'Bearer ' + token },
    });

    if (res.status === 401) return false;

    const shifts = await res.json();
    if (!res.ok) throw new Error(shifts.error || 'Server error');

    if (shifts.length === 0) {
      adminStatus.textContent =
        'No upcoming visits found. Add events to Google Calendar.';
      return true;
    }

    adminStatus.textContent = '';
    shifts.forEach(shift => adminShifts.appendChild(buildShiftBlock(shift)));
    return true;
  } catch (err) {
    adminStatus.textContent = 'Sorry, something went wrong: ' + err.message;
    return true; // server responded — not an auth failure
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

function buildShiftBlock(shift) {
  const wrapper = document.createElement('div');
  wrapper.className = 'card admin-shift';

  // ── Header: icon + title/meta ─────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'admin-shift-header';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'admin-shift-title';

  const icon = document.createElement('div');
  icon.className = 'shift-icon';
  icon.textContent = shift.icon || '🐾';
  titleWrap.appendChild(icon);

  const info = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = shift.title;
  info.appendChild(title);

  const meta = document.createElement('p');
  meta.className = 'shift-meta';
  meta.textContent =
    `${shift.date} · ${shift.start_time}–${shift.end_time} · ` +
    `${shift.signups.length} / ${shift.capacity} filled`;
  info.appendChild(meta);

  if (shift.location) {
    const loc = document.createElement('a');
    loc.className = 'shift-loc';
    loc.href = 'https://www.google.com/maps/search/?api=1&query=' +
               encodeURIComponent(shift.location);
    loc.target = '_blank';
    loc.rel = 'noopener';
    loc.textContent = '📍 ' + shift.location;
    info.appendChild(loc);
  }

  titleWrap.appendChild(info);
  header.appendChild(titleWrap);
  wrapper.appendChild(header);

  // ── Signup list ────────────────────────────────────────────────────────────
  if (shift.signups.length === 0) {
    const none = document.createElement('p');
    none.className = 'no-signups';
    none.textContent = 'No signups yet.';
    wrapper.appendChild(none);
  } else {
    const list = document.createElement('ul');
    list.className = 'signup-list';
    shift.signups.forEach(person => {
      const item = document.createElement('li');
      item.appendChild(document.createTextNode(person.name + ' '));
      const emailSpan = document.createElement('span');
      emailSpan.textContent = `· ${person.email}`;
      item.appendChild(emailSpan);
      list.appendChild(item);
    });
    wrapper.appendChild(list);
  }

  return wrapper;
}

init();
