// app.js — volunteer page (index.html).
// Loads shifts once, lets volunteers filter by date range and activity type,
// and handles signing up through the popup dialog.

if (location.protocol === 'file:') {
  document.body.innerHTML =
    '<div class="setup-notice">' +
    '<h2>Almost there!</h2>' +
    '<p>Run <code>npm start</code> in your terminal, then open ' +
    '<code>http://localhost:3000</code> in your browser.</p>' +
    '</div>';
  throw new Error('Opened via file:// — server not running.');
}

// ── Page elements ────────────────────────────────────────────────────────────
const shiftsContainer = document.getElementById('shifts');
const statusEl        = document.getElementById('status');
const dialog          = document.getElementById('signup-dialog');
const signupForm      = document.getElementById('signup-form');
const dialogTitle     = document.getElementById('dialog-title');
const formError       = document.getElementById('form-error');
const cancelButton    = document.getElementById('cancel-button');
const dateGroup       = document.getElementById('filter-date');
const typeRow         = document.getElementById('filter-type');
const openingsToggle  = document.getElementById('filter-openings');
const resultsCount    = document.getElementById('results-count');
const clearButton     = document.getElementById('clear-filters');
const statNumber      = document.getElementById('stat-number');

// ── State ────────────────────────────────────────────────────────────────────
let allShifts = [];
let selectedShiftId = null;
const filters = { dateRange: 'all', type: 'all', openingsOnly: false };

// ── Boot ─────────────────────────────────────────────────────────────────────
async function loadShifts() {
  statusEl.textContent = 'Loading…';
  shiftsContainer.innerHTML = '';
  try {
    const res = await fetch('/api/shifts');
    allShifts = await res.json();
    statNumber.textContent = allShifts.filter(s => !s.is_full).length;
    buildTypeChips();
    render();
  } catch {
    statusEl.textContent = 'Sorry, something went wrong loading the visits.';
  }
}

// ── Filter pipeline ──────────────────────────────────────────────────────────
function getVisible() {
  const today   = startOfToday();
  const weekEnd = addDays(today, 7);

  return allShifts
    .filter(s => {
      // Date range
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
      // Activity type
      if (filters.type !== 'all' && (s.category || 'Visit') !== filters.type) return false;
      // Openings only — shifts with no limit always pass; limited shifts must have spots left
      if (filters.openingsOnly && s.has_limit && s.is_full) return false;
      return true;
    })
    .sort(compareDateTime); // always soonest first
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
  openingsToggle.classList.toggle('active', filters.openingsOnly);
  clearButton.hidden = (filters.dateRange === 'all' && filters.type === 'all' && !filters.openingsOnly);
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

  // Volunteer-facing description (null = no FOR VOLUNTEERS header → show nothing)
  if (shift.description_volunteers) {
    const PREVIEW_CHARS = 120;
    const full = sanitizeHtml(shift.description_volunteers);
    const needsToggle = shift.description_volunteers.length > PREVIEW_CHARS;

    const desc = document.createElement('div');
    desc.className = 'scard-desc';

    if (!needsToggle) {
      desc.innerHTML = full;
    } else {
      const preview = sanitizeHtml(shift.description_volunteers.slice(0, PREVIEW_CHARS).trimEnd()) + '…';
      const textEl = document.createElement('span');
      textEl.innerHTML = preview;

      const toggle = document.createElement('button');
      toggle.className = 'scard-desc-toggle';
      toggle.textContent = 'Show more';
      let expanded = false;
      toggle.addEventListener('click', () => {
        expanded = !expanded;
        textEl.innerHTML = expanded ? full : preview;
        toggle.textContent = expanded ? 'Show less' : 'Show more';
      });

      desc.appendChild(textEl);
      desc.appendChild(document.createElement('br'));
      desc.appendChild(toggle);
    }

    card.appendChild(desc);
  }

  // Sign-up button — only for events with a volunteer limit
  if (shift.has_limit) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary scard-btn';
    if (shift.is_full) {
      btn.textContent = 'Full';
      btn.disabled = true;
    } else {
      btn.textContent = 'Sign up';
      btn.addEventListener('click', () => openSignup(shift));
    }
    card.appendChild(btn);
  }

  return card;
}

// ── Type chips ───────────────────────────────────────────────────────────────
// Only these five types appear as filter chips on the main page.
const MAIN_FILTER_TYPES = [
  'Farm Chores',
  'Open Hours',
  'Mobile Visits',
  'Volunteer Orientation',
  'Farm Visits',
];

function buildTypeChips() {
  const counts = new Map();
  allShifts.forEach(s => {
    const t = s.category || 'Visit';
    counts.set(t, (counts.get(t) || 0) + 1);
  });

  // Rescue the openings toggle before wiping the row — we'll re-append it at the end.
  const openingsBtn = typeRow.querySelector('#filter-openings');
  typeRow.innerHTML = '';

  // "All types" chip always first.
  typeRow.appendChild(makeChip('all', 'All types', allShifts.length));
  // Only show the five approved filter types (in the defined order), skip missing ones.
  MAIN_FILTER_TYPES.forEach(t => {
    if (counts.has(t)) typeRow.appendChild(makeChip(t, t, counts.get(t)));
  });

  // Openings toggle flows at the end of the chip row.
  if (openingsBtn) typeRow.appendChild(openingsBtn);
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

openingsToggle.addEventListener('click', () => {
  filters.openingsOnly = !filters.openingsOnly;
  openingsToggle.setAttribute('aria-pressed', filters.openingsOnly);
  render();
});

clearButton.addEventListener('click', () => {
  filters.dateRange = 'all';
  filters.type = 'all';
  filters.openingsOnly = false;
  dateGroup.querySelectorAll('.seg').forEach(b =>
    b.classList.toggle('active', b.dataset.range === 'all'));
  typeRow.querySelectorAll('.chip').forEach(c =>
    c.classList.toggle('active', c.dataset.type === 'all'));
  openingsToggle.setAttribute('aria-pressed', 'false');
  render();
});

// ── Signup dialog ─────────────────────────────────────────────────────────────
function openSignup(shift) {
  selectedShiftId = shift.id;
  dialogTitle.textContent = shift.title;
  formError.textContent = '';
  signupForm.reset();
  dialog.showModal();
}

cancelButton.addEventListener('click', () => dialog.close());

signupForm.addEventListener('submit', async e => {
  e.preventDefault();
  formError.textContent = '';
  const name  = document.getElementById('name').value.trim();
  const email = document.getElementById('email').value.trim();

  // Require at least two words (first + last name).
  if (!/\S+\s+\S+/.test(name)) {
    formError.textContent = 'Please enter your first and last name.';
    return;
  }

  const submitBtn = signupForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  try {
    const res  = await fetch(`/api/shifts/${selectedShiftId}/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email }),
    });
    const data = await res.json();
    if (!res.ok) {
      formError.textContent = data.error || 'Something went wrong.';
      submitBtn.disabled = false;
      return;
    }
    dialog.close();
    await loadShifts();
    alert(data.message);
  } catch {
    formError.textContent = 'Sorry, something went wrong. Please try again.';
    submitBtn.disabled = false;
  }
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

loadShifts();
