const express = require('express');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { query, withTransaction } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Splits one line on commas per RFC 4180: a comma inside a "quoted" field doesn't split
// the line, and "" inside a quoted field is an escaped literal quote.
function splitCsvLine(line) {
  const fields = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field);
  return fields;
}

async function upsertGuests(userId, rows) {
  const now = new Date().toISOString();
  let imported = 0;
  const errors = [];

  await withTransaction(async (client) => {
    for (let index = 0; index < rows.length; index += 1) {
      const { name, phone, expected_guest: expectedRaw } = rows[index];
      if (!name || !phone) {
        errors.push({ line: index + 1, error: 'Missing name or phone' });
        continue;
      }
      await client.query(
        `INSERT INTO invited_guests (user_id, phone, name, expected_guest, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT (user_id, phone) DO UPDATE SET name = $3, expected_guest = $4, updated_at = $5`,
        [userId, String(phone).trim(), String(name).trim(), parseInt(expectedRaw, 10) || 1, now]
      );
      imported += 1;
    }
  });

  return { imported, errors };
}

router.get('/public/:userId/invited-guests/:phone', async (req, res) => {
  const { rows } = await query('SELECT * FROM invited_guests WHERE user_id = $1 AND phone = $2', [req.params.userId, req.params.phone]);
  const guest = rows[0];
  if (!guest) return res.status(404).json({ error: 'Not found' });
  res.json(guest);
});

router.get('/invited-guests', requireAuth, async (req, res) => {
  const { rows } = await query('SELECT * FROM invited_guests WHERE user_id = $1 ORDER BY name', [req.userId]);
  res.json(rows);
});

router.post('/invited-guests', requireAuth, async (req, res) => {
  const { phone, name, expected_guest, do_not_send } = req.body;
  if (!phone || !name) return res.status(400).json({ error: 'phone and name are required' });

  const now = new Date().toISOString();
  try {
    await query(
      'INSERT INTO invited_guests (user_id, phone, name, expected_guest, do_not_send, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)',
      [req.userId, phone, name, expected_guest ?? 1, do_not_send ? 1 : 0, now]
    );
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Phone already exists' });
    throw err;
  }
  const { rows } = await query('SELECT * FROM invited_guests WHERE user_id = $1 AND phone = $2', [req.userId, phone]);
  res.status(201).json(rows[0]);
});

router.put('/invited-guests/:phone', requireAuth, async (req, res) => {
  const { rows: existingRows } = await query('SELECT * FROM invited_guests WHERE user_id = $1 AND phone = $2', [req.userId, req.params.phone]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { name, expected_guest, do_not_send } = req.body;
  await query(
    'UPDATE invited_guests SET name = $1, expected_guest = $2, do_not_send = $3, updated_at = $4 WHERE user_id = $5 AND phone = $6',
    [
      name ?? existing.name,
      expected_guest ?? existing.expected_guest,
      do_not_send === undefined ? existing.do_not_send : (do_not_send ? 1 : 0),
      new Date().toISOString(),
      req.userId,
      req.params.phone,
    ]
  );

  const { rows } = await query('SELECT * FROM invited_guests WHERE user_id = $1 AND phone = $2', [req.userId, req.params.phone]);
  res.json(rows[0]);
});

router.delete('/invited-guests/:phone', requireAuth, async (req, res) => {
  await query('DELETE FROM invited_guests WHERE user_id = $1 AND phone = $2', [req.userId, req.params.phone]);
  res.status(204).end();
});

router.post('/invited-guests/bulk-import', requireAuth, async (req, res) => {
  const { text } = req.body;
  if (typeof text !== 'string') return res.status(400).json({ error: 'text is required' });

  const rows = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, phone, expected_guest] = splitCsvLine(line).map((part) => part.trim());
      return { name, phone, expected_guest };
    });

  res.json(await upsertGuests(req.userId, rows));
});

function normalizeCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if (value.text !== undefined) return value.text; // rich text
    if (value.result !== undefined) return value.result; // formula
    if (value instanceof Date) return value.toISOString();
  }
  return value;
}

// Maps a table of raw cell rows into {name, phone, expected_guest} records. If the first
// row looks like a header (contains "name" and "phone"), columns are matched by header text;
// otherwise falls back to the same fixed name,phone,expected_guest order used by manual import.
function mapTableRows(rows) {
  if (rows.length === 0) return [];

  const headerCells = rows[0].map((cell) => String(normalizeCell(cell)).trim().toLowerCase());
  const hasHeader = headerCells.includes('name') && headerCells.includes('phone');

  let nameIdx = 0;
  let phoneIdx = 1;
  let expectedIdx = 2;
  let dataRows = rows;

  if (hasHeader) {
    nameIdx = headerCells.indexOf('name');
    phoneIdx = headerCells.indexOf('phone');
    expectedIdx = headerCells.findIndex((cell) => cell.startsWith('expected'));
    dataRows = rows.slice(1);
  }

  return dataRows
    .filter((row) => row.some((cell) => String(normalizeCell(cell)).trim() !== ''))
    .map((row) => ({
      name: normalizeCell(row[nameIdx]),
      phone: row[phoneIdx] !== undefined ? String(normalizeCell(row[phoneIdx])).trim() : undefined,
      expected_guest: expectedIdx >= 0 ? normalizeCell(row[expectedIdx]) : undefined,
    }));
}

async function parseXlsxBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    rows.push(row.values.slice(1));
  });
  return rows;
}

function parseCsvBuffer(buffer) {
  // Strip a UTF-8 BOM if present (common in CSVs exported from Excel) so it doesn't get
  // stuck onto the first header/cell and break header matching or corrupt the first name.
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => splitCsvLine(line));
}

router.post('/invited-guests/upload', requireAuth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const isXlsx = /\.xlsx$/i.test(req.file.originalname) || req.file.mimetype.includes('spreadsheet');

    let rows;
    try {
      const tableRows = isXlsx ? await parseXlsxBuffer(req.file.buffer) : parseCsvBuffer(req.file.buffer);
      rows = mapTableRows(tableRows);
    } catch (parseErr) {
      return res.status(400).json({ error: 'Could not parse file. Expected a CSV or XLSX with name/phone columns.' });
    }

    res.json(await upsertGuests(req.userId, rows));
  });
});

// Escapes a CSV field per RFC 4180: wraps in quotes and doubles any embedded quotes
// whenever the value contains a comma, quote or line break.
function csvField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

router.get('/invited-guests/export', requireAuth, async (req, res) => {
  const { rows: guests } = await query('SELECT * FROM invited_guests WHERE user_id = $1 ORDER BY name', [req.userId]);
  const { rows: rsvpRows } = await query('SELECT * FROM rsvps WHERE user_id = $1', [req.userId]);
  const rsvpByPhone = new Map(rsvpRows.map((r) => [r.phone, r]));
  const { rows: settingsRows } = await query('SELECT couple_name_1, couple_name_2 FROM settings WHERE user_id = $1', [req.userId]);
  const settings = settingsRows[0];

  const headers = [
    'שם', 'טלפון', 'סטטוס הזמנה', 'סטטוס אישור הגעה', 'מספר מגיעים', 'לשלוח הודעות', 'תאריך תגובה',
  ];
  const rows = guests.map((g) => {
    const rsvp = rsvpByPhone.get(g.phone);
    const invitationStatus = rsvp ? 'ענה' : 'טרם ענה';
    const rsvpStatus = !rsvp ? 'טרם ענה' : rsvp.status === 'attending' ? 'מגיע' : 'לא מגיע';
    const attendeeCount = rsvp && rsvp.status === 'attending' ? rsvp.guests : 0;
    const sendMessages = g.do_not_send ? 'לא' : 'כן';
    const responseDate = rsvp ? rsvp.timestamp : '';
    return [g.name, `="${g.phone}"`, invitationStatus, rsvpStatus, attendeeCount, sendMessages, responseDate];
  });

  const lines = [headers, ...rows].map((row) => row.map(csvField).join(',')).join('\r\n');
  const BOM = '﻿'; // so Excel opens the file as UTF-8 instead of mangling Hebrew text
  const csv = BOM + lines;

  const weddingName = [settings?.couple_name_1, settings?.couple_name_2].filter(Boolean).join('-') || 'guests';
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `${weddingName}-${dateStr}.csv`.replace(/[^\w\-.]/g, '_');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

module.exports = router;
module.exports.csvField = csvField;
