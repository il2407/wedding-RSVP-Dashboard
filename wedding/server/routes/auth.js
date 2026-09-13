const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcrypt');
const { OAuth2Client } = require('google-auth-library');
const { query, withTransaction } = require('../db');
const { setSessionCookie, clearSessionCookie, requireAuth } = require('../middleware/auth');

const router = express.Router();

const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 8;
const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;

router.post('/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const { rows: existingRows } = await query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
  if (existingRows[0]) return res.status(409).json({ error: 'An account with this email already exists' });

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const now = new Date().toISOString();

  let userId;
  try {
    userId = await withTransaction(async (client) => {
      const { rows } = await client.query(
        'INSERT INTO users (email, password_hash, created_at) VALUES ($1, $2, $3) RETURNING id',
        [normalizedEmail, passwordHash, now]
      );
      const id = rows[0].id;
      await client.query('INSERT INTO settings (user_id, updated_at) VALUES ($1, $2)', [id, now]);
      return id;
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An account with this email already exists' });
    throw err;
  }

  setSessionCookie(res, userId);
  res.status(201).json({ id: userId, email: normalizedEmail });
});

router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const normalizedEmail = String(email).trim().toLowerCase();
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
  const user = rows[0];
  const valid = user && (await bcrypt.compare(password, user.password_hash));
  if (!valid) {
    if (user && user.google_sub) {
      return res.status(401).json({ error: 'This account uses Google sign-in. Please continue with Google instead.' });
    }
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  setSessionCookie(res, user.id);
  res.json({ id: user.id, email: user.email });
});

router.post('/auth/reset-password', async (req, res) => {
  const { email, newPassword } = req.body;
  if (!email || !newPassword) return res.status(400).json({ error: 'email and newPassword are required' });
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const { rows } = await query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
  const user = rows[0];
  if (!user) return res.status(404).json({ error: 'No account found with this email' });

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, user.id]);

  setSessionCookie(res, user.id);
  res.json({ id: user.id, email: normalizedEmail });
});

router.post('/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

router.get('/auth/me', requireAuth, async (req, res) => {
  const { rows } = await query('SELECT id, email FROM users WHERE id = $1', [req.userId]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: 'Authentication required' });
  res.json(user);
});

router.get('/auth/google-client-id', (req, res) => {
  res.json({ clientId: process.env.GOOGLE_CLIENT_ID || null });
});

router.post('/auth/google', async (req, res) => {
  if (!googleClient) return res.status(500).json({ error: 'Google sign-in is not configured on this server' });

  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'credential is required' });

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid Google credential' });
  }

  if (!payload.email || !payload.email_verified) {
    return res.status(401).json({ error: 'Google account email is not verified' });
  }

  const normalizedEmail = payload.email.toLowerCase();
  const googleSub = payload.sub;

  let user = (await query('SELECT * FROM users WHERE google_sub = $1', [googleSub])).rows[0];

  if (!user) {
    const existingByEmail = (await query('SELECT * FROM users WHERE email = $1', [normalizedEmail])).rows[0];
    if (existingByEmail) {
      await query('UPDATE users SET google_sub = $1 WHERE id = $2', [googleSub, existingByEmail.id]);
      user = { ...existingByEmail, google_sub: googleSub };
    }
  }

  let isNewUser = false;
  if (!user) {
    isNewUser = true;
    const now = new Date().toISOString();
    // No password is ever set for a Google-only signup; store a hash of an unguessable
    // random value so the column stays populated but password login can never succeed.
    const unusablePasswordHash = await bcrypt.hash(crypto.randomUUID(), BCRYPT_ROUNDS);

    const userId = await withTransaction(async (client) => {
      const { rows } = await client.query(
        'INSERT INTO users (email, password_hash, google_sub, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
        [normalizedEmail, unusablePasswordHash, googleSub, now]
      );
      const id = rows[0].id;
      await client.query('INSERT INTO settings (user_id, updated_at) VALUES ($1, $2)', [id, now]);
      return id;
    });

    user = { id: userId, email: normalizedEmail };
  }

  setSessionCookie(res, user.id);
  res.json({ id: user.id, email: user.email, isNewUser });
});

module.exports = router;
