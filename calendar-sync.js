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
//   {Volunteer signups (3), kept up to date by the volunteer app:
//   Jane Smith
//   Sam Lee (YA)
//   Emma Smith}
//
// It's wrapped in braces, so it's staff-only by the same rule as any other
// braced text, and the app also strips it entirely before reading the
// description — so it never shows on the volunteer page, and nothing a
// volunteer types as their name can change the event's spot limit.
// Everything outside the block belongs to staff and is never touched.

const BLOCK_HEADER = 'Volunteer signups';
const BLOCK_TAIL   = 'kept up to date by the volunteer app:';

// Matches the block plus any blank lines / <br>s directly in front of it, so
// rewriting it never piles up empty lines. Names can't contain "}" (cleanName
// removes it), so the first closing brace after the header ends the block.
const BLOCK_RE = new RegExp(
  String.raw`(?:\s|<br\s*\/?>)*\{${BLOCK_HEADER} \(\d+\), ${BLOCK_TAIL}[\s\S]*?\}`,
  'i'
);

function looksLikeHtml(desc) {
  return /<(br|p|div|b|i|u|a|ul|ol|li|span)\b/i.test(desc || '');
}

// Names come from the public signup form, so anything that could break out of
// the block or be read as markup is removed.
function cleanName(name, html) {
  let s = String(name || '').replace(/[{}<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!s) s = '(no name given)';
  return html ? s.replace(/&/g, '&amp;') : s;
}

// The block for a list of signup rows, or '' when there are none.
function buildSignupBlock(signups, html) {
  if (!signups.length) return '';
  const br    = html ? '<br>' : '\n';
  const lines = signups.map(s => cleanName(s.name, html) + (s.registered === 'YA' ? ' (YA)' : ''));
  return `{${BLOCK_HEADER} (${signups.length}), ${BLOCK_TAIL}${br}${lines.join(br)}}`;
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
function withSignupBlock(desc, signups) {
  const staffText = stripSignupBlock(desc);
  const html      = looksLikeHtml(staffText);
  const block     = buildSignupBlock(signups, html);
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
