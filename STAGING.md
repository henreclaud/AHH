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
   `+new`), a staff password for the TEST sheet, a STAGING banner, and 4–5
   test events. Run it again any time to start fresh.

## Running

- Website: `npm run staging` → http://localhost:3000 (for the staff page, use the password that setup printed)
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
- [ ] Sign up two family members with one email, move their event, run the job → ONE email naming both
- [ ] Run the job again → no second email
- [ ] Change only the end time → one change email
- [ ] Move an event to tomorrow → change email AND a reminder for the new time
- [ ] Delete an event that has a signup → job changes nothing, sends nothing
- [ ] Check in on the moved event's new day → works

## Launch (live)

1. Peter gives the service account **Make changes to events** on the AAH calendar.
2. Merge `release/2026-11` into `main` and push. In Render, set `CALENDAR_WRITEBACK=on`.
3. Sign up for a real upcoming event yourself, check the calendar, then cancel.
   If the list doesn't appear, the Render log will say why (e.g. no edit access yet).
4. After the next hourly run, open GitHub → Actions → the latest "send-reminders"
   run. If it mentions **Column P**, something else (e.g. the sheet's Apps Script)
   is using that column: the app leaves it alone and moved-event handling stays
   off until that's sorted. Everything else keeps working.

If the site misbehaves after the launch: Render → the service → Events →
**Rollback** to the previous deploy. Every moved signup keeps its original
date and time in column P, so any wrong change can be put back.
