// Runs the REAL server.js on http://localhost:3100 with fake Google (no
// network, no real data), for clicking through the app in a browser.
// Every calendar write is printed, so you can see what the app would write.
//   node test/integration/fake-server.js
'use strict';

const path = require('path');
process.env.GOOGLE_CALENDAR_ID = 'cal-test';
process.env.GOOGLE_SHEET_ID    = 'sheet-test';
process.env.CALENDAR_WRITEBACK = 'on';
process.env.PORT               = process.env.PORT || '3100';

const { installFakeGoogle, H } = require('./fake-google');
const now = Date.now();
const fg = installFakeGoogle({
  registered: [
    ['Email', 'Youth Ambassador', 'Phone', 'Adult Volunteer', 'Youth Volunteer', 'Corporate', 'Volunteer Hours'],
    ['jane@example.org', '', '650-555-0101', 'TRUE', '', '', 5],
    ['sam@example.org', 'TRUE', '408-555-0102', '', '', '', 20],
  ],
  staff: [['Name', 'Email'], ['Peter Higa', 'peter@aahsmilefarm.org']],
  password: 'fake-staff-pw',
  onPatch: e => console.log(`[fake-calendar] ${e.id} description is now:\n${e.description}\n[fake-calendar] end`),
});
fg.addEvent('E_FARM', 'Farm Chores Limit 6', 'Wear closed-toe shoes. {Gate code 1234}', now + 30 * H);
fg.addEvent('E_VISIT', 'Farm Visit Limit 8', '<b>Bring water</b><br>Meet at the barn', now + 54 * H);
fg.addEvent('E_MOBILE', 'Mobile Visit - Library', 'No limit, Youth Ambassadors only', now + 78 * H);
fg.addEvent('E_SOON', 'Barnyard Buddy Time Limit 4', 'Starts in 10 minutes (for testing check-in)', now + 10 * 60e3);

process.chdir(path.join(__dirname, '../..'));
require(path.join(__dirname, '../../server.js'));
