PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  center TEXT NOT NULL,
  name TEXT,
  phone TEXT,
  balance REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS codes(
  code INTEGER PRIMARY KEY,
  sport_key TEXT NOT NULL,
  sport TEXT NOT NULL,
  team TEXT NOT NULL,
  ml INTEGER,
  over INTEGER,
  under INTEGER,
  points TEXT,
  game_time TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS tickets(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  center TEXT NOT NULL,
  client_name TEXT,
  client_phone TEXT,
  sport_key TEXT NOT NULL,
  sport TEXT NOT NULL,
  team TEXT NOT NULL,
  bet TEXT NOT NULL, -- ML/Over/Under
  pts TEXT,
  price INTEGER NOT NULL,
  stake REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' -- open|won|lost|void
);
