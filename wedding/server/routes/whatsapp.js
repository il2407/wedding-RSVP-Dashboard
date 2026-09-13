const express = require('express');
const { query, withTransaction } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { runDueJobs } = require('../services/whatsappSender');

const router = express.Router();

// Looks up each phone's guest name (for {name}) and builds its personalized RSVP link (for
// {link}), matching the same u=<userId>&phone=<phone> format the manual wa.me tool uses.
//
// This is the server-side enforcement point for who can actually receive a bulk send: guests
// flagged do_not_send are always excluded (regardless of what the client asked for), and when
// unrespondedOnly is set, anyone who already has an RSVP on file is excluded too. The client's
// phone list is only used to select *which* invited guests to consider — it is never trusted
// as the final recipient list.
async function buildRecipients(req, phones, unresponsedOnly) {
  const requested = new Set(phones);
  const { rows: guestRows } = await query('SELECT phone, name, do_not_send FROM invited_guests WHERE user_id = $1', [req.userId]);
  const guests = guestRows.filter((g) => requested.has(g.phone) && !g.do_not_send);

  let respondedPhones = new Set();
  if (unresponsedOnly) {
    const { rows: rsvpRows } = await query('SELECT phone FROM rsvps WHERE user_id = $1', [req.userId]);
    respondedPhones = new Set(rsvpRows.map((r) => r.phone));
  }

  const eligible = guests.filter((g) => !respondedPhones.has(g.phone));
  const baseUrl = `${req.protocol}://${req.get('host')}/rsvp-form/`;

  return eligible.map((g) => ({
    phone: g.phone,
    name: g.name || '',
    link: `${baseUrl}?u=${req.userId}&phone=${g.phone}`,
  }));
}

router.get('/admin/whatsapp/jobs', requireAuth, async (req, res) => {
  const { rows: jobs } = await query('SELECT * FROM whatsapp_jobs WHERE user_id = $1 ORDER BY id DESC', [req.userId]);
  const withCounts = await Promise.all(
    jobs.map(async (job) => {
      const { rows: countRows } = await query(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM whatsapp_job_recipients WHERE job_id = $1`,
        [job.id]
      );
      const counts = countRows[0];
      return {
        ...job,
        total: Number(counts.total),
        sent: Number(counts.sent),
        failed: Number(counts.failed),
      };
    })
  );
  res.json(withCounts);
});

router.get('/admin/whatsapp/jobs/:id', requireAuth, async (req, res) => {
  const { rows: jobRows } = await query('SELECT * FROM whatsapp_jobs WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  const job = jobRows[0];
  if (!job) return res.status(404).json({ error: 'Not found' });
  const { rows: recipients } = await query(
    'SELECT phone, name, status, error, sent_at FROM whatsapp_job_recipients WHERE job_id = $1 ORDER BY id',
    [job.id]
  );
  res.json({ ...job, recipients });
});

// Lets the client ask "who would actually receive this?" before scheduling, so the
// recipient count shown pre-send always matches what the send endpoint will enforce.
router.post('/admin/whatsapp/recipients-preview', requireAuth, async (req, res) => {
  const { phones, unresponded_only } = req.body;
  if (!Array.isArray(phones)) return res.status(400).json({ error: 'phones must be an array' });
  const recipients = await buildRecipients(req, phones, !!unresponded_only);
  res.json({ count: recipients.length, recipients });
});

router.post('/admin/whatsapp/jobs', requireAuth, async (req, res) => {
  const { message_template, phones, scheduled_at, unresponded_only } = req.body;

  if (!message_template || !message_template.trim()) {
    return res.status(400).json({ error: 'message_template is required' });
  }
  if (!Array.isArray(phones) || phones.length === 0) {
    return res.status(400).json({ error: 'phones must be a non-empty array' });
  }

  const now = new Date();
  const sendAt = scheduled_at ? new Date(scheduled_at) : now;
  if (Number.isNaN(sendAt.getTime())) {
    return res.status(400).json({ error: 'scheduled_at is not a valid date' });
  }

  // Without a country code, toE164Digits() would strip leading zeros and prepend nothing,
  // sending every message in this job to a malformed number.
  const { rows: settingsRows } = await query('SELECT whatsapp_country_code FROM settings WHERE user_id = $1', [req.userId]);
  if (!settingsRows[0] || !settingsRows[0].whatsapp_country_code || !settingsRows[0].whatsapp_country_code.trim()) {
    return res.status(400).json({ error: 'Set a WhatsApp country code in settings before sending messages' });
  }

  const recipients = await buildRecipients(req, phones, !!unresponded_only);
  if (recipients.length === 0) {
    return res.status(400).json({ error: 'No recipients matched after filtering (already responded or marked do-not-send).' });
  }

  const jobId = await withTransaction(async (client) => {
    const { rows } = await client.query(
      'INSERT INTO whatsapp_jobs (user_id, message_template, scheduled_at, status, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [req.userId, message_template, sendAt.toISOString(), 'pending', now.toISOString()]
    );
    const id = rows[0].id;
    for (const r of recipients) {
      const message = message_template
        .replace(/{name}/g, r.name)
        .replace(/{phone}/g, r.phone)
        .replace(/{link}/g, r.link);
      await client.query(
        'INSERT INTO whatsapp_job_recipients (job_id, phone, name, message, status) VALUES ($1, $2, $3, $4, $5)',
        [id, r.phone, r.name, message, 'pending']
      );
    }
    return id;
  });

  if (sendAt.getTime() <= now.getTime()) {
    runDueJobs(); // fire-and-forget: picks this job up right away instead of waiting for the next poll
  }

  const { rows: jobRows } = await query('SELECT * FROM whatsapp_jobs WHERE id = $1', [jobId]);
  res.status(201).json({ ...jobRows[0], total: recipients.length });
});

router.delete('/admin/whatsapp/jobs/:id', requireAuth, async (req, res) => {
  const { rows: jobRows } = await query('SELECT * FROM whatsapp_jobs WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  const job = jobRows[0];
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (job.status !== 'pending') return res.status(409).json({ error: 'Only a still-pending job can be cancelled' });

  await query("UPDATE whatsapp_jobs SET status = 'cancelled' WHERE id = $1", [job.id]);
  res.status(204).end();
});

module.exports = router;
module.exports.buildRecipients = buildRecipients;
