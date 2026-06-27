// google.js — data layer for the AAH volunteer app.
// Replaces db.js (SQLite).
//
// Shifts  → read from Google Calendar (cached 1 min, auto-refreshed).
// Signups → read/write to a Google Sheet.

'use strict';

const crypto = require('crypto');
const { google } = require('googleapis');
const { sendUnregisteredAlert } = require('./mailer');

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
// We do service-account auth by hand instead of using google.auth.GoogleAuth.
//
// Why: GoogleAuth delegates token fetching to gtoken, which hardcodes the
// LEGACY endpoint https://www.googleapis.com/oauth2/v4/token and fetches it via
// node-fetch 2.  On Render that connection dies with "Premature close", so the
// whole app can't authenticate.  Instead we sign the JWT ourselves and POST it
// to the MODERN endpoint https://oauth2.googleapis.com/token using Node's
// built-in fetch (undici), which is reliable on Render.  The resulting token is
// handed to an OAuth2 client whose refreshHandler re-runs this whenever the
// token expires.  We also point that client's transporter at built-in fetch so
// the actual Sheets/Calendar API calls use undici too.

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
].join(' ');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

// Sign a JWT with the service-account key and exchange it for an access token.
async function fetchAccessToken() {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is unavailable — Node 18+ is required.');
  }
  const creds = getCredentials();
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss:   creds.client_email,
    scope: SCOPES,
    aud:   TOKEN_URL,
    exp:   now + 3600,
    iat:   now,
  };

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const signature = crypto.createSign('RSA-SHA256')
    .update(signingInput)
    .sign(creds.private_key, 'base64url');
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google token request failed (${res.status}): ${text}`);
  }
  const data = JSON.parse(text);
  return { access_token: data.access_token, expires_in: data.expires_in || 3600 };
}

// One OAuth2 client shared across the process.  Its refreshHandler is called
// automatically whenever the access token is missing or expired.
let _auth;
function getAuth() {
  if (!_auth) {
    _auth = new google.auth.OAuth2();
    _auth.refreshHandler = async () => {
      const { access_token, expires_in } = await fetchAccessToken();
      return {
        access_token,
        // Refresh a minute early to avoid edge-of-expiry failures.
        expiry_date: Date.now() + (expires_in - 60) * 1000,
      };
    };
    // Route the actual API calls (Sheets/Calendar) through built-in fetch too.
    if (typeof fetch === 'function' && _auth.transporter) {
      _auth.transporter.defaults = {
        ..._auth.transporter.defaults,
        fetchImplementation: fetch,
      };
    }
  }
  return _auth;
}

// ── Description parser ────────────────────────────────────────────────────────
//
// Calendar event descriptions use { } braces to mark staff-only content:
//
//   Please wear closed-toe shoes. {Coordinator: Maria — 555-0100 if late.}
//   Meet at the side entrance on Grove Ave.
//
// Volunteers see the description with all { ... } blocks stripped out.
// Staff see both: the volunteer-facing text, plus a "Staff only" badge showing
// the extracted brace content.
//
// Descriptions with no { } blocks → volunteers = full text, staff = null.
// Descriptions where the full text is inside braces → volunteers = null.

function parseDescription(raw) {
  if (!raw || !raw.trim()) return { volunteers: null, staff: null };

  const text = raw.trim();

  // Collect content from all { ... } blocks (staff-only).
  const staffParts = [];
  const braceRe = /\{([\s\S]*?)\}/g;
  let m;
  while ((m = braceRe.exec(text)) !== null) {
    const inner = m[1].trim();
    if (inner) staffParts.push(inner);
  }

  // Volunteer view: strip { ... } blocks and collapse any double breaks they leave behind.
  const volunteerText = text
    .replace(/\{[\s\S]*?\}/g, '')
    .replace(/(<br\s*\/?>)(\s*<br\s*\/?>\s*)+/gi, '<br>')
    .replace(/\n{2,}/g, '\n')
    .trim();

  return {
    volunteers: volunteerText || null,
    staff:      staffParts.length ? staffParts.join('<br>') : null,
  };
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

    // A title wrapped entirely in { } marks the event as staff-only (hidden from volunteers).
    const staff_only = rawTitle.startsWith('{');
    const titleRaw   = staff_only ? rawTitle.replace(/^\{|\}$/g, '').trim() : rawTitle;

    // Try to get shift name from title; skip all-day/untitled events with no usable name.
    const name = parseShiftName(titleRaw);
    if (!name) continue;

    // Look for a capacity limit in the title first, then the description.
    // If neither has one, capacity is null — no limit is shown in the UI.
    const capacity = parseCapacity(titleRaw) ?? parseCapacity(desc) ?? null;
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
      staff_only,
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

const SHEET_TAB          = 'signups';
const SHEET_RANGE        = `${SHEET_TAB}!A:O`;  // used for reads (A–O)
const SHEET_APPEND_RANGE = `${SHEET_TAB}!A1`;   // used for appends — anchors at A1 so
                                                 // Google Sheets always appends starting
                                                 // at column A, not a sparse later column
// Column layout:
//   A Timestamp  B Name  C Email  D Shift ID  E Shift Name  F Shift Date  G Shift Time
//   H Signup ID  I Reminded  J Registered  K Attendance
//   L Check-in Time  M Check-out Time  N Hours Logged
const PWD_TAB       = 'pwd';
const REG_TAB       = 'registered volunteers';
const SHEET_HEADERS = [
  'Timestamp', 'Volunteer Name', 'Email',
  'Shift ID', 'Shift Name', 'Shift Date', 'Shift Time',
  // col H (7) = Signup ID
  // col I (8) = Reminded (managed by send-reminders.js)
  // col J (9) = Registered (Yes/No — blank for rows created before this feature)
];

// Generates a unique 6-character cancellation code (no 0/O/1/I to avoid confusion).
function generateSignupId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  // crypto.randomInt is a CSPRNG — unlike Math.random(), the IDs can't be
  // predicted, so they can't be guessed to cancel someone else's signup.
  for (let i = 0; i < 6; i++) id += chars[crypto.randomInt(chars.length)];
  return id;
}

// Neutralizes spreadsheet formula / CSV injection. With the USER_ENTERED write
// mode, Google Sheets treats a cell that begins with = + - @ (or tab/CR) as a
// live formula — so a volunteer signing up as `=HYPERLINK("http://evil","x")`
// would run code in staff's account when they open the sheet. Prefixing a
// single quote forces the cell to plain text; the quote is consumed by Sheets
// (not stored or displayed), so values still read back cleanly via the API.
function sanitizeForSheet(value) {
  const s = String(value ?? '');
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

// Writes the header row if the sheet is empty, and ensures column headers for
// Signup ID (H) and Registered (J) exist.  Safe to call every startup.
async function ensureHeaders() {
  if (!SHEET_ID) throw new Error('GOOGLE_SHEET_ID is not set.');

  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!A1:N1`,
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

  // Ensure Registered header in column J (index 9).
  if ((existing[9] || '').trim() !== 'Registered') {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!J1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Registered']] },
    });
    console.log('[sheets] "Registered" header added to column J');
  }

  // Ensure Attendance header in column K (index 10).
  if ((existing[10] || '').trim() !== 'Attendance') {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!K1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Attendance']] },
    });
    console.log('[sheets] "Attendance" header added to column K');
  }

  // Ensure Check-in Time header in column L (index 11).
  if ((existing[11] || '').trim() !== 'Check-in Time') {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!L1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Check-in Time']] },
    });
    console.log('[sheets] "Check-in Time" header added to column L');
  }

  // Ensure Check-out Time header in column M (index 12).
  if ((existing[12] || '').trim() !== 'Check-out Time') {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!M1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Check-out Time']] },
    });
    console.log('[sheets] "Check-out Time" header added to column M');
  }

  // Ensure Hours Logged header in column N (index 13).
  if ((existing[13] || '').trim() !== 'Hours Logged') {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!N1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Hours Logged']] },
    });
    console.log('[sheets] "Hours Logged" header added to column N');
  }

  // Ensure Notes header in column O (index 14).
  if ((existing[14] || '').trim() !== 'Notes') {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!O1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['Notes']] },
    });
    console.log('[sheets] "Notes" header added to column O');
  }

  // Ensure shift_notes tab has a header row.
  try {
    const snRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range:         'shift_notes!A1',
    });
    const snA1 = ((snRes.data.values || [])[0] || [])[0] || '';
    if (snA1.trim() !== 'Timestamp') {
      await sheets.spreadsheets.values.update({
        spreadsheetId:    SHEET_ID,
        range:            'shift_notes!A1',
        valueInputOption: 'RAW',
        requestBody:      { values: [['Timestamp', 'Date', 'Shift Name', 'Shift Time', 'Note']] },
      });
      console.log('[sheets] shift_notes header row written');
    }
  } catch {
    // Tab doesn't exist yet — headers will be added when the first note is saved.
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
      registered:    r[9]  || '',  // col J
      attendance:    r[10] || '',  // col K — 'Attended', 'No-show', or ''
      checkin_time:  r[11] ? (formatPacific(new Date(r[11])) || r[11]) : '',  // col L
      checkout_time: r[12] ? (formatPacific(new Date(r[12])) || r[12]) : '',  // col M
      hours_logged:  r[13] || '',  // col N — decimal hours
      notes:         r[14] || '',  // col O — staff report notes
    }));
}

// Returns all upcoming signups (today or future) for the given email address.
// "Upcoming" = shift_date >= today in Pacific time AND not already attended.
async function getUpcomingSignupsByEmail(email) {
  const today   = todayPacific();
  const signups = await getAllSignups();
  const norm    = (email || '').trim().toLowerCase();
  return signups
    .filter(s =>
      s.email.toLowerCase() === norm &&
      s.attendance !== 'Attended' &&
      s.attendance !== 'No-show'
    )
    .map(s => ({
      signup_id:  s.signup_id,
      name:       s.name,
      shift_name: s.shift_name,
      shift_date: s.shift_date,
      shift_time: s.shift_time,
    }));
}

// ── Public API ─────────────────────────────────────────────────────────────────

// Shared helper — adds live spot counts to a list of cached shifts.
// Youth Ambassadors (registered === 'YA') don't count toward the spot limit.
async function _withCounts(shifts) {
  const signups  = await getAllSignups();
  const counts   = {};  // non-YA signups only
  for (const s of signups) {
    if (s.registered === 'YA') continue;
    counts[s.shift_id] = (counts[s.shift_id] || 0) + 1;
  }
  const farmAddr = (process.env.FARM_ADDRESS || '').trim().toLowerCase();
  return shifts.map(shift => {
    const taken      = counts[shift.id] || 0;
    const spots_left = Math.max(0, shift.capacity - taken);
    const is_farm    = farmAddr ? (shift.location || '').toLowerCase().includes(farmAddr) : false;
    return { ...shift, taken, spots_left, is_full: spots_left <= 0, is_farm };
  });
}

// Returns all upcoming shifts for the public volunteer page.
// Excludes: events with no volunteer limit (QA#1), { }-wrapped titles (QA#2),
// HIDE-prefixed titles, and staff-only fields are stripped from the response.
async function getShifts() {
  const shifts = await getCachedShifts();
  const result = await _withCounts(shifts);
  return result
    .filter(s => !s.staff_only)                    // { }-wrapped title = staff-only event
    .filter(s => !/^hide\b/i.test(s.title || '')) // HIDE- prefix = staff-only event
    .map(({ description_staff, staff_only, ...pub }) => pub);
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
    (byShift[s.shift_id] = byShift[s.shift_id] || []).push({
      name: s.name, email: s.email, registered: s.registered,
      is_ya: s.registered === 'YA',
      attendance: s.attendance, signup_id: s.signup_id,
      checkin_time: s.checkin_time, checkout_time: s.checkout_time, hours_logged: s.hours_logged,
    });
  }

  const farmAddr = (process.env.FARM_ADDRESS || '').trim().toLowerCase();
  return shifts.map(shift => {
    const shiftSignups = byShift[shift.id] || [];
    const spots_left   = Math.max(0, shift.capacity - shiftSignups.length);
    const is_farm      = farmAddr ? (shift.location || '').toLowerCase().includes(farmAddr) : false;
    return { ...shift, spots_left, is_full: spots_left <= 0, signups: shiftSignups, is_farm };
  });
}

// ── Registered volunteers cache ───────────────────────────────────────────────
//
// The "registered volunteers" tab holds approved volunteer emails plus flags.
// Cache: Map<lowercaseEmail, { registered: true, is_ya: boolean }>
// Binary search is no longer needed — Map lookup is O(1).

let _regCache      = null;   // Map<email, { registered, is_ya }>
let _regExpiresAt  = 0;
const REG_CACHE_MS = 5 * 60 * 1000; // 5 minutes

async function getRegisteredEmails() {
  if (_regCache && Date.now() < _regExpiresAt) return _regCache;

  if (!SHEET_ID) throw new Error('GOOGLE_SHEET_ID is not set.');
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range:         `${REG_TAB}!A:Z`,
  });

  const rows = res.data.values || [];
  if (!rows.length) { _regCache = new Map(); _regExpiresAt = Date.now() + REG_CACHE_MS; return _regCache; }

  // First row is the header — find the email column (col A, index 0) and the
  // "Youth Ambassador" column (case-insensitive header match).
  const headers  = rows[0].map(h => (h || '').trim().toLowerCase());
  const emailIdx = headers.findIndex(h => h === 'email' || h.includes('@') || h === 'emails');
  const yaIdx    = headers.findIndex(h => h.includes('youth') || h.includes('ambassador') || h === 'ya');

  // Fall back to column A for email if header not found.
  const eIdx = emailIdx >= 0 ? emailIdx : 0;

  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const email = (rows[i][eIdx] || '').trim().toLowerCase();
    if (!email || !email.includes('@')) continue;
    const yaVal = yaIdx >= 0 ? (rows[i][yaIdx] || '').trim() : '';
    const is_ya = yaVal === '1' || yaVal.toLowerCase() === 'true';
    map.set(email, { registered: true, is_ya });
  }

  _regCache     = map;
  _regExpiresAt = Date.now() + REG_CACHE_MS;
  console.log(`[registered] loaded ${map.size} volunteers (YA col: ${yaIdx >= 0 ? headers[yaIdx] : 'not found'})`);
  return _regCache;
}

// Returns { registered: boolean, is_ya: boolean } for an email address.
function lookupVolunteer(regMap, email) {
  const entry = regMap.get(email.toLowerCase().trim());
  return entry || { registered: false, is_ya: false };
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

  // Duplicate check — same name AND email for the same shift (case-insensitive).
  // Two people sharing an email but with different names (e.g. parent + child) are allowed.
  const duplicate = allSignups.some(
    s => s.shift_id === shiftId &&
         s.email.toLowerCase() === email.toLowerCase() &&
         s.name.toLowerCase()  === name.toLowerCase()
  );
  if (duplicate) {
    return { ok: false, error: 'You are already signed up for this shift.' };
  }

  // Check registration and YA status — non-fatal if the lookup fails.
  let registeredFlag = '';
  let isYA           = false;
  try {
    const regMap = await getRegisteredEmails();
    const info   = lookupVolunteer(regMap, email);
    registeredFlag = info.registered ? 'Yes' : 'No';
    isYA           = info.is_ya;
  } catch (err) {
    console.warn('[registered] could not check registration:', err.message);
  }

  // Capacity check — Youth Ambassadors don't count against the spot limit.
  if (!isYA) {
    const taken = allSignups.filter(s => s.shift_id === shiftId && s.registered !== 'YA').length;
    if (taken >= shift.capacity) {
      return { ok: false, error: 'Sorry, this shift is now full.' };
    }
  }

  // Generate a unique signup ID (retry if collision, though extremely unlikely).
  const allIds = new Set(allSignups.map(s => s.signup_id).filter(Boolean));
  let signupId;
  do { signupId = generateSignupId(); } while (allIds.has(signupId));

  // Append a new row to the Google Sheet.
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  await sheets.spreadsheets.values.append({
    spreadsheetId:   SHEET_ID,
    range:           SHEET_APPEND_RANGE,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[
        new Date().toISOString(),
        sanitizeForSheet(name),
        sanitizeForSheet(email),
        shift.id,
        sanitizeForSheet(shift.title),
        shift.date,
        `${shift.start_time}-${shift.end_time}`,
        signupId,       // col H — Signup ID
        '',             // col I — Reminded (managed by send-reminders.js)
        isYA ? 'YA' : registeredFlag, // col J — 'YA', 'Yes', 'No', or '' if lookup failed
      ]],
    },
  });

  // Confirmation email is handled by the Google Sheet Apps Script trigger.

  // Alert staff if the volunteer is not registered (fire-and-forget, non-fatal).
  if (registeredFlag === 'No') {
    sendUnregisteredAlert({
      name, email,
      shiftName: shift.title,
      date:      shift.date,
      time:      `${shift.start_time}-${shift.end_time}`,
    }).catch(err => console.warn('[alert] unregistered alert failed:', err.message));
  }

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

// ── Attendance helpers ────────────────────────────────────────────────────────

// Returns today's date string in YYYY-MM-DD format, Pacific time.
function todayPacific() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

// Parses a time string like "9:00am" or "3:30pm" → minutes since midnight.
function timeToMinutes(str) {
  const m = (str || '').trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?([ap]m)$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2] || '0', 10);
  if (m[3] === 'pm' && h !== 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  return h * 60 + min;
}

// Returns true if the current Pacific time falls within the check-in window
// for a shift whose time string looks like "9:00am–11:00am".
// Window: 30 minutes before start through 30 minutes after end.
const CHECKIN_BUFFER_MINS = 30;

function isCheckinWindowOpen(shiftTimeStr) {
  const [startStr, endStr] = (shiftTimeStr || '').split(/[-–—]/);
  const startMins = timeToMinutes(startStr);
  const endMins   = timeToMinutes(endStr);
  if (startMins === null || endMins === null) return true; // can't parse → allow

  // Current time in Pacific, as minutes since midnight.
  const now        = new Date();
  const pacificNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const nowMins    = pacificNow.getHours() * 60 + pacificNow.getMinutes();

  return nowMins >= startMins - CHECKIN_BUFFER_MINS &&
         nowMins <= endMins   + CHECKIN_BUFFER_MINS;
}

// Formats a Date as a readable Pacific time string for the sheet.
// e.g. "Jun 13, 2026, 9:05 AM"
function formatPacific(date) {
  return date.toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

// Looks up signups for a given email + name on today's date (Pacific time)
// that are within the check-in window (30 min before start → 30 min after end).
// Matching on BOTH email and name lets two people sharing an email be tracked separately.
// Returns a map of calendar event ID → location string for all cached shifts.
async function _farmLocationMap() {
  const farmAddr = (process.env.FARM_ADDRESS || '').trim().toLowerCase();
  if (!farmAddr) return null; // no filter configured — allow all shifts
  const shifts = await getCachedShifts();
  const map = {};
  shifts.forEach(s => { map[s.id] = (s.location || '').toLowerCase(); });
  return { map, farmAddr };
}

async function getTodaySignupsForPerson(email, name) {
  const today   = todayPacific();
  const signups = await getAllSignups();
  let results = signups.filter(s =>
    s.email.toLowerCase() === email.toLowerCase().trim() &&
    s.name.toLowerCase()  === name.toLowerCase().trim()  &&
    s.shift_date === today &&
    isCheckinWindowOpen(s.shift_time)
  );

  // When FARM_ADDRESS is set, restrict QR check-in to farm-location shifts only.
  const loc = await _farmLocationMap();
  if (loc) results = results.filter(s => (loc.map[s.shift_id] || '').includes(loc.farmAddr));

  return results;
}

// Looks up today's signups for a person that have been checked in but not yet checked out.
// No strict time window for check-out — just needs to be the same day.
async function getTodayCheckoutsForPerson(email, name) {
  const today   = todayPacific();
  const signups = await getAllSignups();
  let results = signups.filter(s =>
    s.email.toLowerCase() === email.toLowerCase().trim() &&
    s.name.toLowerCase()  === name.toLowerCase().trim()  &&
    s.shift_date === today &&
    s.attendance === 'Attended' &&
    !s.checkout_time
  );

  // Same farm filter — checkouts should also be farm-only.
  const loc = await _farmLocationMap();
  if (loc) results = results.filter(s => (loc.map[s.shift_id] || '').includes(loc.farmAddr));

  return results;
}

// Helper — finds the 1-indexed sheet row for a signup_id.
async function findSheetRow(sheets, signupId) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range:         SHEET_RANGE,
  });
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][7] || '').trim().toUpperCase() === signupId.trim().toUpperCase()) {
      return { row: i + 1, rowData: rows[i] };
    }
  }
  return { row: -1, rowData: null };
}

// Marks a volunteer as checked in: sets K=Attended, L=check-in timestamp.
async function markCheckIn(signupId) {
  if (!SHEET_ID) throw new Error('GOOGLE_SHEET_ID is not set.');
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  const { row } = await findSheetRow(sheets, signupId);
  if (row === -1) return { ok: false, error: 'Signup not found.' };

  const now = new Date();
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${SHEET_TAB}!K${row}`, values: [['Attended']] },
        { range: `${SHEET_TAB}!L${row}`, values: [[now.toISOString()]] },
      ],
    },
  });

  return { ok: true, checkin_time: formatPacific(now) };
}

// Marks a volunteer as checked out: sets M=check-out timestamp, N=hours worked.
async function markCheckOut(signupId) {
  if (!SHEET_ID) throw new Error('GOOGLE_SHEET_ID is not set.');
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  const { row, rowData } = await findSheetRow(sheets, signupId);
  if (row === -1) return { ok: false, error: 'Signup not found.' };

  const checkinStr = rowData ? (rowData[11] || '') : '';
  const now        = new Date();
  let   hours      = '';

  if (checkinStr) {
    // Parse the stored Pacific-time string back to a Date for hour computation.
    const checkinDate = new Date(checkinStr);
    if (!isNaN(checkinDate)) {
      hours = ((now - checkinDate) / (1000 * 60 * 60)).toFixed(2);
    }
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data: [
        { range: `${SHEET_TAB}!M${row}`, values: [[now.toISOString()]] },
        { range: `${SHEET_TAB}!N${row}`, values: [[hours]] },
      ],
    },
  });

  return { ok: true, checkout_time: formatPacific(now), hours: hours ? parseFloat(hours) : null };
}

// Scans all signups for a given date and writes 'No-show' to any row where
// attendance is still blank.  Defaults to today (Pacific time) if no date given.
// Called nightly at 11:59pm Pacific via node-cron and also via HTTP endpoint.
async function markNoShows(dateStr) {
  if (!SHEET_ID) throw new Error('GOOGLE_SHEET_ID is not set.');
  const targetDate = dateStr || todayPacific();
  const sheets     = google.sheets({ version: 'v4', auth: getAuth() });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range:         SHEET_RANGE,
  });

  const rows    = res.data.values || [];
  const updates = [];

  for (let i = 1; i < rows.length; i++) {
    const row        = rows[i];
    if (!row || !row[3]) continue;              // skip rows without a shift ID
    const shiftDate  = (row[5]  || '').trim(); // col F
    const attendance = (row[10] || '').trim(); // col K
    if (shiftDate === targetDate && !attendance) {
      updates.push({ range: `${SHEET_TAB}!K${i + 1}`, values: [['No-show']] });
    }
  }

  if (updates.length === 0) {
    console.log(`[no-show] no unfilled rows for ${targetDate}`);
    return { marked: 0, date: targetDate };
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody:   { valueInputOption: 'RAW', data: updates },
  });

  console.log(`[no-show] marked ${updates.length} no-shows for ${targetDate}`);
  return { marked: updates.length, date: targetDate };
}

// ── Password helpers ──────────────────────────────────────────────────────────
//
// Reads the "pwd" tab on the Google Sheet.
// Expected layout (order of rows does not matter; a header row is fine):
//
//   A        B
//   admin    <admin password>
//   staff    <staff password>
//
// Results are cached for 5 minutes so a password change takes effect quickly
// without hammering the Sheets API on every login attempt.

let _pwdCache      = null;
let _pwdExpiresAt  = 0;
const PWD_CACHE_MS = 5 * 60 * 1000; // 5 minutes

async function getPasswords() {
  if (_pwdCache && Date.now() < _pwdExpiresAt) return _pwdCache;

  if (!SHEET_ID) throw new Error('GOOGLE_SHEET_ID is not set.');
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range:         `${PWD_TAB}!A:B`,
  });

  const rows   = res.data.values || [];
  const result = { admin: null, staff: null };

  for (const row of rows) {
    const label = (row[0] || '').trim().toLowerCase();
    const pwd   = (row[1] || '').trim();
    if (label === 'admin' && pwd) result.admin = pwd;
    if (label === 'staff' && pwd) result.staff = pwd;
  }

  _pwdCache     = result;
  _pwdExpiresAt = Date.now() + PWD_CACHE_MS;
  console.log('[passwords] loaded from sheet');
  return result;
}

// ── Staff attendance report ───────────────────────────────────────────────────

// Calculates decimal hours from a shift time string like "9:00am–11:00am".
function calcHoursFromTimeRange(timeStr) {
  const parts = (timeStr || '').split(/[-–—]/);
  if (parts.length < 2) return null;
  const start = timeToMinutes(parts[0].trim());
  const end   = timeToMinutes(parts[1].trim());
  if (start === null || end === null) return null;
  return Math.round((end - start) / 60 * 100) / 100;
}

// Returns all signups for a given date grouped by shift, sorted by start time.
async function getSignupsForReportDate(date) {
  const allSignups = await getAllSignups();
  const filtered   = allSignups.filter(s => s.shift_date === date);

  const map = new Map();
  for (const s of filtered) {
    const key = `${s.shift_name}|${s.shift_time}`;
    if (!map.has(key)) {
      map.set(key, { shift_name: s.shift_name, shift_time: s.shift_time, signups: [] });
    }
    map.get(key).signups.push({
      signup_id:    s.signup_id,
      name:         s.name,
      email:        s.email,
      registered:   s.registered,
      attendance:   s.attendance,
      hours_logged: s.hours_logged,
      notes:        s.notes,
    });
  }

  return [...map.values()].sort((a, b) => {
    const aM = timeToMinutes((a.shift_time || '').split(/[-–—]/)[0].trim()) ?? 0;
    const bM = timeToMinutes((b.shift_time || '').split(/[-–—]/)[0].trim()) ?? 0;
    return aM - bM;
  });
}

// Marks a volunteer as Attended or No-show from the staff report.
// For Attended, auto-calculates hours from the shift time stored in col G.
async function markAttendanceReport(signupId, status, notes) {
  if (!SHEET_ID) throw new Error('GOOGLE_SHEET_ID is not set.');
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  const { row, rowData } = await findSheetRow(sheets, signupId);
  if (row === -1) return { ok: false, error: 'Signup not found.' };

  const updates = [{ range: `${SHEET_TAB}!K${row}`, values: [[status]] }];

  let hours = null;
  if (status === 'Attended') {
    hours = calcHoursFromTimeRange(rowData ? (rowData[6] || '') : '');
    if (hours !== null) {
      updates.push({ range: `${SHEET_TAB}!N${row}`, values: [[hours.toFixed(2)]] });
    }
  } else {
    updates.push({ range: `${SHEET_TAB}!N${row}`, values: [['']] });
  }

  if (notes !== undefined && notes !== null) {
    updates.push({ range: `${SHEET_TAB}!O${row}`, values: [[String(notes)]] });
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody:   { valueInputOption: 'RAW', data: updates },
  });

  return { ok: true, hours };
}

// Returns the most recent note for a given shift date + name from the shift_notes tab.
async function getShiftNotes(date, shiftName) {
  if (!SHEET_ID) throw new Error('GOOGLE_SHEET_ID is not set.');
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });
  try {
    const res  = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range:         'shift_notes!A:E',
    });
    const rows     = res.data.values || [];
    const matching = rows.filter(r => r[1] === date && r[2] === shiftName);
    if (!matching.length) return null;
    return matching[matching.length - 1][4] || null;
  } catch (err) {
    if (err.code === 400 || (err.message || '').includes('Unable to parse range')) return null;
    throw err;
  }
}

// Appends a shift-level note to the 'shift_notes' tab.
// Auto-creates the tab on first use if it doesn't exist.
async function addShiftNote(date, shiftName, shiftTime, note) {
  if (!SHEET_ID) throw new Error('GOOGLE_SHEET_ID is not set.');
  // Normalise any en/em dash in the time range to a plain hyphen before writing.
  shiftTime = String(shiftTime || '').replace(/[–—]/g, '-');
  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  async function doAppend() {
    await sheets.spreadsheets.values.append({
      spreadsheetId:    SHEET_ID,
      range:            'shift_notes!A1',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[new Date().toISOString(), date, sanitizeForSheet(shiftName), shiftTime, sanitizeForSheet(note)]],
      },
    });
  }

  try {
    await doAppend();
  } catch (err) {
    // Tab doesn't exist yet — create it with headers, then append the note.
    if (err.code === 400 || (err.message || '').includes('Unable to parse range')) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody:   { requests: [{ addSheet: { properties: { title: 'shift_notes' } } }] },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId:    SHEET_ID,
        range:            'shift_notes!A1',
        valueInputOption: 'RAW',
        requestBody:      { values: [['Timestamp', 'Date', 'Shift Name', 'Shift Time', 'Note']] },
      });
      await doAppend();
    } else {
      throw err;
    }
  }
  return { ok: true };
}

module.exports = { getShifts, getStaffShifts, getShiftById, getAdminShifts, createSignup, cancelSignupById, getUpcomingSignupsByEmail, ensureHeaders, getPasswords, getTodaySignupsForPerson, getTodayCheckoutsForPerson, markCheckIn, markCheckOut, markNoShows, getSignupsForReportDate, markAttendanceReport, addShiftNote, getShiftNotes, sanitizeForSheet };
