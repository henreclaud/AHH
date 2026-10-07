#!/usr/bin/env node
// scripts/staging.js — run the real app and the real hourly job against a
// TEST calendar and a TEST spreadsheet, never AAH's live ones.
//
//   node scripts/staging.js setup    fill the TEST sheet + calendar with fake data
//   node scripts/staging.js server   run the website on http://localhost:3000
//   node scripts/staging.js job      run the hourly job once (reminders + moves)
//
// Settings come only from .env.staging (see .env.staging.example). Safety:
//   - Refuses to run unless the spreadsheet's name AND the calendar's name both
//     contain "TEST", so it can't be pointed at AAH's live data by mistake.
//   - Every staff alert goes to STAGING_EMAIL, never to AAH staff.
//   - Nothing from a local production .env leaks into a staging run.
// Step-by-step test plan: STAGING.md.

'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const dotenv = require('dotenv');

const ROOT     = path.join(__dirname, '..');
const ENV_FILE = process.env.STAGING_ENV_FILE || path.join(ROOT, '.env.staging');
const PT       = 'America/Los_Angeles';
const REQUIRED = ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_CALENDAR_ID', 'GOOGLE_SHEET_ID', 'STAGING_EMAIL'];

function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function loadStagingEnv() {
  if (!fs.existsSync(ENV_FILE)) fail(`No ${path.basename(ENV_FILE)} found. Copy .env.staging.example to .env.staging and fill it in.`);
  const env = dotenv.parse(fs.readFileSync(ENV_FILE));
  const missing = REQUIRED.filter(k => !String(env[k] || '').trim());
  if (missing.length) fail(`.env.staging is missing: ${missing.join(', ')}`);
  if (!/^[^@\s+]+@[^@\s]+\.[^@\s]+$/.test(env.STAGING_EMAIL.trim())) fail('STAGING_EMAIL must be a plain address like you@gmail.com (no +tag).');
  return env;
}

// "you@gmail.com" + "ya" → "you+ya@gmail.com" (Gmail delivers these to you).
function plusAddress(email, tag) {
  const [user, domain] = email.trim().split('@');
  return `${user}+${tag}@${domain}`;
}

// The environment a staging child process gets: only staging values, with
// every key from a local production .env blanked so none can leak in (dotenv
// never overrides a key that is already set, even to ''). Alerts always go to
// the tester.
function buildChildEnv(staging, prodEnv, base) {
  const env = { ...base };
  for (const k of Object.keys(prodEnv || {})) env[k] = '';
  Object.assign(env, staging);
  env.ALERT_EMAIL               = staging.STAGING_EMAIL;
  env.NEW_VOLUNTEER_ALERT_EMAIL = staging.STAGING_EMAIL;
  env.MESSAGE_SHEET_ID          = staging.GOOGLE_SHEET_ID; // banner tab lives in the TEST sheet
  env.APP_URL                   = 'http://localhost:3000';
  env.CALENDAR_WRITEBACK        = 'on';
  env.PORT                      = '3000';
  return env;
}

function googleClients(staging) {
  const { google } = require('googleapis');
  let creds;
  try { creds = JSON.parse(staging.GOOGLE_SERVICE_ACCOUNT_JSON); }
  catch { creds = JSON.parse(staging.GOOGLE_SERVICE_ACCOUNT_JSON.replace(/\\n/g, '\n')); }
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/calendar'],
  });
  return {
    sheets:   google.sheets({ version: 'v4', auth }),
    calendar: google.calendar({ version: 'v3', auth }),
    serviceAccount: creds.client_email,
  };
}

// The guard: both names must say TEST.
async function assertTestTargets(staging, g) {
  let sheetTitle, calName;
  try {
    const s = await g.sheets.spreadsheets.get({ spreadsheetId: staging.GOOGLE_SHEET_ID, fields: 'properties.title' });
    sheetTitle = s.data.properties.title;
  } catch (err) {
    fail(`Can't open the TEST spreadsheet (${err.message}). Is it shared with ${g.serviceAccount} as Editor?`);
  }
  try {
    const c = await g.calendar.calendars.get({ calendarId: staging.GOOGLE_CALENDAR_ID });
    calName = c.data.summary;
  } catch (err) {
    fail(`Can't open the TEST calendar (${err.message}). Is it shared with ${g.serviceAccount} as "Make changes to events"?`);
  }
  if (!/TEST/.test(sheetTitle)) fail(`The spreadsheet is called "${sheetTitle}". Staging only runs on a spreadsheet with TEST in its name.`);
  if (!/TEST/.test(calName))    fail(`The calendar is called "${calName}". Staging only runs on a calendar with TEST in its name.`);
  console.log(`✓ Using TEST spreadsheet "${sheetTitle}" and TEST calendar "${calName}"`);
}

// ── setup ────────────────────────────────────────────────────────────────────

const pacificDate = (msFromNow) =>
  new Date(Date.now() + msFromNow).toLocaleDateString('en-CA', { timeZone: PT });

// An event at a Pacific wall-clock time `days` from today.
function fixtureEvent(summary, days, start, end, description) {
  const day = pacificDate(days * 864e5);
  return {
    summary,
    description,
    location: '999 E Caribbean Dr, Sunnyvale, CA',
    start: { dateTime: `${day}T${start}:00`, timeZone: PT },
    end:   { dateTime: `${day}T${end}:00`,   timeZone: PT },
    extendedProperties: { private: { aahStaging: '1' } },
  };
}

// HH:MM in Pacific, `mins` from now (for a "starting soon" check-in test).
function pacificTimeIn(mins) {
  return new Date(Date.now() + mins * 60e3).toLocaleTimeString('en-GB', { timeZone: PT, hour: '2-digit', minute: '2-digit' });
}

async function setup(staging, g) {
  const id = staging.GOOGLE_SHEET_ID;
  const me = staging.STAGING_EMAIL.trim();
  const password = 'staging-' + crypto.randomBytes(4).toString('hex');

  const tabs = {
    banner: [['Volunteer banner', 'Staff banner'], ['STAGING — test data only', 'STAGING — test data only']],
    signups: [],
    pwd: [['staff', password]],
    'registered volunteers': [
      ['Email', 'Youth Ambassador', 'Phone', 'Adult Volunteer', 'Youth Volunteer', 'Corporate', 'Volunteer Hours'],
      [plusAddress(me, 'adult'), '',     '555-0101', 'TRUE', '',     '', '12'],
      [plusAddress(me, 'ya'),    'TRUE', '555-0102', '',     '',     '', '30'],
      [plusAddress(me, 'youth'), '',     '555-0103', '',     'TRUE', '', '4'],
      [plusAddress(me, 'new'),   '',     '555-0104', 'TRUE', '',     '', '0'],
    ],
    staff: [['Name', 'Email'], ['Test Staff', me]],
    'app switches': [['calendar signup list', 'ON'], ['follow moved events', 'ON']],
  };

  // Create any missing tabs ("banner" first: the banner reads the first tab).
  const meta = await g.sheets.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties(title,index)' });
  const have = new Set(meta.data.sheets.map(s => s.properties.title));
  const add  = Object.keys(tabs).filter(t => !have.has(t))
    .map(title => ({ addSheet: { properties: { title, ...(title === 'banner' ? { index: 0 } : {}) } } }));
  if (add.length) await g.sheets.spreadsheets.batchUpdate({ spreadsheetId: id, requestBody: { requests: add } });

  // Reset every tab to the fixture data (signups emptied for a clean run).
  for (const [title, values] of Object.entries(tabs)) {
    await g.sheets.spreadsheets.values.clear({ spreadsheetId: id, range: `'${title}'` });
    if (values.length) {
      await g.sheets.spreadsheets.values.update({
        spreadsheetId: id, range: `'${title}'!A1`, valueInputOption: 'RAW', requestBody: { values },
      });
    }
  }
  console.log('✓ TEST spreadsheet filled: banner, signups (empty), pwd, registered volunteers, staff, app switches');

  // Replace earlier fixture events with a fresh set.
  const old = await g.calendar.events.list({
    calendarId: staging.GOOGLE_CALENDAR_ID, privateExtendedProperty: 'aahStaging=1', maxResults: 250, singleEvents: true,
  });
  for (const e of old.data.items || []) {
    await g.calendar.events.delete({ calendarId: staging.GOOGLE_CALENDAR_ID, eventId: e.id });
  }
  const soon = pacificTimeIn(20), soonEnd = pacificTimeIn(140);
  const sameDay = pacificDate(20 * 60e3) === pacificDate(140 * 60e3);
  const events = [
    fixtureEvent('Farm Chores Limit 4', 1, '09:00', '11:00', 'Wear closed-toe shoes. {Staff note: gate code TEST}'),
    fixtureEvent('Mobile Visit - Test Library', 2, '13:00', '15:00', 'No limit, so Youth Ambassadors only.'),
    fixtureEvent('Farm Visit Limit 6', 3, '10:00', '12:00', '<b>Bring water</b><br>Meet at the barn'),
    fixtureEvent('Volunteer Orientation Limit 10', 4, '18:00', '19:30', 'New volunteer orientation.'),
    ...(sameDay ? [fixtureEvent('Barnyard Buddy Time Limit 3', 0, soon, soonEnd, 'Starts in 20 minutes, for testing check-in.')] : []),
  ];
  for (const e of events) {
    await g.calendar.events.insert({ calendarId: staging.GOOGLE_CALENDAR_ID, requestBody: e });
  }
  console.log(`✓ TEST calendar: ${events.length} test events created`);

  console.log(`
Test volunteers (all deliver to ${me}):
  ${plusAddress(me, 'adult')}   registered adult, 12 hours
  ${plusAddress(me, 'ya')}      Youth Ambassador
  ${plusAddress(me, 'youth')}   youth volunteer
  ${plusAddress(me, 'new')}     registered, 0 hours (triggers the new-volunteer alert)
  ${plusAddress(me, 'stranger')}   not registered (triggers the unregistered alert)

Staff password for this TEST sheet only: ${password}

Next: node scripts/staging.js server   then follow STAGING.md`);
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cmd = process.argv[2];
  if (!['setup', 'server', 'job'].includes(cmd)) {
    console.log('Usage: node scripts/staging.js setup | server | job');
    process.exit(1);
  }
  const staging = loadStagingEnv();
  const g = googleClients(staging);
  await assertTestTargets(staging, g);

  if (cmd === 'setup') return setup(staging, g);

  const prodFile = path.join(ROOT, '.env');
  const prodEnv  = fs.existsSync(prodFile) ? dotenv.parse(fs.readFileSync(prodFile)) : {};
  const script   = cmd === 'server' ? 'server.js' : 'send-reminders.js';
  const child = spawn(process.execPath, [path.join(ROOT, script)], {
    cwd: ROOT, stdio: 'inherit', env: buildChildEnv(staging, prodEnv, process.env),
  });
  child.on('exit', code => process.exit(code || 0));
}

if (require.main === module) {
  main().catch(err => fail(err.message));
}

module.exports = { buildChildEnv, plusAddress, assertTestTargets };
