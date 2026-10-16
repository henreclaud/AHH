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
const fg  = installFakeGoogle({
  registered: [
    ['Email', 'Youth Ambassador', 'Phone', 'Adult Volunteer', 'Youth Volunteer', 'Corporate', 'Volunteer Hours'],
    ['jane@x.org', '', '650-555-0101', 'TRUE', '', '', 5],
    ['sam@x.org', 'TRUE', '408-555-0102', '', '', '', 20],
    ['evil@x.org', 'TRUE', '', '', '', '', 1],
    ['amy@x.org', '', '', '', 'TRUE', '', 3],
    ['bo@x.org', '', '', 'TRUE', '', '', 2],
  ],
  staff: [['Name', 'Email'], ['Peter Higa', 'peter@aahsmilefarm.org'], ['Jas Partner', 'jas.partner@gmail.com']],
});
const HEAD = "{━━━━━━━━ VOLUNTEER SIGNUPS (added by the volunteer app) ━━━━━━━━\nPlease don't edit below this line. It's rewritten automatically.";
const { cal, sheet } = fg;
fg.addEvent('E_FARM', 'Farm Chores Limit 6', 'Wear closed-toe shoes. {Gate code 1234}', now + 30 * H);
fg.addEvent('E_YA',   'Mobile Visit - Library', 'Bring the bunnies', now + 50 * H);  // no limit → YA only
fg.addEvent('E_HTML', 'Farm Visit Limit 8', '<b>Bring water</b><br>Meet at the barn', now + 70 * H);
fg.addEvent('E_OUT',  'Mobile Visit - School Limit 6', 'At the school', now + 80 * H, 2 * H, { guests: ['peter@aahsmilefarm.org', 'teacher@school.org'] });
fg.addEvent('E_DOM',  'Farm Chores Limit 6', 'Staff guest', now + 82 * H, 2 * H, { guests: ['jasmine@aahsmilefarm.org'] });
fg.addEvent('E_TAB',  'Farm Chores Limit 6', 'Staff-tab guest', now + 84 * H, 2 * H, { guests: ['jas.partner@gmail.com'] });
fg.addEvent('E_OLDFMT', 'Farm Chores Limit 6', 'Notes\n\n{Volunteer signups (1), kept up to date by the volunteer app:\nSomeone Old}', now + 86 * H);
fg.addEvent('E_CHECKIN', 'Farm Chores Limit 6', 'Check-in test', now + 0.2 * H);   // starting soon

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
  check('signup adds the list: divider, totals, name with type, email and phone',
    desc('E_FARM') === 'Wear closed-toe shoes. {Gate code 1234}\n\n' + HEAD + '\n1 signed up: Adult (1)\n\nJane Smith (A) · jane@x.org · 650-555-0101}', JSON.stringify(desc('E_FARM')));

  // 2. Two signups at the same moment both end up on the list
  await Promise.all([g.createSignup('E_FARM', 'Sam Lee', 'sam@x.org'), g.createSignup('E_FARM', 'Amy Wu', 'amy@x.org')]); await settle();
  const d2 = desc('E_FARM');
  check('two simultaneous signups: all three listed, totals by type', d2.includes('3 signed up: YA (1), Adult (1), Youth (1)') && d2.includes('Sam Lee (YA) · sam@x.org · 408-555-0102') && d2.includes('Amy Wu (Y) · amy@x.org'), JSON.stringify(d2));
  check('only one signup block, staff text untouched', (d2.match(/VOLUNTEER SIGNUPS/g) || []).length === 1 && d2.startsWith('Wear closed-toe shoes. {Gate code 1234}\n\n{'));

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
  check('HTML description: block uses <br>', desc('E_HTML') === '<b>Bring water</b><br>Meet at the barn<br><br>' + HEAD.replace(/\n/g, '<br>') + '<br>1 signed up: Adult (1)<br><br>Bo Park (A) · bo@x.org}', JSON.stringify(desc('E_HTML')));

  // 6. A staff edit landing mid-write is kept, and our write retries
  fg.state.interfere = () => { const e = cal.get('E_FARM'); e.description = e.description.replace('Wear closed-toe shoes.', 'Wear boots!'); e.etag = `"e${fg.state.etagN++}"`; };
  await g.cancelSignupById(idOf('Amy Wu')); await settle();
  const d6 = desc('E_FARM');
  check('concurrent staff edit is kept (not overwritten)', d6.startsWith('Wear boots!'), JSON.stringify(d6));
  check('…and the cancellation still lands after a retry', d6.includes('2 signed up') && !d6.includes('Amy Wu'));

  // 7. Last cancellation removes the block entirely
  await g.cancelSignupById(idOf('Bo Park')); await settle();
  check('last cancel removes the block, staff text intact', desc('E_HTML') === '<b>Bring water</b><br>Meet at the barn', JSON.stringify(desc('E_HTML')));

  // 8. Reconcile picks up rows staff delete by hand, and is idle otherwise
  sheet.splice(sheet.findIndex(r => r[1] === 'Jane Smith'), 1);
  const before = fg.state.patchCalls;
  const r1 = await g.reconcileSignupBlocks();
  // (it also clears the leftover first-format list on E_OLDFMT, which has no signups yet)
  check('reconcile fixes a list after a hand edit to the sheet', r1.written === 2 && !desc('E_FARM').includes('Jane Smith') && desc('E_FARM').includes('1 signed up') && desc('E_OLDFMT') === 'Notes', `written ${r1.written}; ` + JSON.stringify(desc('E_FARM')));
  const afterR1 = fg.state.patchCalls;
  const r2 = await g.reconcileSignupBlocks();
  check('reconcile with nothing to change writes nothing', r2.written === 0 && fg.state.patchCalls === afterR1 && afterR1 === before + 2);

  // 10. Guests from outside AAH: contact details hidden
  await g.createSignup('E_OUT', 'Jane Smith', 'jane@x.org'); await settle();
  check('outside guest on the event: no email or phone, with a note', !desc('E_OUT').includes('jane@x.org') && !desc('E_OUT').includes('650-555') && desc('E_OUT').includes('Contact details hidden') && desc('E_OUT').includes('Jane Smith (A)'), JSON.stringify(desc('E_OUT')));
  await g.createSignup('E_DOM', 'Jane Smith', 'jane@x.org'); await settle();
  check('only @aahsmilefarm.org guests: contact details shown', desc('E_DOM').includes('jane@x.org · 650-555-0101'));
  await g.createSignup('E_TAB', 'Jane Smith', 'jane@x.org'); await settle();
  check('guest who is on the staff tab: contact details shown', desc('E_TAB').includes('jane@x.org · 650-555-0101'));

  // 11. A list written in the first format is replaced, not duplicated
  await g.createSignup('E_OLDFMT', 'Sam Lee', 'sam@x.org'); await settle();
  const dOld = desc('E_OLDFMT');
  check('old-format list replaced with the new one (no duplicate)', !dOld.includes('kept up to date') && !dOld.includes('Someone Old') && (dOld.match(/\{/g) || []).length === 1 && dOld.startsWith('Notes\n\n' + HEAD), JSON.stringify(dOld));

  // 12. Check-in marks "✓ Attended" straight away
  await g.createSignup('E_CHECKIN', 'Sam Lee', 'sam@x.org'); await settle();
  const ci = await g.markCheckIn(idOf('Sam Lee') && sheet.find(r => r[3] === 'E_CHECKIN')[7]); await settle();
  check('check-in: "✓ Attended" appears in the calendar list', ci.ok && desc('E_CHECKIN').includes('Sam Lee (YA) · sam@x.org · 408-555-0102 · ✓ Attended'), JSON.stringify(desc('E_CHECKIN')));

  // 9. Event deleted from the calendar: no crash
  cal.delete('E_YA');
  let threw = false; try { await g.syncEventSignups('E_YA'); } catch { threw = true; }
  check('deleted event: sync skips quietly', !threw);

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('CRASH:', e); process.exit(2); });
