// Utilidades de tiempo y calculo de horarios disponibles.

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function toHHMM(mins) {
  const h = Math.floor(mins / 60)
    .toString()
    .padStart(2, "0");
  const m = (mins % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

function dayOfWeekFor(dateStr) {
  // dateStr: YYYY-MM-DD, interpretado en la zona horaria local del servidor.
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

function nowInMinutesAndDate() {
  // Se usa Intl con la zona horaria configurada (en vez de los getters locales
  // de Date) porque el reloj del sistema operativo del hosting no siempre
  // respeta la variable de entorno TZ (por ejemplo, en Render se quedaba en UTC).
  const timeZone = process.env.TZ || "America/Bogota";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    dateStr: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")),
  };
}

/**
 * Calcula los horarios de inicio disponibles para un servicio en una fecha dada.
 *
 * @param {object} opts
 * @param {string} opts.dateStr - "YYYY-MM-DD"
 * @param {number} opts.durationMin - duracion del servicio en minutos
 * @param {{open_time:string, close_time:string, closed:number}|undefined} opts.dayHours
 * @param {Array<{time:string, duration_min:number}>} opts.existingAppointments - citas activas ese dia
 * @param {number} opts.slotIntervalMin
 * @param {number} opts.minNoticeMin - minutos minimos de antelacion para reservar
 * @returns {string[]} horas disponibles en formato HH:MM
 */
function computeAvailableSlots({
  dateStr,
  durationMin,
  dayHours,
  existingAppointments,
  slotIntervalMin,
  minNoticeMin,
}) {
  if (!dayHours || dayHours.closed) return [];

  const openMin = toMinutes(dayHours.open_time);
  const closeMin = toMinutes(dayHours.close_time);
  if (openMin >= closeMin) return [];

  const busy = existingAppointments.map((a) => {
    const start = toMinutes(a.time);
    return { start, end: start + a.duration_min };
  });

  const { dateStr: todayStr, minutes: nowMinutes } = nowInMinutesAndDate();
  const isToday = dateStr === todayStr;
  const earliestAllowed = isToday ? nowMinutes + minNoticeMin : -Infinity;

  const slots = [];
  for (
    let start = openMin;
    start + durationMin <= closeMin;
    start += slotIntervalMin
  ) {
    if (start < earliestAllowed) continue;
    const end = start + durationMin;
    const overlaps = busy.some((b) => start < b.end && end > b.start);
    if (!overlaps) slots.push(toHHMM(start));
  }
  return slots;
}

module.exports = {
  toMinutes,
  toHHMM,
  dayOfWeekFor,
  nowInMinutesAndDate,
  computeAvailableSlots,
};
