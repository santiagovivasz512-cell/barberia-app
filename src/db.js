const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const DATA_DIR = path.join(__dirname, "..", "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "barberia.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    duration_min INTEGER NOT NULL,
    price INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS hours (
    day_of_week INTEGER PRIMARY KEY, -- 0=domingo .. 6=sabado
    open_time TEXT,
    close_time TEXT,
    closed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_token TEXT NOT NULL UNIQUE,
    ticket_number INTEGER NOT NULL,
    client_name TEXT NOT NULL,
    client_phone TEXT NOT NULL,
    service_id INTEGER,
    service_name TEXT NOT NULL,
    duration_min INTEGER NOT NULL,
    price INTEGER NOT NULL,
    date TEXT NOT NULL,   -- YYYY-MM-DD
    time TEXT NOT NULL,   -- HH:MM
    status TEXT NOT NULL DEFAULT 'confirmed', -- confirmed | done | cancelled
    notes TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_token ON appointments(public_token);
`);

function getSetting(key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

function seedIfEmpty() {
  const seeded = getSetting("seeded", null);
  if (seeded) return;

  setSetting("shop_name", "Mi Barberia");
  setSetting("barber_name", "Barbero");
  setSetting("currency", "COP");
  setSetting("locale", "es-CO");
  setSetting("slot_interval_min", "15");
  setSetting("min_notice_min", "30"); // no permitir reservar con menos de 30 min de antelacion
  setSetting("next_ticket_number", "1");

  const initialPassword = process.env.ADMIN_INITIAL_PASSWORD || "cambiame123";
  const hash = bcrypt.hashSync(initialPassword, 10);
  setSetting("admin_password_hash", hash);

  const insertService = db.prepare(
    `INSERT INTO services (name, duration_min, price, active, sort_order) VALUES (?, ?, ?, 1, ?)`
  );
  const defaultServices = [
    ["Corte clasico", 20, 22000],
    ["Corte + barba", 60, 32000],
    ["Arreglo de barba", 25, 15000],
    ["Corte a maquina (fade)", 40, 28000],
    ["Corte nino", 30, 20000],
  ];
  defaultServices.forEach((s, i) => insertService.run(s[0], s[1], s[2], i));

  const insertHours = db.prepare(
    `INSERT INTO hours (day_of_week, open_time, close_time, closed) VALUES (?, ?, ?, ?)`
  );
  // 0 = domingo ... 6 = sabado. Cerrado el domingo y el martes por defecto.
  for (let d = 0; d <= 6; d++) {
    if (d === 0 || d === 2) insertHours.run(d, null, null, 1);
    else insertHours.run(d, "09:00", "19:00", 0);
  }

  setSetting("seeded", "1");
}

seedIfEmpty();

module.exports = { db, getSetting, setSetting };
