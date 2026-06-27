// Unit tests for sanitizeForSheet — guards against spreadsheet/CSV formula
// injection when user input is written to the Google Sheet.
// Run with:  node --test test/

const { test } = require('node:test');
const assert   = require('node:assert');
const { sanitizeForSheet } = require('../google');

test('prefixes a quote on values that start with a formula trigger', () => {
  // These are the characters Google Sheets treats as the start of a formula.
  assert.strictEqual(sanitizeForSheet('=HYPERLINK("http://evil","x")'), "'=HYPERLINK(\"http://evil\",\"x\")");
  assert.strictEqual(sanitizeForSheet('+1+1'), "'+1+1");
  assert.strictEqual(sanitizeForSheet('-2+3'), "'-2+3");
  assert.strictEqual(sanitizeForSheet('@SUM(A1:A9)'), "'@SUM(A1:A9)");
});

test('a malicious email that passes the email regex is still neutralized', () => {
  // `=foo@bar.com` satisfies the server's email check but is a formula.
  assert.strictEqual(sanitizeForSheet('=foo@bar.com'), "'=foo@bar.com");
});

test('leaves normal names, emails and notes untouched', () => {
  assert.strictEqual(sanitizeForSheet('Jane Smith'), 'Jane Smith');
  assert.strictEqual(sanitizeForSheet('jane@example.com'), 'jane@example.com');
  assert.strictEqual(sanitizeForSheet("O'Brien"), "O'Brien");
  assert.strictEqual(sanitizeForSheet('Note: arrived 10 min early'), 'Note: arrived 10 min early');
});

test('handles empty / null / undefined safely', () => {
  assert.strictEqual(sanitizeForSheet(''), '');
  assert.strictEqual(sanitizeForSheet(null), '');
  assert.strictEqual(sanitizeForSheet(undefined), '');
});
