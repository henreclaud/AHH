// mailer.js — email sending via Nodemailer + Gmail.
// The send-reminders.js script (GitHub Actions) uses sendReminderEmail() via SMTP.
// The server (Render) uses sendUnregisteredAlert() via Gmail API over HTTPS,
// because Render blocks outbound SMTP connections.

'use strict';

const nodemailer = require('nodemailer');

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

// ── Resend API — used by the Render server (HTTPS, never blocked) ─────────────

async function sendViaResend({ to, subject, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set.');

  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    'Animal Assisted Happiness <onboarding@resend.dev>',
      to:      [to],
      subject,
      text,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error ${res.status}: ${err}`);
  }
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
  const d = new Date(date + 'T12:00:00Z');
  const prettyDate = d.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  const text = [
    `${name} (${email}) just signed up for ${shiftName} on ${prettyDate} at ${time}`,
    '',
    'The volunteer does not appear to be registered. Please double check if they are ' +
    'registered or not. If not, please ask them to register as a volunteer on our website.',
  ].join('\n');

  await sendViaResend({
    to:      process.env.ALERT_EMAIL || 'volunteercheck@aahsmilefarm.org',
    subject: 'Unregistered volunteer signup alert',
    text,
  });
}

/**
 * Send a signup confirmation email to a volunteer.
 *
 * @param {object} opts
 * @param {string} opts.to        Volunteer's email
 * @param {string} opts.name      Volunteer's full name
 * @param {string} opts.shiftName Shift title
 * @param {string} opts.date      "YYYY-MM-DD"
 * @param {string} opts.time      e.g. "9:00am–11:00am"
 * @param {string} opts.location  Location string (may be empty)
 */
async function sendConfirmationEmail({ to, name, shiftName, date, time, location }) {
  const d = new Date(date + 'T12:00:00Z');
  const prettyDate = d.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  const locationLine = location ? `\n📍 ${location}` : '';

  const text = [
    `Hi ${name},`,
    '',
    `You're signed up for ${shiftName} on ${prettyDate} at ${time}.${locationLine}`,
    '',
    'See you then!',
    '— Animal Assisted Happiness',
  ].join('\n');

  await sendViaResend({
    to,
    subject: `You're signed up for ${shiftName}`,
    text,
  });
}

module.exports = { sendReminderEmail, sendUnregisteredAlert, sendConfirmationEmail };
