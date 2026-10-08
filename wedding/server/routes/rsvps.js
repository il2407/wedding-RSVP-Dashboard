const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireNumericParam } = require('../middleware/errors');

const router = express.Router();
router.param('userId', requireNumericParam);

// A guest-submitted RSVP always derives its status from the headcount they submitted:
// 0 means they declined, anything else means they're attending with that many people.
function statusForGuestCount(guests) {
  const count = parseInt(guests, 10) || 0;
  return count > 0 ? 'attending' : 'declined';
}

const MAX_GUESTS_PER_RSVP = 50;

// Public RSVP input is untrusted: accepts a whole number 0..MAX_GUESTS_PER_RSVP (as a number
// or numeric string, which is what the form sends) and returns it, or null if invalid —
// so a negative/garbage headcount can never land in the stats.
function parseGuestCount(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (!/^\d+$/.test(String(value).trim())) return null;
  const n = Number(String(value).trim());
  return n <= MAX_GUESTS_PER_RSVP ? n : null;
}

const INVALID_GUESTS_ERROR = `guests must be a whole number between 0 and ${MAX_GUESTS_PER_RSVP}`;

router.get('/rsvps', requireAuth, async (req, res) => {
  const { rows } = await query('SELECT * FROM rsvps WHERE user_id = $1 ORDER BY timestamp DESC', [req.userId]);
  res.json(rows);
});

// Invitations sent, invited headcount (expected guests including plus-ones), responded,
// unanswered, confirmed invitations, confirmed attendees (headcount including plus-ones)
// and declined — kept as separate metrics so a multi-attendee RSVP is never
// double-counted as more than one "responded" invitation.
async function getStats(userId) {
  const { rows: totalRows } = await query(
    'SELECT COUNT(*) AS "totalInvited", COALESCE(SUM(expected_guest), 0) AS "invitedHeadcount" FROM invited_guests WHERE user_id = $1',
    [userId]
  );
  const { rows: respondedRows } = await query(
    `SELECT COUNT(*) AS responded FROM invited_guests ig
     JOIN rsvps r ON r.user_id = ig.user_id AND r.phone = ig.phone
     WHERE ig.user_id = $1`,
    [userId]
  );
  const { rows: confirmedRows } = await query(
    `SELECT COUNT(*) AS "confirmedInvitations", COALESCE(SUM(r.guests), 0) AS "confirmedAttendees" FROM invited_guests ig
     JOIN rsvps r ON r.user_id = ig.user_id AND r.phone = ig.phone
     WHERE ig.user_id = $1 AND r.status = 'attending'`,
    [userId]
  );
  const { rows: declinedRows } = await query(
    `SELECT COUNT(*) AS declined FROM invited_guests ig
     JOIN rsvps r ON r.user_id = ig.user_id AND r.phone = ig.phone
     WHERE ig.user_id = $1 AND r.status = 'declined'`,
    [userId]
  );

  const totalInvited = Number(totalRows[0].totalInvited);
  const responded = Number(respondedRows[0].responded);

  return {
    totalInvited,
    invitedHeadcount: Number(totalRows[0].invitedHeadcount),
    responded,
    unanswered: Math.max(totalInvited - responded, 0),
    confirmedInvitations: Number(confirmedRows[0].confirmedInvitations),
    confirmedAttendees: Number(confirmedRows[0].confirmedAttendees),
    declined: Number(declinedRows[0].declined),
  };
}

router.get('/rsvps/stats', requireAuth, async (req, res) => {
  res.json(await getStats(req.userId));
});

router.get('/public/:userId/rsvps/:phone', async (req, res) => {
  const { rows } = await query('SELECT * FROM rsvps WHERE user_id = $1 AND phone = $2', [req.params.userId, req.params.phone]);
  const rsvp = rows[0];
  if (!rsvp) return res.status(404).json({ error: 'Not found' });
  res.json(rsvp);
});

router.post('/public/:userId/rsvps', async (req, res) => {
  const { phone } = req.body;
  if (!phone || req.body.guests === undefined) return res.status(400).json({ error: 'phone and guests are required' });
  if (typeof phone !== 'string') return res.status(400).json({ error: 'phone must be a string' });
  const guests = parseGuestCount(req.body.guests);
  if (guests === null) return res.status(400).json({ error: INVALID_GUESTS_ERROR });

  const userId = req.params.userId;

  // Guards against a mistyped/stale phone in the guest link silently creating an RSVP that
  // getStats() (which joins on invited_guests) would then never count anywhere.
  const { rows: guestRows } = await query('SELECT 1 FROM invited_guests WHERE user_id = $1 AND phone = $2', [userId, phone]);
  if (!guestRows[0]) return res.status(404).json({ error: 'This phone number was not found on the guest list' });

  const timestamp = new Date().toISOString();
  const status = statusForGuestCount(guests);
  try {
    await query(
      "INSERT INTO rsvps (user_id, phone, guests, status, source, timestamp) VALUES ($1, $2, $3, $4, 'guest', $5)",
      [userId, phone, guests, status, timestamp]
    );
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'RSVP already exists for this phone' });
    throw err;
  }
  const { rows } = await query('SELECT * FROM rsvps WHERE user_id = $1 AND phone = $2', [userId, phone]);
  res.status(201).json(rows[0]);
});

router.put('/public/:userId/rsvps/:phone', async (req, res) => {
  const userId = req.params.userId;
  const { rows: existingRows } = await query('SELECT * FROM rsvps WHERE user_id = $1 AND phone = $2', [userId, req.params.phone]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'Not found' });

  if (req.body.guests === undefined) return res.status(400).json({ error: 'guests is required' });
  const guests = parseGuestCount(req.body.guests);
  if (guests === null) return res.status(400).json({ error: INVALID_GUESTS_ERROR });

  // A guest resubmitting their own RSVP always takes precedence over any prior manual
  // (admin-set) entry, so source is unconditionally reset to 'guest' here.
  await query(
    "UPDATE rsvps SET guests = $1, status = $2, source = 'guest', timestamp = $3 WHERE user_id = $4 AND phone = $5",
    [guests, statusForGuestCount(guests), new Date().toISOString(), userId, req.params.phone]
  );
  const { rows } = await query('SELECT * FROM rsvps WHERE user_id = $1 AND phone = $2', [userId, req.params.phone]);
  res.json(rows[0]);
});

// Manual admin override of a guest's RSVP status from the dashboard. 'unanswered' removes
// any existing RSVP row (reverting them to not-yet-responded); 'attending'/'declined'
// upsert a row tagged source='manual' so it's distinguishable from a guest's own submission
// (which always overwrites it back to source='guest' if the guest later responds themselves).
router.put('/rsvps/:phone', requireAuth, async (req, res) => {
  const { status, guests } = req.body;
  if (!['unanswered', 'attending', 'declined'].includes(status)) {
    return res.status(400).json({ error: "status must be 'unanswered', 'attending' or 'declined'" });
  }

  if (status === 'unanswered') {
    await query('DELETE FROM rsvps WHERE user_id = $1 AND phone = $2', [req.userId, req.params.phone]);
    return res.status(204).end();
  }

  // Mirrors the guard on the public POST route: without it, a stale phone (e.g. from a
  // browser tab left open after the guest was deleted/edited elsewhere) would silently create
  // an rsvps row that getStats() never counts but GET /api/rsvps still lists.
  const { rows: guestRows } = await query('SELECT 1 FROM invited_guests WHERE user_id = $1 AND phone = $2', [req.userId, req.params.phone]);
  if (!guestRows[0]) return res.status(404).json({ error: 'This phone number was not found on the guest list' });

  const guestCount = status === 'attending' ? Math.min(Math.max(parseInt(guests, 10) || 0, 1), MAX_GUESTS_PER_RSVP) : 0;
  const timestamp = new Date().toISOString();

  await query(
    `INSERT INTO rsvps (user_id, phone, guests, status, source, timestamp) VALUES ($1, $2, $3, $4, 'manual', $5)
     ON CONFLICT (user_id, phone) DO UPDATE SET guests = EXCLUDED.guests, status = EXCLUDED.status, source = 'manual', timestamp = EXCLUDED.timestamp`,
    [req.userId, req.params.phone, guestCount, status, timestamp]
  );

  const { rows } = await query('SELECT * FROM rsvps WHERE user_id = $1 AND phone = $2', [req.userId, req.params.phone]);
  res.json(rows[0]);
});

module.exports = router;
module.exports.statusForGuestCount = statusForGuestCount;
module.exports.parseGuestCount = parseGuestCount;
module.exports.getStats = getStats;
