// calendar.js — read-only calendar view (calendar.html).
// Shows upcoming shifts as a clean list grouped by date: just the activity,
// the date, and the time. No signup, no notes, no volunteer names.

if (location.protocol === 'file:') {
  document.body.innerHTML =
    '<div class="setup-notice">' +
    '<h2>Almost there!</h2>' +
    '<p>Run <code>npm start</code> in your terminal, then open ' +
    '<code>http://localhost:3000/calendar</code> in your browser.</p>' +
    '</div>';
  throw new Error('Opened via file:// — server not running.');
}

const calendarEl = document.getElementById('calendar');
const statusEl   = document.getElementById('cal-status');

// Known activities, in display priority order. The calendar shows these clean
// labels instead of the raw event title (which often carries a volunteer's
// name, e.g. "Alyssa - Feeding" or "Hailey Feeding").
const ACTIVITY_MATCHERS = [
  [/feeding/i,              'Feeding'],
  [/farm\s*chore/i,         'Farm Chores'],
  [/open\s*h/i,             'Open Hours'],
  [/mobile|petting/i,       'Mobile Visit'],
  [/volunteer\s*orient/i,   'Volunteer Orientation'],
  [/farm\s*visit/i,         'Farm Visit'],
  [/pony|horse/i,           'Pony Visit'],
  [/bunny|rabbit/i,         'Bunny Visit'],
  [/guinea|reading/i,       'Reading Buddies'],
  [/workshop/i,             'Workshop'],
  [/barnyard|buddy/i,       'Barnyard Buddy Time'],
  [/ambassador/i,           'Youth Ambassador'],
];

// Entries that are availability blockers, not real shifts — hidden from view.
const HIDDEN_RE = /not\s*available|unavailable|out of office|\booo\b|blocked|\bn\/a\b/i;

// Turn a raw event title into a clean activity label.
function cleanActivity(shift) {
  const title = shift.title || '';
  const found = [];
  for (const [re, label] of ACTIVITY_MATCHERS) {
    if (re.test(title) && !found.includes(label)) found.push(label);
  }
  if (found.length) return found.join(' & ');
  // No keyword matched — fall back to the server-derived category.
  return shift.category && shift.category !== 'Visit' ? shift.category : 'Visit';
}

// ── Load + render ─────────────────────────────────────────────────────────────
async function load() {
  try {
    const res    = await fetch('/api/shifts');
    const shifts = await res.json();
    render(shifts);
  } catch {
    statusEl.textContent = 'Sorry, something went wrong loading the calendar.';
  }
}

function render(shifts) {
  const visible = shifts
    .filter(s => !HIDDEN_RE.test(s.title || ''))
    .sort(compareDateTime);

  if (!visible.length) {
    statusEl.textContent = 'No upcoming shifts.';
    return;
  }
  statusEl.hidden = true;

  // Group by date.
  const byDate = new Map();
  for (const s of visible) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push(s);
  }

  calendarEl.innerHTML = '';
  for (const [date, rows] of byDate) {
    const group = document.createElement('section');
    group.className = 'cal-group';

    const heading = document.createElement('h2');
    heading.className   = 'cal-date';
    heading.textContent = formatDate(date);
    group.appendChild(heading);

    for (const s of rows) {
      const row = document.createElement('div');
      row.className = 'cal-row card';

      const activity = document.createElement('span');
      activity.className   = 'cal-activity';
      activity.textContent = cleanActivity(s);

      const time = document.createElement('span');
      time.className   = 'cal-time';
      time.textContent = `${s.start_time}–${s.end_time}`;

      row.appendChild(activity);
      row.appendChild(time);
      group.appendChild(row);
    }
    calendarEl.appendChild(group);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });
}

// Minutes-since-midnight from a "9:00am" / "1:30pm" string, for chronological sort.
function toMinutes(t) {
  const m = String(t).match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
  if (!m) return 0;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (/pm/i.test(m[3]) && h !== 12) h += 12;
  if (/am/i.test(m[3]) && h === 12) h = 0;
  return h * 60 + min;
}

function compareDateTime(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return toMinutes(a.start_time) - toMinutes(b.start_time);
}

load();
