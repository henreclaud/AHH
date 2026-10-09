// Integration test: calendar write-back edge cases — Google failing, scale,
// staff editing the list by hand, the reconcile limits. Real google.js,
// fake Google (fake-google.js).
//   node test/integration/writeback-edge.js
'use strict';

const path = require('path');
process.env.GOOGLE_CALENDAR_ID = 'cal-test';
process.env.GOOGLE_SHEET_ID    = 'sheet-test';
process.env.CALENDAR_WRITEBACK = 'on';

const { installFakeGoogle, signupRow, H } = require('./fake-google');
const now = Date.now();
const fg  = installFakeGoogle({ registered: [['Email','Youth Ambassador','Volunteer Hours'], ['a@x.org','',3]] });
const { cal, sheet, state } = fg;

// All events exist before the app's first calendar read (it caches for a minute).
for (let k = 0; k < 30; k++) fg.addEvent(`E_BULK${k}`, 'Farm Chores Limit 9', `Bulk ${k}`, now + (100 + k) * H);
fg.addEvent('E_DENIED',   'Farm Chores Limit 6', 'No permission yet', now + 30 * H);
fg.addEvent('E_DOWN',     'Farm Chores Limit 6', 'Google is down',    now + 31 * H);
fg.addEvent('E_CONFLICT', 'Farm Chores Limit 6', 'Always busy',       now + 32 * H);
fg.addEvent('E_MANY',     'Farm Chores Limit 12', 'Ten at once',      now + 33 * H);
fg.addEvent('E_EMPTY',    'Farm Chores Limit 6', '',                  now + 34 * H);
fg.addEvent('E_UNICODE',  'Farm Chores Limit 6', 'Unicode',           now + 35 * H);
fg.addEvent('E_HAND',     'Farm Chores Limit 6', 'Hand edits',        now + 36 * H);
fg.addEvent('E_GONE',     'Farm Chores Limit 6', 'Will be deleted',   now + 37 * H);
fg.addEvent('E_BIG',      'Open House Limit 200', 'Big event',        now + 38 * H);
fg.addEvent('E_PAST',     'Farm Chores Limit 6', 'Already over',      now - 5 * H);   // ended 3 h ago

const g = require(path.join(__dirname, '../../google.js'));
let fails = 0;
const check  = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) fails++; };
const desc   = id => cal.get(id).description;
const settle = (ms = 80) => new Promise(r => setTimeout(r, ms));
const seed   = (shiftId, name, n) => sheet.push(signupRow({ name, email: `${name.replace(/\W/g, '').toLowerCase()}@x.org`, shiftId, date: '2026-12-01', time: '9:00am-11:00am', signupId: `S${shiftId}${n}` }));
const quiet  = fn => { const w = console.warn; console.warn = () => {}; return fn().finally(() => { console.warn = w; }); };

(async () => {
  // 1. Reconcile writes at most 25 events per run; the rest follow next run
  for (let k = 0; k < 30; k++) seed(`E_BULK${k}`, `Bulk Person ${k}`, 0);
  seed('E_PAST', 'Past Person', 0);
  const r1 = await g.reconcileSignupBlocks();
  const r2 = await g.reconcileSignupBlocks();
  const r3 = await g.reconcileSignupBlocks();
  check('reconcile: 25 events per run, the other 5 on the next', r1.written === 25 && r2.written === 5 && r3.written === 0, `${r1.written}, ${r2.written}, ${r3.written}`);
  check('reconcile: every bulk event ends up with its list', [...Array(30).keys()].every(k => desc(`E_BULK${k}`).includes(`Bulk Person ${k}`)));
  check('reconcile: an event that already ended is left alone', desc('E_PAST') === 'Already over');

  // 2. No calendar permission yet (Peter hasn't granted it): signups still work
  state.failPatch.set('E_DENIED', 403);
  const s2 = await quiet(async () => { const r = await g.createSignup('E_DENIED', 'Ann Lee', 'a@x.org'); await settle(); return r; });
  check('no calendar permission: signup still succeeds', s2.ok === true && sheet.some(r => r[3] === 'E_DENIED'));
  check('no calendar permission: calendar untouched, nothing crashes', desc('E_DENIED') === 'No permission yet');
  state.failPatch.delete('E_DENIED');
  await g.reconcileSignupBlocks();
  check('…once permission is granted, the next reconcile catches up', desc('E_DENIED').includes('Ann Lee'));

  // 3. Google Calendar down: signups still work
  state.failGet.set('E_DOWN', 500);
  const s3 = await quiet(async () => { const r = await g.createSignup('E_DOWN', 'Ben Ode', 'ben@x.org'); await settle(); return r; });
  check('Google Calendar down: signup still succeeds', s3.ok === true);
  state.failGet.delete('E_DOWN');
  await g.reconcileSignupBlocks();
  check('…and the list is filled in once Google is back', desc('E_DOWN').includes('Ben Ode'));

  // 4. Staff keep saving the event (every write conflicts): give up quietly, retry later
  state.failPatch.set('E_CONFLICT', 412);
  const s4 = await quiet(async () => { const r = await g.createSignup('E_CONFLICT', 'Cy Park', 'cy@x.org'); await settle(); return r; });
  check('endless edit conflicts: signup still succeeds, staff text kept', s4.ok === true && desc('E_CONFLICT') === 'Always busy');
  state.failPatch.delete('E_CONFLICT');
  await g.reconcileSignupBlocks();
  check('…and the list lands once the conflict clears', desc('E_CONFLICT').includes('Cy Park'));

  // 5. Ten people sign up at the same moment
  await Promise.all([...Array(10).keys()].map(k => g.createSignup('E_MANY', `Many ${k}`, `many${k}@x.org`)));
  await settle(400);
  const dm = desc('E_MANY');
  check('10 simultaneous signups: all 10 listed, once each', /\(10\)/.test(dm) && [...Array(10).keys()].every(k => (dm.match(new RegExp(`Many ${k}\\b`, 'g')) || []).length === 1), JSON.stringify(dm.slice(0, 80)) + '…');

  // 6. Event with no description
  await g.createSignup('E_EMPTY', 'Dee Fox', 'dee@x.org'); await settle();
  check('empty description: becomes just the list', desc('E_EMPTY') === '{Volunteer signups (1), kept up to date by the volunteer app:\nDee Fox}', JSON.stringify(desc('E_EMPTY')));
  await g.cancelSignupById(sheet.find(r => r[1] === 'Dee Fox')[7]); await settle();
  check('empty description: back to empty after the last cancel', desc('E_EMPTY') === '', JSON.stringify(desc('E_EMPTY')));

  // 7. Accents and emoji survive
  await g.createSignup('E_UNICODE', 'José Núñez 🐐', 'jose@x.org'); await settle();
  check('accents and emoji in names are kept', desc('E_UNICODE').includes('José Núñez 🐐'));

  // 8. Staff type into the list, or delete it — the sheet stays the source of truth
  await g.createSignup('E_HAND', 'Eve Ng', 'eve@x.org'); await settle();
  let e = cal.get('E_HAND');
  e.description = e.description.replace('Eve Ng', 'Eve Ng\nMade Up Person'); e.etag = `"e${state.etagN++}"`;
  await g.createSignup('E_HAND', 'Finn Ray', 'finn@x.org'); await settle();
  check('staff typing inside the list: replaced with the real signups', !desc('E_HAND').includes('Made Up Person') && desc('E_HAND').includes('Finn Ray') && /\(2\)/.test(desc('E_HAND')));
  e = cal.get('E_HAND');
  e.description = 'Hand edits, block deleted by staff'; e.etag = `"e${state.etagN++}"`;
  // The app sees the edit when its 1-minute calendar copy refreshes; the next
  // reconcile (every 15 min live) then restores the list. No shortcuts here:
  // wait out the real refresh.
  console.log('      (waiting 65 s for the app\'s calendar copy to refresh…)');
  await settle(65 * 1000);
  await g.reconcileSignupBlocks();
  check('staff deleting the list: it comes back, their new text kept', desc('E_HAND').startsWith('Hand edits, block deleted by staff') && desc('E_HAND').includes('Eve Ng'), JSON.stringify(desc('E_HAND')));

  // 9. Cancelling after the event was deleted from the calendar
  await g.createSignup('E_GONE', 'Gil Ho', 'gil@x.org'); await settle();
  cal.delete('E_GONE');
  const c9 = await g.cancelSignupById(sheet.find(r => r[1] === 'Gil Ho')[7]); await settle();
  check('cancel after the event was deleted: cancel still works', c9.ok === true && !sheet.some(r => r[1] === 'Gil Ho'));

  // 10. A big event: 150 names
  for (let k = 0; k < 150; k++) seed('E_BIG', `Guest ${k}`, k);
  const before = state.patchCalls;
  await g.syncEventSignups('E_BIG');
  const db = desc('E_BIG');
  check('150 signups: all listed in one write', /\(150\)/.test(db) && db.includes('Guest 0') && db.includes('Guest 149') && state.patchCalls === before + 1, `${db.length} characters`);

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('CRASH:', e); process.exit(2); });
