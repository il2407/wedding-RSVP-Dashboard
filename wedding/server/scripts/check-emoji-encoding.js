// Diagnostic for the WhatsApp emoji-corruption bug (🎉 and 🖐️ arriving as "�").
//
// Local testing (pg-mem, qs/Twilio URL-encoding, JSON) roundtrips these emoji perfectly,
// which points at the real production Postgres connection/database itself mangling 4-byte
// UTF-8 sequences (which is exactly what emoji need) while leaving Hebrew (2-byte UTF-8)
// untouched. This script isolates where the corruption actually happens:
//
//   1. Reports the database's server_encoding/client_encoding.
//   2. Reads whatever is CURRENTLY stored in settings.whatsapp_message_template and checks
//      whether it is already corrupted at rest (proves the bug is in the save path).
//   3. Runs a fresh INSERT/SELECT round-trip of a known-good emoji string against a scratch
//      table (proves/disproves that Postgres itself is the corrupting layer, independent of
//      any of the app's own code).
//
// Usage (run where DATABASE_URL is set, e.g. Render's Shell tab for the web service):
//   node scripts/check-emoji-encoding.js

const { pool } = require('../db');

const SAMPLE = 'ג׳אגשמאש! 🎉 מתחתנים! תודה רבה, היי פייב! 🖐️';

function describe(label, str) {
  const hasReplacement = str.includes('�');
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(str);
  console.log(`\n${label}:`);
  console.log('  text:', str);
  console.log('  contains U+FFFD (�):', hasReplacement);
  console.log('  contains a lone/unpaired surrogate:', loneSurrogate);
  console.log('  code points:', [...str].map((ch) => 'U+' + ch.codePointAt(0).toString(16).toUpperCase()).join(' '));
}

async function main() {
  const client = await pool.connect();
  try {
    const { rows: encRows } = await client.query('SHOW server_encoding');
    const { rows: clientEncRows } = await client.query('SHOW client_encoding');
    console.log('server_encoding:', encRows[0].server_encoding);
    console.log('client_encoding:', clientEncRows[0].client_encoding);

    const { rows: settingsRows } = await client.query(
      'SELECT user_id, whatsapp_message_template FROM settings WHERE whatsapp_message_template IS NOT NULL AND whatsapp_message_template != \'\''
    );
    for (const row of settingsRows) {
      describe(`settings.whatsapp_message_template (user_id=${row.user_id})`, row.whatsapp_message_template);
    }
    if (settingsRows.length === 0) {
      console.log('\n(no non-empty whatsapp_message_template rows found in settings)');
    }

    describe('Sample string BEFORE insert (in Node, this process)', SAMPLE);

    await client.query('CREATE TEMP TABLE emoji_check (id serial primary key, msg text)');
    await client.query('INSERT INTO emoji_check (msg) VALUES ($1)', [SAMPLE]);
    const { rows } = await client.query('SELECT msg FROM emoji_check');
    describe('Sample string AFTER round-trip through Postgres', rows[0].msg);

    console.log('\nRound-trip equal to original:', rows[0].msg === SAMPLE);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
