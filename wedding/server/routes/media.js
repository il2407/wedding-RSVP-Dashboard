const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { db, uploadsDir } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const VALID_SLOTS = ['groom_photo', 'bride_photo', 'approval_gif', 'decline_gif'];

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    cb(null, `${req.userId}_${req.params.slot}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!VALID_SLOTS.includes(req.params.slot)) {
      return cb(new Error('Unknown media slot'));
    }
    cb(null, true);
  },
});

router.get('/media/:userId/:slot', (req, res) => {
  const row = db.prepare('SELECT * FROM media WHERE user_id = ? AND slot = ?').get(req.params.userId, req.params.slot);
  if (!row) return res.status(404).send('Not found');

  const filePath = path.join(uploadsDir, row.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');

  res.type(row.mime_type);
  res.sendFile(filePath);
});

router.get('/api/admin/media', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT slot, filename, mime_type, uploaded_at FROM media WHERE user_id = ?').all(req.userId);
  res.json(rows);
});

router.put('/api/admin/media/:slot', requireAuth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    db.prepare(
      `INSERT INTO media (user_id, slot, filename, mime_type, uploaded_at) VALUES (@user_id, @slot, @filename, @mime_type, @uploaded_at)
       ON CONFLICT(user_id, slot) DO UPDATE SET filename = @filename, mime_type = @mime_type, uploaded_at = @uploaded_at`
    ).run({
      user_id: req.userId,
      slot: req.params.slot,
      filename: req.file.filename,
      mime_type: req.file.mimetype,
      uploaded_at: new Date().toISOString(),
    });

    res.json({ slot: req.params.slot, filename: req.file.filename });
  });
});

module.exports = router;
