const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcrypt');
const { OAuth2Client } = require('google-auth-library');
const { db } = require('../db');
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
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const now = new Date().toISOString();

  const insertUser = db.transaction(() => {
    const { lastInsertRowid: userId } = db
      .prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)')
      .run(normalizedEmail, passwordHash, now);
    db.prepare('INSERT INTO settings (user_id, updated_at) VALUES (?, ?)').run(userId, now);
    return userId;
  });

  const userId = insertUser();
  setSessionCookie(res, userId);
  res.status(201).json({ id: userId, email: normalizedEmail });
});

router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

  const normalizedEmail = String(email).trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
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

router.post('/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

router.get('/auth/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.userId);
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

  let user = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(googleSub);

  if (!user) {
    const existingByEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(normalizedEmail);
    if (existingByEmail) {
      db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(googleSub, existingByEmail.id);
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

    const insertUser = db.transaction(() => {
      const { lastInsertRowid: userId } = db
        .prepare('INSERT INTO users (email, password_hash, google_sub, created_at) VALUES (?, ?, ?, ?)')
        .run(normalizedEmail, unusablePasswordHash, googleSub, now);
      db.prepare('INSERT INTO settings (user_id, updated_at) VALUES (?, ?)').run(userId, now);
      return userId;
    });

    user = { id: insertUser(), email: normalizedEmail };
  }

  setSessionCookie(res, user.id);
  res.json({ id: user.id, email: user.email, isNewUser });
});

module.exports = router;
