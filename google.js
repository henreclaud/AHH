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

// Extract the shift name: everything in the event title before " Limit".
// e.g. "Pony Visit — Senior Living  Limit 4 volunteers" → "Pony Visit — Senior Living"
function parseShiftName(title) {
  const match = title.match(/^(.+?)\s+Limit\s+\d+/i);
  return match ? match[1].trim() : null;
}

// Extract volunteer capacity from "Limit X volunteers" in the event title.
function parseCapacity(title) {
  const match = title.match(/Limit\s+(\d+)\s+volunteer/i);
  return match ? parseInt(match[1], 10) : null;
}

// Derive the activity category and emoji icon from the shift name.
function deriveCategory(name) {
  if (/pony|horse/i.test(name))      return { category: 'Pony Visit',       icon: '🐴' };
  if (/bunny|rabbit/i.test(name))    return { category: 'Bunny Visit',      icon: '🐰' };
  if (/goat|chore|farm/i.test(name)) return { category: 'Farm Care',        icon: '🐐' };
  if (/mobile|petting/i.test(name))  return { category: 'Mobile Visit',     icon: '🐤' };
  if (/guinea|reading/i.test(name))  return { category: 'Reading Buddies',  icon: '🐹' };
  return { category: 'Visit', icon: '🐾' };
}

// Format a JS Date as "HH:MM" in local time.
function toHHMM(date) {
  return date.toTimeString().slice(0, 5);
}

// ── Calendar cache ────────────────────────────────────────────────────────────

let _calendarCache  = [];   // array of raw shift objects (no signup counts)
let _cacheExpiresAt = 0;    // epoch ms

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function refreshCalendarCache() {
  if (!CALENDAR_ID) throw new Error('GOOGLE_CALENDAR_ID is not set.');

  const calendar = google.calendar({ version: 'v3', auth: getAuth() });

  const timeMin = new Date().toISOString(); // today — skip past events

  // Paginate through all results (API max per page is 2500).
  const events = [];
  let pageToken;
  do {
    const res = await calendar.events.list({
      calendarId:   CALENDAR_ID,
      timeMin,
      singleEvents: true,   // expand recurring events
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
    const name     = parseShiftName(rawTitle);
    const capacity = parseCapacity(rawTitle);

    // Skip any event that doesn't carry a "Limit X volunteers" pattern.
    if (!name || capacity === null) continue;

    // Google Calendar sends dateTime for timed events and date for all-day events.
    const startDt = new Date(event.start.dateTime || event.start.date);
    const endDt   = new Date(event.end.dateTime   || event.end.date);

    const { category, icon } = deriveCategory(name);

    shifts.push({
      id:         event.id,           // Google Calendar event ID — stable, unique
      title:      name,
      icon,
      category,
      location:   (event.location || '').trim(),
      date:       startDt.toISOString().slice(0, 10),  // "YYYY-MM-DD"
      start_time: toHHMM(startDt),
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

module.exports = { getShifts, getShiftById, getAdminShifts, createSignup, ensureHeaders };
