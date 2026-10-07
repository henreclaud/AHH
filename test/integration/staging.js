// Integration test: scripts/staging.js must refuse anything not named TEST,
// fill a TEST target correctly, and never let live settings leak in.
//   node test/integration/staging.js
'use strict';

const { spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '../../scripts/staging.js');
const STUB   = path.join(__dirname, 'staging-stub.js');
const TMP    = fs.mkdtempSync(path.join(os.tmpdir(), 'aah-staging-'));

let fails = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) fails++; };

const GOOD_ENV = [
  'GOOGLE_CALENDAR_ID=test-cal@group.calendar.google.com',
  'GOOGLE_SHEET_ID=TESTSHEETID',
  'GOOGLE_SERVICE_ACCOUNT_JSON={"client_email":"bot@proj.iam.gserviceaccount.com"}',
  'STAGING_EMAIL=tester@gmail.com',
].join('\n');

function run(envText, cfg, cmd = 'setup') {
  const envFile = path.join(TMP, 'env.staging'), out = path.join(TMP, 'calls.json');
  if (envText === null) fs.rmSync(envFile, { force: true }); else fs.writeFileSync(envFile, envText);
  fs.rmSync(out, { force: true });
  const r = spawnSync(process.execPath, ['-r', STUB, SCRIPT, cmd], {
    encoding: 'utf8',
    env: { ...process.env, STAGING_ENV_FILE: envFile, STUB_CFG: JSON.stringify(cfg), STUB_OUT: out },
  });
  const calls = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : [];
  return { code: r.status, text: r.stdout + r.stderr, calls };
}
const writes = calls => calls.filter(c => /batchUpdate|values\.(update|clear)|events\.(insert|delete)/.test(c.name));

// 1. No settings file
let r = run(null, {});
check('no .env.staging: refuses with instructions', r.code === 1 && /Copy \.env\.staging\.example/.test(r.text), r.text.trim());

// 2. Missing a required key
r = run(GOOD_ENV.replace(/STAGING_EMAIL=.*/, 'STAGING_EMAIL='), {});
check('missing STAGING_EMAIL: refuses', r.code === 1 && /missing: STAGING_EMAIL/.test(r.text), r.text.trim());

// 3. Pointed at the LIVE spreadsheet (no TEST in its name)
r = run(GOOD_ENV, { sheetTitle: 'AAH Volunteer Signups', calName: 'AAH Calendar TEST' });
check('live spreadsheet: refuses, writes nothing', r.code === 1 && /spreadsheet with TEST/.test(r.text) && writes(r.calls).length === 0);

// 4. Pointed at the LIVE calendar
r = run(GOOD_ENV, { sheetTitle: 'AAH signups TEST', calName: 'AAH Calendar' });
check('live calendar: refuses, writes nothing', r.code === 1 && /calendar with TEST/.test(r.text) && writes(r.calls).length === 0);

// 5. Both TEST → setup fills them
r = run(GOOD_ENV, { sheetTitle: 'AAH signups TEST', calName: 'AAH Calendar TEST' });
check('TEST targets: setup succeeds', r.code === 0, r.code !== 0 ? r.text : '');
const upd   = r.calls.filter(c => c.name === 'values.update');
const tabOf = c => c.args.range.match(/^'([^']+)'/)[1];
check('setup writes every tab and empties signups',
  ['banner', 'pwd', 'registered volunteers', 'staff', 'app switches'].every(t => upd.some(c => tabOf(c) === t)) &&
  r.calls.some(c => c.name === 'values.clear' && c.args.range === "'signups'"));
const reg = (upd.find(c => tabOf(c) === 'registered volunteers') || { args: { requestBody: { values: [[]] } } }).args.requestBody.values;
check("test volunteers use the tester's +addresses", reg.slice(1).length === 4 && reg.slice(1).every(x => /^tester\+\w+@gmail\.com$/.test(x[0])), reg.slice(1).map(x => x[0]).join(', '));
check('one test volunteer is a Youth Ambassador, one has 0 hours', reg.some(x => x[1] === 'TRUE') && reg.some(x => x[6] === '0'));
const addTabs = ((r.calls.find(c => c.name === 'sheets.batchUpdate') || {}).args || { requestBody: { requests: [] } }).requestBody.requests;
check('"banner" tab placed first (the banner reads the first tab)', addTabs.some(q => q.addSheet.properties.title === 'banner' && q.addSheet.properties.index === 0));
const ins = r.calls.filter(c => c.name === 'events.insert');
check('old test events deleted, new ones created', r.calls.some(c => c.name === 'events.delete' && c.args.eventId === 'old1') && ins.length >= 4);
check('test events are tagged and in Pacific time', ins.length > 0 && ins.every(c => c.args.requestBody.extendedProperties.private.aahStaging === '1' && c.args.requestBody.start.timeZone === 'America/Los_Angeles'));
check('deletes only ever target tagged test events', (r.calls.find(c => c.name === 'events.list') || { args: {} }).args.privateExtendedProperty === 'aahStaging=1');

// 6. The environment a staging server/job run gets
const { buildChildEnv } = require(SCRIPT);
const env = buildChildEnv(
  { GOOGLE_SHEET_ID: 'TESTSHEET', STAGING_EMAIL: 'tester@gmail.com', GOOGLE_CALENDAR_ID: 'testcal' },
  { GOOGLE_SHEET_ID: 'LIVESHEET', RESEND_API_KEY: 're_live', ALERT_EMAIL: 'volunteercheck@aahsmilefarm.org', GMAIL_APP_PASSWORD: 'live' },
  { PATH: '/usr/bin' },
);
check('staging run: live sheet ID replaced by the TEST one', env.GOOGLE_SHEET_ID === 'TESTSHEET');
check('staging run: live-only settings blanked (no leak from .env)', env.RESEND_API_KEY === '' && env.GMAIL_APP_PASSWORD === '');
check('staging run: every staff alert goes to the tester', env.ALERT_EMAIL === 'tester@gmail.com' && env.NEW_VOLUNTEER_ALERT_EMAIL === 'tester@gmail.com');
check('staging run: banner and links point at TEST / localhost', env.MESSAGE_SHEET_ID === 'TESTSHEET' && env.APP_URL === 'http://localhost:3000' && env.CALENDAR_WRITEBACK === 'on');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
