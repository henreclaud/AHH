'use strict';

// The change email a volunteer gets when staff move their event. Nodemailer is
// replaced with a fake that records what would be sent.
const test   = require('node:test');
const assert = require('node:assert');

const sent = [];
require.cache[require.resolve('nodemailer')] = {
  id: 'nodemailer', loaded: true,
  exports: { createTransport: () => ({ sendMail: async (m) => { sent.push(m); } }) },
};
process.env.GMAIL_USER         = 'aah-test@example.org';
process.env.GMAIL_APP_PASSWORD = 'not-a-real-password';
const { sendChangeEmail } = require('../mailer');

const base = {
  to: 'parent@x.org', shiftName: 'Farm Chores',
  oldDate: '2026-10-10', oldTime: '9:00am-11:00am',
  newDate: '2026-10-11', newTime: '1:00pm-3:00pm',
  location: '999 E Caribbean Dr, Sunnyvale', cancelUrl: 'https://volunteerapp.test/cancel.html',
};

test('one volunteer: greeted by name, old and new times, cancel link', async () => {
  sent.length = 0;
  await sendChangeEmail({ ...base, names: ['Jane Smith'] });
  const m = sent[0];
  assert.strictEqual(m.to, 'parent@x.org');
  assert.strictEqual(m.subject, 'Change to your AAH volunteer visit');
  assert.match(m.text, /^Hi Jane Smith,/);
  assert.match(m.text, /The Farm Chores you signed up for has changed\./);
  assert.match(m.text, /Was: Saturday, October 10, 9:00am–11:00am/);
  assert.match(m.text, /Now: Sunday, October 11, 1:00pm–3:00pm, at 999 E Caribbean Dr, Sunnyvale/);
  assert.match(m.text, /cancel your signup at: https:\/\/volunteerapp\.test\/cancel\.html/);
  assert.match(m.html, /<a href="https:\/\/volunteerapp\.test\/cancel\.html">/);
});

test('a family on one email: one message naming everyone', async () => {
  sent.length = 0;
  await sendChangeEmail({ ...base, names: ['Kid One', 'Kid Two', 'Kid Three'] });
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /^Hi,/);
  assert.match(sent[0].text, /that Kid One, Kid Two and Kid Three signed up for has changed/);
  assert.match(sent[0].text, /Everyone is still signed up/);
  assert.match(sent[0].text, /cancel their signup at:/);
});

test('names typed into the signup form cannot inject HTML', async () => {
  sent.length = 0;
  await sendChangeEmail({ ...base, names: ['<script>alert(1)</script>'], shiftName: 'Visit <b>x</b>' });
  assert.ok(!sent[0].html.includes('<script>'));
  assert.ok(sent[0].html.includes('&lt;script&gt;'));
  assert.ok(!sent[0].html.includes('<b>x</b>'));
});

test('no location known: the "at …" part is left out', async () => {
  sent.length = 0;
  await sendChangeEmail({ ...base, names: ['Jane'], location: '' });
  assert.match(sent[0].text, /Now: Sunday, October 11, 1:00pm–3:00pm\n/);
});
