'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const cs     = require('../calendar-sync');

const rows = [
  { name: 'Jane Smith', email: 'jane@x.org', phone: '650-555-0101', adult: true },
  { name: 'Sam Lee',    email: 'sam@x.org',  phone: '408-555-0102', ya: true, attended: true },
];
const HEAD = "{━━━━━━━━ VOLUNTEER SIGNUPS (added by the volunteer app) ━━━━━━━━\nPlease don't edit below this line. It's rewritten automatically.";

test('block: divider, totals by type, then one line per volunteer with email, phone and attendance', () => {
  const out = cs.withSignupBlock('Wear closed-toe shoes. Limit 6', rows);
  assert.strictEqual(out,
    'Wear closed-toe shoes. Limit 6\n\n' + HEAD + '\n' +
    '2 signed up: YA (1), Adult (1)\n\n' +
    'Jane Smith (A) · jane@x.org · 650-555-0101\n' +
    'Sam Lee (YA) · sam@x.org · 408-555-0102 · ✓ Attended}');
});

test('totals leave out types nobody has, and count every type a person has', () => {
  const t = cs.buildSignupBlock([
    { name: 'A', youth: true }, { name: 'B', youth: true, corporate: true }, { name: 'C' },
  ], false);
  assert.match(t, /\n3 signed up: Youth \(2\), Corporate \(1\)\n/);
  assert.match(cs.buildSignupBlock([{ name: 'Solo' }], false), /\n1 signed up\n/);
});

test('contacts off (outside guests): names, types and attendance only, with a note', () => {
  const t = cs.buildSignupBlock(rows, false, { contacts: false });
  assert.ok(!t.includes('jane@x.org') && !t.includes('650-555'));
  assert.ok(t.includes('Contact details hidden: this event has guests from outside AAH.'));
  assert.ok(t.includes('Sam Lee (YA) · ✓ Attended'));
});

test('unregistered volunteers are flagged', () => {
  assert.ok(cs.buildSignupBlock([{ name: 'New Person', unregistered: true }], false).includes('New Person (not registered)'));
});

test('uses <br> in an HTML description', () => {
  const out = cs.withSignupBlock('<b>Bring water</b><br>Limit 6', rows);
  assert.ok(out.startsWith('<b>Bring water</b><br>Limit 6<br><br>{━━━━━━━━ VOLUNTEER SIGNUPS'));
  assert.ok(out.includes('<br>2 signed up: YA (1), Adult (1)<br><br>Jane Smith (A)'));
});

test('rewriting replaces the block instead of adding a second one', () => {
  const once  = cs.withSignupBlock('Notes', rows);
  const twice = cs.withSignupBlock(once, [...rows, { name: 'Emma Smith', adult: true }]);
  assert.strictEqual((twice.match(/VOLUNTEER SIGNUPS/g) || []).length, 1);
  assert.ok(twice.includes('3 signed up: YA (1), Adult (2)'));
  assert.ok(twice.startsWith('Notes\n\n{'));       // no blank lines pile up
});

test('lists written in the first format are replaced, not duplicated', () => {
  const old = 'Notes\n\n{Volunteer signups (2), kept up to date by the volunteer app:\nJane Smith\nSam Lee (YA)}';
  const out = cs.withSignupBlock(old, rows);
  assert.ok(!out.includes('kept up to date'));
  assert.strictEqual((out.match(/\{/g) || []).length, 1);
  assert.ok(out.startsWith('Notes\n\n' + HEAD));
  assert.strictEqual(cs.stripSignupBlock(old), 'Notes');
});

test('same signups twice gives an identical description (no needless writes)', () => {
  const once = cs.withSignupBlock('Notes', rows);
  assert.strictEqual(cs.withSignupBlock(once, rows), once);
});

test('removes the block when the last person cancels', () => {
  const once = cs.withSignupBlock('Notes {staff only bit}', rows);
  assert.strictEqual(cs.withSignupBlock(once, []), 'Notes {staff only bit}');
});

test('an empty description gets just the block', () => {
  assert.ok(cs.withSignupBlock('', rows).startsWith(HEAD));
  assert.strictEqual(cs.withSignupBlock('', []), '');
});

test('staff braces and text around the block are left untouched', () => {
  const desc = 'Meet at gate {Coordinator: Maria 555-0100} Limit 4';
  const out  = cs.withSignupBlock(desc, rows);
  assert.strictEqual(cs.stripSignupBlock(out), desc);
});

test('a hostile name or email cannot escape the block or change the spot limit', () => {
  const evil = [{ name: 'Jane} Limit 50 <script>x</script> {', email: 'x}{@evil.com', phone: '<b>1</b>' }];
  const out  = cs.withSignupBlock('Mobile visit', evil);
  assert.strictEqual((out.match(/\{/g) || []).length, 1);   // only the block's own braces
  assert.strictEqual((out.match(/\}/g) || []).length, 1);
  assert.ok(!/[<>]/.test(out));
  assert.strictEqual(cs.stripSignupBlock(out), 'Mobile visit');
});

test('"&" is escaped only in HTML descriptions', () => {
  const r = [{ name: 'Tom & Jerry' }];
  assert.ok(cs.withSignupBlock('plain', r).includes('Tom & Jerry'));
  assert.ok(cs.withSignupBlock('<b>html</b>', r).includes('Tom &amp; Jerry'));
});

test('the block is still found after Google Calendar converts newlines to <br>', () => {
  const written  = cs.withSignupBlock('Notes', rows);
  const reEdited = written.replace(/\n/g, '<br>');           // what the web UI can do
  assert.strictEqual(cs.stripSignupBlock(reEdited), 'Notes');
});

test('a huge event stays short: contacts dropped, then the list cut with a pointer to the staff page', () => {
  const many = Array.from({ length: 400 }, (_, i) => ({ name: `Volunteer Number ${i}`, email: `volunteer.number.${i}@example.org`, phone: '650-555-0100', adult: true }));
  const t = cs.buildSignupBlock(many, false);
  assert.ok(t.length <= 6000, `${t.length} characters`);
  assert.ok(t.includes('400 signed up: Adult (400)'));       // totals always cover everyone
  assert.ok(!t.includes('@example.org'));
  assert.match(t, /…and \d+ more\. See the staff page for the full list\.\}$/);
  assert.strictEqual(cs.stripSignupBlock('Notes\n\n' + t), 'Notes');
});

test('a mid-size event (60 people) keeps everyone with contact details', () => {
  const sixty = Array.from({ length: 60 }, (_, i) => ({ name: `Person ${i}`, email: `p${i}@x.org`, phone: '650-555-0100', youth: true }));
  const t = cs.buildSignupBlock(sixty, false);
  assert.ok(t.includes('p59@x.org') && !t.includes('more. See the staff page'));
});

test('eventSlot uses the same date and time format as signup rows', () => {
  const slot = cs.eventSlot({
    start: { dateTime: '2026-10-10T09:00:00-07:00' },
    end:   { dateTime: '2026-10-10T11:30:00-07:00' },
  });
  assert.strictEqual(slot.date, '2026-10-10');
  assert.strictEqual(slot.time, '9:00am-11:30am');
});

test('daylight saving (Nov 1, 2026): times stay right on both sides of the change', () => {
  const before = cs.eventSlot({ start: { dateTime: '2026-10-31T09:00:00-07:00' }, end: { dateTime: '2026-10-31T11:00:00-07:00' } });
  const after  = cs.eventSlot({ start: { dateTime: '2026-11-02T09:00:00-08:00' }, end: { dateTime: '2026-11-02T11:00:00-08:00' } });
  assert.deepStrictEqual([before.date, before.time], ['2026-10-31', '9:00am-11:00am']);
  assert.deepStrictEqual([after.date,  after.time],  ['2026-11-02', '9:00am-11:00am']);
  // An event that crosses the change at 2am still reads as the clock-on-the-wall times.
  const across = cs.eventSlot({ start: { dateTime: '2026-11-01T00:30:00-07:00' }, end: { dateTime: '2026-11-01T03:30:00-08:00' } });
  assert.strictEqual(across.time, '12:30am-3:30am');
});

test('hasMoved ignores formatting differences but catches real moves', () => {
  const slot = { date: '2026-10-10', time: '9:00am-11:30am' };
  assert.strictEqual(cs.hasMoved('2026-10-10', '9:00am-11:30am', slot), false);
  assert.strictEqual(cs.hasMoved('10/10/2026', '9:00AM – 11:30AM', slot), false);
  assert.strictEqual(cs.hasMoved('2026-10-11', '9:00am-11:30am', slot), true);
  assert.strictEqual(cs.hasMoved('2026-10-10', '10:00am-11:30am', slot), true);
});
