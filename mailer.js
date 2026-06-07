// mailer.js — email sending via Nodemailer + Gmail.
// To switch providers (SendGrid, Postmark, SES, etc.) just replace this file.
// The send-reminders.js script only calls sendReminderEmail() — nothing else.

'use strict';

const nodemailer = require('nodemailer');

// Build a transporter from env vars each time (picks up any runtime changes).
function createTransport() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD must be set in environment variables.');
  }
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
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

module.exports = { sendReminderEmail };
