// server.js
// This is the main file that starts our web server using Express.
// It serves the web pages (HTML/CSS/JS) and provides a small JSON API that the
// frontend calls to read shifts and create signups.

const express = require('express');
const path = require('path');
const db = require('./db'); // our database connection from db.js

const app = express();

// Let Express read JSON sent in the body of POST/PUT requests.
app.use(express.json());

// Serve everything in the "public" folder as static files.
// This makes http://localhost:3000/ automatically load public/index.html.
app.use(express.static(path.join(__dirname, 'public')));

// A small helper to check that an email looks roughly valid.
function isValidEmail(email) {
  // Some text, then "@", then text, then ".", then text.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ---------------------------------------------------------------------------
// PUBLIC API (used by the volunteer page)
// ---------------------------------------------------------------------------

// GET /api/shifts
// Returns every shift, including how many spots are left and whether it is full.
app.get('/api/shifts', (req, res) => {
  // Get each shift along with a count of how many people already signed up.
  const shifts = db
    .prepare(
      `SELECT
         shifts.*,
         (SELECT COUNT(*) FROM signups WHERE signups.shift_id = shifts.id) AS taken
       FROM shifts
       ORDER BY date, start_time`
    )
    .all();

  // Add two convenient fields the frontend can use directly.
  const result = shifts.map((shift) => ({
    ...shift,
    spots_left: shift.capacity - shift.taken,
    is_full: shift.taken >= shift.capacity,
  }));

  res.json(result);
});

// POST /api/shifts/:id/signup
// Signs a volunteer up for a shift. Expects { name, email } in the request body.
app.post('/api/shifts/:id/signup', (req, res) => {
  const shiftId = Number(req.params.id);
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim();

  // Basic validation of the inputs.
  if (!name || !email) {
    return res.status(400).json({ error: 'Please provide both your name and email.' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }

  // Make sure the shift actually exists.
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
  if (!shift) {
    return res.status(404).json({ error: 'That shift does not exist.' });
  }

  // Count how many people have already signed up for this shift.
  const taken = db
    .prepare('SELECT COUNT(*) AS count FROM signups WHERE shift_id = ?')
    .get(shiftId).count;

  // Stop if the shift is already full.
  if (taken >= shift.capacity) {
    return res.status(409).json({ error: 'Sorry, this shift is already full.' });
  }

  // Stop if this same email already signed up for this shift.
  const existing = db
    .prepare('SELECT id FROM signups WHERE shift_id = ? AND email = ?')
    .get(shiftId, email);
  if (existing) {
    return res.status(409).json({ error: 'You have already signed up for this shift.' });
  }

  // Save the signup.
  db.prepare(
    'INSERT INTO signups (shift_id, name, email, created_at) VALUES (?, ?, ?, ?)'
  ).run(shiftId, name, email, new Date().toISOString());

  res.status(201).json({ message: 'You are signed up. Thank you!' });
});

// ---------------------------------------------------------------------------
// ADMIN API (used by the admin page)
// NOTE: For simplicity this admin API has NO password. Anyone who can reach the
// site can add or delete shifts. Add some protection before deploying publicly
// (see the notes that came with this project).
// ---------------------------------------------------------------------------

// GET /api/admin/shifts
// Returns every shift together with the full list of people who signed up.
app.get('/api/admin/shifts', (req, res) => {
  const shifts = db.prepare('SELECT * FROM shifts ORDER BY date, start_time').all();

  // For each shift, attach the list of its signups.
  const result = shifts.map((shift) => {
    const signups = db
      .prepare(
        'SELECT id, name, email, created_at FROM signups WHERE shift_id = ? ORDER BY created_at'
      )
      .all(shift.id);

    return {
      ...shift,
      signups,
      spots_left: shift.capacity - signups.length,
    };
  });

  res.json(result);
});

// POST /api/shifts
// Adds a new shift. Expects { title, date, start_time, end_time, capacity }.
app.post('/api/shifts', (req, res) => {
  const title = (req.body.title || '').trim();
  // The icon is optional; fall back to a paw print if none is given.
  const icon = (req.body.icon || '').trim() || '🐾';
  // The activity type is optional; used by the volunteer page's filters.
  const category = (req.body.category || '').trim() || 'Visit';
  // The location/address is optional (used to build a map link on the card).
  const location = (req.body.location || '').trim();
  const date = (req.body.date || '').trim();
  const startTime = (req.body.start_time || '').trim();
  const endTime = (req.body.end_time || '').trim();
  const capacity = Number(req.body.capacity);

  // Validate the inputs.
  if (!title || !date || !startTime || !endTime) {
    return res.status(400).json({ error: 'Please fill in all of the shift fields.' });
  }
  if (!Number.isInteger(capacity) || capacity < 1) {
    return res.status(400).json({ error: 'Capacity must be a whole number of 1 or more.' });
  }

  const info = db
    .prepare(
      'INSERT INTO shifts (title, icon, category, location, date, start_time, end_time, capacity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(title, icon, category, location, date, startTime, endTime, capacity);

  res.status(201).json({ id: info.lastInsertRowid, message: 'Shift added.' });
});

// DELETE /api/shifts/:id
// Deletes a shift and (because of ON DELETE CASCADE) all of its signups.
app.delete('/api/shifts/:id', (req, res) => {
  const shiftId = Number(req.params.id);
  const info = db.prepare('DELETE FROM shifts WHERE id = ?').run(shiftId);

  if (info.changes === 0) {
    return res.status(404).json({ error: 'That shift does not exist.' });
  }
  res.json({ message: 'Shift deleted.' });
});

// ---------------------------------------------------------------------------
// Start the server.
// ---------------------------------------------------------------------------
// Use the port the hosting provider gives us (Render/Railway set process.env.PORT),
// or fall back to 3000 when running on your own computer.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Volunteer shift signup app running at http://localhost:${PORT}`);
});
