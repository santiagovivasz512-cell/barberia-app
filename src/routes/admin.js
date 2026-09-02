const express = require("express");
const bcrypt = require("bcryptjs");
const { db, getSetting, setSetting } = require("../db");
const { requireAdmin } = require("../auth");

const router = express.Router();
router.use(requireAdmin);

// ---- Citas -----------------------------------------------------------

router.get("/appointments", (req, res) => {
  const { from, to, status } = req.query;
  let sql = "SELECT * FROM appointments WHERE 1=1";
  const params = [];
  if (from) {
    sql += " AND date >= ?";
    params.push(from);
  }
  if (to) {
    sql += " AND date <= ?";
    params.push(to);
  }
  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }
  sql += " ORDER BY date ASC, time ASC";
  res.json(db.prepare(sql).all(...params));
});

router.patch("/appointments/:id", (req, res) => {
  const { status } = req.body || {};
  if (!["confirmed", "done", "cancelled"].includes(status)) {
    return res.status(400).json({ error: "Estado invalido." });
  }
  const row = db.prepare("SELECT * FROM appointments WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "No encontrada." });
  db.prepare("UPDATE appointments SET status = ? WHERE id = ?").run(status, req.params.id);
  res.json(db.prepare("SELECT * FROM appointments WHERE id = ?").get(req.params.id));
});

router.delete("/appointments/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM appointments WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "No encontrada." });
  db.prepare("DELETE FROM appointments WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---- Servicios ---------------------------------------------------------

router.get("/services", (req, res) => {
  res.json(db.prepare("SELECT * FROM services ORDER BY sort_order ASC, id ASC").all());
});

router.post("/services", (req, res) => {
  const { name, durationMin, price } = req.body || {};
  if (!name || !String(name).trim() || !durationMin || price == null) {
    return res.status(400).json({ error: "Faltan datos del servicio." });
  }
  const maxOrder = db
    .prepare("SELECT COALESCE(MAX(sort_order), -1) as m FROM services")
    .get().m;
  const info = db
    .prepare(
      "INSERT INTO services (name, duration_min, price, active, sort_order) VALUES (?, ?, ?, 1, ?)"
    )
    .run(String(name).trim(), Number(durationMin), Number(price), maxOrder + 1);
  res.status(201).json(db.prepare("SELECT * FROM services WHERE id = ?").get(info.lastInsertRowid));
});

router.patch("/services/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM services WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "No encontrado." });
  const { name, durationMin, price, active } = req.body || {};
  db.prepare(
    `UPDATE services SET
      name = COALESCE(?, name),
      duration_min = COALESCE(?, duration_min),
      price = COALESCE(?, price),
      active = COALESCE(?, active)
     WHERE id = ?`
  ).run(
    name != null ? String(name).trim() : null,
    durationMin != null ? Number(durationMin) : null,
    price != null ? Number(price) : null,
    active != null ? (active ? 1 : 0) : null,
    req.params.id
  );
  res.json(db.prepare("SELECT * FROM services WHERE id = ?").get(req.params.id));
});

router.delete("/services/:id", (req, res) => {
  db.prepare("DELETE FROM services WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---- Horario -------------------------------------------------------

router.get("/hours", (req, res) => {
  res.json(db.prepare("SELECT * FROM hours ORDER BY day_of_week ASC").all());
});

router.put("/hours", (req, res) => {
  const days = req.body;
  if (!Array.isArray(days) || days.length !== 7) {
    return res.status(400).json({ error: "Se esperan los 7 dias de la semana." });
  }
  const stmt = db.prepare(
    `INSERT INTO hours (day_of_week, open_time, close_time, closed) VALUES (?, ?, ?, ?)
     ON CONFLICT(day_of_week) DO UPDATE SET open_time = excluded.open_time,
       close_time = excluded.close_time, closed = excluded.closed`
  );
  const tx = db.transaction((rows) => {
    for (const d of rows) {
      stmt.run(d.day_of_week, d.closed ? null : d.open_time, d.closed ? null : d.close_time, d.closed ? 1 : 0);
    }
  });
  tx(days);
  res.json(db.prepare("SELECT * FROM hours ORDER BY day_of_week ASC").all());
});

// ---- Ajustes -------------------------------------------------------

router.get("/settings", (req, res) => {
  res.json({
    shopName: getSetting("shop_name", "Mi Barberia"),
    barberName: getSetting("barber_name", "Barbero"),
    currency: getSetting("currency", "COP"),
    locale: getSetting("locale", "es-CO"),
    slotIntervalMin: Number(getSetting("slot_interval_min", "15")),
    minNoticeMin: Number(getSetting("min_notice_min", "30")),
  });
});

router.put("/settings", (req, res) => {
  const { shopName, barberName, currency, locale, slotIntervalMin, minNoticeMin } = req.body || {};
  if (shopName != null) setSetting("shop_name", String(shopName).trim());
  if (barberName != null) setSetting("barber_name", String(barberName).trim());
  if (currency != null) setSetting("currency", String(currency).trim());
  if (locale != null) setSetting("locale", String(locale).trim());
  if (slotIntervalMin != null) setSetting("slot_interval_min", Number(slotIntervalMin));
  if (minNoticeMin != null) setSetting("min_notice_min", Number(minNoticeMin));
  res.json({ ok: true });
});

router.post("/change-password", (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: "Datos invalidos. La nueva contrasena debe tener al menos 4 caracteres." });
  }
  const hash = getSetting("admin_password_hash", null);
  if (!hash || !bcrypt.compareSync(currentPassword, hash)) {
    return res.status(401).json({ error: "La contrasena actual no es correcta." });
  }
  setSetting("admin_password_hash", bcrypt.hashSync(newPassword, 10));
  res.json({ ok: true });
});

// ---- Resumen para el panel -------------------------------------------

router.get("/summary", (req, res) => {
  const today = req.query.date;
  if (!today) return res.status(400).json({ error: "Falta 'date'." });

  const todays = db
    .prepare("SELECT * FROM appointments WHERE date = ? AND status != 'cancelled' ORDER BY time ASC")
    .all(today);

  const revenue = todays
    .filter((a) => a.status !== "cancelled")
    .reduce((sum, a) => sum + a.price, 0);

  const next = todays.find((a) => a.status === "confirmed");

  res.json({
    date: today,
    count: todays.length,
    revenue,
    next: next || null,
  });
});

module.exports = router;
