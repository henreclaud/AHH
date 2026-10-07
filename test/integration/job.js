// Integration test: the REAL send-reminders.js (hourly job), run through
// moved-event scenarios against fake Google + Gmail (see job-stub.js).
//   node test/integration/job.js
'use strict';

const { spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const cs   = require('../../calendar-sync');

const JOB  = path.join(__dirname, '../../send-reminders.js');
const STUB = path.join(__dirname, 'job-stub.js');
const TMP  = fs.mkdtempSync(path.join(os.tmpdir(), 'aah-job-'));
const H = 3600e3, now = Date.now(), iso = ms => new Date(ms).toISOString();
const HEADER = ['Timestamp','Volunteer Name','Email','Shift ID','Shift Name','Shift Date','Shift Time','Signup ID','Reminded','Registered','Attendance','Check-in Time','Check-out Time','Hours Logged','Notes',''];

const ev = (id, startMs, location = 'Smile Farm') => ({
  id, status: 'confirmed', location, summary: id,
  start: { dateTime: iso(startMs) }, end: { dateTime: iso(startMs + 2 * H) },
});
// A signup row exactly as the app writes it, for an event at `startMs`.
const row = (name, email, eventId, startMs, signupId, extra = {}) => {
  const s = cs.eventSlot(ev(eventId, startMs));
  return ['ts', name, email, eventId, `Visit ${eventId}`, s.date, s.time, signupId, extra.reminded || '', 'Yes', extra.attendance || '', '', '', '', '', extra.notice || ''];
};

function run(state, label) {
  const inF = path.join(TMP, 'in.json'), outF = path.join(TMP, 'out.json');
  fs.writeFileSync(inF, JSON.stringify(state));
  const res = spawnSync(process.execPath, ['-r', STUB, JOB], {
    env: { ...process.env, STATE_IN: inF, STATE_OUT: outF, GOOGLE_SHEET_ID: 's', GOOGLE_CALENDAR_ID: 'c',
           GOOGLE_SERVICE_ACCOUNT_JSON: '{}', APP_URL: 'https://volunteerapp.test' },
    encoding: 'utf8',
  });
  if (res.status !== 0) { console.log(`--- ${label} CRASHED ---\n${res.stdout}\n${res.stderr}`); process.exit(2); }
  const out = JSON.parse(fs.readFileSync(outF, 'utf8'));
  out.log = res.stdout + res.stderr;   // errors (e.g. SAFETY STOP) go to stderr
  return out;
}

let fails = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) fails++; };
const find      = (st, id) => st.sheet.find(r => r[7] === id);
const changes   = st => st.emails.filter(e => e.kind === 'change');
const reminders = st => st.emails.filter(e => e.kind === 'reminder');
const clone     = o => JSON.parse(JSON.stringify(o));

// A. Nothing moved; one shift is due a reminder
{
  const t = now + 20 * H;
  const st = run({ sheet: [HEADER, row('Jane', 'jane@x.org', 'E1', t, 'S1')], events: { E1: ev('E1', t) } }, 'A');
  check('A. unmoved event: reminder sent, no change email', reminders(st).length === 1 && changes(st).length === 0);
  check('A. unmoved event: row not marked as moved', find(st, 'S1')[15] === '');
  check('A. header "Change Notice" added to empty column P', st.sheet[0][15] === 'Change Notice');
}

// B + C. Event moved 2 days later; then the job runs again
let afterB;
{
  const oldT = now + 72 * H, newT = now + 120 * H;
  const st = run({ sheet: [HEADER, row('Sam', 'sam@x.org', 'E2', oldT, 'S2', { reminded: 'Yes' })], events: { E2: ev('E2', newT, 'Library, 1 Main St') } }, 'B');
  const r = find(st, 'S2'), newS = cs.eventSlot(ev('E2', newT)), oldS = cs.eventSlot(ev('E2', oldT));
  check('B. moved event: row gets the new date and time', r[5] === newS.date && r[6] === newS.time, `${r[5]} ${r[6]}`);
  check('B. moved event: reminder reset for the new time', r[8] === '');
  const c = changes(st)[0];
  check('B. moved event: volunteer emailed once with old and new times',
    changes(st).length === 1 && c.oldDate === oldS.date && c.oldTime === oldS.time && c.newDate === newS.date && c.newTime === newS.time,
    c && `${c.oldDate} ${c.oldTime} → ${c.newDate} ${c.newTime}`);
  check('B. change email has new location and cancel link', c.location === 'Library, 1 Main St' && c.cancelUrl === 'https://volunteerapp.test/cancel.html');
  check('B. column P records the move for staff', /^Moved from \S+ \S+ \(changed \d{4}-\d{2}-\d{2}\) · volunteer emailed \d{4}-\d{2}-\d{2}$/.test(r[15]), r[15]);
  afterB = st;
}
{
  const st = run({ sheet: afterB.sheet, events: afterB.events }, 'C');
  check('C. second run: no repeat email', changes(st).length === 0 && reminders(st).length === 0);
}

// D. Moved into tomorrow after the old-date reminder already went out
{
  const oldT = now + 20 * H, newT = now + 24 * H;
  const st = run({ sheet: [HEADER, row('Amy', 'amy@x.org', 'E3', oldT, 'S3', { reminded: 'Yes' })], events: { E3: ev('E3', newT) } }, 'D');
  check('D. moved to tomorrow: change email AND a fresh reminder for the new time',
    changes(st).length === 1 && reminders(st).length === 1 && find(st, 'S3')[8] === 'Yes');
}

// E + F. Deleted event; already-attended row
{
  const t = now + 48 * H;
  const before = [HEADER, row('Bo', 'bo@x.org', 'E4', t, 'S4'), row('Cy', 'cy@x.org', 'E5', t, 'S5', { attendance: 'Attended' })];
  const st = run({ sheet: clone(before), events: { E4: 'DELETED', E5: ev('E5', t + 24 * H) } }, 'E');
  check('E. deleted event: row left alone, nobody emailed', JSON.stringify(find(st, 'S4').slice(0, 15)) === JSON.stringify(before[1].slice(0, 15)) && st.emails.length === 0);
  check('F. already checked-in row: never moved', find(st, 'S5')[5] === before[2][5]);
}

// G. Email fails, event moves again, then email works
{
  const t0 = now + 72 * H, t1 = now + 96 * H, t2 = now + 144 * H;
  let st = run({ sheet: [HEADER, row('Di', 'di@x.org', 'E6', t0, 'S6')], events: { E6: ev('E6', t1) }, failChangeEmail: true }, 'G1');
  check('G. failed email stays pending for retry', /notice pending$/.test(find(st, 'S6')[15]), find(st, 'S6')[15]);
  st = run({ sheet: st.sheet, events: { E6: ev('E6', t2) } }, 'G2');
  const c = changes(st)[0], s0 = cs.eventSlot(ev('E6', t0)), s2 = cs.eventSlot(ev('E6', t2));
  check('G. after a second move: one email, from the ORIGINAL time to the latest',
    changes(st).length === 1 && c.oldDate === s0.date && c.newDate === s2.date, c && `${c.oldDate} → ${c.newDate}`);
}

// H. Moved, then moved back before anyone was emailed
{
  const t0 = now + 72 * H, t1 = now + 96 * H;
  let st = run({ sheet: [HEADER, row('Ed', 'ed@x.org', 'E7', t0, 'S7')], events: { E7: ev('E7', t1) }, failChangeEmail: true }, 'H1');
  st = run({ sheet: st.sheet, events: { E7: ev('E7', t0) } }, 'H2');
  check('H. moved back before notice: no email, notice cleared', changes(st).length === 0 && find(st, 'S7')[15] === '' && find(st, 'S7')[5] === cs.eventSlot(ev('E7', t0)).date);
}

// I. Safety stop: everything looks moved at once
{
  const rows = [HEADER], evs = {};
  for (let k = 0; k < 30; k++) { rows.push(row(`V${k}`, `v${k}@x.org`, `M${k}`, now + 72 * H, `SM${k}`)); evs[`M${k}`] = ev(`M${k}`, now + 100 * H); }
  const st = run({ sheet: rows, events: evs }, 'I');
  check('I. mass move (30 of 30): safety stop, nothing changed or emailed',
    changes(st).length === 0 && st.sheet.slice(1).every((r, k) => r[5] === rows[k + 1][5]) && /SAFETY STOP/.test(st.log));
}

// J. Column P already used by something else
{
  const oldT = now + 72 * H, t = now + 20 * H;
  const hdr = [...HEADER]; hdr[15] = 'Confirmation Sent';
  const st = run({ sheet: [hdr, row('Flo', 'flo@x.org', 'E8', oldT, 'S8'), row('Gus', 'gus@x.org', 'E9', t, 'S9')],
                   events: { E8: ev('E8', now + 120 * H), E9: ev('E9', t) } }, 'J');
  check('J. column P taken: its header is kept', st.sheet[0][15] === 'Confirmation Sent');
  check('J. column P taken: no moves, but reminders still go out', changes(st).length === 0 && reminders(st).length === 1 && find(st, 'S8')[5] === row('', '', 'E8', oldT, '')[5]);
}

// K. A volunteer cancels (row deleted) while the job is running
{
  const oldT = now + 72 * H, newT = now + 120 * H;
  const st = run({ sheet: [HEADER, row('Hal', 'hal@x.org', 'EK', now + 200 * H, 'SK1'), row('Ivy', 'ivy@x.org', 'EM', oldT, 'SK2')],
                   events: { EK: ev('EK', now + 200 * H), EM: ev('EM', newT) }, deleteRowOnFirstHRead: 2 }, 'K');
  const ivy = find(st, 'SK2');
  check('K. row deleted mid-run: the move lands on the right volunteer', st.sheet.length === 2 && ivy && ivy[5] === cs.eventSlot(ev('EM', newT)).date, ivy && ivy[5]);
}

// L–N. TEMPORARY KILL SWITCH
{
  const oldT = now + 72 * H, t = now + 20 * H;
  const before = [HEADER, row('Kay', 'kay@x.org', 'EL', oldT, 'SL1'), row('Lu', 'lu@x.org', 'EN', t, 'SL2')];
  const st = run({ sheet: clone(before), events: { EL: ev('EL', now + 120 * H), EN: ev('EN', t) },
                   switches: [['calendar signup list','ON'], ['follow moved events','OFF']] }, 'L');
  check('L. switch OFF: moved event left alone, nobody emailed about it', changes(st).length === 0 && find(st, 'SL1')[5] === before[1][5]);
  check('L. switch OFF: column P not claimed', !st.sheet[0][15]);
  check('L. switch OFF: reminders still sent', reminders(st).length === 1);
}
{
  const oldT = now + 72 * H;
  const before = [HEADER, row('Mo', 'mo@x.org', 'EM2', oldT, 'SM2')];
  const st = run({ sheet: clone(before), events: { EM2: ev('EM2', now + 120 * H) }, switches: 'MISSING' }, 'M');
  check('M. switch tab missing: treated as OFF', changes(st).length === 0 && find(st, 'SM2')[5] === before[1][5]);
}
{
  const t0 = now + 72 * H, t1 = now + 96 * H;
  let st = run({ sheet: [HEADER, row('Ned', 'ned@x.org', 'EP', t0, 'SN')], events: { EP: ev('EP', t1) }, failChangeEmail: true }, 'N1');
  st = run({ sheet: st.sheet, events: { EP: ev('EP', t1) }, switches: [['follow moved events','OFF']] }, 'N2');
  check('N. pending notice + switch OFF: no email sent', changes(st).length === 0 && /notice pending$/.test(find(st, 'SN')[15]));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
