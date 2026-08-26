CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  google_sub TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  couple_name_1 TEXT NOT NULL DEFAULT '',
  couple_name_2 TEXT NOT NULL DEFAULT '',
  wedding_date TEXT NOT NULL DEFAULT '',
  wedding_time TEXT NOT NULL DEFAULT '',
  venue_name TEXT NOT NULL DEFAULT '',
  waze_link TEXT NOT NULL DEFAULT '',
  bus_pickup_location TEXT NOT NULL DEFAULT '',
  bus_destination_text TEXT NOT NULL DEFAULT '',
  bus_departure_time TEXT NOT NULL DEFAULT '',
  bus_return_time TEXT NOT NULL DEFAULT '',
  deployed_base_url TEXT NOT NULL DEFAULT '',
  whatsapp_message_template TEXT NOT NULL DEFAULT '',
  whatsapp_country_code TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invited_guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  phone TEXT NOT NULL,
  name TEXT NOT NULL,
  expected_guest INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invited_guests_user_phone ON invited_guests(user_id, phone);

CREATE TABLE IF NOT EXISTS rsvps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  phone TEXT NOT NULL,
  guests INTEGER NOT NULL,
  timestamp TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rsvps_user_phone ON rsvps(user_id, phone);

CREATE TABLE IF NOT EXISTS bus_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  going_count INTEGER NOT NULL DEFAULT 0,
  return_count INTEGER NOT NULL DEFAULT 0,
  going_confirmed INTEGER NOT NULL DEFAULT 0,
  return_confirmed INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bus_registrations_user_phone ON bus_registrations(user_id, phone);

CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  slot TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  uploaded_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_media_user_slot ON media(user_id, slot);
