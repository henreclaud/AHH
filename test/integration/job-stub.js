// Preloaded with `node -r` before the REAL send-reminders.js by job.js. Swaps
// Google and Gmail for in-memory fakes, loads state from $STATE_IN, and on
// exit writes the resulting sheet + emails to $STATE_OUT.
'use strict';

const fs = require('fs');
const Module = require('module');
const origLoad = Module._load;

const state  = JSON.parse(fs.readFileSync(process.env.STATE_IN, 'utf8'));
const sheet  = state.sheet;   // 2-D array, row 0 = header
const events = state.events;  // id → event | 'DELETED'
state.emails = [];

const COLS = 'ABCDEFGHIJKLMNOP';
const setCell = (r, c, v) => { const row = sheet[r - 1]; while (row.length <= c) row.push(''); row[c] = v; };
function write(range, values) {
  const m = range.match(/^signups!([A-Z])(\d+)(?::([A-Z])(\d+))?$/);
  const c0 = COLS.indexOf(m[1]), r0 = +m[2];
  values.forEach((vr, dr) => vr.forEach((v, dc) => setCell(r0 + dr, c0 + dc, v)));
}
let hReads = 0;

const fakeGoogle = {
  auth: { GoogleAuth: class { constructor() {} } },
  calendar: () => ({ events: { get: async ({ eventId }) => {
    const e = events[eventId];
    if (!e || e === 'DELETED') { const er = new Error('Not Found'); er.status = 404; throw er; }
    return { data: JSON.parse(JSON.stringify(e)) };
  } } }),
  sheets: () => ({ spreadsheets: { values: {
    get: async ({ range }) => {
      if (range === "'app switches'!A:B") {
        const sw = state.switches === undefined ? [['calendar signup list','ON'], ['follow moved events','ON']] : state.switches;
        if (sw === 'MISSING') { const e = new Error('Unable to parse range'); e.status = 400; throw e; }
        return { data: { values: sw } };
      }
      if (range === 'signups!H:H') {
        hReads++;
        // Simulate a volunteer cancelling mid-run (their row is deleted).
        if (state.deleteRowOnFirstHRead && hReads === 1) sheet.splice(state.deleteRowOnFirstHRead - 1, 1);
        return { data: { values: sheet.map(r => [r[7] || '']) } };
      }
      return { data: { values: JSON.parse(JSON.stringify(sheet)) } };
    },
    update:      async ({ range, requestBody }) => { write(range, requestBody.values); return {}; },
    batchUpdate: async ({ requestBody }) => { requestBody.data.forEach(d => write(d.range, d.values)); return {}; },
  } } }),
};
const fakeMailer = {
  sendReminderEmail: async (o) => { state.emails.push({ kind: 'reminder', ...o }); },
  sendChangeEmail:   async (o) => {
    if (state.failChangeEmail) throw new Error('SMTP down');
    state.emails.push({ kind: 'change', ...o });
  },
};
Module._load = function (r) {
  if (r === 'googleapis') return { google: fakeGoogle };
  if (r === './mailer')   return fakeMailer;
  if (r === 'dotenv')     return { config: () => {} };
  return origLoad.apply(this, arguments);
};
process.on('beforeExit', () => fs.writeFileSync(process.env.STATE_OUT, JSON.stringify(state)));
