const express = require("express");
const crypto = require("crypto");
const { db, getSetting, setSetting } = require("../db");
const {
  dayOfWeekFor,
  computeAvailableSlots,
} = require("../availability");
const { sendBookingNotification } = require("../mailer");

const router = express.Router();

function publicSettings() {
  return {
    shopName: getSetting("shop_name", "Mi Barberia"),
    barberName: getSetting("barber_name", "Barbero"),
    currency: getSetting("currency", "COP"),
    locale: getSetting("locale", "es-CO"),
    slotIntervalMin: Number(getSetting("slot_interval_min", "15")),
  };
}

router.get("/settings", (req, res) => {
  res.json(publicSettings());
});

router.get("/services", (req, res) => {
  const rows = db
    .prepare(
      "SELECT id, name, duration_min, price FROM services WHERE active = 1 ORDER BY sort_order ASC, id ASC"
    )
    .all();
  res.json(rows);
});

router.get("/hours", (req, res) => {
  const rows = db
    .prepare(
      "SELECT day_of_week, open_time, close_time, closed FROM hours ORDER BY day_of_week ASC"
    )
    .all();
  res.json(rows);
});

router.get("/availability", (req, res) => {
  const { date, serviceId } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "Parametro 'date' invalido (usa YYYY-MM-DD)." });
  }
  const service = db
    .prepare("SELECT * FROM services WHERE id = ? AND active = 1")
    .get(serviceId);
  if (!service) {
    return res.status(404).json({ error: "Servicio no encontrado." });
  }

  const dow = dayOfWeekFor(date);
  const dayHours = db
    .prepare("SELECT * FROM hours WHERE day_of_week = ?")
    .get(dow);

  const existing = db
    .prepare(
      "SELECT time, duration_min FROM appointments WHERE date = ? AND status != 'cancelled'"
    )
    .all(date);

  const slots = computeAvailableSlots({
    dateStr: date,
    durationMin: service.duration_min,
    dayHours,
    existingAppointments: existing,
    slotIntervalMin: Number(getSetting("slot_interval_min", "15")),
    minNoticeMin: Number(getSetting("min_notice_min", "30")),
  });

  res.json({ date, serviceId: service.id, slots });
});

router.post("/appointments", (req, res) => {
  const { clientName, clientPhone, serviceId, date, time } = req.body || {};

  if (
    !clientName ||
    !String(clientName).trim() ||
    !clientPhone ||
    !String(clientPhone).trim() ||
    !serviceId ||
    !date ||
    !time
  ) {
    return res.status(400).json({ error: "Faltan datos para crear la reserva." });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return res.status(400).json({ error: "Fecha u hora con formato invalido." });
  }

  const service = db
    .prepare("SELECT * FROM services WHERE id = ? AND active = 1")
    .get(serviceId);
  if (!service) return res.status(404).json({ error: "Servicio no encontrado." });

  // Revalidar disponibilidad justo antes de guardar (evita choques de horario).
  const dow = dayOfWeekFor(date);
  const dayHours = db.prepare("SELECT * FROM hours WHERE day_of_week = ?").get(dow);
  const existing = db
    .prepare(
      "SELECT time, duration_min FROM appointments WHERE date = ? AND status != 'cancelled'"
    )
    .all(date);
  const slots = computeAvailableSlots({
    dateStr: date,
    durationMin: service.duration_min,
    dayHours,
    existingAppointments: existing,
    slotIntervalMin: Number(getSetting("slot_interval_min", "15")),
    minNoticeMin: Number(getSetting("min_notice_min", "30")),
  });
  if (!slots.includes(time)) {
    return res.status(409).json({
      error: "Ese horario ya no esta disponible. Por favor elige otro.",
    });
  }

  const insertAndBump = db.transaction(() => {
    const ticketNumber = Number(getSetting("next_ticket_number", "1"));
    const publicToken = crypto.randomUUID();
    const info = db
      .prepare(
        `INSERT INTO appointments
          (public_token, ticket_number, client_name, client_phone, service_id, service_name, duration_min, price, date, time, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?)`
      )
      .run(
        publicToken,
        ticketNumber,
        String(clientName).trim(),
        String(clientPhone).trim(),
        service.id,
        service.name,
        service.duration_min,
        service.price,
        date,
        time,
        new Date().toISOString()
      );
    setSetting("next_ticket_number", ticketNumber + 1);
    return { id: info.lastInsertRowid, ticketNumber };
  });

  const { id, ticketNumber } = insertAndBump();
  const appointment = db.prepare("SELECT * FROM appointments WHERE id = ?").get(id);
  res.status(201).json({ ...appointment, ticketNumber });
  sendBookingNotification(appointment);
});

// Estas dos rutas usan el "public_token" opaco (no el id numerico) para que
// nadie pueda adivinar o recorrer las reservas de otras personas.
router.get("/appointments/:token", (req, res) => {
  const row = db
    .prepare("SELECT * FROM appointments WHERE public_token = ?")
    .get(req.params.token);
  if (!row) return res.status(404).json({ error: "No encontrada." });
  res.json(row);
});

router.delete("/appointments/:token", (req, res) => {
  const row = db
    .prepare("SELECT * FROM appointments WHERE public_token = ?")
    .get(req.params.token);
  if (!row) return res.status(404).json({ error: "No encontrada." });
  if (row.status === "cancelled") return res.json(row);
  db.prepare("UPDATE appointments SET status = 'cancelled' WHERE public_token = ?").run(req.params.token);
  const updated = db
    .prepare("SELECT * FROM appointments WHERE public_token = ?")
    .get(req.params.token);
  res.json(updated);
});

module.exports = router;
