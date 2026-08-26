const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const SETTINGS_FIELDS = [
  'couple_name_1',
  'couple_name_2',
  'wedding_date',
  'wedding_time',
  'venue_name',
  'waze_link',
  'bus_pickup_location',
  'bus_destination_text',
  'bus_departure_time',
  'bus_return_time',
  'whatsapp_message_template',
  'whatsapp_country_code',
];

function loadConfig(userId) {
  const settings = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(userId);
  if (!settings) return null;
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM invited_guests WHERE user_id = ?').get(userId);
  return { ...settings, totalInvited: count };
}

router.get('/public/:userId/config', (req, res) => {
  const config = loadConfig(req.params.userId);
  if (!config) return res.status(404).json({ error: 'Not found' });
  res.json(config);
});

router.get('/admin/config', requireAuth, (req, res) => {
  res.json(loadConfig(req.userId));
});

router.put('/admin/config', requireAuth, (req, res) => {
  const updates = {};
  for (const field of SETTINGS_FIELDS) {
    if (req.body[field] !== undefined) {
      updates[field] = String(req.body[field]);
    }
  }

  const setClause = Object.keys(updates)
    .map((field) => `${field} = @${field}`)
    .join(', ');

  if (setClause) {
    db.prepare(`UPDATE settings SET ${setClause}, updated_at = @updated_at WHERE user_id = @user_id`).run({
      ...updates,
      updated_at: new Date().toISOString(),
      user_id: req.userId,
    });
  }

  res.json(loadConfig(req.userId));
});

module.exports = router;
