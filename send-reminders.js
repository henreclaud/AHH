#!/usr/bin/env node
// send-reminders.js — run once per execution by GitHub Actions (every hour).
//
// What it does:
//   1. Reads all signup rows from the Google Sheet
//   2. Looks up each upcoming signup's calendar event. If staff have moved the
//      event, the row's date/time is updated to match and the volunteer is
//      emailed about the change (with a cancel link), per Peter, Oct 2026.
//   3. For each row whose shift starts within ~26 hours (and isn't already
//      reminded), sends a reminder email and marks column I "Reminded" = Yes
//   4. Exits when done
//
// Run manually to test:
//   GMAIL_USER=you@gmail.com GMAIL_APP_PASSWORD=xxxx node send-reminders.js

'use strict';

require('dotenv').config();

const { google } = require('googleapis');
const { sendReminderEmail, sendChangeEmail } = require('./mailer');
const {
  toDateStr, normalizeDateStr, normalizeTimeRange, eventSlot, hasMoved,
} = require('./calendar-sync');

// ── Config ────────────────────────────────────────────────────────────────────

const SHEET_ID    = process.env.GOOGLE_SHEET_ID;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;
const APP_URL   = (process.env.APP_URL || 'https://ahh-yozo.onrender.com').replace(/\/$/, '');
const CANCEL_URL = `${APP_URL}/cancel.html`;

// Sheet column layout (0-indexed):
//  A(0) Timestamp  B(1) Name  C(2) Email  D(3) ShiftID  E(4) ShiftName
//  F(5) ShiftDate  G(6) ShiftTime  H(7) Signup ID  I(8) Reminded
//  J(9) Registered  K(10) Attendance  …  P(15) Change Notice
const COL = {
  NAME: 1, EMAIL: 2, SHIFT_ID: 3, SHIFT_NAME: 4, DATE: 5, TIME: 6,
  SIGNUP_ID: 7, REMINDED: 8, ATTENDANCE: 10, NOTICE: 15,
};
const SHEET_RANGE = 'signups!A:P';

// Reminder window: send when the shift is roughly a day away. The window is wide
// (1–26 h) on purpose — GitHub Actions runs the hourly cron irregularly (often
// multi-hour gaps), so a narrow window would skip people entirely. The
// "Reminded = Yes" guard below still ensures each person is emailed only once.
const WINDOW_MIN_MS = 1  * 60 * 60 * 1000;  // stop reminding once the shift is <1h away
const WINDOW_MAX_MS = 26 * 60 * 60 * 1000;  // start reminding up to ~26h before

// Moved events: rows up to 2 days old are still checked, so an event moved
// late at night (or just after its old date) is still caught.
const MOVE_LOOKBACK_DAYS = 2;
// Safety stop: if a single run finds more than this many moved EVENTS and
// they're more than half of all upcoming events with signups, something is
// wrong (e.g. a date bug) rather than staff rescheduling — so nothing is
// changed or emailed. Counted in events, not signups, so moving one big event
// with lots of volunteers is never blocked.
const MASS_MOVE_LIMIT = 10;

// Column P records each move, so staff can see it (and when it happened), and
// so a volunteer is only ever emailed once per move:
//   "Moved from 2026-10-10 9:00am-11:00am (changed 2026-10-05) · notice pending"
//   "Moved from 2026-10-10 9:00am-11:00am (changed 2026-10-05) · volunteer emailed 2026-10-05"
const PENDING = 'notice pending';
const NOTICE_RE = /^Moved from (\d{4}-\d{2}-\d{2}) (\S+)/;

// ── Google Auth ───────────────────────────────────────────────────────────────

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set.');
  let creds;
  try { creds = JSON.parse(raw); }
  catch { creds = JSON.parse(raw.replace(/\\n/g, '\n')); }
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      // Read-only: the job only reads events (date, time, location).
      'https://www.googleapis.com/auth/calendar.readonly',
    ],
  });
}

// ── Calendar events ───────────────────────────────────────────────────────────
//
// Fetches each event by ID, so an event is found wherever staff moved it.
// Result: Map of event ID → event, or → null when the event was deleted or
// cancelled. IDs that couldn't be read (network error etc.) are left out, and
// rows for them are simply left alone this run.
async function fetchEventsById(auth, ids) {
  const map = new Map();
  if (!CALENDAR_ID) {
    console.warn('[calendar] GOOGLE_CALENDAR_ID not set — no move checks, reminders omit locations.');
    return map;
  }
  const calendar = google.calendar({ version: 'v3', auth });
  const queue = [...ids];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        const { data } = await calendar.events.get({ calendarId: CALENDAR_ID, eventId: id });
        map.set(id, data.status === 'cancelled' ? null : data);
      } catch (err) {
        const code = Number(err.status || err.code || (err.response && err.response.status));
        if (code === 404 || code === 410) map.set(id, null);
        else console.warn(`[calendar] could not read event ${id}:`, err.message);
      }
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker)); // 5 lookups at a time
  console.log(`[calendar] looked up ${ids.length} event(s), ${[...map.values()].filter(Boolean).length} found`);
  return map;
}

// ── Sheet helpers ─────────────────────────────────────────────────────────────

const cell = (row, col) => String((row && row[col]) || '').trim();

// Row numbers shift whenever someone cancels (their row is deleted), so
// writes are addressed by Signup ID, re-read right before writing.
async function rowNumbersBySignupId(sheets) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'signups!H:H' });
  const map = new Map();
  (res.data.values || []).forEach((r, idx) => {
    const id = String(r[0] || '').trim();
    if (idx > 0 && id) map.set(id, idx + 1);
  });
  return map;
}

async function ensureHeader(sheets, header, col, letter, title) {
  if ((header[col] || '').trim() === title) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId:   SHEET_ID,
    range:           `signups!${letter}1`,
    valueInputOption: 'RAW',
    requestBody:     { values: [[title]] },
  });
  console.log(`[sheet] Added "${title}" header to column ${letter}.`);
}

// ── Moved events ──────────────────────────────────────────────────────────────

// Finds signups whose event has moved, and updates their rows: new date and
// time, "Reminded" cleared (so they get a fresh reminder for the new time),
// and a pending notice in column P. Mutates `rows` to match.
async function applyMoves(sheets, rows, events, now) {
  const cutoff = toDateStr(new Date(now.getTime() - MOVE_LOOKBACK_DAYS * 864e5));
  const changes = [];
  const eligibleEvents = new Set();
  const movedEvents    = new Set();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const signupId = cell(row, COL.SIGNUP_ID);
    const event    = events.get(cell(row, COL.SHIFT_ID));
    if (!signupId || cell(row, COL.ATTENDANCE)) continue;          // already checked in / no-show
    if (normalizeDateStr(cell(row, COL.DATE)) < cutoff) continue;  // long past
    eligibleEvents.add(cell(row, COL.SHIFT_ID));
    if (!event) continue;                                          // deleted, or couldn't read it

    const slot = eventSlot(event);
    if (!hasMoved(cell(row, COL.DATE), cell(row, COL.TIME), slot)) continue;
    if (slot.startMs <= now.getTime()) continue;                   // moved into the past — leave it

    // What the volunteer last heard: the original slot if they haven't been
    // emailed about an earlier move yet, otherwise the row as it stands.
    const notice = cell(row, COL.NOTICE);
    const prior  = notice.includes(PENDING) && NOTICE_RE.exec(notice);
    const from   = prior
      ? { date: prior[1], time: prior[2] }
      : { date: normalizeDateStr(cell(row, COL.DATE)), time: normalizeTimeRange(cell(row, COL.TIME)) };
    // Moved back to where it was before anyone was told: no email needed.
    const backToStart = from.date === slot.date && from.time === normalizeTimeRange(slot.time);

    movedEvents.add(cell(row, COL.SHIFT_ID));
    changes.push({
      i, signupId,
      date: slot.date, time: slot.time,
      notice: backToStart ? '' : `Moved from ${from.date} ${from.time} (changed ${toDateStr(now)}) · ${PENDING}`,
    });
  }

  if (!changes.length) return 0;
  if (movedEvents.size > MASS_MOVE_LIMIT && movedEvents.size > eligibleEvents.size / 2) {
    console.error(`[moves] SAFETY STOP: ${movedEvents.size} of ${eligibleEvents.size} upcoming events look moved. ` +
                  'Nothing was changed or emailed — please check the calendar and this job.');
    return 0;
  }

  const rowNo = await rowNumbersBySignupId(sheets);
  const data = [];
  for (const c of changes) {
    const r = rowNo.get(c.signupId);
    if (!r) continue; // cancelled in the meantime
    data.push(
      { range: `signups!F${r}:G${r}`, values: [[c.date, c.time]] },
      { range: `signups!I${r}`,       values: [['']] },
      { range: `signups!P${r}`,       values: [[c.notice]] },
    );
    const row = rows[c.i];
    while (row.length <= COL.NOTICE) row.push('');
    row[COL.DATE] = c.date; row[COL.TIME] = c.time; row[COL.REMINDED] = ''; row[COL.NOTICE] = c.notice;
    console.log(`[moves] ${c.signupId} → ${c.date} ${c.time}`);
  }
  if (data.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody:   { valueInputOption: 'RAW', data },
    });
  }
  return data.length / 3;
}

// Emails every volunteer with a pending move notice, then marks it sent.
// A failed email stays pending and is retried on the next run.
//
// Signups that share an email AND an event (a parent who signed up several
// children with "Count me in and add another") get ONE email naming them all,
// not one identical email per child.
async function sendMoveNotices(sheets, rows, events, now) {
  const today  = toDateStr(now);
  const groups = new Map();

  for (let i = 1; i < rows.length; i++) {
    const row    = rows[i];
    const notice = cell(row, COL.NOTICE);
    if (!notice.includes(PENDING)) continue;
    const from  = NOTICE_RE.exec(notice);
    const email = cell(row, COL.EMAIL);
    const date  = normalizeDateStr(cell(row, COL.DATE));
    if (!from || !email || date < today) continue;

    const key = [email.toLowerCase(), cell(row, COL.SHIFT_ID), from[1], from[2], date, normalizeTimeRange(cell(row, COL.TIME))].join('|');
    if (!groups.has(key)) {
      groups.set(key, {
        email, from, date, time: cell(row, COL.TIME),
        shiftId: cell(row, COL.SHIFT_ID), shiftName: cell(row, COL.SHIFT_NAME),
        names: [], rows: [],
      });
    }
    const g = groups.get(key);
    g.names.push(cell(row, COL.NAME));
    g.rows.push({ i, signupId: cell(row, COL.SIGNUP_ID), text: notice.replace(PENDING, `volunteer emailed ${today}`) });
  }

  const sent = [];
  for (const g of groups.values()) {
    const event = events.get(g.shiftId);
    try {
      await sendChangeEmail({
        to:        g.email,
        names:     g.names,
        shiftName: g.shiftName,
        oldDate:   g.from[1], oldTime: g.from[2],
        newDate:   g.date,    newTime: g.time,
        location:  ((event && event.location) || '').trim(),
        cancelUrl: CANCEL_URL,
      });
      sent.push(...g.rows);
      console.log(`[moves] ✓ Change email sent to ${g.email} (${g.names.length} signup(s))`);
    } catch (err) {
      console.error(`[moves] ✗ Change email to ${g.email} failed (will retry next run):`, err.message);
    }
  }

  if (!sent.length) return 0;
  const rowNo = await rowNumbersBySignupId(sheets);
  const data  = [];
  for (const s of sent) {
    const r = rowNo.get(s.signupId);
    if (r) data.push({ range: `signups!P${r}`, values: [[s.text]] });
    rows[s.i][COL.NOTICE] = s.text;
  }
  if (data.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody:   { valueInputOption: 'RAW', data },
    });
  }
  return sent.length;
}

// ── Time helpers ──────────────────────────────────────────────────────────────

// Returns the current UTC offset for America/Los_Angeles in hours (e.g. -7 for PDT).
function getPacificOffsetHours() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone:     'America/Los_Angeles',
    timeZoneName: 'shortOffset',
  }).formatToParts(new Date());
  const tz = parts.find(p => p.type === 'timeZoneName');
  const m  = (tz?.value || 'GMT-7').match(/GMT([+-]\d+)/);
  return m ? parseInt(m[1], 10) : -7;
}

// Convert shift date + time strings (Pacific) to a UTC Date. Only used when
// the calendar event couldn't be read; otherwise the event's own start time
// is used, which is also right across daylight-saving changes.
// dateStr: "YYYY-MM-DD"   timeStr: "9:00am–10:00am" or "9:00am"
function parseShiftStartUTC(dateStr, timeStr) {
  const startStr = timeStr.split(/[–\-]/)[0].trim();   // take start time only
  const m = startStr.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)$/i);
  if (!m) return null;

  let h   = parseInt(m[1], 10);
  const min = parseInt(m[2] || '0', 10);
  if (m[3].toLowerCase() === 'pm' && h !== 12) h += 12;
  if (m[3].toLowerCase() === 'am' && h === 12) h = 0;

  const [year, month, day] = dateStr.split('-').map(Number);
  const offset = getPacificOffsetHours(); // e.g. -7

  // Pacific time → UTC: subtract the (negative) offset i.e. add abs(offset)
  return new Date(Date.UTC(year, month - 1, day, h - offset, min));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!SHEET_ID) throw new Error('GOOGLE_SHEET_ID is not set.');

  // One auth client, reused for both Sheets and the calendar.
  const auth   = getAuth();
  const sheets = google.sheets({ version: 'v4', auth });

  const res  = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range:         SHEET_RANGE,
  });
  const rows = res.data.values || [];

  if (rows.length < 2) {
    console.log('[reminders] Sheet is empty — nothing to do.');
    return;
  }

  const header = rows[0] || [];
  await ensureHeader(sheets, header, COL.REMINDED, 'I', 'Reminded');

  const now = new Date();

  // Everything about moved events below is fail-soft: whatever goes wrong in
  // it, reminders still go out. (An earlier version threw in this area and
  // killed every reminder run for ~17 hours.)

  // Column P is claimed only if it's empty: the sheet's own Apps Script (signup
  // confirmations) lives outside this code, and if it ever uses P we must not
  // overwrite its data. In that case moves are skipped and it's logged.
  let movesEnabled = true;
  try {
    const pHeader = (header[COL.NOTICE] || '').trim();
    if (!pHeader) await ensureHeader(sheets, header, COL.NOTICE, 'P', 'Change Notice');
    else if (pHeader !== 'Change Notice') {
      movesEnabled = false;
      console.error(`[moves] Column P already holds "${pHeader}" — move checks are off until it's free.`);
    }
  } catch (err) {
    movesEnabled = false;
    console.warn('[moves] Could not set up column P; skipping move checks:', err.message);
  }

  // ── Look up the calendar event behind every upcoming signup ───────────────
  // If the calendar can't be read, moves are skipped this run and reminders
  // still go out (without locations).
  let events = new Map();
  try {
    const cutoff = toDateStr(new Date(now.getTime() - MOVE_LOOKBACK_DAYS * 864e5));
    const ids = [...new Set(rows.slice(1)
      .filter(r => cell(r, COL.SHIFT_ID) && normalizeDateStr(cell(r, COL.DATE)) >= cutoff)
      .map(r => cell(r, COL.SHIFT_ID)))];
    events = await fetchEventsById(auth, ids);
  } catch (err) {
    console.warn('[calendar] Event lookup failed; skipping move checks this run:', err.message);
  }

  // ── Moved events: update rows, then email the volunteers ──────────────────
  if (movesEnabled) try {
    const moved = await applyMoves(sheets, rows, events, now);
    const told  = await sendMoveNotices(sheets, rows, events, now);
    if (moved || told) console.log(`[moves] ${moved} signup(s) moved, ${told} signup(s) notified`);
  } catch (err) {
    console.error('[moves] Move check failed; continuing with reminders:', err.message);
  }

  // ── Reminders ─────────────────────────────────────────────────────────────
  let sent = 0, skipped = 0;

  // Rows shift when someone cancels (their row is deleted), so "Reminded" is
  // marked by Signup ID, looked up fresh here — not by the row number from the
  // read at the start, which could by now point at someone else's row (who
  // would then never get their reminder).
  let rowNo = null;
  try { rowNo = await rowNumbersBySignupId(sheets); }
  catch (err) { console.warn('[reminders] Could not re-read signup IDs; using original row numbers:', err.message); }

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    const name      = cell(row, COL.NAME);
    const email     = cell(row, COL.EMAIL);
    const shiftId   = cell(row, COL.SHIFT_ID);
    const shiftName = cell(row, COL.SHIFT_NAME);
    const dateStr   = normalizeDateStr(cell(row, COL.DATE));
    const timeStr   = cell(row, COL.TIME);
    const reminded  = cell(row, COL.REMINDED).toLowerCase();

    // Skip rows that are incomplete, already reminded, or can't be parsed.
    if (!email || !dateStr || !timeStr) { skipped++; continue; }
    if (reminded === 'yes')             { skipped++; continue; }

    const event = events.get(shiftId);
    const shiftStart = event && !hasMoved(dateStr, timeStr, eventSlot(event))
      ? new Date(eventSlot(event).startMs)
      : parseShiftStartUTC(dateStr, timeStr);
    if (!shiftStart) {
      console.warn(`[reminders] Row ${i + 1}: could not parse time "${timeStr}" — skipping.`);
      skipped++;
      continue;
    }

    const diff = shiftStart - now; // ms until shift starts

    if (diff >= WINDOW_MIN_MS && diff <= WINDOW_MAX_MS) {
      const startTime = timeStr.split(/[–\-]/)[0].trim();
      try {
        await sendReminderEmail({
          to:        email,
          name,
          shiftName,
          date:      dateStr,
          time:      startTime,
          // Real address from the calendar event. Empty when unknown, which
          // makes the email omit the location rather than guess at one.
          location:  ((event && event.location) || '').trim(),
          cancelUrl: CANCEL_URL,
        });

        // Mark row as reminded so we never send twice. A row whose Signup ID
        // has vanished was cancelled meanwhile: nothing to mark.
        const signupId = cell(row, COL.SIGNUP_ID);
        const sheetRow = rowNo && signupId ? rowNo.get(signupId) : i + 1;
        if (sheetRow) {
          await sheets.spreadsheets.values.update({
            spreadsheetId:   SHEET_ID,
            range:           `signups!I${sheetRow}`,
            valueInputOption: 'RAW',
            requestBody:     { values: [['Yes']] },
          });
        }

        console.log(`[reminders] ✓ Sent to ${email} — ${shiftName} on ${dateStr} at ${startTime}`);
        sent++;
      } catch (err) {
        console.error(`[reminders] ✗ Failed to send to ${email}:`, err.message);
      }
    } else {
      skipped++;
    }
  }

  console.log(`[reminders] Complete. Sent: ${sent} | Skipped/not-due: ${skipped}`);
}

main().catch(err => {
  console.error('[reminders] Fatal:', err.message);
  process.exit(1);
});
