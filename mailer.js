// mailer.js — email sending via Nodemailer + Gmail.
// The send-reminders.js script (GitHub Actions) uses sendReminderEmail() via SMTP.
// The server (Render) uses sendUnregisteredAlert() via Gmail API over HTTPS,
// because Render blocks outbound SMTP connections.

'use strict';

const nodemailer       = require('nodemailer');
const { google }       = require('googleapis');

// ── SMTP transport — used by send-reminders.js (GitHub Actions only) ──────────

function createTransport() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD must be set in environment variables.');
  }
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
  });
}

// ── Gmail API client — used by the Render server (HTTPS, never blocked) ──────

async function getGmailClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set.');
  let creds;
  try { creds = JSON.parse(raw); }
  catch { creds = JSON.parse(raw.replace(/\\n/g, '\n')); }

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
  });
  const client = await auth.getClient();
  // Impersonate the sending address via domain-wide delegation.
  client.subject = process.env.GMAIL_USER;
  return google.gmail({ version: 'v1', auth: client });
}

function buildRawMessage({ from, to, subject, text }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
  ];
  return Buffer.from(lines.join('\r\n')).toString('base64url');
}

/**
 * Send a shift reminder email to one volunteer.
 *
 * @param {object} opts
 * @param {string} opts.to        Recipient email
 * @param {string} opts.name      Volunteer's full name
 * @param {string} opts.shiftName e.g. "Farm Chores"
 * @param {string} opts.date      "YYYY-MM-DD"
 * @param {string} opts.time      Start time string, e.g. "9:00am"
 * @param {string} opts.location  Location string (may be empty)
 * @param {string} opts.cancelUrl Full URL to the cancel page
 */
async function sendReminderEmail({ to, name, shiftName, date, time, location, cancelUrl }) {
  const transport = createTransport();

  // Format date nicely: "Monday, June 9"
  const d = new Date(date + 'T12:00:00Z'); // noon UTC keeps date stable across timezones
  const prettyDate = d.toLocaleDateString('en-US', {
    weekday: 'long',
    month:   'long',
    day:     'numeric',
  });

  const locationLine = location ? `located at ${location}` : 'at Smile Farm';

  const subject = 'Reminder: Your AAH volunteer shift tomorrow';

  const text = [
    `Hi ${name},`,
    '',
    `This is a reminder that you're signed up for ${shiftName} tomorrow, ${prettyDate} at ${time}, ${locationLine}.`,
    '',
    'We look forward to seeing you!',
    '',
    `If you can't make it, please cancel your signup at: ${cancelUrl}`,
    '',
    '— Animal Assisted Happiness',
  ].join('\n');

  const html = `
<p>Hi ${name},</p>
<p>
  This is a reminder that you're signed up for <strong>${shiftName}</strong> tomorrow,
  <strong>${prettyDate} at ${time}</strong>, ${locationLine}.
</p>
<p>We look forward to seeing you!</p>
<p>
  If you can't make it, please
  <a href="${cancelUrl}">cancel your signup here</a>.
</p>
<p>— Animal Assisted Happiness</p>
`.trim();

  await transport.sendMail({
    from:    `"Animal Assisted Happiness" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    text,
    html,
  });
}

/**
 * Send an alert to staff when an unregistered volunteer signs up.
 *
 * @param {object} opts
 * @param {string} opts.name      Volunteer's full name
 * @param {string} opts.email     Volunteer's email
 * @param {string} opts.shiftName Shift title
 * @param {string} opts.date      "YYYY-MM-DD"
 * @param {string} opts.time      Shift time string, e.g. "9:00am–11:00am"
 */
async function sendUnregisteredAlert({ name, email, shiftName, date, time }) {
  const gmail = await getGmailClient();

  const d = new Date(date + 'T12:00:00Z');
  const prettyDate = d.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  const staffUrl = 'https://ahh-yozo.onrender.com/staff';
  const text =
    `${name} (${email}) just signed up for ${shiftName} on ${prettyDate} at ${time} ` +
    `and is not a registered volunteer. Please review at ${staffUrl}`;

  const raw = buildRawMessage({
    from:    `"Animal Assisted Happiness" <${process.env.GMAIL_USER}>`,
    to:      'henry.p.kolb@gmail.com', // TESTING — change to volunteercheck@aahsmilefarm.org when done
    subject: 'Unregistered volunteer signup alert',
    text,
  });

  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

module.exports = { sendReminderEmail, sendUnregisteredAlert };
