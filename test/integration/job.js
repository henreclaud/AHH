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

const rowFor = (event, name, email, signupId, extra = {}) => {
  const s = cs.eventSlot(event);
  return ['ts', name, email, event.id, `Visit ${event.id}`, extra.date || s.date, extra.time || s.time, signupId, '', 'Yes', '', '', '', '', '', ''];
};

function run(state, label, extraEnv = {}) {
  const inF = path.join(TMP, 'in.json'), outF = path.join(TMP, 'out.json');
  fs.writeFileSync(inF, JSON.stringify(state));
  const res = spawnSync(process.execPath, ['-r', STUB, JOB], {
    env: { ...process.env, STATE_IN: inF, STATE_OUT: outF, GOOGLE_SHEET_ID: 's', GOOGLE_CALENDAR_ID: 'c',
           GOOGLE_SERVICE_ACCOUNT_JSON: '{}', APP_URL: 'https://volunteerapp.test', ...extraEnv },
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


// O. A parent signed up three kids with one email; the event moves
{
  const oldT = now + 72 * H, newT = now + 120 * H;
  const st = run({ sheet: [HEADER,
      row('Kid One', 'parent@x.org', 'EF', oldT, 'SF1'),
      row('Kid Two', 'parent@x.org', 'EF', oldT, 'SF2'),
      row('Kid Three', 'PARENT@x.org', 'EF', oldT, 'SF3')],
    events: { EF: ev('EF', newT) } }, 'O');
  const c = changes(st);
  check('O. family on one email: ONE change email naming all three', c.length === 1 && c[0].names.join(',') === 'Kid One,Kid Two,Kid Three', c.map(x => x.names.join('+')).join(' | '));
  check('O. family: all three rows marked as emailed', ['SF1', 'SF2', 'SF3'].every(id => /volunteer emailed/.test(find(st, id)[15])));
}

// P. Two different people on the same moved event → one email each
{
  const oldT = now + 72 * H, newT = now + 120 * H;
  const st = run({ sheet: [HEADER, row('Pat', 'pat@x.org', 'EG', oldT, 'SG1'), row('Quin', 'quin@x.org', 'EG', oldT, 'SG2')],
                   events: { EG: ev('EG', newT) } }, 'P');
  check('P. two different emails on one event: two emails', changes(st).length === 2 && new Set(changes(st).map(x => x.to)).size === 2);
}

// Q + R. Only the time changes (same day)
{
  const t = now + 72 * H;
  const later = { ...ev('EQ', t + 2 * H) };                                    // starts 2 h later, same length
  const longer = { ...ev('ER', t), end: { dateTime: iso(t + 3 * H) } };       // same start, ends 1 h later
  const st = run({ sheet: [HEADER, row('Rae', 'rae@x.org', 'EQ', t, 'SQ'), row('Sol', 'sol@x.org', 'ER', t, 'SR')],
                   events: { EQ: later, ER: longer } }, 'Q');
  const byTo = Object.fromEntries(changes(st).map(x => [x.to, x]));
  check('Q. start time changed on the same day: change email with new time', byTo['rae@x.org'] && byTo['rae@x.org'].newTime === cs.eventSlot(later).time && byTo['rae@x.org'].oldDate === byTo['rae@x.org'].newDate);
  check('R. only the end time changed: change email too', byTo['sol@x.org'] && byTo['sol@x.org'].newTime === cs.eventSlot(longer).time);
}

// S. Google Sheets reformatted the date (10/10/2026) and time ("9:00AM – 11:00AM")
{
  const t = now + 20 * H, e = ev('ES', t), s = cs.eventSlot(e);
  const [y, m, d] = s.date.split('-');
  const usDate = `${+m}/${+d}/${y}`;
  const fancyTime = s.time.toUpperCase().replace('-', ' – ');
  const st = run({ sheet: [HEADER, rowFor(e, 'Tia', 'tia@x.org', 'SS', { date: usDate, time: fancyTime })], events: { ES: e } }, 'S');
  check('S. reformatted date/time in the sheet: NOT treated as a move', changes(st).length === 0 && find(st, 'SS')[5] === usDate, `${usDate} ${fancyTime}`);
  check('S. …and the reminder still goes out', reminders(st).length === 1);
}

// T. All-day event: row and calendar agree, nothing moves
{
  const d0 = new Date(now + 4 * 864e5).toISOString().slice(0, 10), d1 = new Date(now + 5 * 864e5).toISOString().slice(0, 10);
  const allDay = { id: 'ET', status: 'confirmed', location: 'Farm', summary: 'Open Day', start: { date: d0 }, end: { date: d1 } };
  const st = run({ sheet: [HEADER, rowFor(allDay, 'Uma', 'uma@x.org', 'ST')], events: { ET: allDay } }, 'T');
  check('T. all-day event: not treated as a move', changes(st).length === 0 && !find(st, 'ST')[15]);
}

// U. Google errors on one event; another event moved in the same run
{
  const oldT = now + 72 * H;
  const st = run({ sheet: [HEADER, row('Vic', 'vic@x.org', 'EU', oldT, 'SU1'), row('Wes', 'wes@x.org', 'EV', oldT, 'SU2')],
                   events: { EU: 'ERROR500', EV: ev('EV', now + 120 * H) } }, 'U');
  check('U. one event unreadable: its row left alone', find(st, 'SU1')[5] === row('', '', 'EU', oldT, '')[5] && !find(st, 'SU1')[15]);
  check('U. …the other moved event is still handled', changes(st).length === 1 && changes(st)[0].to === 'wes@x.org');
}

// V. Calendar not configured at all: no moves, reminders still go out
{
  const t = now + 20 * H;
  const st = run({ sheet: [HEADER, row('Xan', 'xan@x.org', 'EW', t, 'SV')], events: { EW: ev('EW', t + 48 * H) } }, 'V', { GOOGLE_CALENDAR_ID: '' });
  check('V. no calendar ID: nothing moved, reminder still sent (no location)', changes(st).length === 0 && reminders(st).length === 1 && reminders(st)[0].location === '');
}

// W. Old row with no Signup ID: never moved (rows are matched by ID)
{
  const oldT = now + 72 * H;
  const r = row('Yul', 'yul@x.org', 'EX', oldT, '');
  const st = run({ sheet: [HEADER, r], events: { EX: ev('EX', now + 120 * H) } }, 'W');
  check('W. row without a Signup ID: left alone', changes(st).length === 0 && st.sheet[1][5] === r[5]);
}

// X. Scale: 2,000 signups across 150 events, 10 of which moved
{
  const rows = [HEADER], evs = {};
  for (let k = 0; k < 150; k++) evs[`EB${k}`] = ev(`EB${k}`, now + (50 + k) * H);
  for (let i = 0; i < 2000; i++) { const k = i % 150; rows.push(row(`P${i}`, `p${i}@x.org`, `EB${k}`, now + (50 + k) * H, `SB${i}`)); }
  for (let k = 0; k < 10; k++) evs[`EB${k}`] = ev(`EB${k}`, now + (50 + k) * H + 24 * H);   // move 10 events a day later
  const movedRows = rows.slice(1).filter(r => +r[3].slice(2) < 10).length;
  const t0 = Date.now();
  const st = run({ sheet: rows, events: evs }, 'X');
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const marked = st.sheet.slice(1).filter(r => /volunteer emailed/.test(r[15] || '')).length;
  check(`X. 2,000 signups / 150 events: exactly the ${movedRows} moved signups updated and emailed`, marked === movedRows && changes(st).length === movedRows, `${marked} marked, ${changes(st).length} emails, ${secs}s`);
}

// Y. Quiet month: one big event holds 40 of 50 signups and is moved
{
  const rows = [HEADER], evs = {};
  evs.EBIG = ev('EBIG', now + 120 * H);                         // moved (signups say +72 h)
  for (let i = 0; i < 40; i++) rows.push(row(`Big${i}`, `big${i}@x.org`, 'EBIG', now + 72 * H, `SY${i}`));
  for (let k = 0; k < 10; k++) { evs[`EQ${k}`] = ev(`EQ${k}`, now + (80 + k) * H); rows.push(row(`Q${k}`, `q${k}@x.org`, `EQ${k}`, now + (80 + k) * H, `SYQ${k}`)); }
  const st = run({ sheet: rows, events: evs }, 'Y');
  check('Y. one big event moved in a quiet month: NOT blocked, all 40 emailed', changes(st).length === 40 && !/SAFETY STOP/.test(st.log));
}

// Z. Someone cancels while reminders are going out: the "Reminded" mark lands on the right person
{
  const t = now + 20 * H;
  // Row 2 (not due) is deleted mid-run; the due signup moves from row 3 up to row 2.
  const st = run({ sheet: [HEADER, row('Gone', 'gone@x.org', 'EZ1', now + 200 * H, 'SZ1'), row('Due', 'due@x.org', 'EZ2', t, 'SZ2')],
                   events: { EZ1: ev('EZ1', now + 200 * H), EZ2: ev('EZ2', t) }, deleteRowOnFirstHRead: 2 }, 'Z');
  const due = find(st, 'SZ2');
  check('Z. row deleted mid-run: reminder sent AND marked on the right row', reminders(st).length === 1 && due && due[8] === 'Yes', JSON.stringify(st.sheet.slice(1).map(r => [r[1], r[8]])));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
