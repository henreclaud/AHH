// db.js
// This file sets up our SQLite database and creates the tables we need.
// We use the "better-sqlite3" library because it is simple and lets us write
// database code without callbacks (each query runs and returns right away).

const Database = require('better-sqlite3');
const path = require('path');

// Create (or open) a database file called "database.sqlite" in the project folder.
// If the file does not exist yet, better-sqlite3 creates it automatically.
const db = new Database(path.join(__dirname, 'database.sqlite'));

// Turn on "foreign keys" so the database enforces the link between a signup
// and the shift it belongs to (and cleans up signups when a shift is deleted).
db.pragma('foreign_keys = ON');

// The "shifts" table. Each row is one volunteer shift (e.g. a pony visit).
db.exec(`
  CREATE TABLE IF NOT EXISTS shifts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT, -- unique id for each shift
    title      TEXT    NOT NULL,                  -- the name of the visit, e.g. "Pony Visit"
    icon       TEXT    NOT NULL DEFAULT '🐾',     -- a friendly emoji shown on the card
    category   TEXT    NOT NULL DEFAULT 'Visit',  -- activity type, used for filtering
    location   TEXT    NOT NULL DEFAULT '',       -- the address (becomes a clickable map link)
    date       TEXT    NOT NULL,                  -- the date as text, e.g. "2026-06-14"
    start_time TEXT    NOT NULL,                  -- start time, e.g. "10:00"
    end_time   TEXT    NOT NULL,                  -- end time, e.g. "12:00"
    capacity   INTEGER NOT NULL                   -- how many volunteers are needed
  )
`);

// If you have an older database created before some columns existed, quietly
// add them so everything keeps working. (Each one is skipped if already there.)
const shiftColumns = db.prepare('PRAGMA table_info(shifts)').all();
const hasColumn = (name) => shiftColumns.some((column) => column.name === name);
if (!hasColumn('icon')) {
  db.exec("ALTER TABLE shifts ADD COLUMN icon TEXT NOT NULL DEFAULT '🐾'");
}
if (!hasColumn('location')) {
  db.exec("ALTER TABLE shifts ADD COLUMN location TEXT NOT NULL DEFAULT ''");
}
if (!hasColumn('category')) {
  db.exec("ALTER TABLE shifts ADD COLUMN category TEXT NOT NULL DEFAULT 'Visit'");
  // Backfill sensible activity types for any pre-existing shifts so the new
  // "activity type" filter has something to group by. Each statement only
  // touches rows still on the default, and order matters (Mobile before Farm,
  // since "Mobile Petting Farm" contains the word "Farm").
  db.exec("UPDATE shifts SET category = 'Mobile Visit'   WHERE category = 'Visit' AND title LIKE '%Mobile%'");
  db.exec("UPDATE shifts SET category = 'Reading Buddies' WHERE category = 'Visit' AND title LIKE '%Read%'");
  db.exec("UPDATE shifts SET category = 'Pony Visit'     WHERE category = 'Visit' AND (title LIKE '%Pony%' OR title LIKE '%Horse%')");
  db.exec("UPDATE shifts SET category = 'Bunny Visit'    WHERE category = 'Visit' AND (title LIKE '%Bunny%' OR title LIKE '%Rabbit%')");
  db.exec("UPDATE shifts SET category = 'Farm Care'      WHERE category = 'Visit' AND (title LIKE '%Farm%' OR title LIKE '%Chore%' OR title LIKE '%Barn%')");
}

// The "signups" table. Each row is one volunteer signed up for one shift.
db.exec(`
  CREATE TABLE IF NOT EXISTS signups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id   INTEGER NOT NULL,                  -- which shift this signup is for
    name       TEXT    NOT NULL,
    email      TEXT    NOT NULL,
    created_at TEXT    NOT NULL,                  -- when they signed up (a timestamp)
    FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE CASCADE
  )
`);

// If there are no shifts yet, add a few example animal visits so the app is not
// empty the first time you run it. You can delete these from the admin page.
const shiftCount = db.prepare('SELECT COUNT(*) AS count FROM shifts').get().count;
if (shiftCount === 0) {
  // NOTE: these are EXAMPLE visits with example addresses, just to show how the
  // app looks. Replace them with your real visits from the admin page.
  const insert = db.prepare(
    'INSERT INTO shifts (title, icon, category, location, date, start_time, end_time, capacity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  insert.run('Smile Farm Morning Chores', '🐐', 'Farm Care', '27210 Altamont Rd, Los Altos Hills, CA', '2026-06-14', '08:00', '11:00', 5);
  insert.run('Pony Visit — Senior Living', '🐴', 'Pony Visit', '500 W Middlefield Rd, Mountain View, CA', '2026-06-15', '10:00', '12:00', 3);
  insert.run('Bunny Cuddle Corner — Children\'s Hospital', '🐰', 'Bunny Visit', '725 Welch Rd, Palo Alto, CA', '2026-06-17', '14:00', '16:00', 4);
  insert.run('Mobile Petting Farm — Community Festival', '🐤', 'Mobile Visit', '201 S Rengstorff Ave, Mountain View, CA', '2026-06-20', '09:00', '13:00', 8);
  insert.run('Reading Buddies with Guinea Pigs', '🐹', 'Reading Buddies', '770 Main St, Los Altos, CA', '2026-06-22', '13:00', '15:00', 4);
}

// Make this database connection available to other files (server.js uses it).
module.exports = db;
