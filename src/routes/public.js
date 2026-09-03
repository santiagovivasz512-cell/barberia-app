const express = require("express");
const crypto = require("crypto");
const { db, getSetting, setSetting, upsertClient } = require("../db");
const { computeSlotsForDate } = require("../scheduling");
const { sendBookingNotification } = require("../mailer");
const { asyncHandler } = require("../asyncHandler");

const router = express.Router();

async function publicSettings() {
  return {
    shopName: await getSetting("shop_name", "Mi Barberia"),
    barberName: await getSetting("barber_name", "Barbero"),
    currency: await getSetting("currency", "COP"),
    locale: await getSetting("locale", "es-CO"),
    slotIntervalMin: Number(await getSetting("slot_interval_min", "15")),
    logoUrl: await getSetting("logo_url", ""),
    description: await getSetting("description", ""),
    phone: await getSetting("phone", ""),
    email: await getSetting("email", ""),
    address: await getSetting("address", ""),
    instagram: await getSetting("instagram", ""),
    facebook: await getSetting("facebook", ""),
    colorPrimary: await getSetting("color_primary", "#d9a441"),
    colorSecondary: await getSetting("color_secondary", "#f2c14e"),
    cancellationPolicy: await getSetting("cancellation_policy", ""),
  };
}

router.get(
  "/settings",
  asyncHandler(async (req, res) => {
    res.json(await publicSettings());
  })
);

router.get(
  "/services",
  asyncHandler(async (req, res) => {
    const rows = await db
      .prepare(
        "SELECT id, name, duration_min, price FROM services WHERE active = 1 ORDER BY sort_order ASC, id ASC"
      )
      .all();
    res.json(rows);
  })
);

router.get(
  "/hours",
  asyncHandler(async (req, res) => {
    const rows = await db
      .prepare(
        "SELECT day_of_week, open_time, close_time, closed FROM hours ORDER BY day_of_week ASC"
      )
      .all();
    res.json(rows);
  })
);

router.get(
  "/availability",
  asyncHandler(async (req, res) => {
    const { date, serviceId } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Parametro 'date' invalido (usa YYYY-MM-DD)." });
    }
    const service = await db
      .prepare("SELECT * FROM services WHERE id = ? AND active = 1")
      .get(serviceId);
    if (!service) {
      return res.status(404).json({ error: "Servicio no encontrado." });
    }

    const slots = await computeSlotsForDate({
      date,
      durationMin: service.duration_min,
      slotIntervalMin: Number(await getSetting("slot_interval_min", "15")),
      minNoticeMin: Number(await getSetting("min_notice_min", "30")),
    });

    res.json({ date, serviceId: service.id, slots });
  })
);

router.post(
  "/appointments",
  asyncHandler(async (req, res) => {
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

    const service = await db
      .prepare("SELECT * FROM services WHERE id = ? AND active = 1")
      .get(serviceId);
    if (!service) return res.status(404).json({ error: "Servicio no encontrado." });

    // Revalidar disponibilidad justo antes de guardar (evita choques de horario).
    const slots = await computeSlotsForDate({
      date,
      durationMin: service.duration_min,
      slotIntervalMin: Number(await getSetting("slot_interval_min", "15")),
      minNoticeMin: Number(await getSetting("min_notice_min", "30")),
    });
    if (!slots.includes(time)) {
      return res.status(409).json({
        error: "Ese horario ya no esta disponible. Por favor elige otro.",
      });
    }

    const ticketNumber = Number(await getSetting("next_ticket_number", "1"));
    const publicToken = crypto.randomUUID();
    const trimmedName = String(clientName).trim();
    const trimmedPhone = String(clientPhone).trim();
    const client = await upsertClient(trimmedName, trimmedPhone);
    const info = await db
      .prepare(
        `INSERT INTO appointments
          (public_token, ticket_number, client_name, client_phone, client_id, service_id, service_name, duration_min, price, date, time, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?) RETURNING id`
      )
      .run(
        publicToken,
        ticketNumber,
        trimmedName,
        trimmedPhone,
        client.id,
        service.id,
        service.name,
        service.duration_min,
        service.price,
        date,
        time,
        new Date().toISOString()
      );
    await setSetting("next_ticket_number", ticketNumber + 1);

    const appointment = await db.prepare("SELECT * FROM appointments WHERE id = ?").get(info.lastInsertRowid);
    res.status(201).json({ ...appointment, ticketNumber });
    sendBookingNotification(appointment);
  })
);

// Estas dos rutas usan el "public_token" opaco (no el id numerico) para que
// nadie pueda adivinar o recorrer las reservas de otras personas.
router.get(
  "/appointments/:token",
  asyncHandler(async (req, res) => {
    const row = await db
      .prepare("SELECT * FROM appointments WHERE public_token = ?")
      .get(req.params.token);
    if (!row) return res.status(404).json({ error: "No encontrada." });
    res.json(row);
  })
);

router.delete(
  "/appointments/:token",
  asyncHandler(async (req, res) => {
    const row = await db
      .prepare("SELECT * FROM appointments WHERE public_token = ?")
      .get(req.params.token);
    if (!row) return res.status(404).json({ error: "No encontrada." });
    if (row.status === "cancelled") return res.json(row);
    await db.prepare("UPDATE appointments SET status = 'cancelled' WHERE public_token = ?").run(req.params.token);
    const updated = await db
      .prepare("SELECT * FROM appointments WHERE public_token = ?")
      .get(req.params.token);
    res.json(updated);
  })
);

module.exports = router;
