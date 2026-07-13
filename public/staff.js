// staff.js — staff view page (staff.html).
// Identical to app.js except:
//   • Password-gated: requires staff login (token stored in sessionStorage)
//   • Loads from /api/staff/shifts (includes staff-only description text)
//   • Cards show both the volunteer-facing description AND the staff-only section

if (location.protocol === 'file:') {
  document.body.innerHTML =
    '<div class="setup-notice">' +
    '<h2>Almost there!</h2>' +
    '<p>Run <code>npm start</code> in your terminal, then open ' +
    '<code>http://localhost:3000/staff.html</code> in your browser.</p>' +
    '</div>';
  throw new Error('Opened via file:// — server not running.');
}

// ── Auth gate ─────────────────────────────────────────────────────────────────
const authGate  = document.getElementById('auth-gate');
const staffMain = document.getElementById('staff-main');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');

let sessionToken = ''; // page-lifetime only — cleared when you navigate away

function showGate(msg) {
  authGate.hidden  = false;
  staffMain.hidden = true;
  if (msg) {
    loginError.style.color = '';
    loginError.textContent = msg;
  }
}

function showStaff() {
  authGate.hidden  = true;
  staffMain.hidden = false;
}

loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  const submitBtn = loginForm.querySelector('[type=submit]');
  const password  = document.getElementById('staff-password').value;
  loginError.textContent = '';
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in…';

  // Show "waking up" message if the server takes more than 6s (Render cold start).
  const wakeMsg = setTimeout(() => {
    if (submitBtn.disabled) {
      loginError.textContent = 'Server is waking up — this takes up to a minute on the free plan. Almost there…';
    }
  }, 6000);

  // 70-second timeout to survive Render free-tier cold starts.
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 70000);

  try {
    const res  = await fetch('/api/staff/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password }),
      signal:  controller.signal,
    });
    const data = await res.json();
    clearTimeout(wakeMsg);
    clearTimeout(timeout);

    if (!res.ok) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign in';
      showGate(data.error || 'Something went wrong. Try again.');
      return;
    }

    // Success — store token in page-lifetime variable.
    sessionToken = data.token;

    submitBtn.textContent = '✓ Signed in!';
    loginError.style.color = 'var(--purple)';
    loginError.textContent = '↓ Scroll down to see shifts';

    setTimeout(() => {
      showStaff();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      loadShifts();
    }, 600);
  } catch (err) {
    clearTimeout(wakeMsg);
    clearTimeout(timeout);
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign in';
    if (err.name === 'AbortError') {
      showGate('Request timed out — server may still be waking up. Please try again.');
    } else {
      showGate('Could not connect. Please try again.');
    }
  }
});

// Always show the gate on every page load — no persistence.
showGate();

// ── Page elements ────────────────────────────────────────────────────────────
const shiftsContainer = document.getElementById('shifts');
const statusEl        = document.getElementById('status');
const dateGroup       = document.getElementById('filter-date');
const typeRow         = document.getElementById('filter-type');
const resultsCount    = document.getElementById('results-count');
const clearButton     = document.getElementById('clear-filters');
const statNumber      = document.getElementById('stat-number');

// ── State ────────────────────────────────────────────────────────────────────
let allShifts = [];
let staffList = [];   // [{ name, email }] from the staff tab on the Sheet
// filters.type: 'all' or a staff member's email — shifts are matched by the
// calendar event's guest list, not the title (titles can name several people).
const filters = { dateRange: 'all', type: 'all' };

// ── Boot ─────────────────────────────────────────────────────────────────────
async function loadShifts() {
  statusEl.textContent = 'Loading…';
  shiftsContainer.innerHTML = '';
  try {
    const authHeader = { 'Authorization': `Bearer ${sessionToken}` };
    const [shiftsRes, staffRes] = await Promise.all([
      fetch('/api/staff/shifts', { headers: authHeader }),
      fetch('/api/staff/list',   { headers: authHeader }),
    ]);
    if (shiftsRes.status === 401) {
      sessionToken = '';
      showGate('Session expired — please sign in again.');
      return;
    }
    allShifts = await shiftsRes.json();
    staffList = staffRes.ok ? await staffRes.json() : [];
    statNumber.textContent = allShifts.filter(s => !s.is_full).length;
    buildStaffChips();
    render();
    loadBanner();
  } catch {
    statusEl.textContent = 'Sorry, something went wrong loading the visits.';
  }
}

// True when this staff member is on the event's invited-guest list.
function isAssignedTo(shift, email) {
  return (shift.attendees || []).some(a => a.email === email);
}

// Announcement banner — staff message from the restricted sheet (cell B2).
async function loadBanner() {
  try {
    const res  = await fetch('/api/staff/message', {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    const data = await res.json();
    const bannerEl = document.getElementById('site-banner');
    bannerEl.textContent = data.message || ''; // textContent — never rendered as HTML
    bannerEl.hidden = !data.message;           // hide again when the cell is cleared
  } catch { /* banner is cosmetic — ignore failures */ }
}

// ── Filter pipeline ──────────────────────────────────────────────────────────
function getVisible() {
  const today   = startOfToday();
  const weekEnd = addDays(today, 7);

  return allShifts
    .filter(s => {
      if (filters.dateRange !== 'all') {
        const d = parseDate(s.date);
        if (!d) return false;
        if (filters.dateRange === 'today' && d.getTime() !== today.getTime()) return false;
        if (filters.dateRange === 'week'  && (d < today || d >= weekEnd))      return false;
        if (filters.dateRange === 'month') {
          if (d.getFullYear() !== today.getFullYear() ||
              d.getMonth()    !== today.getMonth()) return false;
        }
      }
      if (filters.type !== 'all' && !isAssignedTo(s, filters.type)) return false;
      return true;
    })
    .sort(compareDateTime);
}

// ── Render ───────────────────────────────────────────────────────────────────
function render() {
  const visible = getVisible();
  shiftsContainer.innerHTML = '';

  if (allShifts.length === 0) {
    statusEl.textContent = 'No visits are scheduled yet — check back soon.';
  } else if (visible.length === 0) {
    statusEl.textContent = 'No visits match the current filters.';
  } else {
    statusEl.textContent = '';
    visible.forEach(s => shiftsContainer.appendChild(createCard(s)));
  }

  const total = allShifts.length;
  resultsCount.textContent = total
    ? `Showing ${visible.length} of ${total} visit${total === 1 ? '' : 's'}`
    : '';
  clearButton.hidden = (filters.dateRange === 'all' && filters.type === 'all');
}

// ── Card builder ─────────────────────────────────────────────────────────────
function createCard(shift) {
  const card = document.createElement('article');
  card.className = 'scard' + (shift.is_full ? ' is-full' : '');

  // Top row: category tag + spots status
  const top = document.createElement('div');
  top.className = 'scard-top';

  const tag = document.createElement('span');
  tag.className = 'type-tag';
  tag.textContent = shift.category || 'Visit';
  top.appendChild(tag);

  if (shift.has_limit) {
    const pill = document.createElement('span');
    const left = shift.spots_left;
    if (shift.is_full) {
      pill.className = 'spots-pill full';
      pill.textContent = 'Full';
    } else {
      pill.className = 'spots-pill' + (left <= 2 ? ' low' : '');
      pill.textContent = `${left} spot${left === 1 ? '' : 's'} left`;
    }
    top.appendChild(pill);
  }
  card.appendChild(top);

  // Title
  const title = document.createElement('h3');
  title.className = 'scard-title';
  title.textContent = shift.title;
  card.appendChild(title);

  // Date · time
  const when = document.createElement('p');
  when.className = 'scard-when';
  when.innerHTML =
    `<span class="when-date">${escapeHtml(formatDate(shift.date))}</span>` +
    `<span class="when-sep">·</span>` +
    `<span class="when-time">${escapeHtml(shift.start_time)}–${escapeHtml(shift.end_time)}</span>`;
  card.appendChild(when);

  // Location (Google Maps link)
  if (shift.location) {
    const loc = document.createElement('a');
    loc.className = 'scard-loc';
    loc.href = 'https://www.google.com/maps/search/?api=1&query=' +
               encodeURIComponent(shift.location);
    loc.target = '_blank';
    loc.rel = 'noopener';
    loc.textContent = shift.location;
    card.appendChild(loc);
  }

  // Volunteer-facing description (shown exactly as volunteers see it)
  if (shift.description_volunteers) {
    const desc = document.createElement('div');
    desc.className = 'scard-desc';
    desc.innerHTML = sanitizeHtml(shift.description_volunteers);
    card.appendChild(desc);
  }

  // ── Signup list ───────────────────────────────────────────────────────────
  const signupSection = document.createElement('div');
  signupSection.className = 'scard-signups';

  const signupHeading = document.createElement('p');
  signupHeading.className = 'scard-signups-heading';
  const signupCount = (shift.signups || []).length;
  const yaCount      = (shift.signups || []).filter(s => s.is_ya).length;
  signupHeading.textContent = yaCount
    ? `Signups (${signupCount}) · ${yaCount} YA`
    : `Signups (${signupCount})`;
  signupSection.appendChild(signupHeading);

  if (!shift.signups || shift.signups.length === 0) {
    const none = document.createElement('p');
    none.className = 'scard-signups-empty';
    none.textContent = 'No signups yet.';
    signupSection.appendChild(none);
  } else {
    const list = document.createElement('ul');
    list.className = 'scard-signups-list';
    // Determine whether this shift is in the future (for ⏳ badge).
    const todayStr = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local (Pacific) time

    shift.signups.forEach(({ name, email, phone, registered, is_ya, attendance, checkin_time, checkout_time, hours_logged }) => {
      const li = document.createElement('li');

      let attendanceBadge = '';
      if (attendance === 'Attended') {
        attendanceBadge = '<span class="att-badge att-attended">✅ Attended</span>';
      } else if (attendance === 'No-show') {
        attendanceBadge = '<span class="att-badge att-noshow">❌ No-show</span>';
      } else if (shift.date >= todayStr) {
        attendanceBadge = '<span class="att-badge att-upcoming">⏳ Upcoming</span>';
      }

      let hoursHtml = '';
      if (checkin_time) {
        hoursHtml += `<div class="signup-hours">🕐 In: ${escapeHtml(checkin_time)}`;
        if (checkout_time) hoursHtml += ` &nbsp;·&nbsp; 🕑 Out: ${escapeHtml(checkout_time)}`;
        if (hours_logged)  hoursHtml += ` &nbsp;·&nbsp; ⏱ ${escapeHtml(hours_logged)} hrs`;
        hoursHtml += `</div>`;
      }

      const yaBadge = is_ya ? '<span class="ya-badge">🌟 Youth Ambassador</span>' : '';
      const phoneHtml = phone
        ? `<a class="signup-phone" href="tel:${encodeURIComponent(phone)}">${escapeHtml(phone)}</a>`
        : '';
      li.innerHTML = `
        <div class="signup-row">
          <span class="signup-name">${escapeHtml(name)}${is_ya ? ' <span class="ya-inline">(YA)</span>' : ''}</span>
          <a class="signup-email" href="mailto:${encodeURIComponent(email)}">${escapeHtml(email)}</a>
          ${phoneHtml}
          ${attendanceBadge}
          ${yaBadge}
        </div>
        ${hoursHtml}
        ${registered === 'No' ? '<div class="signup-unregistered">⚠️ Not a registered volunteer</div>' : ''}
      `;
      list.appendChild(li);
    });
    signupSection.appendChild(list);

    // "Notify volunteers" mailto button
    const emails  = shift.signups.map(s => s.email).join(',');
    const subject = `Update regarding your signup: ${shift.title} on ${formatDate(shift.date)}`;
    const mailto  = `mailto:${emails}?subject=${encodeURIComponent(subject)}`;
    const notify  = document.createElement('a');
    notify.className = 'btn btn-secondary scard-notify-btn';
    notify.href      = mailto;
    notify.textContent = 'Notify volunteers of a change';
    signupSection.appendChild(notify);
  }

  card.appendChild(signupSection);

  // Staff-only description
  if (shift.description_staff) {
    const staffBlock = document.createElement('div');
    staffBlock.className = 'scard-desc scard-desc-staff';

    const badge = document.createElement('span');
    badge.className = 'staff-badge';
    badge.textContent = 'Staff only';
    staffBlock.appendChild(badge);

    const staffText = document.createElement('div');
    staffText.className = 'scard-desc-text';
    staffText.innerHTML = sanitizeHtml(shift.description_staff);
    staffBlock.appendChild(staffText);

    card.appendChild(staffBlock);
  }

  return card;
}

// ── Staff chips ──────────────────────────────────────────────────────────────
// One chip per staff member (from the staff tab on the Sheet). Clicking a name
// shows only the events where that person is on the calendar guest list.
function buildStaffChips() {
  typeRow.innerHTML = '';
  typeRow.appendChild(makeChip('all', 'Everyone', allShifts.length));
  staffList.forEach(p => {
    const count = allShifts.filter(s => isAssignedTo(s, p.email)).length;
    typeRow.appendChild(makeChip(p.email, p.name, count));
  });
}

function makeChip(value, label, count) {
  const chip = document.createElement('button');
  chip.className = 'chip' + (filters.type === value ? ' active' : '');
  chip.dataset.type = value;
  chip.innerHTML =
    `${escapeHtml(label)}<span class="chip-count">${count}</span>`;
  chip.addEventListener('click', () => {
    filters.type = value;
    typeRow.querySelectorAll('.chip').forEach(c =>
      c.classList.toggle('active', c.dataset.type === value));
    render();
  });
  return chip;
}

// ── Filter wiring ─────────────────────────────────────────────────────────────
dateGroup.addEventListener('click', e => {
  const btn = e.target.closest('.seg');
  if (!btn) return;
  filters.dateRange = btn.dataset.range;
  dateGroup.querySelectorAll('.seg').forEach(b => b.classList.toggle('active', b === btn));
  render();
});

clearButton.addEventListener('click', () => {
  filters.dateRange = 'all';
  filters.type = 'all';
  dateGroup.querySelectorAll('.seg').forEach(b =>
    b.classList.toggle('active', b.dataset.range === 'all'));
  typeRow.querySelectorAll('.chip').forEach(c =>
    c.classList.toggle('active', c.dataset.type === 'all'));
  render();
});

// ── Date helpers ──────────────────────────────────────────────────────────────
function parseDate(iso)    { const d = new Date(iso + 'T00:00:00'); return isNaN(d) ? null : d; }
function startOfToday()    { const d = new Date(); d.setHours(0,0,0,0); return d; }
function addDays(d, n)     { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function compareDateTime(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return a.start_time < b.start_time ? -1 : a.start_time > b.start_time ? 1 : 0;
}
function formatDate(iso) {
  const d = parseDate(iso);
  if (!d) return iso;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function escapeHtml(t) {
  const el = document.createElement('div'); el.textContent = t ?? ''; return el.innerHTML;
}

// loadShifts() is called by the login form handler after a successful login.
