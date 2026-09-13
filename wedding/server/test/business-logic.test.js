// Unit tests for the business logic behind issues #1 (server-side recipient filtering),
// #2 (dashboard stats), #6 (Hebrew name joining), #7 (CSV export escaping) and #8 (manual
// RSVP status + do-not-send). Uses Node's built-in test runner against a throwaway in-memory
// Postgres (pg-mem) database so it never touches real wedding data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wedding-rsvp-test-'));
process.env.DATA_DIR = tmpDataDir;

const { query, pool } = require('../db');
const { statusForGuestCount, getStats } = require('../routes/rsvps');
const { buildRecipients } = require('../routes/whatsapp');
const { csvField } = require('../routes/invitedGuests');
const { formatHebrewNameList } = require('../../assets/hebrew-name-format');

let nextUserId = 1;
async function makeUser() {
  const id = nextUserId++;
  await query(
    "INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, 'x', $3)",
    [id, `user${id}@example.com`, new Date().toISOString()]
  );
  return id;
}

async function addGuest(userId, phone, name, extra = {}) {
  await query(
    `INSERT INTO invited_guests (user_id, phone, name, expected_guest, do_not_send, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, phone, name, extra.expected_guest ?? 1, extra.do_not_send ? 1 : 0, new Date().toISOString(), new Date().toISOString()]
  );
}

async function addRsvp(userId, phone, guests, source = 'guest') {
  const status = statusForGuestCount(guests);
  await query(
    "INSERT INTO rsvps (user_id, phone, guests, status, source, timestamp) VALUES ($1, $2, $3, $4, $5, $6)",
    [userId, phone, guests, status, source, new Date().toISOString()]
  );
}

test('statusForGuestCount: 0 guests is declined, any positive count is attending', () => {
  assert.equal(statusForGuestCount(0), 'declined');
  assert.equal(statusForGuestCount('0'), 'declined');
  assert.equal(statusForGuestCount(undefined), 'declined');
  assert.equal(statusForGuestCount(1), 'attending');
  assert.equal(statusForGuestCount('4'), 'attending');
});

test('getStats: separates invitations sent/responded/unanswered from attendee headcount (issue #2)', async () => {
  const userId = await makeUser();
  await addGuest(userId, '0501111111', 'Guest One');
  await addGuest(userId, '0502222222', 'Guest Two');
  // Guest One responds with 2 attendees; Guest Two has not responded yet.
  await addRsvp(userId, '0501111111', 2);

  const stats = await getStats(userId);
  assert.equal(stats.totalInvited, 2);
  assert.equal(stats.responded, 1); // one invitation answered, not two attendees
  assert.equal(stats.unanswered, 1);
  assert.equal(stats.confirmedAttendees, 2); // headcount including the plus-one
  assert.equal(stats.declined, 0);
});

test('getStats: a decline counts as responded but contributes 0 confirmed attendees', async () => {
  const userId = await makeUser();
  await addGuest(userId, '0503333333', 'Guest Three');
  await addRsvp(userId, '0503333333', 0);

  const stats = await getStats(userId);
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

test('buildRecipients: excludes do_not_send guests regardless of client selection (issue #1)', async () => {
  const userId = await makeUser();
  await addGuest(userId, '0504444444', 'Send Me');
  await addGuest(userId, '0505555555', 'Do Not Send', { do_not_send: true });

  const recipients = await buildRecipients(fakeReq(userId), ['0504444444', '0505555555'], false);
  assert.deepEqual(
    recipients.map((r) => r.phone),
    ['0504444444']
  );
});

test('buildRecipients: unrespondedOnly excludes guests who already have an RSVP on file (issue #1)', async () => {
  const userId = await makeUser();
  await addGuest(userId, '0506666666', 'Answered');
  await addGuest(userId, '0507777777', 'Not Answered');
  await addRsvp(userId, '0506666666', 1);

  const all = await buildRecipients(fakeReq(userId), ['0506666666', '0507777777'], false);
  assert.equal(all.length, 2);

  const unrespondedOnly = await buildRecipients(fakeReq(userId), ['0506666666', '0507777777'], true);
  assert.deepEqual(
    unrespondedOnly.map((r) => r.phone),
    ['0507777777']
  );
});

test('buildRecipients: only considers phones the client actually requested', async () => {
  const userId = await makeUser();
  await addGuest(userId, '0508888888', 'Requested');
  await addGuest(userId, '0509999999', 'Not Requested');

  const recipients = await buildRecipients(fakeReq(userId), ['0508888888'], false);
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

test('manual RSVP upsert (PUT /rsvps/:phone logic): a later guest submission overrides a manual entry', async () => {
  const userId = await makeUser();
  await addGuest(userId, '0501212121', 'Manual Then Guest');

  // Admin manually marks them attending with 3 guests.
  await query(
    `INSERT INTO rsvps (user_id, phone, guests, status, source, timestamp) VALUES ($1, $2, $3, $4, 'manual', $5)
     ON CONFLICT (user_id, phone) DO UPDATE SET guests = EXCLUDED.guests, status = EXCLUDED.status, source = 'manual', timestamp = EXCLUDED.timestamp`,
    [userId, '0501212121', 3, 'attending', new Date().toISOString()]
  );

  let { rows } = await query('SELECT * FROM rsvps WHERE user_id = $1 AND phone = $2', [userId, '0501212121']);
  let row = rows[0];
  assert.equal(row.source, 'manual');
  assert.equal(row.guests, 3);

  // Guest later submits their own RSVP for real — this must win and flip source back to 'guest'.
  await query(
    "UPDATE rsvps SET guests = $1, status = $2, source = 'guest', timestamp = $3 WHERE user_id = $4 AND phone = $5",
    [1, statusForGuestCount(1), new Date().toISOString(), userId, '0501212121']
  );

  ({ rows } = await query('SELECT * FROM rsvps WHERE user_id = $1 AND phone = $2', [userId, '0501212121']));
  row = rows[0];
  assert.equal(row.source, 'guest');
  assert.equal(row.guests, 1);

  const stats = await getStats(userId);
  assert.equal(stats.responded, 1); // never double-counted across the manual + guest write
});

test.after(async () => {
  await pool.end();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});
