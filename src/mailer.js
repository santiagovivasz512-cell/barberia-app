const { getSetting } = require("./db");

async function sendBookingNotification(appointment) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (!apiKey || !to) {
    console.warn(
      "[mailer] RESEND_API_KEY o NOTIFY_EMAIL no configurados: no se envio notificacion de la reserva."
    );
    return;
  }

  const shopName = getSetting("shop_name", "Mi Barberia");
  const from = process.env.MAIL_FROM || "onboarding@resend.dev";

  const html = `
    <div style="font-family: sans-serif; max-width: 480px;">
      <h2>Nueva cita agendada</h2>
      <p><strong>Ticket:</strong> #${String(appointment.ticket_number).padStart(4, "0")}</p>
      <p><strong>Cliente:</strong> ${appointment.client_name}</p>
      <p><strong>Telefono:</strong> ${appointment.client_phone}</p>
      <p><strong>Servicio:</strong> ${appointment.service_name} (${appointment.duration_min} min)</p>
      <p><strong>Fecha:</strong> ${appointment.date}</p>
      <p><strong>Hora:</strong> ${appointment.time}</p>
      <p><strong>Valor:</strong> $${Number(appointment.price).toLocaleString("es-CO")}</p>
    </div>
  `;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${shopName} <${from}>`,
        to: [to],
        subject: `Nueva cita: ${appointment.client_name} - ${appointment.date} ${appointment.time}`,
        html,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error("[mailer] Resend respondio con error:", res.status, body);
    }
  } catch (err) {
    console.error("[mailer] Fallo al enviar la notificacion:", err.message);
  }
}

module.exports = { sendBookingNotification };
