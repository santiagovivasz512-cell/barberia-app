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

    CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_token ON appointments(public_token);
  `);
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
})();

module.exports = { db, pool, getSetting, setSetting, ready };
