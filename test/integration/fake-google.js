// In-memory fake of the Google Calendar + Sheets APIs, installed in place of
// `googleapis` so the REAL google.js / server.js can run with no network and
// no real data. Shared by the integration tests and the fake dev server.
//
// The fake calendar behaves like the real one where it matters: events carry
// etags and a write with a stale etag is refused (412), and it can be told to
// fail on purpose — failGet / failPatch map an event ID to an HTTP status.
'use strict';

const Module = require('module');

const H    = 3600e3;
const iso  = ms => new Date(ms).toISOString();
const copy = o => JSON.parse(JSON.stringify(o));

const SIGNUP_HEADER = ['Timestamp','Volunteer Name','Email','Shift ID','Shift Name','Shift Date','Shift Time','Signup ID','Reminded','Registered','Attendance','Check-in Time','Check-out Time','Hours Logged'];

function httpError(status, msg) { const e = new Error(msg || `HTTP ${status}`); e.status = status; return e; }

function installFakeGoogle({ registered, staff, password, onPatch } = {}) {
  const state = { etagN: 1, patchCalls: 0, getCalls: 0, interfere: null, failGet: new Map(), failPatch: new Map() };
  const cal   = new Map();
  const sheet = [SIGNUP_HEADER.slice()];
  // The real sheet marks Youth Ambassadors with TRUE (Salesforce checkbox export).
  const reg = registered || [['Email', 'Youth Ambassador', 'Volunteer Hours']];

  const addEvent = (id, summary, description, startMs, durMs = 2 * H, extra = {}) => cal.set(id, {
    id, summary, description, status: 'confirmed', etag: `"e${state.etagN++}"`,
    location: extra.location || '999 E Caribbean Dr, Sunnyvale, CA',
    start: { dateTime: iso(startMs) }, end: { dateTime: iso(startMs + durMs) },
    attendees: (extra.guests || []).map(email => ({ email, responseStatus: 'accepted' })),
  });

  const calendarApi = { events: {
    list: async () => ({ data: { items: [...cal.values()].map(copy) } }),
    get: async ({ eventId }) => {
      state.getCalls++;
      if (state.failGet.has(eventId)) throw httpError(state.failGet.get(eventId));
      const e = cal.get(eventId);
      if (!e) throw httpError(404, 'Not Found');
      return { data: copy(e) };
    },
    patch: async ({ eventId, sendUpdates, requestBody }, opts = {}) => {
      state.patchCalls++;
      if (state.interfere) { const f = state.interfere; state.interfere = null; f(); }
      const mode = state.failPatch.get(eventId);
      if (mode) throw httpError(mode);
      const e = cal.get(eventId);
      if (sendUpdates !== 'none') throw new Error('guests would be emailed!');
      if ((opts.headers || {})['If-Match'] !== e.etag) throw httpError(412, 'Precondition Failed');
      Object.assign(e, requestBody, { etag: `"e${state.etagN++}"` });
      if (onPatch) onPatch(e);
      return { data: copy(e) };
    },
  } };

  const sheetsApi = { spreadsheets: {
    get: async () => ({ data: { sheets: [
      { properties: { title: 'signups', sheetId: 0 } },
      { properties: { title: 'staff', sheetId: 1 } },
    ] } }),
    values: {
      get: async ({ range }) => {
        if (/^registered volunteers!/.test(range)) return { data: { values: reg } };
        if (/^pwd!/.test(range))                   return { data: { values: [['staff', password || 'test-staff-pw']] } };
        if (/^'staff'!/.test(range))               return { data: { values: staff || [['Name', 'Email']] } };
        if (/^A2:B2$/.test(range))                 return { data: { values: [] } };   // banner
        const m = range.match(/^signups!H(\d+)$/);
        if (m) return { data: { values: [[(sheet[m[1] - 1] || [])[7] || '']] } };
        return { data: { values: copy(sheet) } };
      },
      append: async ({ requestBody }) => { sheet.push(requestBody.values[0].map(String)); return {}; },
      update: async () => ({}),
      batchUpdate: async ({ requestBody }) => {
        for (const d of requestBody.data || []) {
          const m = d.range.match(/^signups!([A-Z])(\d+)$/);
          if (!m) continue;
          const row = sheet[+m[2] - 1], col = m[1].charCodeAt(0) - 65;
          while (row.length <= col) row.push('');
          row[col] = String(d.values[0][0]);
        }
        return {};
      },
    },
    batchUpdate: async ({ requestBody }) => {
      for (const r of requestBody.requests) if (r.deleteDimension) sheet.splice(r.deleteDimension.range.startIndex, 1);
      return {};
    },
  } };

  const origLoad = Module._load;
  Module._load = function (r) {
    if (r === 'googleapis') return { google: {
      auth: { OAuth2: class { constructor() { this.transporter = null; } } },
      calendar: () => calendarApi,
      sheets:   () => sheetsApi,
    } };
    if (r === './mailer') return { sendUnregisteredAlert: async () => {}, sendNewVolunteerAlert: async () => {} };
    if (r === 'dotenv')   return { config: () => {} };
    return origLoad.apply(this, arguments);
  };

  return { cal, sheet, reg, state, addEvent };
}

// A signups-sheet row as the app writes it (for tests that seed rows directly).
function signupRow({ name, email, shiftId, date, time, signupId, registered = 'Yes' }) {
  return [new Date().toISOString(), name, email, shiftId, 'Visit', date, time, signupId, '', registered, '', '', '', ''];
}

module.exports = { installFakeGoogle, signupRow, H, iso };
