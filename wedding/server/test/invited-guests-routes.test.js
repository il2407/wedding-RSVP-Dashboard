// HTTP-level tests for the invited-guests routes covering the reported bugs/requests:
//   - CSV import strips the Excel ="..." force-text wrapper (bug #1)
//   - Delete All is scoped to the authenticated account only (request #6)
//   - Editing a guest can rename their phone, and collisions 409 instead of overwriting
//     another guest (request #7)
// Uses Node's built-in test runner + global fetch against a real Express app, going through
// the actual requireAuth signed-cookie middleware (not a fake), backed by pg-mem, so it never
// touches real wedding data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const cookieParser = require('cookie-parser');
const cookieSignature = require('cookie-signature');

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wedding-rsvp-test-'));
process.env.DATA_DIR = tmpDataDir;
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret';
process.env.COOKIE_SECRET = COOKIE_SECRET;

const { query, pool } = require('../db');
const invitedGuestsRoutes = require('../routes/invitedGuests');

let server;
let baseUrl;
let currentUserId;
let nextUserId = 5000;

function sessionCookieHeader(userId) {
  const signed = cookieSignature.sign(String(userId), COOKIE_SECRET);
  return `sid=s:${signed}`;
}

async function makeUser() {
  const id = nextUserId++;
  await query(
    "INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, 'x', $3)",
    [id, `routes-user${id}@example.com`, new Date().toISOString()]
  );
  currentUserId = id;
  return id;
}

async function addGuest(userId, phone, name) {
  const now = new Date().toISOString();
  await query(
    `INSERT INTO invited_guests (user_id, phone, name, expected_guest, do_not_send, created_at, updated_at)
     VALUES ($1, $2, $3, 1, 0, $4, $4)`,
    [userId, phone, name, now]
  );
}

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(COOKIE_SECRET));
  app.use('/api', invitedGuestsRoutes);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}/api`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

test('bulk-import strips the Excel ="..." force-text wrapper from phone numbers (issue #1)', async () => {
  await makeUser();
  const csvText = 'Guest One,="0501234567",2\nGuest Two,0509999999,1';

  const res = await fetch(`${baseUrl}/invited-guests/bulk-import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookieHeader(currentUserId) },
    body: JSON.stringify({ text: csvText }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.imported, 2);

  const { rows } = await query('SELECT phone FROM invited_guests WHERE user_id = $1 ORDER BY phone', [currentUserId]);
  assert.deepEqual(rows.map((r) => r.phone).sort(), ['0501234567', '0509999999']);
});

test('DELETE /invited-guests (Delete All) only removes the authenticated account\'s guests (issue #6)', async () => {
  const userA = await makeUser();
  await addGuest(userA, '0511111111', 'A1');
  await addGuest(userA, '0511111112', 'A2');

  const userB = await makeUser();
  await addGuest(userB, '0522222222', 'B1');

  const res = await fetch(`${baseUrl}/invited-guests`, {
    method: 'DELETE',
    headers: { Cookie: sessionCookieHeader(userA) },
  });
  assert.equal(res.status, 204);

  const { rows: aRows } = await query('SELECT * FROM invited_guests WHERE user_id = $1', [userA]);
  assert.equal(aRows.length, 0);

  const { rows: bRows } = await query('SELECT * FROM invited_guests WHERE user_id = $1', [userB]);
  assert.equal(bRows.length, 1); // other account's guests are untouched
});

test('PUT /invited-guests/:phone can rename a guest, and 409s instead of overwriting a collision (issue #7)', async () => {
  const userId = await makeUser();
  await addGuest(userId, '0531111111', 'Original Name');
  await addGuest(userId, '0532222222', 'Other Guest');

  let res = await fetch(`${baseUrl}/invited-guests/0531111111`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookieHeader(userId) },
    body: JSON.stringify({ name: 'Renamed', phone: '0533333333' }),
  });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.phone, '0533333333');
  assert.equal(body.name, 'Renamed');

  // Renaming onto a phone another guest already has must 409, not silently merge/overwrite.
  res = await fetch(`${baseUrl}/invited-guests/0533333333`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookieHeader(userId) },
    body: JSON.stringify({ phone: '0532222222' }),
  });
  assert.equal(res.status, 409);

  // The original guest (now at 0533333333) must be unchanged after the rejected rename.
  const { rows } = await query('SELECT * FROM invited_guests WHERE user_id = $1 AND phone = $2', [userId, '0533333333']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Renamed');
});
