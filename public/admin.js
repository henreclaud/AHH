// admin.js — runs on the admin page (admin.html).
// Shows all visits (from Google Calendar) and who has signed up (from Google Sheets).
// Shifts are managed directly in Google Calendar — not from this page.

if (location.protocol === 'file:') {
  document.body.innerHTML =
    '<div class="setup-notice">' +
    '<h2>Almost there!</h2>' +
    '<p>Run <code>npm start</code> in your terminal, then open ' +
    '<code>http://localhost:3000/admin.html</code> in your browser.</p>' +
    '</div>';
  throw new Error('Opened via file:// — server not running.');
}

const adminShifts = document.getElementById('admin-shifts');
const adminStatus = document.getElementById('admin-status');

// Load all shifts (with their signups) and render them.
async function loadAdminShifts() {
  adminStatus.textContent = 'Loading…';
  adminShifts.innerHTML   = '';

  try {
    const res    = await fetch('/api/admin/shifts');
    const shifts = await res.json();

    if (!res.ok) throw new Error(shifts.error || 'Server error');

    if (shifts.length === 0) {
      adminStatus.textContent =
        'No upcoming visits found. Add events to Google Calendar with ' +
        '"Limit X volunteers" in the title.';
      return;
    }

    adminStatus.textContent = '';
    shifts.forEach(shift => adminShifts.appendChild(buildShiftBlock(shift)));
  } catch (err) {
    adminStatus.textContent = 'Sorry, something went wrong: ' + err.message;
  }
}

// Build the admin block for one shift.
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

loadAdminShifts();
