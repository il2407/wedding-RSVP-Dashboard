const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { query, uploadsDir } = require('../db');
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

router.get('/media/:userId/:slot', async (req, res) => {
  const { rows } = await query('SELECT * FROM media WHERE user_id = $1 AND slot = $2', [req.params.userId, req.params.slot]);
  const row = rows[0];
  if (!row) return res.status(404).send('Not found');

  const filePath = path.join(uploadsDir, row.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');

  res.type(row.mime_type);
  res.sendFile(filePath);
});

router.get('/api/admin/media', requireAuth, async (req, res) => {
  const { rows } = await query('SELECT slot, filename, mime_type, uploaded_at FROM media WHERE user_id = $1', [req.userId]);
  res.json(rows);
});

router.put('/api/admin/media/:slot', requireAuth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    await query(
      `INSERT INTO media (user_id, slot, filename, mime_type, uploaded_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, slot) DO UPDATE SET filename = $3, mime_type = $4, uploaded_at = $5`,
      [req.userId, req.params.slot, req.file.filename, req.file.mimetype, new Date().toISOString()]
    );

    res.json({ slot: req.params.slot, filename: req.file.filename });
  });
});

module.exports = router;
