import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, 'data.sqlite');

const db = new Database(dbPath);

export function init() {
  const schemaPath = path.resolve(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schema);

  // Seed users if none
  const row = db.prepare('SELECT COUNT(*) as c FROM users').get();
  if (row.c === 0) {
    const hash = (p)=>p; // placeholder, we will store plain initially and upgrade below
    // We'll actually bcrypt later in server.js when seeding
  }
  return db;
}

export default db;
