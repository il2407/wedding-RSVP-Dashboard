const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, 'data');
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

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

module.exports = { db, uploadsDir };
