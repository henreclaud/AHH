// google.js — data layer for the AAH volunteer app.
// Replaces db.js (SQLite).
//
// Shifts  → read from Google Calendar (cached 5 min, auto-refreshed).
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

// ── Calendar helpers ──────────────────────────────────────────────────────────

const PT = 'America/Los_Angeles'; // AAH operates in Pacific Time

// Format a JS Date as "HH:MM" in Pacific Time.
function toHHMM(date) {
  return date.toLocaleTimeString('en-US', {
    timeZone: PT,
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  });
}

// Format a JS Date as "YYYY-MM-DD" in Pacific Time.
function toDateStr(date) {
  return date.toLocaleDateString('en-CA', { timeZone: PT }); // en-CA gives YYYY-MM-DD
}

// Patterns that indicate a volunteer limit — checked in title AND description.
// Matches: "Limit 5", "Limit: 5", "Limit 5 volunteers", "5 spots", "5 volunteer spots"
const LIMIT_RE = /(?:limit:?\s*(\d+)(?:\s+volunteers?)?|(\d+)\s+(?:volunteer\s+)?spots?)/i;

// Extract volunteer capacity from a string (title or description).
// Returns an integer, or null if no pattern found.
function parseCapacity(text) {
  if (!text) return null;
  const m = text.match(LIMIT_RE);
  if (!m) return null;
  return parseInt(m[1] || m[2], 10);
}

// Extract the shift name from the event title.
// Strips the limit phrase and any trailing dashes / punctuation.
function parseShiftName(title) {
  // Remove the limit phrase (and everything after it on the same segment).
  const stripped = title
    .replace(/\s*[-–—]?\s*(?:limit:?\s*\d+(?:\s+volunteers?)?|\d+\s+(?:volunteer\s+)?spots?).*/i, '')
    .trim()
    .replace(/[-–—\s]+$/, '') // remove trailing dashes / spaces
    .trim();
  return stripped || null;
}

// Derive the activity category and emoji icon from the shift name.
function deriveCategory(name) {
  if (/pony|horse/i.test(name))       return { category: 'Pony Visit',      icon: '🐴' };
  if (/bunny|rabbit/i.test(name))     return { category: 'Bunny Visit',     icon: '🐰' };
  if (/goat|chore|farm/i.test(name))  return { category: 'Farm Care',       icon: '🐐' };
  if (/mobile|petting/i.test(name))   return { category: 'Mobile Visit',    icon: '🐤' };
  if (/guinea|reading/i.test(name))   return { category: 'Reading Buddies', icon: '🐹' };
  if (/workshop/i.test(name))         return { category: 'Workshop',        icon: '🎨' };
  return { category: 'Visit', icon: '🐾' };
}

// ── Calendar cache ────────────────────────────────────────────────────────────

let _calendarCache  = [];   // array of raw shift objects (no signup counts)
let _cacheExpiresAt = 0;    // epoch ms

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
    // If neither has one, default to 10 spots so the event still shows up.
    const capacity = parseCapacity(rawTitle) ?? parseCapacity(desc) ?? 10;

    // Google Calendar sends dateTime for timed events and date for all-day events.
    const startDt = new Date(event.start.dateTime || event.start.date);
    const endDt   = new Date(event.end.dateTime   || event.end.date);

    const { category, icon } = deriveCategory(name);

    shifts.push({
      id:         event.id,        // Google Calendar event ID — stable, unique
      title:      name,
      icon,
      category,
      location:   (event.location || '').trim(),
      date:       toDateStr(startDt),   // "YYYY-MM-DD" in Pacific Time
      start_time: toHHMM(startDt),     // "HH:MM" in Pacific Time
      end_time:   toHHMM(endDt),
      capacity,
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

const SHEET_RANGE   = 'Sheet1!A:G';
const SHEET_HEADERS = [
  'Timestamp', 'Volunteer Name', 'Email',
  'Shift ID', 'Shift Name', 'Shift Date', 'Shift Time',
];

// Writes the header row if the sheet is empty.  Safe to call every startup.
async function ensureHeaders() {
  if (!SHEET_ID) throw new Error('GOOGLE_SHEET_ID is not set.');

  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Sheet1!A1:G1',
  });

  const existing = (res.data.values || [])[0];
  if (!existing || existing[0] !== 'Timestamp') {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: 'Sheet1!A1:G1',
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_HEADERS] },
    });
    console.log('[sheets] header row written');
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
    }));
}

// ── Public API ─────────────────────────────────────────────────────────────────

// Returns all upcoming shifts with live spots_left and is_full.
async function getShifts() {
  const [shifts, signups] = await Promise.all([getCachedShifts(), getAllSignups()]);

  // Count signups per shift ID in one pass.
  const counts = {};
  for (const s of signups) {
    counts[s.shift_id] = (counts[s.shift_id] || 0) + 1;
  }

  return shifts.map(shift => {
    const taken      = counts[shift.id] || 0;
    const spots_left = Math.max(0, shift.capacity - taken);
    return { ...shift, taken, spots_left, is_full: spots_left <= 0 };
  });
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
      ]],
    },
  });

  return { ok: true, message: `You're signed up for ${shift.title}. Thank you!` };
}

// Normalise a user-entered time string to "HH:MM" (24-hour) for comparison.
// Accepts: "9am", "9:00am", "9:00 am", "3pm", "3:30pm", "09:00", "15:30", etc.
// Returns null if the string can't be parsed.
function normalizeTime(raw) {
  const s = raw.trim().toLowerCase().replace(/\s/g, '');

  // Try 12-hour with optional minutes: 9am / 9:00am / 3:30pm
  const ampm = s.match(/^(\d{1,2})(?::(\d{2}))?([ap]m)$/);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const m = parseInt(ampm[2] || '0', 10);
    if (ampm[3] === 'pm' && h !== 12) h += 12;
    if (ampm[3] === 'am' && h === 12) h = 0;
    if (h > 23 || m > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  // Try 24-hour: 09:00 / 9:00 / 15:30
  const h24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) {
    const h = parseInt(h24[1], 10);
    const m = parseInt(h24[2], 10);
    if (h > 23 || m > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  return null;
}

// Cancels a volunteer signup by matching all four fields:
//   name (col B, case-insensitive), email (col C), date (col F), start time (col G).
// Returns { ok: true, message } or { ok: false, error }.
async function cancelSignup(name, email, date, startTime) {
  if (!SHEET_ID) throw new Error('GOOGLE_SHEET_ID is not set.');

  // Normalise the user's time input to "HH:MM" for comparison.
  const timeNorm = normalizeTime(startTime);
  if (!timeNorm) {
    return { ok: false, error: 'Could not understand that time. Try "9am", "3pm", or "10:30am".' };
  }

  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_RANGE,
  });

  const rows = res.data.values || [];

  const nameNorm  = name.trim().toLowerCase();
  const emailNorm = email.trim().toLowerCase();
  const dateNorm  = date.trim(); // "YYYY-MM-DD"

  // Sheet columns (0-indexed):
  //  0 Timestamp  1 Name  2 Email  3 ShiftID  4 ShiftName  5 ShiftDate  6 ShiftTime
  // Col 6 is stored as "HH:MM–HH:MM" — extract just the start time before the dash.
  let matchIndex = -1;
  for (let i = 1; i < rows.length; i++) {
    const row      = rows[i];
    const rowName  = (row[1] || '').toLowerCase();
    const rowEmail = (row[2] || '').toLowerCase();
    const rowDate  = (row[5] || '').trim();
    const rowTime  = (row[6] || '').split('–')[0].trim(); // "HH:MM" start time

    if (
      rowName  === nameNorm  &&
      rowEmail === emailNorm &&
      rowDate  === dateNorm  &&
      rowTime  === timeNorm
    ) {
      matchIndex = i;
      break;
    }
  }

  if (matchIndex === -1) {
    return {
      ok: false,
      error: 'No signup found. Please double-check your name, email, date, and time.',
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

module.exports = { getShifts, getShiftById, getAdminShifts, createSignup, cancelSignup, ensureHeaders };
