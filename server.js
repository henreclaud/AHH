// server.js — AAH volunteer signup app.
// Serves the frontend and provides a JSON API backed by Google Calendar + Sheets.

'use strict';

const express   = require('express');
const path      = require('path');
const crypto    = require('crypto');
const cron      = require('node-cron');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

// Load .env file when running locally.
// On Render the real environment variables are set in the dashboard.
require('dotenv').config();

const {
  getShifts,
  getStaffShifts,
  getAdminShifts,
  createSignup,
  cancelSignupById,
  getUpcomingSignupsByEmail,
  ensureHeaders,
  getPasswords,
  getStaffList,
  getBannerMessages,
  getTodaySignupsForPerson,
  getTodayCheckoutsForPerson,
  markCheckIn,
  markCheckOut,
  markNoShows,
} = require('./google');

const app  = express();
const PORT = process.env.PORT || 3000;

// Render terminates TLS at its proxy, so the real client IP arrives in
// X-Forwarded-For. Trust one proxy hop so rate limiting keys on the real IP.
app.set('trust proxy', 1);

// Security headers. CSP is left off because the pages use inline style
// attributes and would otherwise break; the other protections (no MIME
// sniffing, no framing/clickjacking, referrer policy, HSTS) all apply.
app.use(helmet({ contentSecurityPolicy: false }));

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ── Rate limiters ───────────────────────────────────────────────────────────
// Login: blunt the password brute-force. 10 tries / 15 min / IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

// Public write/lookup endpoints (signup, cancel, lookup-by-email, check-in/out):
// stop signup-ID guessing and PII enumeration. 30 requests / min / IP.
const publicApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down and try again shortly.' },
});

// ── Auth ──────────────────────────────────────────────────────────────────────
// Token-based auth for Admin and Staff pages.
// Tokens are random 32-byte hex strings kept in memory; they expire on server
// restart (deploy), requiring a re-login.  Passwords are read from the "pwd"
// tab on the Google Sheet so Peter can update them without a code change.

const adminTokens = new Set();
const staffTokens = new Set();

function makeRequireRole(tokenSet) {
  return function (req, res, next) {
    const header = req.headers['authorization'] || '';
    const token  = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token && tokenSet.has(token)) return next();
    res.status(401).json({ error: 'Unauthorized' });
  };
}
const requireAdmin = makeRequireRole(adminTokens);
const requireStaff = makeRequireRole(staffTokens);

// Length-safe constant-time string comparison — avoids leaking the password
// via response timing. Returns false for any length mismatch.
function constantTimeEquals(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Shared login helper — looks up the password for `role` in the sheet and
// issues a token if it matches.
async function handleLogin(role, tokenSet, supplied, res) {
  if (!supplied) {
    return res.status(400).json({ error: 'Password is required.' });
  }
  let passwords;
  try {
    passwords = await getPasswords();
  } catch (err) {
    console.error(`[auth] Could not read passwords from sheet:`, err.message);
    return res.status(503).json({ error: 'Could not verify password — please try again.' });
  }
  const expected = passwords[role];
  if (!expected) {
    console.warn(`[auth] No ${role} password set in the pwd tab.`);
    return res.status(503).json({ error: `${role.charAt(0).toUpperCase() + role.slice(1)} access is not configured. Add the password to the pwd tab on the sheet.` });
  }
  if (!constantTimeEquals(supplied, expected)) {
    console.log(`[auth] Failed ${role} login`);
    return res.status(401).json({ error: 'Incorrect password. Try again.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  tokenSet.add(token);
  console.log(`[auth] ${role} login successful`);
  res.json({ token });
}

// POST /api/admin/login — body: { password }
app.post('/api/admin/login', loginLimiter, async (req, res) => {
  await handleLogin('admin', adminTokens, (req.body.password || '').trim(), res);
});

// POST /api/staff/login — body: { password }
app.post('/api/staff/login', loginLimiter, async (req, res) => {
  await handleLogin('staff', staffTokens, (req.body.password || '').trim(), res);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ── Public API ────────────────────────────────────────────────────────────────

// GET /api/shifts
// Returns all upcoming shifts (from Google Calendar) with live spot counts.
app.get('/api/shifts', async (req, res) => {
  try {
    res.json(await getShifts());
  } catch (err) {
    console.error('[GET /api/shifts]', err.message);
    res.status(500).json({ error: 'Could not load shifts. Please try again.' });
  }
});

// POST /api/shifts/:id/signup
// Signs a volunteer up for a shift. Body: { name, email }.
// :id is the Google Calendar event ID.
app.post('/api/shifts/:id/signup', publicApiLimiter, async (req, res) => {
  const name  = (req.body.name  || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();

  if (!name || !email) {
    return res.status(400).json({ error: 'Please provide both your name and email.' });
  }
  if (!/\S+\s+\S+/.test(name)) {
    return res.status(400).json({ error: 'Please enter your first and last name.' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  try {
    const result = await createSignup(req.params.id, name, email);
    if (!result.ok) return res.status(409).json({ error: result.error });
    res.status(201).json({ message: result.message, signupId: result.signupId });
  } catch (err) {
    console.error('[POST /api/shifts/:id/signup]', err.message);
    res.status(500).json({ error: 'Could not save your signup. Please try again.' });
  }
});

// GET /api/signups?email=
// Returns all upcoming signups for the given email (for the cancel page).
app.get('/api/signups', publicApiLimiter, async (req, res) => {
  const email = (req.query.email || '').trim();
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  try {
    res.json(await getUpcomingSignupsByEmail(email));
  } catch (err) {
    console.error('[GET /api/signups]', err.message);
    res.status(500).json({ error: 'Could not look up signups. Please try again.' });
  }
});

// POST /api/signups/cancel
// Cancels a signup by ID. Body: { signupId }.
app.post('/api/signups/cancel', publicApiLimiter, async (req, res) => {
  const signupId = (req.body.signupId || '').trim();

  if (!signupId) {
    return res.status(400).json({ error: 'signupId is required.' });
  }

  try {
    const result = await cancelSignupById(signupId);
    if (!result.ok) return res.status(404).json({ error: result.error });
    res.json({ message: result.message });
  } catch (err) {
    console.error('[POST /api/signups/cancel]', err.message);
    res.status(500).json({ error: 'Could not cancel signup. Please try again.' });
  }
});

// ── Admin API ─────────────────────────────────────────────────────────────────

// GET /api/staff/shifts  (requires staff auth)
// Returns all shifts with both description sections AND the full signup list per shift.
app.get('/api/staff/shifts', requireStaff, async (req, res) => {
  try {
    res.json(await getAdminShifts());
  } catch (err) {
    console.error('[GET /api/staff/shifts]', err.message);
    res.status(500).json({ error: 'Could not load shifts. Please try again.' });
  }
});

// GET /api/message — banner message for the volunteer page (public).
// Staff write it into cell A2 of the restricted message sheet.
app.get('/api/message', async (req, res) => {
  try {
    const { volunteer } = await getBannerMessages();
    res.json({ message: volunteer });
  } catch (err) {
    console.error('[GET /api/message]', err.message);
    res.json({ message: '' }); // banner is cosmetic — never error the page
  }
});

// GET /api/staff/message — banner message for the staff page (cell B2).
app.get('/api/staff/message', requireStaff, async (req, res) => {
  try {
    const { staff } = await getBannerMessages();
    res.json({ message: staff });
  } catch (err) {
    console.error('[GET /api/staff/message]', err.message);
    res.json({ message: '' });
  }
});

// GET /api/staff/list  (requires staff auth)
// Returns the staff roster [{ name, email }] from the staff tab on the Sheet.
// Powers the per-person filter chips on the staff page.
app.get('/api/staff/list', requireStaff, async (req, res) => {
  try {
    res.json(await getStaffList());
  } catch (err) {
    console.error('[GET /api/staff/list]', err.message);
    res.status(500).json({ error: 'Could not load the staff list.' });
  }
});

// GET /api/admin/shifts  (requires admin auth)
// Returns all shifts with their full signup lists (name + email per person).
app.get('/api/admin/shifts', requireAdmin, async (req, res) => {
  try {
    res.json(await getAdminShifts());
  } catch (err) {
    console.error('[GET /api/admin/shifts]', err.message);
    res.status(500).json({ error: 'Could not load admin data. Please try again.' });
  }
});

// ── Check-in / Check-out API ──────────────────────────────────────────────────

// GET /api/checkin?email=&name=
// Returns today's active-window signups for the given person (email + name).
app.get('/api/checkin', publicApiLimiter, async (req, res) => {
  const email = (req.query.email || '').trim();
  const name  = (req.query.name  || '').trim();
  if (!email || !name) return res.status(400).json({ error: 'Email and name are required.' });
  try {
    res.json(await getTodaySignupsForPerson(email, name));
  } catch (err) {
    console.error('[GET /api/checkin]', err.message);
    res.status(500).json({ error: 'Could not look up signups. Please try again.' });
  }
});

// POST /api/checkin  body: { signupId }
// Marks a signup as Attended and records the check-in time.
app.post('/api/checkin', publicApiLimiter, async (req, res) => {
  const signupId = (req.body.signupId || '').trim().toUpperCase();
  if (!signupId) return res.status(400).json({ error: 'signupId is required.' });
  try {
    const result = await markCheckIn(signupId);
    if (!result.ok) return res.status(404).json({ error: result.error });
    res.json({ ok: true, checkin_time: result.checkin_time });
  } catch (err) {
    console.error('[POST /api/checkin]', err.message);
    res.status(500).json({ error: 'Could not record check-in. Please try again.' });
  }
});

// GET /api/checkout?email=&name=
// Returns today's checked-in (but not yet checked-out) signups for this person.
app.get('/api/checkout', publicApiLimiter, async (req, res) => {
  const email = (req.query.email || '').trim();
  const name  = (req.query.name  || '').trim();
  if (!email || !name) return res.status(400).json({ error: 'Email and name are required.' });
  try {
    res.json(await getTodayCheckoutsForPerson(email, name));
  } catch (err) {
    console.error('[GET /api/checkout]', err.message);
    res.status(500).json({ error: 'Could not look up signups. Please try again.' });
  }
});

// POST /api/checkout  body: { signupId }
// Records check-out time and computes hours worked.
app.post('/api/checkout', publicApiLimiter, async (req, res) => {
  const signupId = (req.body.signupId || '').trim().toUpperCase();
  if (!signupId) return res.status(400).json({ error: 'signupId is required.' });
  try {
    const result = await markCheckOut(signupId);
    if (!result.ok) return res.status(404).json({ error: result.error });
    res.json({ ok: true, checkout_time: result.checkout_time, hours: result.hours });
  } catch (err) {
    console.error('[POST /api/checkout]', err.message);
    res.status(500).json({ error: 'Could not record check-out. Please try again.' });
  }
});

// ── No-show cron ──────────────────────────────────────────────────────────────

// POST /api/cron/mark-noshows
// Marks all unfilled attendance rows for today (or a given date) as No-show.
// Protected by CRON_SECRET env var.  Also called internally by node-cron.
app.post('/api/cron/mark-noshows', async (req, res) => {
  const secret   = (process.env.CRON_SECRET || '').trim();
  const supplied = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  // Fail closed: with no CRON_SECRET configured, the endpoint stays locked —
  // the internal node-cron schedule below doesn't go through HTTP anyway.
  if (!secret || supplied !== secret) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }
  try {
    const result = await markNoShows(req.body.date || undefined);
    res.json(result);
  } catch (err) {
    console.error('[POST /api/cron/mark-noshows]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Schedule no-show flagging at 11:59pm Pacific every night.
cron.schedule('59 23 * * *', async () => {
  console.log('[cron] running nightly no-show check');
  try {
    const result = await markNoShows();
    console.log(`[cron] no-show check done: ${result.marked} marked for ${result.date}`);
  } catch (err) {
    console.error('[cron] no-show check failed:', err.message);
  }
}, { timezone: 'America/Los_Angeles' });

// ── Start ─────────────────────────────────────────────────────────────────────

async function start() {
  // Make sure the signup spreadsheet has a header row before taking traffic.
  try {
    await ensureHeaders();
  } catch (err) {
    // Don't crash — the app can still serve the UI if the sheet isn't ready yet.
    // The real error will show up the first time someone tries to sign up.
    console.warn('[startup] sheet header check failed:', err.message);
  }

  app.listen(PORT, () => {
    console.log(`AAH volunteer app → http://localhost:${PORT}`);
  });
}

start();
