// HTTP-level regression tests for the QA pass:
//   - malformed public input returns 4xx instead of crashing the process (async errors)
//   - guest counts are validated (negative / garbage / huge)
//   - bus registration validates phone/name and normalizes phone formatting
//   - media uploads only accept real image/video types, served with nosniff
//   - invited-guest phones are normalized to digits (dashes, +972, numeric XLSX cells)
//   - only a still-pending WhatsApp job can be cancelled
// Runs against a real Express app with the production error handler, backed by pg-mem.
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

const { query, pool, uploadsDir } = require('../db');
const { errorHandler } = require('../middleware/errors');
const rsvpRoutes = require('../routes/rsvps');
const { parseGuestCount } = require('../routes/rsvps');
const busRoutes = require('../routes/busRegistrations');
const configRoutes = require('../routes/config');
const invitedGuestsRoutes = require('../routes/invitedGuests');
const { normalizePhone } = require('../routes/invitedGuests');
const whatsappRoutes = require('../routes/whatsapp');
const mediaRoutes = require('../routes/media');
const authRoutes = require('../routes/auth');

let server;
let baseUrl;
let nextUserId = 7000;

function authHeaders(userId) {
  return { Cookie: `sid=s:${cookieSignature.sign(String(userId), COOKIE_SECRET)}` };
}

async function makeUser() {
  const id = nextUserId++;
  await query(
    "INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, 'x', $3)",
    [id, `qa-user${id}@example.com`, new Date().toISOString()]
  );
  return id;
}

function jsonRequest(method, urlPath, body, headers = {}) {
  return fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function uploadMedia(userId, slot, content, type, filename) {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), filename);
  return fetch(`${baseUrl}/api/admin/media/${slot}`, { method: 'PUT', headers: authHeaders(userId), body: form });
}

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(COOKIE_SECRET));
  app.use('/api', authRoutes);
  app.use('/api', configRoutes);
  app.use('/api', invitedGuestsRoutes);
  app.use('/api', rsvpRoutes);
  app.use('/api', busRoutes);
  app.use('/api', whatsappRoutes);
  app.use(mediaRoutes);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

test('non-numeric account ids on public routes are a 404, not a crash', async () => {
  for (const urlPath of ['/api/public/abc/config', '/api/public/abc/rsvps/0501234567', '/media/abc/groom_photo']) {
    const res = await fetch(`${baseUrl}${urlPath}`);
    assert.equal(res.status, 404, urlPath);
  }
  const res = await fetch(`${baseUrl}/api/admin/whatsapp/jobs/abc`, { headers: authHeaders(await makeUser()) });
  assert.equal(res.status, 404);
});

test('malformed JSON and non-string passwords get a JSON 400', async () => {
  const bad = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops',
  });
  assert.equal(bad.status, 400);
  assert.ok((await bad.json()).error);

  const signup = await jsonRequest('POST', '/api/auth/signup', { email: 'numeric@example.com', password: 12345678 });
  assert.equal(signup.status, 400);
});

test('parseGuestCount accepts 0..50 only', () => {
  assert.equal(parseGuestCount(0), 0);
  assert.equal(parseGuestCount('3'), 3);
  assert.equal(parseGuestCount(50), 50);
  for (const bad of [-1, '-1', 51, 'abc', '1.5', 1.5, '', null, undefined, '99999999999']) {
    assert.equal(parseGuestCount(bad), null, String(bad));
  }
});

test('public RSVP rejects garbage guest counts with 400 and the server keeps serving', async () => {
  const userId = await makeUser();
  await jsonRequest('POST', '/api/invited-guests', { name: 'RSVP Guest', phone: '0501234567' }, authHeaders(userId));
  const post = await jsonRequest('POST', `/api/public/${userId}/rsvps`, { phone: '0501234567', guests: 'abc' });
  assert.equal(post.status, 400);
  const negative = await jsonRequest('POST', `/api/public/${userId}/rsvps`, { phone: '0501234567', guests: -3 });
  assert.equal(negative.status, 400);

  const ok = await jsonRequest('POST', `/api/public/${userId}/rsvps`, { phone: '0501234567', guests: 2 });
  assert.equal(ok.status, 201);
  const put = await jsonRequest('PUT', `/api/public/${userId}/rsvps/0501234567`, { guests: 'abc' });
  assert.equal(put.status, 400);
  const dup = await jsonRequest('POST', `/api/public/${userId}/rsvps`, { phone: '0501234567', guests: 1 });
  assert.equal(dup.status, 409);
});

test('bus registration normalizes phone formatting and validates input', async () => {
  const userId = await makeUser();
  const created = await jsonRequest('POST', `/api/public/${userId}/bus-registrations`, {
    full_name: 'Bus Guest', phone: '050-123-4567', going_count: 1, return_count: 1,
  });
  assert.equal(created.status, 201);
  const fetched = await fetch(`${baseUrl}/api/public/${userId}/bus-registrations/0501234567`);
  assert.equal(fetched.status, 200);

  const badPhone = await jsonRequest('POST', `/api/public/${userId}/bus-registrations`, { full_name: 'X', phone: '12' });
  assert.equal(badPhone.status, 400);
  const unknownAccount = await jsonRequest('POST', '/api/public/999999/bus-registrations', { full_name: 'X', phone: '0509999999' });
  assert.equal(unknownAccount.status, 404);
});

test('media upload rejects HTML/SVG and stores images with a server-chosen extension', async () => {
  const userId = await makeUser();
  const html = await uploadMedia(userId, 'approval_gif', '<script>alert(1)</script>', 'text/html', 'x.png');
  assert.equal(html.status, 400);
  const svg = await uploadMedia(userId, 'groom_photo', '<svg onload="alert(1)"/>', 'image/svg+xml', 'x.svg');
  assert.equal(svg.status, 400);
  const videoInPhotoSlot = await uploadMedia(userId, 'groom_photo', 'x', 'video/mp4', 'x.mp4');
  assert.equal(videoInPhotoSlot.status, 400);

  const png = await uploadMedia(userId, 'groom_photo', 'fakepng', 'image/png', 'evil.html');
  assert.equal(png.status, 200);
  assert.equal((await png.json()).filename, `${userId}_groom_photo.png`);

  const served = await fetch(`${baseUrl}/media/${userId}/groom_photo`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.match(served.headers.get('content-type'), /^image\/png/);

  // Replacing with a different type removes the old file instead of orphaning it.
  const gif = await uploadMedia(userId, 'groom_photo', 'fakegif', 'image/gif', 'a.gif');
  assert.equal(gif.status, 200);
  assert.equal(fs.existsSync(path.join(uploadsDir, `${userId}_groom_photo.gif`)), true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(path.join(uploadsDir, `${userId}_groom_photo.png`)), false);
});

test('normalizePhone strips formatting and restores the leading zero of numeric XLSX cells', () => {
  assert.equal(normalizePhone('050-123-4567'), '0501234567');
  assert.equal(normalizePhone(' 050 1234567 '), '0501234567');
  assert.equal(normalizePhone('+972-50-123-4567'), '972501234567');
  assert.equal(normalizePhone('="0501234567"'), '0501234567');
  assert.equal(normalizePhone(501234567), '0501234567');
  assert.equal(normalizePhone('501234567'), '501234567'); // text cells are kept as typed
});

test('invited guests: phones are stored as digits, invalid phones are rejected', async () => {
  const userId = await makeUser();
  const headers = authHeaders(userId);
  const created = await jsonRequest('POST', '/api/invited-guests', { name: 'Dashed', phone: '050-765-4321' }, headers);
  assert.equal(created.status, 201);
  assert.equal((await created.json()).phone, '0507654321');

  const invalid = await jsonRequest('POST', '/api/invited-guests', { name: 'Bad', phone: 'abc' }, headers);
  assert.equal(invalid.status, 400);

  const bulk = await jsonRequest('POST', '/api/invited-guests/bulk-import', {
    text: 'A,+972 52 111 2222\nB,12',
  }, headers);
  const bulkBody = await bulk.json();
  assert.equal(bulkBody.imported, 1);
  assert.equal(bulkBody.errors.length, 1);
});

test('invited guests: editing a legacy dashed-phone guest without changing the phone keeps it', async () => {
  const userId = await makeUser();
  const now = new Date().toISOString();
  await query(
    `INSERT INTO invited_guests (user_id, phone, name, expected_guest, do_not_send, created_at, updated_at)
     VALUES ($1, '050-111-2222', 'Legacy', 1, 0, $2, $2)`,
    [userId, now]
  );
  const res = await jsonRequest('PUT', `/api/invited-guests/${encodeURIComponent('050-111-2222')}`,
    { name: 'Legacy Renamed', phone: '050-111-2222' }, authHeaders(userId));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).phone, '050-111-2222');
});

test('only a still-pending WhatsApp job can be cancelled', async () => {
  const userId = await makeUser();
  const now = new Date().toISOString();
  const { rows } = await query(
    "INSERT INTO whatsapp_jobs (user_id, message_template, scheduled_at, status, created_at) VALUES ($1, 'hi', $2, 'sending', $2) RETURNING id",
    [userId, now]
  );
  const sending = await fetch(`${baseUrl}/api/admin/whatsapp/jobs/${rows[0].id}`, { method: 'DELETE', headers: authHeaders(userId) });
  assert.equal(sending.status, 409);

  await query("UPDATE whatsapp_jobs SET status = 'pending' WHERE id = $1", [rows[0].id]);
  const pending = await fetch(`${baseUrl}/api/admin/whatsapp/jobs/${rows[0].id}`, { method: 'DELETE', headers: authHeaders(userId) });
  assert.equal(pending.status, 204);
});
