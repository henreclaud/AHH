// Integration test: the staff page visit counter. Real server.js + google.js,
// fake Google (fake-google.js), real HTTP logins.
//   node test/integration/visits.js
'use strict';

const path = require('path');
process.env.GOOGLE_CALENDAR_ID = 'cal-test';
process.env.GOOGLE_SHEET_ID    = 'sheet-test';
process.env.PORT               = '3111';

const { installFakeGoogle } = require('./fake-google');
const fg = installFakeGoogle({ password: 'right-pw', staff: [['Name', 'Email'], ['Jas Chen', 'jasmine@aahsmilefarm.org']] });
const { state, sheet } = fg;
const TAB = 'page counts';

let fails = 0;
const check  = (label, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) fails++; };
const settle = (ms = 100) => new Promise(r => setTimeout(r, ms));
const login  = password => fetch('http://localhost:3111/api/staff/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
});
const today  = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

const log = console.log;
console.log = (...a) => { if (!/^\[|volunteer app/.test(String(a[0]))) log(...a); };
const warnings = [];
console.warn = (...a) => warnings.push(a.join(' '));

require(path.join(__dirname, '../../server.js'));
const g = require(path.join(__dirname, '../../google.js'));

(async () => {
  await settle(300);

  // 1. A wrong password is not a visit
  const bad = await login('wrong');
  await settle();
  check('wrong password: refused and not counted', bad.status === 401 && !state.tabs[TAB]);

  // 2. First visit creates the tab with a header
  const ok = await login('right-pw');
  await settle();
  check('first login succeeds', ok.status === 200 && !!(await ok.json()).token);
  check('first visit: tab created with header and a count of 1',
    JSON.stringify(state.tabs[TAB]) === JSON.stringify([['Date', 'Staff page visits'], [today(), 1]]), JSON.stringify(state.tabs[TAB]));

  // 3. Same day adds to the same row; the tab isn't created twice
  await login('right-pw');
  await settle();
  check('second visit same day: same row goes to 2', state.tabs[TAB].length === 2 && state.tabs[TAB][1][1] === 2);
  check('tab only created once', state.addSheetCalls === 1);

  // 4. Simultaneous logins don't lose a count
  await Promise.all([1, 2, 3].map(() => g.countStaffVisit()));
  check('three at once: none lost', state.tabs[TAB][1][1] === 5, String(state.tabs[TAB][1][1]));

  // 5. A new day gets a new row, older rows are left alone
  state.tabs[TAB][1][0] = '2026-01-15';
  await g.countStaffVisit();
  check('new day: new row, the old day keeps its number',
    state.tabs[TAB].length === 3 && state.tabs[TAB][1][0] === '2026-01-15' && state.tabs[TAB][1][1] === 5 && state.tabs[TAB][2][0] === today() && state.tabs[TAB][2][1] === 1);

  // 6. Someone typed over a number by hand: don't crash, keep counting
  state.tabs[TAB][2][1] = 'n/a';
  await g.countStaffVisit();
  check('hand-edited count: restarts instead of breaking', state.tabs[TAB][2][1] === 1);

  // 7. Sheets failing never blocks a sign-in, and counting recovers afterwards
  state.failTabs = true;
  warnings.length = 0;
  const during = await login('right-pw');
  await settle();
  check('Sheets write failing: staff can still sign in', during.status === 200);
  check('…the problem is logged', warnings.some(w => /\[visits\]/.test(w)));
  state.failTabs = false;
  const before = state.tabs[TAB][2][1];
  await login('right-pw');
  await settle();
  check('…and counting carries on once Sheets is back', state.tabs[TAB][2][1] === before + 1);

  // 8. No permission to add the tab: sign-in still works
  delete state.tabs[TAB];
  state.failTabs = true;
  const noTab = await login('right-pw');
  await settle();
  check('cannot create the tab: staff can still sign in', noTab.status === 200 && !state.tabs[TAB]);
  state.failTabs = false;

  // 9. The new tab doesn't confuse the lookups that find tabs by name
  await g.countStaffVisit();
  const staff = await g.getStaffList();
  check('staff roster still read from the real staff tab', staff.length === 1 && staff[0].name === 'Jas Chen');
  check('counter tab name can\'t match the roster lookup', !/sta+f/i.test(TAB));
  check('signups tab untouched', sheet.length === 1);

  log(fails ? `\n${fails} FAILED` : '\nAll visit-counter tests passed');
  process.exit(fails ? 1 : 0);
})();
