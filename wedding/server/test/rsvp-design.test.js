const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_DESIGN, validateDesign } = require('../rsvpDesign');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invitation-design-'));
process.env.DATA_DIR = dataDir;
const { query, pool } = require('../db');

test('design rejects invalid fields, colors, options and excessive text', () => {
  for (const input of [null, [], { background: 'red' }, { font: 'script' }, { title: 'a'.repeat(121) }, { unknown: 'x' }, { motion: true }, JSON.parse('{"__proto__":"x"}')]) {
    assert.throws(() => validateDesign(input));
  }
  assert.deepEqual(validateDesign({}), DEFAULT_DESIGN);
});

test('config saves the design per account and exposes it to guests', async () => {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.signedCookies = { sid: '1' }; next(); });
  app.use(require('../routes/config'));
  for (const id of [1, 2]) {
    await query("INSERT INTO users (id,email,password_hash,created_at) VALUES ($1,$2,'x',$3)", [id, `${id}@test.local`, new Date().toISOString()]);
    await query("INSERT INTO settings (user_id,updated_at) VALUES ($1,$2)", [id, new Date().toISOString()]);
  }
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://localhost:${server.address().port}`;
  try {
    const res = await fetch(`${url}/admin/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rsvp_design: { title: 'היום שלנו', photo_style: 'circle' } }) });
    assert.equal(res.status, 200);
    const { rows } = await query('SELECT rsvp_design FROM settings WHERE user_id=$1', [1]);
    assert.equal(JSON.parse(rows[0].rsvp_design).title, 'היום שלנו');
    const publicConfig = await (await fetch(`${url}/public/1/config`)).json();
    assert.equal(publicConfig.rsvp_design.photo_style, 'circle');
    const other = await (await fetch(`${url}/public/2/config`)).json();
    assert.equal(other.rsvp_design.title, DEFAULT_DESIGN.title);
    const invalid = await fetch(`${url}/admin/config`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rsvp_design: { background: 'url(x)' } }) });
    assert.equal(invalid.status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test.after(async () => { await pool.end(); fs.rmSync(dataDir, { recursive: true, force: true }); });
