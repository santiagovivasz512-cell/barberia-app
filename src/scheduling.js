// Punto unico donde se calculan los horarios realmente disponibles,
// combinando horario semanal, descanso/almuerzo, citas existentes y
// bloqueos manuales. Lo usan tanto la reserva publica como el panel
// (reprogramar), para que la regla de "no doble reserva" sea una sola.
const { db } = require("./db");
const { dayOfWeekFor, computeAvailableSlots, toMinutes } = require("./availability");

async function getBusyBlocksForDate(date) {
  const blocks = await db.prepare("SELECT * FROM time_blocks WHERE date = ?").all(date);
  if (blocks.some((b) => b.all_day)) return { allDay: true, busy: [] };
  const busy = blocks
    .filter((b) => b.start_time && b.end_time)
    .map((b) => ({ time: b.start_time, duration_min: toMinutes(b.end_time) - toMinutes(b.start_time) }));
  return { allDay: false, busy };
}

async function computeSlotsForDate({ date, durationMin, slotIntervalMin, minNoticeMin, excludeAppointmentId }) {
  const dow = dayOfWeekFor(date);
  const dayHours = await db.prepare("SELECT * FROM hours WHERE day_of_week = ?").get(dow);
  if (!dayHours || dayHours.closed) return [];

  const { allDay, busy: blockBusy } = await getBusyBlocksForDate(date);
  if (allDay) return [];

  let existingSql = "SELECT id, time, duration_min FROM appointments WHERE date = ? AND status != 'cancelled'";
  const params = [date];
  if (excludeAppointmentId) {
    existingSql += " AND id != ?";
    params.push(excludeAppointmentId);
  }
  const existing = await db.prepare(existingSql).all(...params);

  const breakBusy = [];
  if (dayHours.break_start && dayHours.break_end) {
    breakBusy.push({
      time: dayHours.break_start,
      duration_min: toMinutes(dayHours.break_end) - toMinutes(dayHours.break_start),
    });
  }

  return computeAvailableSlots({
    dateStr: date,
    durationMin,
    dayHours,
    existingAppointments: [...existing, ...blockBusy, ...breakBusy],
    slotIntervalMin,
    minNoticeMin,
  });
}

module.exports = { computeSlotsForDate, getBusyBlocksForDate };
