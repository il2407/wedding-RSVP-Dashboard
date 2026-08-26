const express = require('express');
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Old single-tenant media slots have no automatic equivalent in the new 4-slot model,
// since happy/sad each collapsed a photo+video pair into a single gif.
const MEDIA_SLOT_MAP = {
  sticker_1: 'groom_photo',
  sticker_2: 'bride_photo',
};

function tableExists(name) {
  return !!db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', name);
}

router.post('/admin/claim-legacy-data', requireAuth, (req, res) => {
  const legacyTables = ['settings_legacy', 'invited_guests_legacy', 'rsvps_legacy', 'bus_registrations_legacy', 'media_legacy'];
  const present = legacyTables.filter(tableExists);
  if (present.length === 0) {
    return res.json({ claimed: false, reason: 'No legacy data found' });
  }

  const userId = req.userId;
  const summary = {
    claimed: true,
    settingsClaimed: false,
    guestsClaimed: 0,
    rsvpsClaimed: 0,
    busRegistrationsClaimed: 0,
    mediaClaimed: 0,
    mediaSkipped: [],
  };

  const run = db.transaction(() => {
    if (tableExists('settings_legacy')) {
      const legacy = db.prepare('SELECT * FROM settings_legacy WHERE id = 1').get();
      if (legacy) {
        db.prepare(
          `UPDATE settings SET couple_name_1 = ?, couple_name_2 = ?, wedding_date = ?, wedding_time = ?, venue_name = ?,
           waze_link = ?, bus_pickup_location = ?, bus_destination_text = ?, bus_departure_time = ?, bus_return_time = ?,
           deployed_base_url = ?, whatsapp_message_template = ?, whatsapp_country_code = ?, updated_at = ? WHERE user_id = ?`
        ).run(
          legacy.couple_name_1, legacy.couple_name_2, legacy.wedding_date, legacy.wedding_time, legacy.venue_name,
          legacy.waze_link, legacy.bus_pickup_location, legacy.bus_destination_text, legacy.bus_departure_time,
          legacy.bus_return_time, legacy.deployed_base_url, legacy.whatsapp_message_template, legacy.whatsapp_country_code,
          new Date().toISOString(), userId
        );
        summary.settingsClaimed = true;
      }
      db.exec('DROP TABLE settings_legacy');
    }

    if (tableExists('invited_guests_legacy')) {
      const { changes } = db.prepare(
        `INSERT INTO invited_guests (user_id, phone, name, expected_guest, created_at, updated_at)
         SELECT ?, phone, name, expected_guest, created_at, updated_at FROM invited_guests_legacy`
      ).run(userId);
      summary.guestsClaimed = changes;
      db.exec('DROP TABLE invited_guests_legacy');
    }

    if (tableExists('rsvps_legacy')) {
      const { changes } = db.prepare(
        `INSERT INTO rsvps (user_id, phone, guests, timestamp) SELECT ?, phone, guests, timestamp FROM rsvps_legacy`
      ).run(userId);
      summary.rsvpsClaimed = changes;
      db.exec('DROP TABLE rsvps_legacy');
    }

    if (tableExists('bus_registrations_legacy')) {
      const { changes } = db.prepare(
        `INSERT INTO bus_registrations (user_id, full_name, phone, going_count, return_count, going_confirmed, return_confirmed, updated_at)
         SELECT ?, full_name, phone, going_count, return_count, going_confirmed, return_confirmed, updated_at FROM bus_registrations_legacy`
      ).run(userId);
      summary.busRegistrationsClaimed = changes;
      db.exec('DROP TABLE bus_registrations_legacy');
    }

    if (tableExists('media_legacy')) {
      const insertMedia = db.prepare(
        `INSERT INTO media (user_id, slot, filename, mime_type, uploaded_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, slot) DO NOTHING`
      );
      const legacyMedia = db.prepare('SELECT * FROM media_legacy').all();
      legacyMedia.forEach((row) => {
        const newSlot = MEDIA_SLOT_MAP[row.slot];
        if (newSlot) {
          insertMedia.run(userId, newSlot, row.filename, row.mime_type, row.uploaded_at);
          summary.mediaClaimed += 1;
        } else {
          summary.mediaSkipped.push(row.slot);
        }
      });
      db.exec('DROP TABLE media_legacy');
    }
  });

  run();
  res.json(summary);
});

module.exports = router;
