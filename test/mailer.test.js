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

test('cancellation email: one volunteer, with date, time and a link to sign up again', async () => {
  sent.length = 0;
  const { sendCancelEmail } = require('../mailer');
  await sendCancelEmail({ to: 'v@x.org', names: ['Jane Smith'], shiftName: 'Farm Chores', date: '2026-10-24', time: '9:00am-11:00am', appUrl: 'https://volunteerapp.test' });
  const m = sent[0];
  assert.strictEqual(m.subject, 'Your AAH volunteer visit has been cancelled');
  assert.match(m.text, /^Hi Jane Smith,/);
  assert.match(m.text, /the Farm Chores you signed up for on Saturday, October 24, 9:00am–11:00am has been cancelled/);
  assert.match(m.text, /Your signup has been removed/);
  assert.match(m.html, /<a href="https:\/\/volunteerapp\.test">/);
});

test('cancellation email: a family gets one message naming everyone', async () => {
  sent.length = 0;
  const { sendCancelEmail } = require('../mailer');
  await sendCancelEmail({ to: 'p@x.org', names: ['Kid One', 'Kid Two'], shiftName: 'Farm Chores', date: '2026-10-24', time: '9:00am-11:00am', appUrl: 'https://volunteerapp.test' });
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].text, /which Kid One and Kid Two signed up for, has been cancelled/);
  assert.match(sent[0].text, /Their signups have been removed/);
});

test('reminder: names the staff to contact when there are any', async () => {
  sent.length = 0;
  const { sendReminderEmail } = require('../mailer');
  const base2 = { to: 'v@x.org', name: 'Aanya', shiftName: 'Mobile Visit', date: '2026-10-24', time: '1:45pm', location: '2625 Patricia Dr', cancelUrl: 'https://volunteerapp.test/cancel.html' };
  await sendReminderEmail({ ...base2, staffContacts: [{ name: 'Jas Chen', email: 'jasmine@aahsmilefarm.org' }] });
  assert.match(sent[0].text, /If you have any questions, you can contact Jas Chen at jasmine@aahsmilefarm\.org\./);
  assert.match(sent[0].html, /Jas Chen at <a href="mailto:jasmine@aahsmilefarm\.org">jasmine@aahsmilefarm\.org<\/a>/);
  sent.length = 0;
  await sendReminderEmail({ ...base2, staffContacts: [{ name: 'Jas Chen', email: 'a@aahsmilefarm.org' }, { name: '', email: 'b@aahsmilefarm.org' }, { name: 'Pat <b>', email: 'c@x.org' }] });
  assert.match(sent[0].text, /contact Jas Chen at a@aahsmilefarm\.org, b@aahsmilefarm\.org or Pat <b> at c@x\.org\./);
  assert.ok(!sent[0].html.includes('Pat <b>') && sent[0].html.includes('Pat &lt;b&gt;'));
  sent.length = 0;
  await sendReminderEmail({ ...base2 });
  assert.ok(!/any questions/.test(sent[0].text) && !/any questions/.test(sent[0].html));
});
