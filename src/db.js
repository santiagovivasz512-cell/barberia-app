const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Envoltorio delgado sobre "pg" que imita el estilo prepare().get/all/run()
// (para no reescribir cada consulta de las rutas), pero de forma asincrona.
const db = {
  prepare(sql) {
    const pgSql = toPgSql(sql);
    return {
      all: async (...params) => (await pool.query(pgSql, params)).rows,
      get: async (...params) => (await pool.query(pgSql, params)).rows[0],
      run: async (...params) => {
        const res = await pool.query(pgSql, params);
        return {
          changes: res.rowCount,
          lastInsertRowid: res.rows[0] ? res.rows[0].id : undefined,
        };
      },
    };
  },
};

async function getSetting(key, fallback) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`
    )
    .run(key, String(value));
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS services (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      duration_min INTEGER NOT NULL,
      price INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS hours (
      day_of_week INTEGER PRIMARY KEY,
      open_time TEXT,
      close_time TEXT,
      closed INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS clients (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      email TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS appointments (
      id SERIAL PRIMARY KEY,
      public_token TEXT NOT NULL UNIQUE,
      ticket_number INTEGER NOT NULL,
      client_name TEXT NOT NULL,
      client_phone TEXT NOT NULL,
      service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
      service_name TEXT NOT NULL,
      duration_min INTEGER NOT NULL,
      price INTEGER NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'confirmed',
      notes TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS appointment_history (
      id SERIAL PRIMARY KEY,
      appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
      from_date TEXT NOT NULL,
      from_time TEXT NOT NULL,
      to_date TEXT NOT NULL,
      to_time TEXT NOT NULL,
      changed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS time_blocks (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      start_time TEXT,
      end_time TEXT,
      all_day INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_token ON appointments(public_token);
    CREATE INDEX IF NOT EXISTS idx_time_blocks_date ON time_blocks(date);

    ALTER TABLE appointments ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL;
    ALTER TABLE hours ADD COLUMN IF NOT EXISTS break_start TEXT;
    ALTER TABLE hours ADD COLUMN IF NOT EXISTS break_end TEXT;
    ALTER TABLE services ADD COLUMN IF NOT EXISTS description TEXT;
    ALTER TABLE services ADD COLUMN IF NOT EXISTS category TEXT;
  `);
}

async function upsertClient(name, phone) {
  const existing = await db.prepare(`SELECT * FROM clients WHERE phone = ?`).get(phone);
  if (existing) return existing;
  const ins = await db
    .prepare(`INSERT INTO clients (name, phone, created_at) VALUES (?, ?, ?) RETURNING id`)
    .run(name, phone, new Date().toISOString());
  return db.prepare(`SELECT * FROM clients WHERE id = ?`).get(ins.lastInsertRowid);
}

async function backfillClients() {
  const rows = await db
    .prepare(`SELECT DISTINCT client_phone, client_name FROM appointments WHERE client_id IS NULL`)
    .all();
  for (const r of rows) {
    let client = await db.prepare(`SELECT id FROM clients WHERE phone = ?`).get(r.client_phone);
    if (!client) {
      const ins = await db
        .prepare(`INSERT INTO clients (name, phone, created_at) VALUES (?, ?, ?) RETURNING id`)
        .run(r.client_name, r.client_phone, new Date().toISOString());
      client = { id: ins.lastInsertRowid };
    }
    await db
      .prepare(`UPDATE appointments SET client_id = ? WHERE client_phone = ? AND client_id IS NULL`)
      .run(client.id, r.client_phone);
  }
}

async function ensureNewSettingDefaults() {
  const defaults = {
    logo_url: "",
    description: "",
    phone: "",
    email: "",
    address: "",
    instagram: "",
    color_primary: "#d9a441",
    color_secondary: "#f2c14e",
    cancellation_policy: "",
  };
  for (const [key, val] of Object.entries(defaults)) {
    const existing = await getSetting(key, undefined);
    if (existing === undefined) await setSetting(key, val);
  }
}

async function seedIfEmpty() {
  const seeded = await getSetting("seeded", null);
  if (seeded) return;

  await setSetting("shop_name", "Mi Barberia");
  await setSetting("barber_name", "Barbero");
  await setSetting("currency", "COP");
  await setSetting("locale", "es-CO");
  await setSetting("slot_interval_min", "15");
  await setSetting("min_notice_min", "30");
  await setSetting("next_ticket_number", "1");

  const initialPassword = process.env.ADMIN_INITIAL_PASSWORD || "cambiame123";
  const hash = bcrypt.hashSync(initialPassword, 10);
  await setSetting("admin_password_hash", hash);

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
  for (let i = 0; i < defaultServices.length; i++) {
    const s = defaultServices[i];
    await insertService.run(s[0], s[1], s[2], i);
  }

  const insertHours = db.prepare(
    `INSERT INTO hours (day_of_week, open_time, close_time, closed) VALUES (?, ?, ?, ?)`
  );
  // 0 = domingo ... 6 = sabado. Cerrado el domingo y el martes por defecto.
  for (let d = 0; d <= 6; d++) {
    if (d === 0 || d === 2) await insertHours.run(d, null, null, 1);
    else await insertHours.run(d, "09:00", "19:00", 0);
  }

  await setSetting("seeded", "1");
}

const ready = (async () => {
  await initSchema();
  await seedIfEmpty();
  await ensureNewSettingDefaults();
  await backfillClients();
})();

module.exports = { db, pool, getSetting, setSetting, upsertClient, ready };
