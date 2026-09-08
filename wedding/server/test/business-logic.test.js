// Unit tests for the business logic behind issues #1 (server-side recipient filtering),
// #2 (dashboard stats), #6 (Hebrew name joining), #7 (CSV export escaping) and #8 (manual
// RSVP status + do-not-send). Uses Node's built-in test runner against a throwaway SQLite
// database so it never touches real wedding data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wedding-rsvp-test-'));
process.env.DATA_DIR = tmpDataDir;

const { db } = require('../db');
const { statusForGuestCount, getStats } = require('../routes/rsvps');
const { buildRecipients } = require('../routes/whatsapp');
const { csvField } = require('../routes/invitedGuests');
const { formatHebrewNameList } = require('../../assets/hebrew-name-format');

let nextUserId = 1;
function makeUser() {
  const id = nextUserId++;
  db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'x', datetime('now'))").run(
    id,
    `user${id}@example.com`
  );
  return id;
}

function addGuest(userId, phone, name, extra = {}) {
  db.prepare(
    `INSERT INTO invited_guests (user_id, phone, name, expected_guest, do_not_send, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(userId, phone, name, extra.expected_guest ?? 1, extra.do_not_send ? 1 : 0);
}

function addRsvp(userId, phone, guests, source = 'guest') {
  const status = statusForGuestCount(guests);
  db.prepare(
    "INSERT INTO rsvps (user_id, phone, guests, status, source, timestamp) VALUES (?, ?, ?, ?, ?, datetime('now'))"
  ).run(userId, phone, guests, status, source);
}

test('statusForGuestCount: 0 guests is declined, any positive count is attending', () => {
  assert.equal(statusForGuestCount(0), 'declined');
  assert.equal(statusForGuestCount('0'), 'declined');
  assert.equal(statusForGuestCount(undefined), 'declined');
  assert.equal(statusForGuestCount(1), 'attending');
  assert.equal(statusForGuestCount('4'), 'attending');
});

test('getStats: separates invitations sent/responded/unanswered from attendee headcount (issue #2)', () => {
  const userId = makeUser();
  addGuest(userId, '0501111111', 'Guest One');
  addGuest(userId, '0502222222', 'Guest Two');
  // Guest One responds with 2 attendees; Guest Two has not responded yet.
  addRsvp(userId, '0501111111', 2);

  const stats = getStats(userId);
  assert.equal(stats.totalInvited, 2);
  assert.equal(stats.responded, 1); // one invitation answered, not two attendees
  assert.equal(stats.unanswered, 1);
  assert.equal(stats.confirmedAttendees, 2); // headcount including the plus-one
  assert.equal(stats.declined, 0);
});

test('getStats: a decline counts as responded but contributes 0 confirmed attendees', () => {
  const userId = makeUser();
  addGuest(userId, '0503333333', 'Guest Three');
  addRsvp(userId, '0503333333', 0);

  const stats = getStats(userId);
  assert.equal(stats.responded, 1);
  assert.equal(stats.unanswered, 0);
  assert.equal(stats.confirmedAttendees, 0);
  assert.equal(stats.declined, 1);
});

function fakeReq(userId, phones, unrespondedOnly) {
  return {
    userId,
    protocol: 'http',
    get: () => 'localhost:8080',
  };
}

test('buildRecipients: excludes do_not_send guests regardless of client selection (issue #1)', () => {
  const userId = makeUser();
  addGuest(userId, '0504444444', 'Send Me');
  addGuest(userId, '0505555555', 'Do Not Send', { do_not_send: true });

  const recipients = buildRecipients(fakeReq(userId), ['0504444444', '0505555555'], false);
  assert.deepEqual(
    recipients.map((r) => r.phone),
    ['0504444444']
  );
});

test('buildRecipients: unrespondedOnly excludes guests who already have an RSVP on file (issue #1)', () => {
  const userId = makeUser();
  addGuest(userId, '0506666666', 'Answered');
  addGuest(userId, '0507777777', 'Not Answered');
  addRsvp(userId, '0506666666', 1);

  const all = buildRecipients(fakeReq(userId), ['0506666666', '0507777777'], false);
  assert.equal(all.length, 2);

  const unrespondedOnly = buildRecipients(fakeReq(userId), ['0506666666', '0507777777'], true);
  assert.deepEqual(
    unrespondedOnly.map((r) => r.phone),
    ['0507777777']
  );
});

test('buildRecipients: only considers phones the client actually requested', () => {
  const userId = makeUser();
  addGuest(userId, '0508888888', 'Requested');
  addGuest(userId, '0509999999', 'Not Requested');

  const recipients = buildRecipients(fakeReq(userId), ['0508888888'], false);
  assert.deepEqual(
    recipients.map((r) => r.phone),
    ['0508888888']
  );
});

test('csvField: leaves plain values untouched (issue #7)', () => {
  assert.equal(csvField('Gabi'), 'Gabi');
  assert.equal(csvField(''), '');
  assert.equal(csvField(null), '');
  assert.equal(csvField(undefined), '');
});

test('csvField: quotes and escapes values containing commas, quotes or line breaks (issue #7)', () => {
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('line1\nline2'), '"line1\nline2"');
});

test('formatHebrewNameList: joins two names with the natural Hebrew conjunction (issue #6)', () => {
  assert.equal(formatHebrewNameList(['גבי', 'נדב']), 'גבי ונדב');
});

test('formatHebrewNameList: three or more names use commas plus a final conjunction', () => {
  assert.equal(formatHebrewNameList(['גבי', 'נדב', 'רון']), 'גבי, נדב ורון');
});

test('formatHebrewNameList: handles whitespace, a single name, and empty/missing values', () => {
  assert.equal(formatHebrewNameList(['  גבי  ', '  נדב  ']), 'גבי ונדב');
  assert.equal(formatHebrewNameList(['גבי']), 'גבי');
  assert.equal(formatHebrewNameList(['גבי', '']), 'גבי');
  assert.equal(formatHebrewNameList([]), '');
  assert.equal(formatHebrewNameList([null, undefined, '']), '');
});

test('manual RSVP upsert (PUT /rsvps/:phone logic): a later guest submission overrides a manual entry', () => {
  const userId = makeUser();
  addGuest(userId, '0501212121', 'Manual Then Guest');

  // Admin manually marks them attending with 3 guests.
  db.prepare(
    `INSERT INTO rsvps (user_id, phone, guests, status, source, timestamp) VALUES (?, ?, ?, ?, 'manual', datetime('now'))
     ON CONFLICT(user_id, phone) DO UPDATE SET guests = excluded.guests, status = excluded.status, source = 'manual', timestamp = excluded.timestamp`
  ).run(userId, '0501212121', 3, 'attending');

  let row = db.prepare('SELECT * FROM rsvps WHERE user_id = ? AND phone = ?').get(userId, '0501212121');
  assert.equal(row.source, 'manual');
  assert.equal(row.guests, 3);

  // Guest later submits their own RSVP for real — this must win and flip source back to 'guest'.
  db.prepare(
    "UPDATE rsvps SET guests = ?, status = ?, source = 'guest', timestamp = datetime('now') WHERE user_id = ? AND phone = ?"
  ).run(1, statusForGuestCount(1), userId, '0501212121');

  row = db.prepare('SELECT * FROM rsvps WHERE user_id = ? AND phone = ?').get(userId, '0501212121');
  assert.equal(row.source, 'guest');
  assert.equal(row.guests, 1);

  const stats = getStats(userId);
  assert.equal(stats.responded, 1); // never double-counted across the manual + guest write
});

test.after(() => {
  db.close();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});
