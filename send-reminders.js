#!/usr/bin/env node
// send-reminders.js — run once per execution as a Render Cron Job (every hour).
//
// What it does:
//   1. Reads all signup rows from the Google Sheet
//   2. For each row whose shift starts 23–25 hours from now, sends a reminder email
//   3. Marks each reminded row with "Yes" in column H ("Reminded") to prevent duplicates
//   4. Exits when done
//
// Run manually to test:
//   GMAIL_USER=you@gmail.com GMAIL_APP_PASSWORD=xxxx node send-reminders.js

'use strict';

require('dotenv').config();

const { google }           = require('googleapis');
const { sendReminderEmail } = require('./mailer');

// ── Config ────────────────────────────────────────────────────────────────────

const SHEET_ID  = process.env.GOOGLE_SHEET_ID;
const APP_URL   = (process.env.APP_URL || 'https://ahh-yozo.onrender.com').replace(/\/$/, '');
const CANCEL_URL = `${APP_URL}/cancel.html`;

// Sheet column layout (0-indexed):
//  A(0) Timestamp  B(1) Name  C(2) Email  D(3) ShiftID
//  E(4) ShiftName  F(5) ShiftDate  G(6) ShiftTime  H(7) Signup ID  I(8) Reminded
const COL = { NAME: 1, EMAIL: 2, SHIFT_NAME: 4, DATE: 5, TIME: 6, REMINDED: 8 };
const SHEET_RANGE = 'signups!A:I';

// The reminder window: send when the shift is between 23 and 25 hours away.
const WINDOW_MIN_MS = 23 * 60 * 60 * 1000;  // send when shift is 23–25 hours away
const WINDOW_MAX_MS = 25 * 60 * 60 * 1000;

// ── Google Auth ───────────────────────────────────────────────────────────────

function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set.');
  let creds;
  try { creds = JSON.parse(raw); }
  catch { creds = JSON.parse(raw.replace(/\\n/g, '\n')); }
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
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

// Convert shift date + time strings (Pacific) to a UTC Date.
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

  const sheets = google.sheets({ version: 'v4', auth: getAuth() });

  // Read all rows including the new Reminded column.
  const res  = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range:         SHEET_RANGE,
  });
  const rows = res.data.values || [];

  if (rows.length < 2) {
    console.log('[reminders] Sheet is empty — nothing to do.');
    return;
  }

  // ── Ensure the "Reminded" header exists in column I ───────────────────────
  const header = rows[0] || [];
  if ((header[COL.REMINDED] || '').trim() !== 'Reminded') {
    await sheets.spreadsheets.values.update({
      spreadsheetId:   SHEET_ID,
      range:           'signups!I1',
      valueInputOption: 'RAW',
      requestBody:     { values: [['Reminded']] },
    });
    console.log('[reminders] Added "Reminded" header to column I.');
  }

  // ── Check each signup row ─────────────────────────────────────────────────
  const now = new Date();
  let sent = 0, skipped = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    const name      = (row[COL.NAME]       || '').trim();
    const email     = (row[COL.EMAIL]      || '').trim();
    const shiftName = (row[COL.SHIFT_NAME] || '').trim();
    const dateStr   = (row[COL.DATE]       || '').trim();
    const timeStr   = (row[COL.TIME]       || '').trim();
    const reminded  = (row[COL.REMINDED]   || '').trim().toLowerCase();

    // Skip rows that are incomplete, already reminded, or can't be parsed.
    if (!email || !dateStr || !timeStr) { skipped++; continue; }
    if (reminded === 'yes')             { skipped++; continue; }

    const shiftStart = parseShiftStartUTC(dateStr, timeStr);
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
          location:  '', // location not stored in sheet; omit gracefully
          cancelUrl: CANCEL_URL,
        });

        // Mark row as reminded so we never send twice.
        await sheets.spreadsheets.values.update({
          spreadsheetId:   SHEET_ID,
          range:           `signups!I${i + 1}`,
          valueInputOption: 'RAW',
          requestBody:     { values: [['Yes']] },
        });

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
