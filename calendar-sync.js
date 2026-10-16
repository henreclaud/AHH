// calendar-sync.js — shared helpers for keeping the AAH Calendar and the
// signups sheet in step. Used by both the web server (google.js) and the hourly
// GitHub job (send-reminders.js), so the two can never disagree about what a
// signup list looks like or what an event's date/time is.
//
// Two jobs (Peter, Oct 2026):
//   1. Write each event's signup list into its calendar description, so staff
//      can see who's affected without opening the app.
//   2. Tell when staff have moved an event, so the signups can move with it.

'use strict';

const PT = 'America/Los_Angeles'; // AAH operates in Pacific Time

// ── Date / time formats ──────────────────────────────────────────────────────
// These are the exact formats the signups sheet stores (col F date, col G
// time), so comparing a sheet row to a calendar event is a plain string match.

// Format a JS Date as "9:00am" / "3:30pm" in Pacific Time.
function toHHMM(date) {
  return date.toLocaleTimeString('en-US', {
    timeZone: PT,
    hour:     'numeric',
    minute:   '2-digit',
    hour12:   true,
  }).toLowerCase().replace(/\s/g, ''); // "9:00 AM" → "9:00am"
}

// Format a JS Date as "YYYY-MM-DD" in Pacific Time.
function toDateStr(date) {
  return date.toLocaleDateString('en-CA', { timeZone: PT }); // en-CA gives YYYY-MM-DD
}

// Normalises a sheet date string to "YYYY-MM-DD" for comparison.
// Google Sheets may silently reformat dates written as 2026-07-02 into a
// locale form like 7/2/2026, which breaks exact string matching everywhere
// (no-show cron, upcoming-signup lookup).
function normalizeDateStr(s) {
  s = String(s || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); // M/D/YYYY (US sheet locale)
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleDateString('en-CA', { timeZone: PT });
}

// "9:00am – 11:00am" / "9:00AM-11:00AM" → "9:00am-11:00am"
function normalizeTimeRange(s) {
  return String(s || '').toLowerCase().replace(/\s/g, '').replace(/[–—]/g, '-');
}

// An event's date and time in the sheet's format. Mirrors exactly how a
// signup row is written, so an unmoved event always compares equal.
function eventSlot(event) {
  const startDt = new Date(event.start.dateTime || event.start.date);
  const endDt   = new Date(event.end.dateTime   || event.end.date);
  return {
    date:    toDateStr(startDt),
    time:    `${toHHMM(startDt)}-${toHHMM(endDt)}`,
    startMs: startDt.getTime(),
  };
}

// True when a sheet row's stored date/time no longer matches the event.
function hasMoved(rowDate, rowTime, slot) {
  return normalizeDateStr(rowDate) !== slot.date ||
         normalizeTimeRange(rowTime) !== normalizeTimeRange(slot.time);
}

// ── Signup list in the event description ─────────────────────────────────────
//
// The app owns one block at the end of the description:
//
//   {━━━━━━━━ VOLUNTEER SIGNUPS (added by the volunteer app) ━━━━━━━━
//   Please don't edit below this line. It's rewritten automatically.
//   15 signed up: YA (4), Adult (8), Youth (3)
//
//   Beckett Eaton (YA) · beckett@example.com · 650-555-0101 · ✓ Attended
//   Gwendolyn Hui (A) · gwen@example.com · 408-555-0199}
//
// The rule line is the divider staff asked for (Peter, Oct 2026). It's
// wrapped in braces, so it's staff-only by the same rule as any other braced
// text, and the app also strips it entirely before reading the description —
// so it never shows on the volunteer page, and nothing a volunteer types can
// change the event's spot limit. Everything outside the block belongs to
// staff and is never touched.
//
// Emails and phone numbers are left out (contacts: false) when the event has
// guests from outside AAH: invited guests see the description, and some
// volunteers are children.

const RULE        = '━━━━━━━━';
const BLOCK_TITLE = 'VOLUNTEER SIGNUPS (added by the volunteer app)';

// Matches the block plus any blank lines / <br>s directly in front of it, so
// rewriting it never piles up empty lines. Also matches the first version's
// header ("{Volunteer signups (3), kept up to date…"), so blocks written
// before this format are replaced, not duplicated. Nothing inside the block
// can contain "}" (clean() removes it), so the first closing brace ends it.
const BLOCK_RE = new RegExp(
  String.raw`(?:\s|<br\s*\/?>)*\{(?:━+ VOLUNTEER SIGNUPS \(added by the volunteer app\)|Volunteer signups \(\d+\), kept up to date by the volunteer app:)[\s\S]*?\}`,
  'i'
);

// Over this, contact details are dropped and, if still too long, the list is
// cut short — keeps the description well inside Google Calendar's limits.
const MAX_BLOCK_CHARS = 6000;

function looksLikeHtml(desc) {
  return /<(br|p|div|b|i|u|a|ul|ol|li|span)\b/i.test(desc || '');
}

// Names and emails come from the public signup form, so anything that could
// break out of the block or be read as markup is removed.
function clean(value, html) {
  const s = String(value || '').replace(/[{}<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 254);
  return html ? s.replace(/&/g, '&amp;') : s;
}

// One signup's line: name, type markers, then (optionally) email, phone, and
// whether they've checked in. Markers match the staff page: (YA) (A) (Y) (C).
function signupLine(e, html, contacts) {
  const ya = e.ya !== undefined ? e.ya : e.registered === 'YA';
  const markers = [ya && '(YA)', e.adult && '(A)', e.youth && '(Y)', e.corporate && '(C)'].filter(Boolean);
  let who = clean(e.name, html) || '(no name given)';
  if (markers.length) who += ' ' + markers.join(' ');
  if (e.unregistered) who += ' (not registered)';
  const parts = [who];
  if (contacts) {
    if (clean(e.email, html)) parts.push(clean(e.email, html));
    if (clean(e.phone, html)) parts.push(clean(e.phone, html));
  }
  if (e.attended) parts.push('✓ Attended');
  return parts.join(' · ');
}

// "15 signed up: YA (4), Adult (8), Youth (3)" — types with nobody are left out.
function totalsLine(entries) {
  const n = key => entries.filter(e => key === 'ya' ? (e.ya !== undefined ? e.ya : e.registered === 'YA') : e[key]).length;
  const types = [['YA', n('ya')], ['Adult', n('adult')], ['Youth', n('youth')], ['Corporate', n('corporate')]]
    .filter(([, c]) => c > 0).map(([label, c]) => `${label} (${c})`);
  return `${entries.length} signed up` + (types.length ? `: ${types.join(', ')}` : '');
}

function renderBlock(entries, html, contacts, note, limit = entries.length) {
  const br    = html ? '<br>' : '\n';
  const head  = [
    `{${RULE} ${BLOCK_TITLE} ${RULE}`,
    "Please don't edit below this line. It's rewritten automatically.",
    totalsLine(entries),
  ];
  if (note) head.push(note);
  const lines = entries.slice(0, limit).map(e => signupLine(e, html, contacts));
  if (limit < entries.length) lines.push(`…and ${entries.length - limit} more. See the staff page for the full list.`);
  return head.join(br) + br + br + lines.join(br) + '}';
}

// The block for a list of signups, or '' when there are none.
//   entries: [{ name, email, phone, ya, adult, youth, corporate, unregistered, attended }]
//   opts.contacts: include emails and phone numbers (default true)
function buildSignupBlock(entries, html, opts = {}) {
  if (!entries.length) return '';
  const contacts = opts.contacts !== false;
  const hidden   = contacts ? '' : 'Contact details hidden: this event has guests from outside AAH. See the staff page.';
  let block = renderBlock(entries, html, contacts, hidden);
  if (block.length <= MAX_BLOCK_CHARS) return block;
  block = renderBlock(entries, html, false, 'Contact details left out to keep this short. See the staff page.');
  let limit = entries.length;
  while (block.length > MAX_BLOCK_CHARS && limit > 1) {
    limit = Math.max(1, Math.floor(limit * 0.9));
    block = renderBlock(entries, html, false, 'Contact details left out to keep this short. See the staff page.', limit);
  }
  return block;
}

// The description with the app's block removed — what the app reads.
function stripSignupBlock(desc) {
  return String(desc || '').replace(BLOCK_RE, '');
}

// The block currently in a description, or '' if there isn't one.
function currentSignupBlock(desc) {
  const m = String(desc || '').match(BLOCK_RE);
  return m ? m[0].replace(/^(?:\s|<br\s*\/?>)*/i, '') : '';
}

// The description with the block replaced (or removed, if nobody's signed up).
// Staff text is kept exactly as it was.
function withSignupBlock(desc, entries, opts = {}) {
  const staffText = stripSignupBlock(desc);
  const html      = looksLikeHtml(staffText);
  const block     = buildSignupBlock(entries, html, opts);
  if (!block) return staffText;
  if (!staffText.trim()) return block;
  return staffText.replace(/(?:\s|<br\s*\/?>)*$/i, '') + (html ? '<br><br>' : '\n\n') + block;
}

module.exports = {
  PT,
  toHHMM,
  toDateStr,
  normalizeDateStr,
  normalizeTimeRange,
  eventSlot,
  hasMoved,
  buildSignupBlock,
  stripSignupBlock,
  currentSignupBlock,
  withSignupBlock,
};
