// Preloaded before scripts/staging.js by staging.js: fake googleapis that
// records every call, with configurable spreadsheet / calendar names.
'use strict';

const fs = require('fs');
const Module = require('module');
const origLoad = Module._load;
const cfg = JSON.parse(process.env.STUB_CFG);
const calls = [];
const rec = (name, args) => { calls.push({ name, args }); };

const fake = { google: {
  auth: { GoogleAuth: class { constructor() {} } },
  sheets: () => ({ spreadsheets: {
    get: async (a) => {
      rec('sheets.get', a);
      if (a.fields === 'properties.title') return { data: { properties: { title: cfg.sheetTitle } } };
      return { data: { sheets: [{ properties: { title: 'Sheet1', index: 0 } }] } };
    },
    batchUpdate: async (a) => { rec('sheets.batchUpdate', a); return {}; },
    values: {
      clear:  async (a) => { rec('values.clear', a);  return {}; },
      update: async (a) => { rec('values.update', a); return {}; },
    },
  } }),
  calendar: () => ({
    calendars: { get: async (a) => { rec('calendars.get', a); return { data: { summary: cfg.calName } }; } },
    events: {
      list:   async (a) => { rec('events.list', a);   return { data: { items: [{ id: 'old1' }] } }; },
      delete: async (a) => { rec('events.delete', a); return {}; },
      insert: async (a) => { rec('events.insert', a); return {}; },
    },
  }),
} };
Module._load = function (r) {
  if (r === 'googleapis') return fake;
  return origLoad.apply(this, arguments);
};
process.on('exit', () => fs.writeFileSync(process.env.STUB_OUT, JSON.stringify(calls)));
