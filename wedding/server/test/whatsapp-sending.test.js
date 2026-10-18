// Automated WhatsApp sending after scheduled sends were removed:
//   - a send goes out immediately (any scheduled_at from an old client is ignored)
//   - a send started while another is still going out is not left behind
//   - without Twilio configured the send is refused instead of queued forever
//   - the one-off startup check resumes interrupted sends but leaves legacy scheduled jobs alone
// Twilio is replaced with an in-process fake, backed by pg-mem, so nothing is really sent.
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
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'test-token';
process.env.TWILIO_WHATSAPP_FROM = '+14155238886';

const sentMessages = [];
require.cache[require.resolve('twilio')] = {
  id: require.resolve('twilio'),
  loaded: true,
  exports: () => ({
    messages: {
      create: async (msg) => {
        sentMessages.push(msg);
        return { sid: `SM${sentMessages.length}` };
      },
    },
  }),
};

const { query, pool } = require('../db');
const { errorHandler } = require('../middleware/errors');
const whatsappRoutes = require('../routes/whatsapp');
const { resumeInterruptedJobs } = require('../services/whatsappSender');

let server;
let baseUrl;
let nextUserId = 8000;

function authHeaders(userId) {
  return { Cookie: `sid=s:${cookieSignature.sign(String(userId), COOKIE_SECRET)}` };
}

async function makeUserWithGuest(phone) {
  const id = nextUserId++;
  const now = new Date().toISOString();
  await query("INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, 'x', $3)", [id, `wa-user${id}@example.com`, now]);
  await query("INSERT INTO settings (user_id, whatsapp_country_code, updated_at) VALUES ($1, '972', $2)", [id, now]);
  await query('INSERT INTO invited_guests (user_id, phone, name, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)', [id, phone, 'Dana', now]);
  return id;
}

function postJob(userId, body) {
  return fetch(`${baseUrl}/api/admin/whatsapp/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(userId) },
    body: JSON.stringify(body),
  });
}

async function waitForJobStatus(jobId, expected) {
  const deadline = Date.now() + 10000;
  for (;;) {
    const { rows } = await query('SELECT status FROM whatsapp_jobs WHERE id = $1', [jobId]);
    if (rows[0].status === expected) return;
    if (Date.now() > deadline) assert.fail(`job ${jobId} is '${rows[0].status}', expected '${expected}'`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser(COOKIE_SECRET));
  app.use('/api', whatsappRoutes);
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

test('a send goes out immediately, ignoring any scheduled_at', async () => {
  const userId = await makeUserWithGuest('0501111111');
  const res = await postJob(userId, { message_template: 'Hi {name}', phones: ['0501111111'], scheduled_at: '2099-01-01T00:00:00.000Z' });
  assert.equal(res.status, 201);
  const job = await res.json();
  assert.equal(job.total, 1);
  assert.equal(job.scheduled_at, job.created_at);

  await waitForJobStatus(job.id, 'completed');
  assert.ok(sentMessages.some((m) => m.to === 'whatsapp:+972501111111' && m.body === 'Hi Dana'));
  const { rows } = await query('SELECT status, sent_at FROM whatsapp_job_recipients WHERE job_id = $1', [job.id]);
  assert.equal(rows[0].status, 'sent');
  assert.ok(rows[0].sent_at);
});

test('a send started while another is still going out is sent too', async () => {
  const userId = await makeUserWithGuest('0502222222');
  const first = await (await postJob(userId, { message_template: 'first', phones: ['0502222222'] })).json();
  const second = await (await postJob(userId, { message_template: 'second', phones: ['0502222222'] })).json();

  await waitForJobStatus(first.id, 'completed');
  await waitForJobStatus(second.id, 'completed');
});

test('without Twilio configured, a send is refused rather than queued', async () => {
  const userId = await makeUserWithGuest('0503333333');
  const from = process.env.TWILIO_WHATSAPP_FROM;
  delete process.env.TWILIO_WHATSAPP_FROM;
  try {
    const res = await postJob(userId, { message_template: 'hi', phones: ['0503333333'] });
    assert.equal(res.status, 503);
  } finally {
    process.env.TWILIO_WHATSAPP_FROM = from;
  }
  const { rows } = await query('SELECT id FROM whatsapp_jobs WHERE user_id = $1', [userId]);
  assert.equal(rows.length, 0);
});

test('startup resumes interrupted sends but leaves legacy scheduled jobs pending', async () => {
  const userId = await makeUserWithGuest('0504444444');
  const now = new Date().toISOString();
  const insertJob = async (status, scheduledAt) => {
    const { rows } = await query(
      "INSERT INTO whatsapp_jobs (user_id, message_template, scheduled_at, status, created_at) VALUES ($1, 'x', $2, $3, $4) RETURNING id",
      [userId, scheduledAt, status, now]
    );
    await query("INSERT INTO whatsapp_job_recipients (job_id, phone, name, message, status) VALUES ($1, '0504444444', 'Dana', 'x', 'pending')", [rows[0].id]);
    return rows[0].id;
  };
  const interruptedId = await insertJob('sending', now);
  const legacyScheduledId = await insertJob('pending', '2099-01-01T00:00:00.000Z');

  await resumeInterruptedJobs();

  await waitForJobStatus(interruptedId, 'completed');
  const { rows } = await query('SELECT status FROM whatsapp_jobs WHERE id = $1', [legacyScheduledId]);
  assert.equal(rows[0].status, 'pending');
});
