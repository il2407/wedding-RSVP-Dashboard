const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// A guest-submitted RSVP always derives its status from the headcount they submitted:
// 0 means they declined, anything else means they're attending with that many people.
function statusForGuestCount(guests) {
  const count = parseInt(guests, 10) || 0;
  return count > 0 ? 'attending' : 'declined';
}

router.get('/rsvps', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM rsvps WHERE user_id = ? ORDER BY timestamp DESC').all(req.userId));
});

// Invitations sent, responded, unanswered, confirmed attendees (headcount including
// plus-ones) and declined — kept as separate metrics so a multi-attendee RSVP is never
// double-counted as more than one "responded" invitation.
function getStats(userId) {
  const { totalInvited } = db
    .prepare('SELECT COUNT(*) AS totalInvited FROM invited_guests WHERE user_id = ?')
    .get(userId);
  const { responded } = db
    .prepare(
      `SELECT COUNT(*) AS responded FROM invited_guests ig
       JOIN rsvps r ON r.user_id = ig.user_id AND r.phone = ig.phone
       WHERE ig.user_id = ?`
    )
    .get(userId);
  const { confirmedAttendees } = db
    .prepare(
      `SELECT COALESCE(SUM(r.guests), 0) AS confirmedAttendees FROM invited_guests ig
       JOIN rsvps r ON r.user_id = ig.user_id AND r.phone = ig.phone
       WHERE ig.user_id = ? AND r.status = 'attending'`
    )
    .get(userId);
  const { declined } = db
    .prepare(
      `SELECT COUNT(*) AS declined FROM invited_guests ig
       JOIN rsvps r ON r.user_id = ig.user_id AND r.phone = ig.phone
       WHERE ig.user_id = ? AND r.status = 'declined'`
    )
    .get(userId);

  return {
    totalInvited,
    responded,
    unanswered: Math.max(totalInvited - responded, 0),
    confirmedAttendees,
    declined,
  };
}

router.get('/rsvps/stats', requireAuth, (req, res) => {
  res.json(getStats(req.userId));
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
  const status = statusForGuestCount(guests);
  try {
    db.prepare(
      "INSERT INTO rsvps (user_id, phone, guests, status, source, timestamp) VALUES (?, ?, ?, ?, 'guest', ?)"
    ).run(userId, phone, guests, status, timestamp);
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

  // A guest resubmitting their own RSVP always takes precedence over any prior manual
  // (admin-set) entry, so source is unconditionally reset to 'guest' here.
  db.prepare(
    "UPDATE rsvps SET guests = ?, status = ?, source = 'guest', timestamp = ? WHERE user_id = ? AND phone = ?"
  ).run(guests, statusForGuestCount(guests), new Date().toISOString(), userId, req.params.phone);
  res.json(db.prepare('SELECT * FROM rsvps WHERE user_id = ? AND phone = ?').get(userId, req.params.phone));
});

// Manual admin override of a guest's RSVP status from the dashboard. 'unanswered' removes
// any existing RSVP row (reverting them to not-yet-responded); 'attending'/'declined'
// upsert a row tagged source='manual' so it's distinguishable from a guest's own submission
// (which always overwrites it back to source='guest' if the guest later responds themselves).
router.put('/rsvps/:phone', requireAuth, (req, res) => {
  const { status, guests } = req.body;
  if (!['unanswered', 'attending', 'declined'].includes(status)) {
    return res.status(400).json({ error: "status must be 'unanswered', 'attending' or 'declined'" });
  }

  if (status === 'unanswered') {
    db.prepare('DELETE FROM rsvps WHERE user_id = ? AND phone = ?').run(req.userId, req.params.phone);
    return res.status(204).end();
  }

  const guestCount = status === 'attending' ? Math.max(parseInt(guests, 10) || 0, 1) : 0;
  const timestamp = new Date().toISOString();

  db.prepare(
    `INSERT INTO rsvps (user_id, phone, guests, status, source, timestamp) VALUES (?, ?, ?, ?, 'manual', ?)
     ON CONFLICT(user_id, phone) DO UPDATE SET guests = excluded.guests, status = excluded.status, source = 'manual', timestamp = excluded.timestamp`
  ).run(req.userId, req.params.phone, guestCount, status, timestamp);

  res.json(db.prepare('SELECT * FROM rsvps WHERE user_id = ? AND phone = ?').get(req.userId, req.params.phone));
});

module.exports = router;
module.exports.statusForGuestCount = statusForGuestCount;
module.exports.getStats = getStats;
