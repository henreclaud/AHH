// google.js — data layer for the AAH volunteer app.
// Replaces db.js (SQLite).
//
// Shifts  → read from Google Calendar (cached 1 min, auto-refreshed).
// Signups → read/write to a Google Sheet.

'use strict';

const { google } = require('googleapis');

// ── Environment variables ────────────────────────────────────────────────────
// GOOGLE_CALENDAR_ID          — the calendar to read shifts from
// GOOGLE_SHEET_ID             — the spreadsheet to write signups to
// GOOGLE_SERVICE_ACCOUNT_JSON — full service-account credentials JSON as a string

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const SHEET_ID    = process.env.GOOGLE_SHEET_ID;

// Parse the service-account credentials.
// When pasting JSON into Render's env var field the newlines inside the
// private key sometimes get double-escaped ("\\n" instead of "\n").
// We try plain parse first, then fix escaped newlines as a fallback.
function getCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set. See .env.example.');
  }
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(raw.replace(/\\n/g, '\n'));
    } catch (err2) {
      throw new Error('Could not parse GOOGLE_SERVICE_ACCOUNT_JSON: ' + err2.message);
    }
  }
}

// ── Auth ─────────────────────────────────────────────────────────────────────
// One GoogleAuth instance shared across the process.
let _auth;
function getAuth() {
  if (!_auth) {
    _auth = new google.auth.GoogleAuth({
      credentials: getCredentials(),
      scopes: [
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/spreadsheets',
      ],
    });
  }
  return _auth;
}

// ── Description parser ────────────────────────────────────────────────────────
//
// Calendar event descriptions may contain ALL-CAPS section headers:
//
//   FOR VOLUNTEERS
//   Text that shows for volunteers and staff.
//
//   FOR STAFF
//   Text shown to staff only.
//
// Headers are matched case-insensitively; extra whitespace is ignored.
// Descriptions may be plain text or HTML (Google Calendar rich text).
//
// Return values:
//   volunteers — null if no FOR VOLUNTEERS header exists; otherwise the HTML/text
//                content under that header (shown on volunteer + staff pages)
//   staff      — null if no FOR STAFF header exists; otherwise content under that
//                header (shown on staff page only)
//
// No-headers case: volunteers = null (shown to nobody on volunteer page),
//                  staff = raw description (staff page shows everything).

function parseDescription(raw) {
  if (!raw || !raw.trim()) return { volunteers: null, staff: null };

  // Split into "logical lines" by converting all common block-level breaks
  // (plain \n, HTML <br>, </p>, <p>) to a null-byte marker, then splitting.
  // This preserves inline HTML (links, bold, etc.) within each line.
  const MARKER = '\x00';
  const marked = raw
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, MARKER)
    .replace(/<br\s*\/?>/gi, MARKER)
    .replace(/<\/p\s*>/gi,   MARKER)
    .replace(/<p[^>]*>/gi,   MARKER);

  const rawLines = marked.split(MARKER);

  // Strip all tags + decode basic entities to get visible text per line,
  // used only for header detection.
  const textLines = rawLines.map(l =>
    l.replace(/<[^>]+>/g, '')
     .replace(/&nbsp;/g, ' ')
     .replace(/&amp;/g,  '&')
     .replace(/&lt;/g,   '<')
     .replace(/&gt;/g,   '>')
     .trim()
  );

  const isVol   = l => /^for\s+volunteers\s*$/i.test(l);
  const isStaff = l => /^for\s+staff\s*$/i.test(l);

  const volIdx   = textLines.findIndex(isVol);
  const staffIdx = textLines.findIndex(isStaff);

  // No section headers at all — volunteer page shows nothing, staff sees everything.
  if (volIdx === -1 && staffIdx === -1) {
    return { volunteers: null, staff: raw.trim() };
  }

  // Build an ordered list of section starts.
  const sections = [];
  if (volIdx   !== -1) sections.push({ type: 'volunteers', idx: volIdx });
  if (staffIdx !== -1) sections.push({ type: 'staff',      idx: staffIdx });
  sections.sort((a, b) => a.idx - b.idx);

  // Extract HTML content between each header and the next (or end of description).
  // Re-join with <br> so line breaks render correctly in the browser.
  const result = { volunteers: null, staff: null };
  for (let i = 0; i < sections.length; i++) {
    const start = sections[i].idx + 1;
    const end   = sections[i + 1] ? sections[i + 1].idx : rawLines.length;
    const html  = rawLines.slice(start, end)
      .join('<br>')
      .replace(/^(<br>\s*)+|(\s*<br>)+$/g, '') // trim leading/trailing <br>
      .trim();
    result[sections[i].type] = html || null;
  }
  return result;
}

// ── Calendar helpers ──────────────────────────────────────────────────────────

const PT = 'America/Los_Angeles'; // AAH operates in Pacific Time

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

// Patterns that indicate a volunteer limit — checked in title AND description.
// Matches: "Limit 5", "Limit: 5", "Limit 5 volunteers", "5 spots", "5 volunteer spots",
//          "25 Volunteers", "(25 Volunteers)"
const LIMIT_RE = /(?:limit:?\s*(\d+)(?:\s+volunteers?)?|(\d+)\s+(?:volunteer\s+)?spots?|\(?\s*(\d+)\s+volunteers?\s*\)?)/i;

// Extract volunteer capacity from a string (title or description).
// Returns an integer, or null if no pattern found.
function parseCapacity(text) {
  if (!text) return null;
  const m = text.match(LIMIT_RE);
  if (!m) return null;
  return parseInt(m[1] || m[2] || m[3], 10);
}

// Extract the shift name from the event title.
// Strips the limit phrase and any trailing/leading dashes / punctuation.
// Handles:
//   "Rabbit Workshop (25 Volunteers)"  → "Rabbit Workshop"
//   "25 Volunteers - Barnyard Buddy Day" → "Barnyard Buddy Day"
//   "Barnyard Visit - Limit 10"        → "Barnyard Visit"
function parseShiftName(title) {
  const stripped = title
    // Strip "(N Volunteers)" parenthetical anywhere in the title
    .replace(/\s*\(\s*\d+\s+volunteers?\s*\)/gi, '')
    // Strip "N Volunteers - " or "N Volunteers – " at the start of the title
    .replace(/^\s*\d+\s+volunteers?\s*[-–—]\s*/i, '')
    // Strip old-style limit phrases (and everything after on the same segment)
    .replace(/\s*[-–—]?\s*(?:limit:?\s*\d+(?:\s+volunteers?)?|\d+\s+(?:volunteer\s+)?spots?).*/i, '')
    .trim()
    .replace(/[-–—\s]+$/, '') // remove trailing dashes / spaces
    .trim();
  return stripped || null;
}

// Derive the activity category and emoji icon from the shift name.
// Category names must exactly match the MAIN_FILTER_TYPES list in app.js
// so the filter chips work correctly.
function deriveCategory(name) {
  if (/farm\s*chore/i.test(name))        return { category: 'Farm Chores',          icon: '🐐' };
  if (/open\s*h/i.test(name))            return { category: 'Open Hours',            icon: '🏡' };
  if (/mobile|petting/i.test(name))      return { category: 'Mobile Visits',         icon: '🐤' };
  if (/volunteer\s*orient/i.test(name))  return { category: 'Volunteer Orientation', icon: '📋' };
  if (/farm\s*visit/i.test(name))        return { category: 'Farm Visits',           icon: '🌾' };
  if (/pony|horse/i.test(name))          return { category: 'Pony Visit',            icon: '🐴' };
  if (/bunny|rabbit/i.test(name))        return { category: 'Bunny Visit',           icon: '🐰' };
  if (/guinea|reading/i.test(name))      return { category: 'Reading Buddies',       icon: '🐹' };
  if (/workshop/i.test(name))            return { category: 'Workshop',              icon: '🎨' };
  if (/barnyard|buddy/i.test(name))      return { category: 'Barnyard Buddy Time',   icon: '🐄' };
  if (/ambassador/i.test(name))          return { category: 'Youth Ambassador',      icon: '⭐' };
  if (/goat/i.test(name))               return { category: 'Farm Care',             icon: '🐐' };
  return { category: 'Visit', icon: '🐾' };
}

// ── Calendar cache ────────────────────────────────────────────────────────────

let _calendarCache  = [];   // array of raw shift objects (no signup counts)
let _cacheExpiresAt = 0;    // epoch ms

const CACHE_TTL_MS = 1 * 60 * 1000; // 1 minute

async function refreshCalendarCache() {
  if (!CALENDAR_ID) throw new Error('GOOGLE_CALENDAR_ID is not set.');

  const calendar = google.calendar({ version: 'v3', auth: getAuth() });

  const now     = new Date();
  const timeMin = now.toISOString();
  // Cap at 60 days ahead — prevents recurring-event explosion into thousands of instances.
  const timeMax = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString();

  // Paginate through all results within the window (API max per page is 2500).
  const events = [];
  let pageToken;
  do {
    const res = await calendar.events.list({
      calendarId:   CALENDAR_ID,
      timeMin,
      timeMax,
      timeZone:     PT,           // return dateTime strings in Pacific Time
      singleEvents: true,         // expand recurring events into individual instances
      orderBy:      'startTime',
      maxResults:   2500,
      pageToken,
    });
    const items = res.data.items || [];
    events.push(...items);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  const shifts = [];

  for (const event of events) {
    const rawTitle = (event.summary || '').trim();
    const desc     = (event.description || '').trim();

    // Skip events that are already full — they're at capacity and not available.
    if (/\bfull\b/i.test(rawTitle)) continue;

    // Try to get shift name from title; skip all-day/untitled events with no usable name.
    const name = parseShiftName(rawTitle);
    if (!name) continue;

    // Look for a capacity limit in the title first, then the description.
    // If neither has one, capacity is null — no limit is shown in the UI.
    const capacity = parseCapacity(rawTitle) ?? parseCapacity(desc) ?? null;
    const has_limit = capacity !== null;

    // Google Calendar sends dateTime for timed events and date for all-day events.
    const startDt = new Date(event.start.dateTime || event.start.date);
    const endDt   = new Date(event.end.dateTime   || event.end.date);

    const { category, icon } = deriveCategory(name);
    const { volunteers: description_volunteers, staff: description_staff } =
      parseDescription(desc);

    shifts.push({
      id:         event.id,        // Google Calendar event ID — stable, unique
      title:      name,
      icon,
      category,
      location:   (event.location || '').trim(),
      date:       toDateStr(startDt),   // "YYYY-MM-DD" in Pacific Time
      start_time: toHHMM(startDt),     // "HH:MM" in Pacific Time
      end_time:   toHHMM(endDt),
      capacity:  has_limit ? capacity : 999999, // unlimited events never fill up
      has_limit,
      description_volunteers, // shown on volunteer + staff pages
      description_staff,      // shown on staff page only
    });
  }

  _calendarCache  = shifts;
  _cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  console.log(`[calendar] cached ${shifts.length} shift(s)`);
  return shifts;
}

// Returns cached shifts, refreshing from the API if the cache has expired.
async function getCachedShifts() {
  if (Date.now() >= _cacheExpiresAt) await refreshCalendarCache();
  return _calendarCache;
}

// Background timer: keeps the cache warm so no visitor has to wait for a
// full API round-trip.  Errors are logged but do not crash the server.
setInterval(async () => {
  try { await refreshCalendarCache(); }
  catch (err) { console.error('[calendar] background refresh failed:', err.message); }
}, CACHE_TTL_MS);

// ── Sheets helpers ────────────────────────────────────────────────────────────
//
// Column layout (A–G):
//   A  Timestamp
//   B  Volunteer Name
//   C  Email
//   D  Shift ID          ← Google Calendar event ID
//   E  Shift Name
//   F  Shift Date
//   G  Shift Time

const SHEET_TAB     = 'signups';
const SHEET_RANGE   = `${SHEET_TAB}!A:I`;
const SHEET_HEADERS = [
  'Timestamp', 'Volunteer Name', 'Email',
  'Shift ID', 'Shift Name', 'Shift Date', 'Shift Time',
  // col H (7) = Signup ID
  // col I (8) = Reminded (managed by send-reminders.js)
];

// Generates a unique 6-character cancellation code (no 0/O/1/I to avoid confusion).
function generateSignupId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// Writes the header row if the sheet is empty, and ensures the Signup ID header
// exists in column H.  Safe to call every startup.
async function ensureHeaders() {
  if (!SHEET_ID) throw new Error('GOOGLE_SHEET_ID is not set.');

  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A1:I1`,
  });

  const existing = (res.data.values || [])[0] || [];

  // Write the base headers if the sheet is brand new.
  if (!existing[0] || existing[0] !== 'Timestamp') {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A1:G1`,
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_HEADERS] },
    });
    console.log('[sheets] header row written');
  }

  // Ensure Signup ID header in column H (index 7).
  if ((existing[7] || '').trim() !== 'Signup ID') {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!H1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Signup ID']] },
    });
    console.log('[sheets] "Signup ID" header added to column H');
  }
}

// Reads every signup row from the sheet and returns plain objects.
async function getAllSignups() {
  if (!SHEET_ID) throw new Error('GOOGLE_SHEET_ID is not set.');

  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_RANGE,
  });

  const rows = res.data.values || [];
  // Row 0 is the header; skip it.  Also skip any row missing a Shift ID.
  return rows
    .slice(1)
    .filter(r => r && r[3])
    .map(r => ({
      timestamp:  r[0] || '',
      name:       r[1] || '',
      email:      r[2] || '',
      shift_id:   r[3] || '',
      shift_name: r[4] || '',
      shift_date: r[5] || '',
      shift_time: r[6] || '',
      signup_id:  r[7] || '',  // col H
      // r[8] = Reminded (col I) — managed by send-reminders.js
    }));
}

// ── Public API ─────────────────────────────────────────────────────────────────

// Shared helper — adds live spot counts to a list of cached shifts.
async function _withCounts(shifts) {
  const signups = await getAllSignups();
  const counts  = {};
  for (const s of signups) counts[s.shift_id] = (counts[s.shift_id] || 0) + 1;
  return shifts.map(shift => {
    const taken      = counts[shift.id] || 0;
    const spots_left = Math.max(0, shift.capacity - taken);
    return { ...shift, taken, spots_left, is_full: spots_left <= 0 };
  });
}

// Returns all upcoming shifts for the public volunteer page.
// description_staff is intentionally omitted — it is staff-only information.
async function getShifts() {
  const shifts = await getCachedShifts();
  const result = await _withCounts(shifts);
  return result.map(({ description_staff, ...pub }) => pub); // strip staff text
}

// Returns all upcoming shifts for the staff page, including both description
// sections so coordinators can see what volunteers will read and what's staff-only.
async function getStaffShifts() {
  const shifts = await getCachedShifts();
  return _withCounts(shifts);
}

// Returns a single shift (with live counts) by calendar event ID.
async function getShiftById(id) {
  const shifts = await getShifts();
  return shifts.find(s => s.id === id) || null;
}

// Returns all shifts with a nested array of signups — used by the admin page.
async function getAdminShifts() {
  const [shifts, signups] = await Promise.all([getCachedShifts(), getAllSignups()]);

  // Group signup rows by shift_id.
  const byShift = {};
  for (const s of signups) {
    (byShift[s.shift_id] = byShift[s.shift_id] || []).push({ name: s.name, email: s.email });
  }

  return shifts.map(shift => {
    const shiftSignups = byShift[shift.id] || [];
    const spots_left   = Math.max(0, shift.capacity - shiftSignups.length);
    return { ...shift, spots_left, is_full: spots_left <= 0, signups: shiftSignups };
  });
}

// Validates and records a volunteer signup.
// Returns { ok: true, message } on success or { ok: false, error } on failure.
async function createSignup(shiftId, name, email) {
  // Fetch shift metadata and all existing signups in parallel.
  const [shift, allSignups] = await Promise.all([
    getShiftById(shiftId),
    getAllSignups(),
  ]);

  if (!shift) {
    return { ok: false, error: 'That shift no longer exists.' };
  }

  // Duplicate check — same email for the same Google Calendar event ID.
  const duplicate = allSignups.some(
    s => s.shift_id === shiftId &&
         s.email.toLowerCase() === email.toLowerCase()
  );
  if (duplicate) {
    return { ok: false, error: 'You are already signed up for this shift.' };
  }

  // Capacity check — count existing signups for this shift.
  const taken = allSignups.filter(s => s.shift_id === shiftId).length;
  if (taken >= shift.capacity) {
    return { ok: false, error: 'Sorry, this shift is now full.' };
  }

  // Generate a unique signup ID (retry if collision, though extremely unlikely).
  const allIds = new Set(allSignups.map(s => s.signup_id).filter(Boolean));
  let signupId;
  do { signupId = generateSignupId(); } while (allIds.has(signupId));

  // Append a new row to the Google Sheet.
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  await sheets.spreadsheets.values.append({
    spreadsheetId:   SHEET_ID,
    range:           SHEET_RANGE,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        new Date().toISOString(),
        name,
        email,
        shift.id,
        shift.title,
        shift.date,
        `${shift.start_time}–${shift.end_time}`,
        signupId,    // col H — Signup ID
        // col I — Reminded (managed by send-reminders.js)
      ]],
    },
  });

  return { ok: true, message: `You're signed up for ${shift.title}. Thank you!`, signupId };
}

// Normalise a time string to "H:MMam/pm" format for comparison.
// Accepts: "9am", "9:00am", "3pm", "3:30pm", "09:00", "15:30", etc.
// Returns null if the string can't be parsed.
function normalizeTime(raw) {
  const s = raw.trim().toLowerCase().replace(/\s/g, '');

  // 12-hour with optional minutes: "9am", "9:00am", "3:30pm"
  const ampm = s.match(/^(\d{1,2})(?::(\d{2}))?([ap]m)$/);
  if (ampm) {
    const h = parseInt(ampm[1], 10);
    const m = parseInt(ampm[2] || '0', 10);
    if (h < 1 || h > 12 || m > 59) return null;
    return `${h}:${String(m).padStart(2, '0')}${ampm[3]}`;
  }

  // 24-hour: "09:00", "15:30" — convert to 12-hour am/pm
  const h24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) {
    let h = parseInt(h24[1], 10);
    const m = parseInt(h24[2], 10);
    if (h > 23 || m > 59) return null;
    const period = h >= 12 ? 'pm' : 'am';
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${String(m).padStart(2, '0')}${period}`;
  }

  return null;
}

// Cancels a volunteer signup by its unique Signup ID (column I).
// Returns { ok: true, message } or { ok: false, error }.
async function cancelSignupById(signupId) {
  if (!SHEET_ID) throw new Error('GOOGLE_SHEET_ID is not set.');

  const id = (signupId || '').trim().toUpperCase();
  if (!id) return { ok: false, error: 'Please enter your cancellation code.' };

  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_RANGE,
  });

  const rows = res.data.values || [];

  // Find row where col H (index 7) matches the signup ID.
  let matchIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][7] || '').trim().toUpperCase() === id) {
      matchIndex = i;
      break;
    }
  }

  if (matchIndex === -1) {
    return {
      ok: false,
      error: 'No signup found with that code. Please check your cancellation code.',
    };
  }

  // Sheet rows are 1-indexed; array index N = sheet row N+1.
  const sheetRow = matchIndex + 1;

  // Delete the entire row so the sheet stays clean (no blank rows).
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId:    0,
            dimension:  'ROWS',
            startIndex: sheetRow - 1,  // 0-indexed
            endIndex:   sheetRow,
          },
        },
      }],
    },
  });

  return { ok: true, message: 'Your signup has been cancelled.' };
}

module.exports = { getShifts, getStaffShifts, getShiftById, getAdminShifts, createSignup, cancelSignupById, ensureHeaders };
