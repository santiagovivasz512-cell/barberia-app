const express = require("express");
const bcrypt = require("bcryptjs");
const { db, getSetting, setSetting } = require("../db");
const { requireAdmin } = require("../auth");
const { asyncHandler } = require("../asyncHandler");
const { computeSlotsForDate } = require("../scheduling");
const { toMinutes } = require("../availability");
const { classifyClient } = require("../clientClassification");

const APPOINTMENT_STATUSES = ["pending", "confirmed", "done", "cancelled", "no_show"];

const router = express.Router();
router.use(requireAdmin);

// ---- Citas -----------------------------------------------------------

router.get(
  "/appointments",
  asyncHandler(async (req, res) => {
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
    res.json(await db.prepare(sql).all(...params));
  })
);

router.patch(
  "/appointments/:id",
  asyncHandler(async (req, res) => {
    const { status } = req.body || {};
    if (!APPOINTMENT_STATUSES.includes(status)) {
      return res.status(400).json({ error: "Estado invalido." });
    }
    const row = await db.prepare("SELECT * FROM appointments WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "No encontrada." });
    await db
      .prepare("UPDATE appointments SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), req.params.id);
    res.json(await db.prepare("SELECT * FROM appointments WHERE id = ?").get(req.params.id));
  })
);

router.post(
  "/appointments/:id/reschedule",
  asyncHandler(async (req, res) => {
    const { date, time } = req.body || {};
    if (!date || !time || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
      return res.status(400).json({ error: "Fecha u hora con formato invalido." });
    }
    const row = await db.prepare("SELECT * FROM appointments WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "No encontrada." });
    if (row.status === "cancelled") {
      return res.status(400).json({ error: "No se puede reprogramar una cita cancelada." });
    }

    const slots = await computeSlotsForDate({
      date,
      durationMin: row.duration_min,
      slotIntervalMin: Number(await getSetting("slot_interval_min", "15")),
      minNoticeMin: Number(await getSetting("min_notice_min", "30")),
      excludeAppointmentId: row.id,
    });
    if (!slots.includes(time)) {
      return res.status(409).json({ error: "Ese horario ya no esta disponible. Elige otro." });
    }

    await db
      .prepare(
        `INSERT INTO appointment_history (appointment_id, from_date, from_time, to_date, to_time, changed_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, row.date, row.time, date, time, new Date().toISOString());

    const nextStatus = row.status === "no_show" ? "confirmed" : row.status;
    await db
      .prepare("UPDATE appointments SET date = ?, time = ?, status = ? WHERE id = ?")
      .run(date, time, nextStatus, row.id);

    res.json(await db.prepare("SELECT * FROM appointments WHERE id = ?").get(row.id));
  })
);

router.get(
  "/appointments/:id/reschedule-options",
  asyncHandler(async (req, res) => {
    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Parametro 'date' invalido." });
    }
    const row = await db.prepare("SELECT * FROM appointments WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "No encontrada." });
    const slots = await computeSlotsForDate({
      date,
      durationMin: row.duration_min,
      slotIntervalMin: Number(await getSetting("slot_interval_min", "15")),
      minNoticeMin: Number(await getSetting("min_notice_min", "30")),
      excludeAppointmentId: row.id,
    });
    res.json({ date, slots });
  })
);

router.get(
  "/appointments/:id/history",
  asyncHandler(async (req, res) => {
    const rows = await db
      .prepare("SELECT * FROM appointment_history WHERE appointment_id = ? ORDER BY changed_at ASC")
      .all(req.params.id);
    res.json(rows);
  })
);

router.delete(
  "/appointments/:id",
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT * FROM appointments WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "No encontrada." });
    await db.prepare("DELETE FROM appointments WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  })
);

// ---- Servicios ---------------------------------------------------------

router.get(
  "/services",
  asyncHandler(async (req, res) => {
    res.json(await db.prepare("SELECT * FROM services ORDER BY sort_order ASC, id ASC").all());
  })
);

router.post(
  "/services",
  asyncHandler(async (req, res) => {
    const { name, durationMin, price } = req.body || {};
    if (!name || !String(name).trim() || !durationMin || price == null) {
      return res.status(400).json({ error: "Faltan datos del servicio." });
    }
    const maxRow = await db.prepare("SELECT COALESCE(MAX(sort_order), -1) as m FROM services").get();
    const info = await db
      .prepare(
        "INSERT INTO services (name, duration_min, price, active, sort_order) VALUES (?, ?, ?, 1, ?) RETURNING id"
      )
      .run(String(name).trim(), Number(durationMin), Number(price), maxRow.m + 1);
    res.status(201).json(await db.prepare("SELECT * FROM services WHERE id = ?").get(info.lastInsertRowid));
  })
);

router.patch(
  "/services/:id",
  asyncHandler(async (req, res) => {
    const row = await db.prepare("SELECT * FROM services WHERE id = ?").get(req.params.id);
    if (!row) return res.status(404).json({ error: "No encontrado." });
    const { name, durationMin, price, active } = req.body || {};
    await db
      .prepare(
        `UPDATE services SET
          name = COALESCE(?, name),
          duration_min = COALESCE(?, duration_min),
          price = COALESCE(?, price),
          active = COALESCE(?, active)
         WHERE id = ?`
      )
      .run(
        name != null ? String(name).trim() : null,
        durationMin != null ? Number(durationMin) : null,
        price != null ? Number(price) : null,
        active != null ? (active ? 1 : 0) : null,
        req.params.id
      );
    res.json(await db.prepare("SELECT * FROM services WHERE id = ?").get(req.params.id));
  })
);

router.delete(
  "/services/:id",
  asyncHandler(async (req, res) => {
    await db.prepare("DELETE FROM services WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  })
);

// ---- Horario -------------------------------------------------------

router.get(
  "/hours",
  asyncHandler(async (req, res) => {
    res.json(await db.prepare("SELECT * FROM hours ORDER BY day_of_week ASC").all());
  })
);

router.put(
  "/hours",
  asyncHandler(async (req, res) => {
    const days = req.body;
    if (!Array.isArray(days) || days.length !== 7) {
      return res.status(400).json({ error: "Se esperan los 7 dias de la semana." });
    }
    const stmt = db.prepare(
      `INSERT INTO hours (day_of_week, open_time, close_time, closed, break_start, break_end)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (day_of_week) DO UPDATE SET open_time = excluded.open_time,
         close_time = excluded.close_time, closed = excluded.closed,
         break_start = excluded.break_start, break_end = excluded.break_end`
    );
    for (const d of days) {
      const hasBreak = !d.closed && d.break_start && d.break_end;
      await stmt.run(
        d.day_of_week,
        d.closed ? null : d.open_time,
        d.closed ? null : d.close_time,
        d.closed ? 1 : 0,
        hasBreak ? d.break_start : null,
        hasBreak ? d.break_end : null
      );
    }
    res.json(await db.prepare("SELECT * FROM hours ORDER BY day_of_week ASC").all());
  })
);

// ---- Bloqueos manuales de horario --------------------------------------

router.get(
  "/time-blocks",
  asyncHandler(async (req, res) => {
    const { from, to } = req.query;
    let sql = "SELECT * FROM time_blocks WHERE 1=1";
    const params = [];
    if (from) {
      sql += " AND date >= ?";
      params.push(from);
    }
    if (to) {
      sql += " AND date <= ?";
      params.push(to);
    }
    sql += " ORDER BY date ASC, start_time ASC NULLS FIRST";
    res.json(await db.prepare(sql).all(...params));
  })
);

router.post(
  "/time-blocks",
  asyncHandler(async (req, res) => {
    const { date, startTime, endTime, allDay, reason } = req.body || {};
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Fecha invalida." });
    }
    if (!allDay && (!startTime || !endTime)) {
      return res.status(400).json({ error: "Indica hora de inicio y fin, o marca todo el dia." });
    }
    const info = await db
      .prepare(
        `INSERT INTO time_blocks (date, start_time, end_time, all_day, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .run(date, allDay ? null : startTime, allDay ? null : endTime, allDay ? 1 : 0, reason || null, new Date().toISOString());
    res.status(201).json(await db.prepare("SELECT * FROM time_blocks WHERE id = ?").get(info.lastInsertRowid));
  })
);

router.delete(
  "/time-blocks/:id",
  asyncHandler(async (req, res) => {
    await db.prepare("DELETE FROM time_blocks WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  })
);

// ---- Ajustes -------------------------------------------------------

router.get(
  "/settings",
  asyncHandler(async (req, res) => {
    res.json({
      shopName: await getSetting("shop_name", "Mi Barberia"),
      barberName: await getSetting("barber_name", "Barbero"),
      currency: await getSetting("currency", "COP"),
      locale: await getSetting("locale", "es-CO"),
      slotIntervalMin: Number(await getSetting("slot_interval_min", "15")),
      minNoticeMin: Number(await getSetting("min_notice_min", "30")),
      description: await getSetting("description", ""),
      phone: await getSetting("phone", ""),
      email: await getSetting("email", ""),
      address: await getSetting("address", ""),
      instagram: await getSetting("instagram", ""),
      logoUrl: await getSetting("logo_url", ""),
      colorPrimary: await getSetting("color_primary", "#d9a441"),
      colorSecondary: await getSetting("color_secondary", "#f2c14e"),
      cancellationPolicy: await getSetting("cancellation_policy", ""),
    });
  })
);

router.put(
  "/settings",
  asyncHandler(async (req, res) => {
    const {
      shopName, barberName, currency, locale, slotIntervalMin, minNoticeMin,
      description, phone, email, address, instagram,
      logoUrl, colorPrimary, colorSecondary, cancellationPolicy,
    } = req.body || {};
    if (shopName != null) await setSetting("shop_name", String(shopName).trim());
    if (barberName != null) await setSetting("barber_name", String(barberName).trim());
    if (currency != null) await setSetting("currency", String(currency).trim());
    if (locale != null) await setSetting("locale", String(locale).trim());
    if (slotIntervalMin != null) await setSetting("slot_interval_min", Number(slotIntervalMin));
    if (minNoticeMin != null) await setSetting("min_notice_min", Number(minNoticeMin));
    if (description != null) await setSetting("description", String(description).trim());
    if (phone != null) await setSetting("phone", String(phone).trim());
    if (email != null) await setSetting("email", String(email).trim());
    if (address != null) await setSetting("address", String(address).trim());
    if (instagram != null) await setSetting("instagram", String(instagram).trim().replace(/^@/, ""));
    if (logoUrl != null) await setSetting("logo_url", String(logoUrl).trim());
    if (colorPrimary != null) await setSetting("color_primary", String(colorPrimary).trim());
    if (colorSecondary != null) await setSetting("color_secondary", String(colorSecondary).trim());
    if (cancellationPolicy != null) await setSetting("cancellation_policy", String(cancellationPolicy).trim());
    res.json({ ok: true });
  })
);

router.post(
  "/change-password",
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword || String(newPassword).length < 4) {
      return res.status(400).json({ error: "Datos invalidos. La nueva contrasena debe tener al menos 4 caracteres." });
    }
    const hash = await getSetting("admin_password_hash", null);
    if (!hash || !bcrypt.compareSync(currentPassword, hash)) {
      return res.status(401).json({ error: "La contrasena actual no es correcta." });
    }
    await setSetting("admin_password_hash", bcrypt.hashSync(newPassword, 10));
    res.json({ ok: true });
  })
);

// ---- Resumen para el panel -------------------------------------------

router.get(
  "/summary",
  asyncHandler(async (req, res) => {
    const today = req.query.date;
    if (!today) return res.status(400).json({ error: "Falta 'date'." });

    const todays = await db
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
  })
);

// ---- Estadisticas del dashboard ("Inicio") ----------------------------

function isoDateJS(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toCsvValue(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, columns) {
  const header = columns.map((c) => toCsvValue(c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => toCsvValue(r[c.key])).join(",")).join("\n");
  return `${header}\n${body}`;
}

router.get(
  "/dashboard-stats",
  asyncHandler(async (req, res) => {
    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Parametro 'date' invalido." });
    }
    const [y, m, d] = date.split("-").map(Number);
    const anchor = new Date(y, m - 1, d);

    const dow = anchor.getDay();
    const mondayOffset = dow === 0 ? -6 : 1 - dow;
    const monday = new Date(anchor);
    monday.setDate(anchor.getDate() + mondayOffset);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    const weekFrom = isoDateJS(monday);
    const weekTo = isoDateJS(sunday);

    const monthStart = `${y}-${String(m).padStart(2, "0")}-01`;

    const weekAppointments = await db
      .prepare("SELECT * FROM appointments WHERE date >= ? AND date <= ?")
      .all(weekFrom, weekTo);
    const monthAppointments = await db
      .prepare("SELECT * FROM appointments WHERE date >= ? AND date <= ?")
      .all(monthStart, date);
    const allClients = await db.prepare("SELECT id, created_at FROM clients").all();

    const totalClients = allClients.length;
    const newClientsThisMonth = allClients.filter((c) => c.created_at >= monthStart).length;
    const completedThisMonth = monthAppointments.filter((a) => a.status === "done").length;
    const cancelledThisMonth = monthAppointments.filter((a) => a.status === "cancelled").length;
    const noShowThisMonth = monthAppointments.filter((a) => a.status === "no_show").length;

    const weekActive = weekAppointments.filter((a) => a.status !== "cancelled");
    const weekCount = weekActive.length;
    const bookedMinutes = weekActive.reduce((sum, a) => sum + a.duration_min, 0);

    const hours = await db.prepare("SELECT * FROM hours").all();
    let capacityMinutes = 0;
    for (const h of hours) {
      if (h.closed || !h.open_time || !h.close_time) continue;
      let mins = toMinutes(h.close_time) - toMinutes(h.open_time);
      if (h.break_start && h.break_end) mins -= toMinutes(h.break_end) - toMinutes(h.break_start);
      capacityMinutes += Math.max(mins, 0);
    }
    const occupancyPercent = capacityMinutes > 0 ? Math.round((bookedMinutes / capacityMinutes) * 100) : 0;

    const from30 = isoDateJS(new Date(anchor.getTime() - 29 * 86400000));
    const recentAppointments = await db
      .prepare("SELECT service_name FROM appointments WHERE date >= ? AND date <= ? AND status != 'cancelled'")
      .all(from30, date);
    const counts = {};
    recentAppointments.forEach((a) => {
      counts[a.service_name] = (counts[a.service_name] || 0) + 1;
    });
    let topService = null;
    for (const [name, count] of Object.entries(counts)) {
      if (!topService || count > topService.count) topService = { name, count };
    }

    res.json({
      weekCount,
      totalClients,
      newClientsThisMonth,
      completedThisMonth,
      cancelledThisMonth,
      noShowThisMonth,
      occupancyPercent,
      topService,
    });
  })
);

router.get(
  "/activity",
  asyncHandler(async (req, res) => {
    const booked = await db
      .prepare("SELECT client_name, service_name, created_at as at FROM appointments ORDER BY created_at DESC LIMIT 8")
      .all();
    const rescheduled = await db
      .prepare(
        `SELECT a.client_name, h.changed_at as at FROM appointment_history h
         JOIN appointments a ON a.id = h.appointment_id ORDER BY h.changed_at DESC LIMIT 8`
      )
      .all();
    const statusChanged = await db
      .prepare(
        `SELECT client_name, status, updated_at as at FROM appointments
         WHERE updated_at IS NOT NULL AND status IN ('done', 'cancelled', 'no_show')
         ORDER BY updated_at DESC LIMIT 8`
      )
      .all();

    const events = [
      ...booked.map((r) => ({ type: "booked", clientName: r.client_name, serviceName: r.service_name, at: r.at })),
      ...rescheduled.map((r) => ({ type: "rescheduled", clientName: r.client_name, at: r.at })),
      ...statusChanged.map((r) => ({ type: r.status, clientName: r.client_name, at: r.at })),
    ];
    events.sort((a, b) => new Date(b.at) - new Date(a.at));
    res.json(events.slice(0, 8));
  })
);

// ---- CRM de clientes ---------------------------------------------------

async function getClientsWithStats() {
  const clients = await db.prepare("SELECT * FROM clients ORDER BY name ASC").all();
  const appts = await db
    .prepare("SELECT client_id, date, time, status, price FROM appointments WHERE client_id IS NOT NULL")
    .all();
  const today = isoDateJS(new Date());

  const byClient = {};
  appts.forEach((a) => {
    (byClient[a.client_id] = byClient[a.client_id] || []).push(a);
  });

  return clients.map((c) => {
    const list = byClient[c.id] || [];
    const active = list.filter((a) => a.status !== "cancelled");
    const completed = list.filter((a) => a.status === "done");
    const totalSpent = completed.reduce((sum, a) => sum + a.price, 0);
    const lastVisit = completed.length ? completed.map((a) => a.date).sort().slice(-1)[0] : null;
    const upcoming = active
      .filter((a) => a.date >= today && (a.status === "confirmed" || a.status === "pending"))
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0];

    const classification = classifyClient({
      totalCount: active.length,
      completedCount: completed.length,
      totalSpent,
      lastVisitDate: lastVisit,
      hasUpcoming: !!upcoming,
      today,
    });

    return {
      id: c.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      notes: c.notes,
      createdAt: c.created_at,
      appointmentCount: active.length,
      lastVisit,
      nextAppointment: upcoming ? `${upcoming.date} ${upcoming.time}` : null,
      totalSpent,
      classification,
    };
  });
}

router.get(
  "/clients",
  asyncHandler(async (req, res) => {
    const { search, filter } = req.query;
    let result = await getClientsWithStats();
    if (search) {
      const q = String(search).toLowerCase();
      result = result.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.phone.includes(q) ||
          (c.email || "").toLowerCase().includes(q)
      );
    }
    if (filter && filter !== "all") {
      result = result.filter((c) => c.classification === filter);
    }
    res.json(result);
  })
);

router.get(
  "/clients/export.csv",
  asyncHandler(async (req, res) => {
    const clients = await getClientsWithStats();
    const csv = toCsv(clients, [
      { key: "name", label: "Nombre" },
      { key: "phone", label: "Telefono" },
      { key: "email", label: "Correo" },
      { key: "appointmentCount", label: "Citas" },
      { key: "lastVisit", label: "Ultima visita" },
      { key: "nextAppointment", label: "Proxima cita" },
      { key: "totalSpent", label: "Gastado" },
      { key: "classification", label: "Clasificacion" },
    ]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=clientes.csv");
    res.send(csv);
  })
);

router.get(
  "/appointments/export.csv",
  asyncHandler(async (req, res) => {
    const rows = await db.prepare("SELECT * FROM appointments ORDER BY date DESC, time DESC").all();
    const csv = toCsv(rows, [
      { key: "id", label: "ID" },
      { key: "date", label: "Fecha" },
      { key: "time", label: "Hora" },
      { key: "client_name", label: "Cliente" },
      { key: "client_phone", label: "Telefono" },
      { key: "service_name", label: "Servicio" },
      { key: "duration_min", label: "Duracion (min)" },
      { key: "price", label: "Precio" },
      { key: "status", label: "Estado" },
    ]);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=citas.csv");
    res.send(csv);
  })
);

router.get(
  "/clients/:id",
  asyncHandler(async (req, res) => {
    const client = await db.prepare("SELECT * FROM clients WHERE id = ?").get(req.params.id);
    if (!client) return res.status(404).json({ error: "No encontrado." });

    const appointments = await db
      .prepare("SELECT * FROM appointments WHERE client_id = ? ORDER BY date DESC, time DESC")
      .all(req.params.id);
    const completed = appointments.filter((a) => a.status === "done");
    const cancelled = appointments.filter((a) => a.status === "cancelled");
    const noShow = appointments.filter((a) => a.status === "no_show");
    const totalSpent = completed.reduce((sum, a) => sum + a.price, 0);
    const today = isoDateJS(new Date());
    const upcoming = appointments
      .filter((a) => a.date >= today && (a.status === "confirmed" || a.status === "pending"))
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0];
    const lastVisit = completed.length ? completed.map((a) => a.date).sort().slice(-1)[0] : null;

    res.json({
      ...client,
      appointments,
      stats: {
        totalAppointments: appointments.filter((a) => a.status !== "cancelled").length,
        completed: completed.length,
        cancelled: cancelled.length,
        noShow: noShow.length,
        totalSpent,
        lastVisit,
        nextAppointment: upcoming ? `${upcoming.date} ${upcoming.time}` : null,
      },
    });
  })
);

router.patch(
  "/clients/:id",
  asyncHandler(async (req, res) => {
    const { notes, email } = req.body || {};
    const client = await db.prepare("SELECT * FROM clients WHERE id = ?").get(req.params.id);
    if (!client) return res.status(404).json({ error: "No encontrado." });
    await db
      .prepare("UPDATE clients SET notes = COALESCE(?, notes), email = COALESCE(?, email) WHERE id = ?")
      .run(notes != null ? notes : null, email != null ? email : null, req.params.id);
    res.json(await db.prepare("SELECT * FROM clients WHERE id = ?").get(req.params.id));
  })
);

module.exports = router;
