const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/rsvps', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM rsvps WHERE user_id = ? ORDER BY timestamp DESC').all(req.userId));
});

router.get('/public/:userId/rsvps/:phone', (req, res) => {
  const rsvp = db.prepare('SELECT * FROM rsvps WHERE user_id = ? AND phone = ?').get(req.params.userId, req.params.phone);
  if (!rsvp) return res.status(404).json({ error: 'Not found' });
  res.json(rsvp);
});

router.post('/public/:userId/rsvps', (req, res) => {
  const { phone, guests } = req.body;
  if (!phone || guests === undefined) return res.status(400).json({ error: 'phone and guests are required' });

  const userId = req.params.userId;
  const timestamp = new Date().toISOString();
  try {
    db.prepare('INSERT INTO rsvps (user_id, phone, guests, timestamp) VALUES (?, ?, ?, ?)').run(userId, phone, guests, timestamp);
  } catch (err) {
    return res.status(409).json({ error: 'RSVP already exists for this phone' });
  }
  res.status(201).json(db.prepare('SELECT * FROM rsvps WHERE user_id = ? AND phone = ?').get(userId, phone));
});

router.put('/public/:userId/rsvps/:phone', (req, res) => {
  const userId = req.params.userId;
  const existing = db.prepare('SELECT * FROM rsvps WHERE user_id = ? AND phone = ?').get(userId, req.params.phone);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { guests } = req.body;
  if (guests === undefined) return res.status(400).json({ error: 'guests is required' });

  db.prepare('UPDATE rsvps SET guests = ?, timestamp = ? WHERE user_id = ? AND phone = ?').run(
    guests,
    new Date().toISOString(),
    userId,
    req.params.phone
  );
  res.json(db.prepare('SELECT * FROM rsvps WHERE user_id = ? AND phone = ?').get(userId, req.params.phone));
});

module.exports = router;
