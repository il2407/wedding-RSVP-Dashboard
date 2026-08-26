const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function readFields(body, fallback = {}) {
  return {
    full_name: body.full_name ?? fallback.full_name,
    going_count: body.going_count ?? fallback.going_count ?? 0,
    return_count: body.return_count ?? fallback.return_count ?? 0,
    going_confirmed: body.going_confirmed !== undefined ? (body.going_confirmed ? 1 : 0) : (fallback.going_confirmed ?? 0),
    return_confirmed: body.return_confirmed !== undefined ? (body.return_confirmed ? 1 : 0) : (fallback.return_confirmed ?? 0),
  };
}

router.get('/bus-registrations', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM bus_registrations WHERE user_id = ? ORDER BY updated_at DESC').all(req.userId));
});

router.get('/public/:userId/bus-registrations/:phone', (req, res) => {
  const row = db
    .prepare('SELECT * FROM bus_registrations WHERE user_id = ? AND phone = ?')
    .get(req.params.userId, req.params.phone);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/public/:userId/bus-registrations', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required' });
  const fields = readFields(req.body);
  if (!fields.full_name) return res.status(400).json({ error: 'full_name is required' });

  const userId = req.params.userId;
  const updated_at = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO bus_registrations (user_id, full_name, phone, going_count, return_count, going_confirmed, return_confirmed, updated_at)
       VALUES (@user_id, @full_name, @phone, @going_count, @return_count, @going_confirmed, @return_confirmed, @updated_at)`
    ).run({ ...fields, user_id: userId, phone, updated_at });
  } catch (err) {
    return res.status(409).json({ error: 'Registration already exists for this phone' });
  }
  res.status(201).json(db.prepare('SELECT * FROM bus_registrations WHERE user_id = ? AND phone = ?').get(userId, phone));
});

router.put('/public/:userId/bus-registrations/:phone', (req, res) => {
  const userId = req.params.userId;
  const existing = db
    .prepare('SELECT * FROM bus_registrations WHERE user_id = ? AND phone = ?')
    .get(userId, req.params.phone);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const fields = readFields(req.body, existing);
  const updated_at = new Date().toISOString();
  db.prepare(
    `UPDATE bus_registrations SET full_name = @full_name, going_count = @going_count, return_count = @return_count,
     going_confirmed = @going_confirmed, return_confirmed = @return_confirmed, updated_at = @updated_at
     WHERE user_id = @user_id AND phone = @phone`
  ).run({ ...fields, user_id: userId, phone: req.params.phone, updated_at });

  res.json(db.prepare('SELECT * FROM bus_registrations WHERE user_id = ? AND phone = ?').get(userId, req.params.phone));
});

module.exports = router;
