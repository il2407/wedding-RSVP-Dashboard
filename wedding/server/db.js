const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Configurable so the SQLite file can live on a persistent disk/volume (e.g. Render's
// persistent disk) instead of the app's own directory, which is wiped on every deploy.
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const uploadsDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const db = new Database(path.join(dataDir, 'wedding.db'));
db.pragma('journal_mode = WAL');

const LEGACY_TABLES = ['settings', 'invited_guests', 'rsvps', 'bus_registrations', 'media'];

function tableExists(name) {
  return !!db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', name);
}

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((col) => col.name === column);
}

// One-time upgrade from the old single-tenant schema: the pre-existing tables have no
// user_id column, so they're renamed aside as `<name>_legacy` and left untouched until a
// real account claims them via POST /api/admin/claim-legacy-data.
function migrateLegacySchema() {
  const hasUsersTable = tableExists('users');
  const hasLegacySettings = tableExists('settings') && !columnExists('settings', 'user_id');

  if (hasUsersTable || !hasLegacySettings) return;

  const rename = db.transaction(() => {
    for (const table of LEGACY_TABLES) {
      if (tableExists(table)) {
        db.exec(`ALTER TABLE ${table} RENAME TO ${table}_legacy`);
      }
    }
  });
  rename();
}

migrateLegacySchema();

// One-time upgrade for accounts created before Google sign-in existed: adds the column
// that links a user row to their Google account (nullable/unique, so existing
// password-only accounts are unaffected until they choose to link one).
function migrateGoogleAuthColumn() {
  if (!tableExists('users') || columnExists('users', 'google_sub')) return;
  db.exec('ALTER TABLE users ADD COLUMN google_sub TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub)');
}

migrateGoogleAuthColumn();

// One-time upgrade for accounts created before per-tenant theming existed.
function migrateThemeColorColumn() {
  if (!tableExists('settings') || columnExists('settings', 'theme_color')) return;
  db.exec("ALTER TABLE settings ADD COLUMN theme_color TEXT NOT NULL DEFAULT '#f97316'");
}

migrateThemeColorColumn();

// One-time upgrade adding distinct RSVP status/source tracking, so "responded" and
// "confirmed attendees" can be computed separately instead of conflating invitation
// counts with attendee headcounts. Existing rows (all guest-submitted, pre-dating this
// column) are backfilled from their `guests` value: 0 means the guest declined, anything
// else means they're attending.
function migrateRsvpStatusColumns() {
  if (!tableExists('rsvps')) return;
  if (!columnExists('rsvps', 'status')) {
    db.exec("ALTER TABLE rsvps ADD COLUMN status TEXT NOT NULL DEFAULT 'attending'");
    db.exec("UPDATE rsvps SET status = CASE WHEN guests = 0 THEN 'declined' ELSE 'attending' END");
  }
  if (!columnExists('rsvps', 'source')) {
    db.exec("ALTER TABLE rsvps ADD COLUMN source TEXT NOT NULL DEFAULT 'guest'");
  }
}

migrateRsvpStatusColumns();

// One-time upgrade adding a per-guest flag to skip them when sending bulk WhatsApp
// invitations (e.g. close friends/family already known to be attending). Defaults to 0
// (send as before) so existing guest records are unaffected.
function migrateDoNotSendColumn() {
  if (!tableExists('invited_guests') || columnExists('invited_guests', 'do_not_send')) return;
  db.exec('ALTER TABLE invited_guests ADD COLUMN do_not_send INTEGER NOT NULL DEFAULT 0');
}

migrateDoNotSendColumn();

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

module.exports = { db, uploadsDir };
