const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { query, uploadsDir } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireNumericParam } = require('../middleware/errors');

const router = express.Router();
router.param('userId', requireNumericParam);

const VALID_SLOTS = ['groom_photo', 'bride_photo', 'approval_gif', 'decline_gif', 'maybe_gif'];

// Media is served back from our own origin, so only real image/video types are accepted —
// an uploaded .html/.svg would otherwise run script on the app's domain. The stored file's
// extension comes from this map, never from the client's original filename.
const IMAGE_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'image/heif': '.heif',
};
const VIDEO_TYPES = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};
const ALLOWED_TYPES = { ...IMAGE_TYPES, ...VIDEO_TYPES };

// Photo slots take images only; the reaction (gif) slots also accept short videos.
function allowedTypesForSlot(slot) {
  return slot.endsWith('_photo') ? IMAGE_TYPES : ALLOWED_TYPES;
}

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => {
    cb(null, `${req.userId}_${req.params.slot}${ALLOWED_TYPES[file.mimetype]}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!VALID_SLOTS.includes(req.params.slot)) {
      return cb(new Error('Unknown media slot'));
    }
    if (!allowedTypesForSlot(req.params.slot)[file.mimetype]) {
      return cb(new Error('Unsupported file type. Please upload an image (JPG, PNG, GIF, WEBP) or a short MP4/WEBM video.'));
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

  // Anything stored before the type allowlist existed that isn't a real image/video is never
  // rendered by the browser — it's served as an opaque download instead.
  res.set('X-Content-Type-Options', 'nosniff');
  if (ALLOWED_TYPES[row.mime_type]) {
    res.type(row.mime_type);
  } else {
    res.type('application/octet-stream');
    res.attachment(row.filename);
  }
  res.sendFile(filePath);
});

router.get('/api/admin/media', requireAuth, async (req, res) => {
  const { rows } = await query('SELECT slot, filename, mime_type, uploaded_at FROM media WHERE user_id = $1', [req.userId]);
  res.json(rows);
});

router.put('/api/admin/media/:slot', requireAuth, (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const { rows: previousRows } = await query('SELECT filename FROM media WHERE user_id = $1 AND slot = $2', [req.userId, req.params.slot]);
      await query(
        `INSERT INTO media (user_id, slot, filename, mime_type, uploaded_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, slot) DO UPDATE SET filename = $3, mime_type = $4, uploaded_at = $5`,
        [req.userId, req.params.slot, req.file.filename, req.file.mimetype, new Date().toISOString()]
      );

      // Replacing e.g. a .png with a .gif writes a new filename, so remove the old file
      // rather than leaving it orphaned on disk.
      const previous = previousRows[0];
      if (previous && previous.filename !== req.file.filename) {
        fs.rm(path.join(uploadsDir, path.basename(previous.filename)), { force: true }, () => {});
      }

      res.json({ slot: req.params.slot, filename: req.file.filename });
    } catch (handlerErr) {
      next(handlerErr);
    }
  });
});

module.exports = router;
