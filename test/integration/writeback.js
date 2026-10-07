// Integration test: the REAL google.js calendar write-back, run against an
// in-memory fake Google Calendar + Sheet. No network, no real data.
//   node test/integration/writeback.js on    (feature on)
//   node test/integration/writeback.js off   (feature off: must never write)
'use strict';

const path = require('path');
const MODE = process.argv[2] || 'on';
process.env.GOOGLE_CALENDAR_ID = 'cal-test';
process.env.GOOGLE_SHEET_ID    = 'sheet-test';
process.env.CALENDAR_WRITEBACK = MODE;
process.env.SWITCH_CACHE_MS    = '1';   // switch flips take effect at once in tests

const Module = require('module');
const origLoad = Module._load;
const H = 3600e3, now = Date.now(), iso = ms => new Date(ms).toISOString();
const copy = o => JSON.parse(JSON.stringify(o));

// ── Fake calendar with real etag behaviour ──
let etagN = 1, patchCalls = 0;
const cal = new Map();
const addEvent = (id, summary, description, startMs) => cal.set(id, {
  id, summary, description, status: 'confirmed', etag: `"e${etagN++}"`, location: 'Smile Farm',
  start: { dateTime: iso(startMs) }, end: { dateTime: iso(startMs + 2 * H) }, attendees: [],
});
addEvent('E_FARM', 'Farm Chores Limit 6', 'Wear closed-toe shoes. {Gate code 1234}', now + 30 * H);
addEvent('E_YA',   'Mobile Visit - Library', 'Bring the bunnies', now + 50 * H);  // no limit → YA only
addEvent('E_HTML', 'Farm Visit Limit 8', '<b>Bring water</b><br>Meet at the barn', now + 70 * H);
addEvent('E_KILL', 'Farm Chores Limit 6', 'Kill-switch test', now + 90 * H);
let interfere = null; // a staff edit landing between our get and our patch
const calendarApi = { events: {
  list: async () => ({ data: { items: [...cal.values()].map(copy) } }),
  get:  async ({ eventId }) => {
    const e = cal.get(eventId);
    if (!e) { const er = new Error('Not Found'); er.status = 404; throw er; }
    return { data: copy(e) };
  },
  patch: async ({ eventId, sendUpdates, requestBody }, opts = {}) => {
    patchCalls++;
    if (interfere) { const f = interfere; interfere = null; f(); }
    const e = cal.get(eventId);
    if (sendUpdates !== 'none') throw new Error('guests would be emailed!');
    if ((opts.headers || {})['If-Match'] !== e.etag) { const er = new Error('Precondition Failed'); er.status = 412; throw er; }
    Object.assign(e, requestBody, { etag: `"e${etagN++}"` });
    return { data: copy(e) };
  },
} };

// ── Fake sheet ──
const sheet = [['Timestamp','Volunteer Name','Email','Shift ID','Shift Name','Shift Date','Shift Time','Signup ID','Reminded','Registered','Attendance','Check-in Time','Check-out Time','Hours Logged']];
// The real sheet marks Youth Ambassadors with TRUE (Salesforce checkbox export).
const reg = [['Email','Youth Ambassador','Volunteer Hours'], ['jane@x.org','',5], ['sam@x.org','TRUE',20], ['evil@x.org','TRUE',1], ['amy@x.org','',3], ['bo@x.org','',2]];
let switches = [['calendar signup list','ON'], ['follow moved events','ON']];
const sheetsApi = { spreadsheets: {
  get: async () => ({ data: { sheets: [{ properties: { title: 'signups', sheetId: 0 } }] } }),
  values: {
    get: async ({ range }) => {
      if (range === "'app switches'!A:B") {
        if (switches === 'MISSING') { const e = new Error('Unable to parse range'); e.status = 400; throw e; }
        return { data: { values: switches } };
      }
      if (/^registered volunteers!/.test(range)) return { data: { values: reg } };
      const m = range.match(/^signups!H(\d+)$/);
      if (m) return { data: { values: [[(sheet[m[1] - 1] || [])[7] || '']] } };
      return { data: { values: copy(sheet) } };
    },
    append: async ({ requestBody }) => { sheet.push(requestBody.values[0].map(String)); return {}; },
    update: async () => ({}),
  },
  batchUpdate: async ({ requestBody }) => {
    for (const r of requestBody.requests) if (r.deleteDimension) sheet.splice(r.deleteDimension.range.startIndex, 1);
    return {};
  },
} };

Module._load = function (r) {
  if (r === 'googleapis') return { google: { auth: { OAuth2: class { constructor() { this.transporter = null; } } }, calendar: () => calendarApi, sheets: () => sheetsApi } };
  if (r === './mailer') return { sendUnregisteredAlert: async () => {}, sendNewVolunteerAlert: async () => {} };
  if (r === 'dotenv') return { config: () => {} };
  return origLoad.apply(this, arguments);
};

const g = require(path.join(__dirname, '../../google.js'));
let fails = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) fails++; };
const desc   = id => cal.get(id).description;
const settle = () => new Promise(r => setTimeout(r, 50));
const wait   = ms => new Promise(r => setTimeout(r, ms));
const idOf   = name => (sheet.find(r => r[1] === name) || [])[7];

(async () => {
  if (MODE !== 'on') {
    await g.createSignup('E_FARM', 'Jane Smith', 'jane@x.org'); await settle();
    await g.reconcileSignupBlocks();
    check('feature off: calendar is never written', patchCalls === 0 && desc('E_FARM') === 'Wear closed-toe shoes. {Gate code 1234}');
    console.log(fails ? `\n${fails} FAILED` : '\nALL PASS'); process.exit(fails ? 1 : 0);
  }

  // 1. A signup writes the list
  await g.createSignup('E_FARM', 'Jane Smith', 'jane@x.org'); await settle();
  check('signup adds the name to the event description',
    desc('E_FARM') === 'Wear closed-toe shoes. {Gate code 1234}\n\n{Volunteer signups (1), kept up to date by the volunteer app:\nJane Smith}', JSON.stringify(desc('E_FARM')));

  // 2. Two signups at the same moment both end up on the list
  await Promise.all([g.createSignup('E_FARM', 'Sam Lee', 'sam@x.org'), g.createSignup('E_FARM', 'Amy Wu', 'amy@x.org')]); await settle();
  const d2 = desc('E_FARM');
  check('two simultaneous signups: both names listed', /\(3\)/.test(d2) && d2.includes('Sam Lee (YA)') && d2.includes('Amy Wu'), JSON.stringify(d2));
  check('only one signup block, staff text untouched', (d2.match(/Volunteer signups/g) || []).length === 1 && d2.startsWith('Wear closed-toe shoes. {Gate code 1234}\n\n{'));

  // 3. Volunteers never see names; staff page doesn't double-list them
  const pub = (await g.getShifts()).find(s => s.id === 'E_FARM');
  check('volunteer page: no names in the description', !JSON.stringify(pub).includes('Jane Smith'), pub.description_volunteers);
  const staff = (await g.getAdminShifts()).find(s => s.id === 'E_FARM');
  check('staff page: staff notes shown, signup block not duplicated', staff.description_staff === 'Gate code 1234', staff.description_staff);
  check('capacity still read correctly (Limit 6)', pub.capacity === 6 && pub.spots_left === 4, `capacity ${pub.capacity}, left ${pub.spots_left}`);

  // 4. A hostile name can't open a YA-only event or break out of the block
  await g.createSignup('E_YA', 'Evil} Limit 50 <img src=x> {', 'evil@x.org'); await settle();
  const dYA = desc('E_YA');
  check('hostile name: braces and tags stripped', (dYA.match(/[{}]/g) || []).length === 2 && !/[<>]/.test(dYA), JSON.stringify(dYA));
  const ya = (await g.getShifts()).find(s => s.id === 'E_YA');
  check('hostile name: YA-only event still has 0 open spots', ya.capacity === 0 && ya.has_limit === false, `capacity ${ya.capacity}`);

  // 5. HTML descriptions get <br> line breaks
  await g.createSignup('E_HTML', 'Bo Park', 'bo@x.org'); await settle();
  check('HTML description: block uses <br>', desc('E_HTML') === '<b>Bring water</b><br>Meet at the barn<br><br>{Volunteer signups (1), kept up to date by the volunteer app:<br>Bo Park}', JSON.stringify(desc('E_HTML')));

  // 6. A staff edit landing mid-write is kept, and our write retries
  interfere = () => { const e = cal.get('E_FARM'); e.description = e.description.replace('Wear closed-toe shoes.', 'Wear boots!'); e.etag = `"e${etagN++}"`; };
  await g.cancelSignupById(idOf('Amy Wu')); await settle();
  const d6 = desc('E_FARM');
  check('concurrent staff edit is kept (not overwritten)', d6.startsWith('Wear boots!'), JSON.stringify(d6));
  check('…and the cancellation still lands after a retry', /\(2\)/.test(d6) && !d6.includes('Amy Wu'));

  // 7. Last cancellation removes the block entirely
  await g.cancelSignupById(idOf('Bo Park')); await settle();
  check('last cancel removes the block, staff text intact', desc('E_HTML') === '<b>Bring water</b><br>Meet at the barn', JSON.stringify(desc('E_HTML')));

  // 8. Reconcile picks up rows staff delete by hand, and is idle otherwise
  sheet.splice(sheet.findIndex(r => r[1] === 'Jane Smith'), 1);
  const before = patchCalls;
  const r1 = await g.reconcileSignupBlocks();
  check('reconcile fixes a list after a hand edit to the sheet', r1.written === 1 && !desc('E_FARM').includes('Jane Smith') && /\(1\)/.test(desc('E_FARM')), JSON.stringify(desc('E_FARM')));
  const r2 = await g.reconcileSignupBlocks();
  check('reconcile with nothing to change writes nothing', r2.written === 0 && patchCalls === before + 1);

  // 9. Event deleted from the calendar: no crash
  cal.delete('E_YA');
  let threw = false; try { await g.syncEventSignups('E_YA'); } catch { threw = true; }
  check('deleted event: sync skips quietly', !threw);

  // 10. TEMPORARY KILL SWITCH: OFF means signups work but nothing is written
  switches = [['calendar signup list','OFF'], ['follow moved events','ON']];
  await wait(5);
  let p0 = patchCalls;
  await g.createSignup('E_KILL', 'Jane Smith', 'jane@x.org'); await settle();
  await g.reconcileSignupBlocks();
  check('kill switch OFF: signup still works, calendar not written', patchCalls === p0 && desc('E_KILL') === 'Kill-switch test' && sheet.some(r => r[3] === 'E_KILL'));

  switches = 'MISSING';
  await wait(5);
  p0 = patchCalls;
  await g.createSignup('E_KILL', 'Amy Wu', 'amy@x.org'); await settle();
  await g.reconcileSignupBlocks();
  check('switch tab missing: treated as OFF, nothing written', patchCalls === p0);

  switches = [['calendar signup list','yes']];
  await wait(5);
  await g.reconcileSignupBlocks();
  check('switch says "yes" (not ON): nothing written', patchCalls === p0);

  switches = [['calendar signup list','ON']];
  await wait(5);
  await g.reconcileSignupBlocks();
  check('switch back ON: missed signups are filled in', /\(2\)/.test(desc('E_KILL')) && desc('E_KILL').includes('Amy Wu'), JSON.stringify(desc('E_KILL')));

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('CRASH:', e); process.exit(2); });
