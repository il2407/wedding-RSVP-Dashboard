const path = require('path');
const fs = require('fs');

// Configurable so uploaded media can live on a persistent disk/volume (e.g. Render's
// persistent disk) instead of the app's own directory, which is wiped on every deploy.
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const uploadsDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

// Tests run against an in-memory pg-mem instance (no real Postgres server is available in
// this environment); production/dev connect to a real Postgres via DATABASE_URL.
let pool;
if (process.env.NODE_ENV === 'test') {
  const { newDb } = require('pg-mem');
  const mem = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = mem.adapters.createPg();
  pool = new adapter.Pool();
} else {
  const { Pool } = require('pg');
  // Render's managed Postgres (and most hosted providers) require SSL and present a
  // self-signed cert, so verification must be disabled rather than the connection refused.
  const ssl = process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : undefined;
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
  // Some hosted Postgres instances default a role/database to a non-UTF8 client_encoding,
  // which silently mangles multi-byte characters (e.g. emoji) on write/read. Force UTF8
  // on every new connection so this can't depend on the server's default.
  pool.on('connect', (client) => {
    client.query("SET client_encoding TO 'UTF8'").catch((err) => {
      console.error('Failed to set client_encoding', err);
    });
  });
}

const ready = pool.query(schema).catch((err) => {
  console.error('Failed to initialize database schema', err);
  process.exit(1);
});

async function query(text, params) {
  await ready;
  return pool.query(text, params);
}

// Runs `fn(client)` inside a BEGIN/COMMIT transaction, rolling back on error. `client`
// exposes the same `query(text, params)` signature as the pool.
async function withTransaction(fn) {
  await ready;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction, uploadsDir, ready };
