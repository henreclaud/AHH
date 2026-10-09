'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const cs     = require('../calendar-sync');

const rows = [
  { name: 'Jane Smith',  registered: 'Yes' },
  { name: 'Sam Lee',     registered: 'YA'  },
];

test('adds a braced signup block under plain-text staff notes', () => {
  const out = cs.withSignupBlock('Wear closed-toe shoes. Limit 6', rows);
  assert.strictEqual(out,
    'Wear closed-toe shoes. Limit 6\n\n' +
    '{Volunteer signups (2), kept up to date by the volunteer app:\nJane Smith\nSam Lee (YA)}');
});

test('uses <br> in an HTML description', () => {
  const out = cs.withSignupBlock('<b>Bring water</b><br>Limit 6', rows);
  assert.ok(out.startsWith('<b>Bring water</b><br>Limit 6<br><br>{Volunteer signups (2)'));
  assert.ok(out.includes('Jane Smith<br>Sam Lee (YA)}'));
});

test('rewriting replaces the block instead of adding a second one', () => {
  const once  = cs.withSignupBlock('Notes', rows);
  const twice = cs.withSignupBlock(once, [...rows, { name: 'Emma Smith', registered: 'Yes' }]);
  assert.strictEqual((twice.match(/Volunteer signups/g) || []).length, 1);
  assert.ok(twice.includes('Volunteer signups (3)'));
  assert.ok(twice.startsWith('Notes\n\n{'));       // no blank lines pile up
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
  assert.ok(cs.withSignupBlock('', rows).startsWith('{Volunteer signups (2)'));
  assert.strictEqual(cs.withSignupBlock('', []), '');
});

test('staff braces and text around the block are left untouched', () => {
  const desc = 'Meet at gate {Coordinator: Maria 555-0100} Limit 4';
  const out  = cs.withSignupBlock(desc, rows);
  assert.strictEqual(cs.stripSignupBlock(out), desc);
});

test('a hostile name cannot escape the block or change the spot limit', () => {
  const evil = [{ name: 'Jane} Limit 50 <script>x</script> {', registered: 'Yes' }];
  const out  = cs.withSignupBlock('Mobile visit', evil);
  // One opening and one closing brace: the block's own.
  assert.strictEqual((out.match(/\{/g) || []).length, 1);
  assert.strictEqual((out.match(/\}/g) || []).length, 1);
  assert.ok(!/[<>]/.test(out));
  // What the app reads for capacity has the block (and the "Limit 50") gone.
  assert.strictEqual(cs.stripSignupBlock(out), 'Mobile visit');
});

test('"&" is escaped only in HTML descriptions', () => {
  const r = [{ name: 'Tom & Jerry', registered: '' }];
  assert.ok(cs.withSignupBlock('plain', r).includes('Tom & Jerry'));
  assert.ok(cs.withSignupBlock('<b>html</b>', r).includes('Tom &amp; Jerry'));
});

test('the block is still found after Google Calendar converts newlines to <br>', () => {
  const written   = cs.withSignupBlock('Notes', rows);
  const reEdited  = written.replace(/\n/g, '<br>');          // what the web UI can do
  assert.strictEqual(cs.stripSignupBlock(reEdited), 'Notes');
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
