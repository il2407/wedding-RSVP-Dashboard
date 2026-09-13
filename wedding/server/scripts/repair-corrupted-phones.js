// One-time data repair for phone numbers corrupted by two now-fixed bugs:
//   1. Exporting guests to CSV wraps the phone in Excel's `="<phone>"` "force text" marker
//      (so leading zeros survive opening in Excel); re-importing that same exported file fed
//      the literal wrapper -- quotes and all -- back in as the phone number.
//   2. WhatsApp RSVP links were built by interpolating the raw phone into a URL without
//      encoding it, so a phone already containing `="..."` (from bug #1) broke the query
//      string apart, and a guest submitting the RSVP form from that broken link could write
//      the mangled value back into rsvps/bus_registrations.
//
// Both bugs are fixed at the source (stripExcelTextWrapper() on CSV import, encodeURIComponent()
// on link building), but any phone values already corrupted before the fix stay corrupted until
// repaired here.
//
// Usage:
//   node scripts/repair-corrupted-phones.js            # dry run: reports what would change
//   node scripts/repair-corrupted-phones.js --apply     # actually writes the fixes
//
// Requires DATABASE_URL to be set (same as the server). Safe to re-run: rows that are already
// clean are left untouched, and a cleaned value that would collide with another row for the
// same user is skipped and reported instead of overwritten, since resolving a collision
// (which of the two rows is the "real" guest) needs a human decision.

const { pool } = require('../db');

function cleanPhone(raw) {
  let value = String(raw);
  const wrapped = /^="(.*)"$/.exec(value);
  if (wrapped) value = wrapped[1];
  // Strips any stray quote/equals characters left over from a partially-mangled value (e.g.
  // the URL-building bug could leave just a leading '=' or embedded '"' rather than the full
  // ="..." wrapper).
  value = value.replace(/["=]/g, '');
  return value.trim();
}

const TABLES = [
  { name: 'invited_guests', uniqueOn: 'user_id' },
  { name: 'rsvps', uniqueOn: 'user_id' },
  { name: 'bus_registrations', uniqueOn: 'user_id' },
];

async function repairTable(client, table, apply) {
  const { rows } = await client.query(`SELECT id, user_id, phone FROM ${table.name}`);
  let fixed = 0;
  let skipped = 0;

  for (const row of rows) {
    const cleaned = cleanPhone(row.phone);
    if (cleaned === row.phone) continue;

    const { rows: conflictRows } = await client.query(
      `SELECT id FROM ${table.name} WHERE user_id = $1 AND phone = $2 AND id != $3`,
      [row.user_id, cleaned, row.id]
    );
    if (conflictRows[0]) {
      skipped += 1;
      console.log(
        `[SKIP] ${table.name}.id=${row.id} (user ${row.user_id}): "${row.phone}" -> "${cleaned}" ` +
          `collides with existing row id=${conflictRows[0].id}; resolve manually.`
      );
      continue;
    }

    console.log(`[${apply ? 'FIX' : 'DRY-RUN'}] ${table.name}.id=${row.id} (user ${row.user_id}): "${row.phone}" -> "${cleaned}"`);
    if (apply) {
      await client.query(`UPDATE ${table.name} SET phone = $1 WHERE id = $2`, [cleaned, row.id]);
    }
    fixed += 1;
  }

  return { fixed, skipped };
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Running in dry-run mode. Pass --apply to write changes.\n');
  }

  const client = await pool.connect();
  try {
    let totalFixed = 0;
    let totalSkipped = 0;
    for (const table of TABLES) {
      const { fixed, skipped } = await repairTable(client, table, apply);
      totalFixed += fixed;
      totalSkipped += skipped;
    }
    console.log(`\nDone. ${totalFixed} row(s) ${apply ? 'fixed' : 'would be fixed'}, ${totalSkipped} skipped due to conflicts.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
