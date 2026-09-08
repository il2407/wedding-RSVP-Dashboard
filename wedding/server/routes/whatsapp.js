const express = require('express');
const { db } = require('../db');
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
function buildRecipients(req, phones, unresponsedOnly) {
  const requested = new Set(phones);
  const guests = db
    .prepare('SELECT phone, name, do_not_send FROM invited_guests WHERE user_id = ?')
    .all(req.userId)
    .filter((g) => requested.has(g.phone) && !g.do_not_send);

  const respondedPhones = unresponsedOnly
    ? new Set(db.prepare('SELECT phone FROM rsvps WHERE user_id = ?').all(req.userId).map((r) => r.phone))
    : new Set();

  const eligible = guests.filter((g) => !respondedPhones.has(g.phone));
  const baseUrl = `${req.protocol}://${req.get('host')}/rsvp-form/`;

  return eligible.map((g) => ({
    phone: g.phone,
    name: g.name || '',
    link: `${baseUrl}?u=${req.userId}&phone=${g.phone}`,
  }));
}

router.get('/admin/whatsapp/jobs', requireAuth, (req, res) => {
  const jobs = db.prepare('SELECT * FROM whatsapp_jobs WHERE user_id = ? ORDER BY id DESC').all(req.userId);
  const withCounts = jobs.map((job) => {
    const counts = db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
         FROM whatsapp_job_recipients WHERE job_id = ?`
      )
      .get(job.id);
    return { ...job, ...counts };
  });
  res.json(withCounts);
});

router.get('/admin/whatsapp/jobs/:id', requireAuth, (req, res) => {
  const job = db.prepare('SELECT * FROM whatsapp_jobs WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!job) return res.status(404).json({ error: 'Not found' });
  const recipients = db
    .prepare('SELECT phone, name, status, error, sent_at FROM whatsapp_job_recipients WHERE job_id = ? ORDER BY id')
    .all(job.id);
  res.json({ ...job, recipients });
});

// Lets the client ask "who would actually receive this?" before scheduling, so the
// recipient count shown pre-send always matches what the send endpoint will enforce.
router.post('/admin/whatsapp/recipients-preview', requireAuth, (req, res) => {
  const { phones, unresponded_only } = req.body;
  if (!Array.isArray(phones)) return res.status(400).json({ error: 'phones must be an array' });
  const recipients = buildRecipients(req, phones, !!unresponded_only);
  res.json({ count: recipients.length, recipients });
});

router.post('/admin/whatsapp/jobs', requireAuth, (req, res) => {
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

  const recipients = buildRecipients(req, phones, !!unresponded_only);
  if (recipients.length === 0) {
    return res.status(400).json({ error: 'No recipients matched after filtering (already responded or marked do-not-send).' });
  }

  const insertJob = db.prepare(
    'INSERT INTO whatsapp_jobs (user_id, message_template, scheduled_at, status, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const insertRecipient = db.prepare(
    'INSERT INTO whatsapp_job_recipients (job_id, phone, name, message, status) VALUES (?, ?, ?, ?, ?)'
  );

  const createJob = db.transaction(() => {
    const { lastInsertRowid: jobId } = insertJob.run(
      req.userId,
      message_template,
      sendAt.toISOString(),
      'pending',
      now.toISOString()
    );
    for (const r of recipients) {
      const message = message_template
        .replace(/{name}/g, r.name)
        .replace(/{phone}/g, r.phone)
        .replace(/{link}/g, r.link);
      insertRecipient.run(jobId, r.phone, r.name, message, 'pending');
    }
    return jobId;
  });

  const jobId = createJob();

  if (sendAt.getTime() <= now.getTime()) {
    runDueJobs(); // fire-and-forget: picks this job up right away instead of waiting for the next poll
  }

  const job = db.prepare('SELECT * FROM whatsapp_jobs WHERE id = ?').get(jobId);
  res.status(201).json({ ...job, total: recipients.length });
});

router.delete('/admin/whatsapp/jobs/:id', requireAuth, (req, res) => {
  const job = db.prepare('SELECT * FROM whatsapp_jobs WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (job.status !== 'pending') return res.status(409).json({ error: 'Only a still-pending job can be cancelled' });

  db.prepare("UPDATE whatsapp_jobs SET status = 'cancelled' WHERE id = ?").run(job.id);
  res.status(204).end();
});

module.exports = router;
module.exports.buildRecipients = buildRecipients;
