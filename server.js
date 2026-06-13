// server.js — AAH volunteer signup app.
// Serves the frontend and provides a JSON API backed by Google Calendar + Sheets.

'use strict';

const express = require('express');
const path    = require('path');
const crypto  = require('crypto');

// Load .env file when running locally.
// On Render the real environment variables are set in the dashboard.
require('dotenv').config();

const {
  getShifts,
  getStaffShifts,
  getAdminShifts,
  createSignup,
  cancelSignupById,
  ensureHeaders,
  getPasswords,
} = require('./google');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  if (supplied !== expected) {
    console.log(`[auth] Failed ${role} login`);
    return res.status(401).json({ error: 'Incorrect password. Try again.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  tokenSet.add(token);
  console.log(`[auth] ${role} login successful`);
  res.json({ token });
}

// POST /api/admin/login — body: { password }
app.post('/api/admin/login', async (req, res) => {
  await handleLogin('admin', adminTokens, (req.body.password || '').trim(), res);
});

// POST /api/staff/login — body: { password }
app.post('/api/staff/login', async (req, res) => {
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
app.post('/api/shifts/:id/signup', async (req, res) => {
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

// POST /api/signups/cancel
// Cancels a signup. Body: { signupId }.
app.post('/api/signups/cancel', async (req, res) => {
  const signupId = (req.body.signupId || '').trim();

  if (!signupId) {
    return res.status(400).json({ error: 'Please enter your cancellation code.' });
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
