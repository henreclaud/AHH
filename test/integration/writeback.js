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

const { installFakeGoogle, H } = require('./fake-google');
const now = Date.now();
const fg  = installFakeGoogle({ registered: [
  ['Email','Youth Ambassador','Volunteer Hours'],
  ['jane@x.org','',5], ['sam@x.org','TRUE',20], ['evil@x.org','TRUE',1], ['amy@x.org','',3], ['bo@x.org','',2],
] });
const { cal, sheet } = fg;
fg.addEvent('E_FARM', 'Farm Chores Limit 6', 'Wear closed-toe shoes. {Gate code 1234}', now + 30 * H);
fg.addEvent('E_YA',   'Mobile Visit - Library', 'Bring the bunnies', now + 50 * H);  // no limit → YA only
fg.addEvent('E_HTML', 'Farm Visit Limit 8', '<b>Bring water</b><br>Meet at the barn', now + 70 * H);

const g = require(path.join(__dirname, '../../google.js'));
let fails = 0;
const check = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) fails++; };
const desc   = id => cal.get(id).description;
const settle = () => new Promise(r => setTimeout(r, 50));
const idOf   = name => (sheet.find(r => r[1] === name) || [])[7];

(async () => {
  if (MODE !== 'on') {
    await g.createSignup('E_FARM', 'Jane Smith', 'jane@x.org'); await settle();
    await g.reconcileSignupBlocks();
    check('feature off: calendar is never written', fg.state.patchCalls === 0 && desc('E_FARM') === 'Wear closed-toe shoes. {Gate code 1234}');
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
  fg.state.interfere = () => { const e = cal.get('E_FARM'); e.description = e.description.replace('Wear closed-toe shoes.', 'Wear boots!'); e.etag = `"e${fg.state.etagN++}"`; };
  await g.cancelSignupById(idOf('Amy Wu')); await settle();
  const d6 = desc('E_FARM');
  check('concurrent staff edit is kept (not overwritten)', d6.startsWith('Wear boots!'), JSON.stringify(d6));
  check('…and the cancellation still lands after a retry', /\(2\)/.test(d6) && !d6.includes('Amy Wu'));

  // 7. Last cancellation removes the block entirely
  await g.cancelSignupById(idOf('Bo Park')); await settle();
  check('last cancel removes the block, staff text intact', desc('E_HTML') === '<b>Bring water</b><br>Meet at the barn', JSON.stringify(desc('E_HTML')));

  // 8. Reconcile picks up rows staff delete by hand, and is idle otherwise
  sheet.splice(sheet.findIndex(r => r[1] === 'Jane Smith'), 1);
  const before = fg.state.patchCalls;
  const r1 = await g.reconcileSignupBlocks();
  check('reconcile fixes a list after a hand edit to the sheet', r1.written === 1 && !desc('E_FARM').includes('Jane Smith') && /\(1\)/.test(desc('E_FARM')), JSON.stringify(desc('E_FARM')));
  const r2 = await g.reconcileSignupBlocks();
  check('reconcile with nothing to change writes nothing', r2.written === 0 && fg.state.patchCalls === before + 1);

  // 9. Event deleted from the calendar: no crash
  cal.delete('E_YA');
  let threw = false; try { await g.syncEventSignups('E_YA'); } catch { threw = true; }
  check('deleted event: sync skips quietly', !threw);

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('CRASH:', e); process.exit(2); });
