const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Bus seats are booked in a handful at a time, never a whole busload by one registrant, so
// counts are clamped to a sane range rather than trusting the client's raw number as-is.
function clampCount(value, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(Math.max(n, 0), 20);
}

function readFields(body, fallback = {}) {
  return {
    full_name: body.full_name ?? fallback.full_name,
    going_count: body.going_count !== undefined ? clampCount(body.going_count, fallback.going_count ?? 0) : (fallback.going_count ?? 0),
    return_count: body.return_count !== undefined ? clampCount(body.return_count, fallback.return_count ?? 0) : (fallback.return_count ?? 0),
    going_confirmed: body.going_confirmed !== undefined ? (body.going_confirmed ? 1 : 0) : (fallback.going_confirmed ?? 0),
    return_confirmed: body.return_confirmed !== undefined ? (body.return_confirmed ? 1 : 0) : (fallback.return_confirmed ?? 0),
  };
}

router.get('/bus-registrations', requireAuth, async (req, res) => {
  const { rows } = await query('SELECT * FROM bus_registrations WHERE user_id = $1 ORDER BY updated_at DESC', [req.userId]);
  res.json(rows);
});

router.get('/public/:userId/bus-registrations/:phone', async (req, res) => {
  const { rows } = await query(
    'SELECT * FROM bus_registrations WHERE user_id = $1 AND phone = $2',
    [req.params.userId, req.params.phone]
  );
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/public/:userId/bus-registrations', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required' });
  const fields = readFields(req.body);
  if (!fields.full_name) return res.status(400).json({ error: 'full_name is required' });

  const userId = req.params.userId;
  const updated_at = new Date().toISOString();
  try {
    await query(
      `INSERT INTO bus_registrations (user_id, full_name, phone, going_count, return_count, going_confirmed, return_confirmed, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, fields.full_name, phone, fields.going_count, fields.return_count, fields.going_confirmed, fields.return_confirmed, updated_at]
    );
  } catch (err) {
    return res.status(409).json({ error: 'Registration already exists for this phone' });
  }
  const { rows } = await query('SELECT * FROM bus_registrations WHERE user_id = $1 AND phone = $2', [userId, phone]);
  res.status(201).json(rows[0]);
});

router.put('/public/:userId/bus-registrations/:phone', async (req, res) => {
  const userId = req.params.userId;
  const { rows: existingRows } = await query(
    'SELECT * FROM bus_registrations WHERE user_id = $1 AND phone = $2',
    [userId, req.params.phone]
  );
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const fields = readFields(req.body, existing);
  const updated_at = new Date().toISOString();
  await query(
    `UPDATE bus_registrations SET full_name = $1, going_count = $2, return_count = $3,
     going_confirmed = $4, return_confirmed = $5, updated_at = $6
     WHERE user_id = $7 AND phone = $8`,
    [fields.full_name, fields.going_count, fields.return_count, fields.going_confirmed, fields.return_confirmed, updated_at, userId, req.params.phone]
  );

  const { rows } = await query('SELECT * FROM bus_registrations WHERE user_id = $1 AND phone = $2', [userId, req.params.phone]);
  res.json(rows[0]);
});

module.exports = router;
