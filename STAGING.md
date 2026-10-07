# Staging: testing calendar sync before launch

Staging runs the real app and the real hourly job on your laptop, against a
**TEST calendar** and a **TEST spreadsheet**. It never touches AAH's live
calendar or sheet: `scripts/staging.js` refuses to run unless both names
contain `TEST`, and sends every staff alert to you.

## One-time setup

1. **Calendar:** in Google Calendar, create a new calendar named e.g. `AAH TEST`.
   Settings → Share with specific people → add the service account's email
   (the `client_email` in the service-account JSON) with **Make changes to events**.
2. **Spreadsheet:** create a blank Google Sheet named e.g. `AAH signups TEST`.
   Share it with the same service account as **Editor**.
3. **Settings:** copy `.env.staging.example` to `.env.staging` and fill it in.
   The service-account JSON is in Render → Environment. Paste it into the file,
   never into chat or email. `.env.staging` is git-ignored.
4. **Fill with test data:** `npm run staging:setup`
   This creates fake volunteers (your address with `+adult`, `+ya`, `+youth`,
   `+new`), a staff password for the TEST sheet, both switches ON, a STAGING
   banner, and 4–5 test events. Run it again any time to start fresh.

## Running

- Website: `npm run staging` → http://localhost:3000 (staff page uses the password `setup` printed)
- Hourly job, once: `npm run staging:job`

## Test plan

Tick each one. "Calendar" means the TEST calendar in Google Calendar.

**Signup list in the calendar**
- [ ] Sign up for *Farm Chores* as `you+adult@…` → within seconds the event's description in Calendar ends with `{Volunteer signups (1), …: <name>}`
- [ ] Sign up `you+ya@…` → list shows 2, the second with `(YA)`
- [ ] Use "Count me in and add another" for two names → both appear
- [ ] Cancel one on My Opportunities → it disappears from the list
- [ ] Cancel the last one → the block disappears; your staff text is unchanged
- [ ] The volunteer page and staff page never show the block
- [ ] *Farm Visit* (HTML description) → list appears on its own lines, formatting intact
- [ ] Edit an event's description in Calendar, then sign up → your edit is kept
- [ ] Delete a signup row by hand in the TEST sheet → within 15 minutes the list catches up

**Moved events**
- [ ] Sign up for an event, then drag it to another day in Calendar, then run `npm run staging:job`
      → the sheet row has the new date/time, column P says `Moved from … · volunteer emailed …`, and the change email arrives (needs `GMAIL_*` set)
- [ ] Run the job again → no second email
- [ ] Move an event to tomorrow → change email AND a reminder for the new time
- [ ] Delete an event that has a signup → job changes nothing, sends nothing
- [ ] Check in on the moved event's new day → works

**Kill switch** (`app switches` tab)
- [ ] Set `calendar signup list` to OFF → wait 1 minute → sign up → calendar NOT changed, signup still works
- [ ] Set it back to ON → within 15 minutes the missed signup appears
- [ ] Set `follow moved events` to OFF → move an event → run job → nothing changes, no email; reminders still sent

## Launch (live)

1. Peter gives the service account **Make changes to events** on the AAH calendar.
2. Check the live sheet's Apps Script (Extensions → Apps Script) doesn't use column P.
3. Add an `app switches` tab to the live sheet with both rows set to **OFF**.
4. Merge `release/2026-11` into `main` and push. In Render, set `CALENDAR_WRITEBACK=on`.
5. Turn `calendar signup list` ON, then `follow moved events` ON. Watch for a day.

## Kill switch (if something goes wrong)

Set the broken feature's row in the `app switches` tab to **OFF**.
The website stops writing to the calendar within 1 minute; the hourly job
stops on its next run. Signups, reminders and check-in carry on as normal.
Every moved row keeps its original date/time in column P, so anything wrong
can be put back.

If the whole site is broken (not just these features): Render → the service →
Events → **Rollback** to the previous deploy.

## After launch: remove the kill switch

Once both features have run without problems, delete every block marked
`TEMPORARY KILL SWITCH` (calendar-sync.js, google.js, send-reminders.js, and
the related tests), and the `app switches` tab. Both features then simply run.
