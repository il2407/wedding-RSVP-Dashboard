const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const { DEFAULT_DESIGN, validateDesign } = require('../rsvpDesign');
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
  'theme_color',
];

async function loadConfig(userId) {
  const { rows } = await query('SELECT * FROM settings WHERE user_id = $1', [userId]);
  const settings = rows[0];
  if (!settings) return null;
  const { rows: countRows } = await query('SELECT COUNT(*) AS count FROM invited_guests WHERE user_id = $1', [userId]);
  return {
    ...settings,
    rsvp_design: { ...DEFAULT_DESIGN, ...JSON.parse(settings.rsvp_design || '{}') },
    totalInvited: Number(countRows[0].count),
  };
}

router.get('/public/:userId/config', async (req, res) => {
  const config = await loadConfig(req.params.userId);
  if (!config) return res.status(404).json({ error: 'Not found' });
  res.json(config);
});

router.get('/admin/config', requireAuth, async (req, res) => {
  res.json(await loadConfig(req.userId));
});

router.put('/admin/config', requireAuth, async (req, res) => {
  if (req.body.theme_color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(req.body.theme_color)) {
    return res.status(400).json({ error: 'theme_color must be a hex color like #f97316' });
  }

  const updates = {};
  if (req.body.rsvp_design !== undefined) {
    try { updates.rsvp_design = JSON.stringify(validateDesign(req.body.rsvp_design)); }
    catch (err) { return res.status(400).json({ error: err.message }); }
  }
  for (const field of SETTINGS_FIELDS) {
    if (req.body[field] !== undefined) {
      updates[field] = String(req.body[field]);
    }
  }

  const fields = Object.keys(updates);
  if (fields.length) {
    const params = fields.map((field) => updates[field]);
    const setClause = fields.map((field, i) => `${field} = $${i + 1}`).join(', ');
    params.push(new Date().toISOString());
    params.push(req.userId);
    await query(
      `UPDATE settings SET ${setClause}, updated_at = $${params.length - 1} WHERE user_id = $${params.length}`,
      params
    );
  }

  res.json(await loadConfig(req.userId));
});

module.exports = router;
