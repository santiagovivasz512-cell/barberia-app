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

  const ticket = `#${String(appointment.ticket_number).padStart(4, "0")}`;
  const [y, m, d] = appointment.date.split("-").map(Number);
  const niceDate = new Date(y, m - 1, d).toLocaleDateString("es-CO", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const price = `$${Number(appointment.price).toLocaleString("es-CO")}`;

  const row = (emoji, label, value) => `
    <tr>
      <td style="padding: 10px 0; border-bottom: 1px solid #2b241d; font-size: 15px; color: #ab9c88; white-space: nowrap; vertical-align: top;">
        ${emoji}&nbsp; ${label}
      </td>
      <td style="padding: 10px 0 10px 16px; border-bottom: 1px solid #2b241d; font-size: 15px; color: #f1e9da; font-weight: 600; text-align: right;">
        ${value}
      </td>
    </tr>
  `;

  const html = `
  <div style="background: #17130f; padding: 32px 16px; font-family: 'Segoe UI', Helvetica, Arial, sans-serif;">
    <table role="presentation" width="100%" style="max-width: 480px; margin: 0 auto; background: #221c17; border-radius: 16px; overflow: hidden; border: 1px solid #3c332a;">
      <tr>
        <td style="background: linear-gradient(135deg, #7c551f, #d3a44f); padding: 28px 28px 22px; text-align: center;">
          <div style="font-size: 34px; line-height: 1;">💈✂️</div>
          <div style="margin-top: 8px; font-size: 13px; letter-spacing: 0.12em; text-transform: uppercase; color: #241a0c; font-weight: 700;">Nueva cita agendada</div>
          <div style="margin-top: 2px; font-size: 20px; color: #241a0c; font-weight: 800;">${shopName}</div>
        </td>
      </tr>
      <tr>
        <td style="padding: 26px 28px 8px;">
          <div style="text-align: center; margin-bottom: 18px;">
            <span style="display: inline-block; background: #2b241d; color: #e9c17c; font-family: 'Courier New', monospace; font-size: 13px; letter-spacing: 0.08em; padding: 6px 14px; border-radius: 999px; border: 1px solid #3c332a;">
              🎟️ TICKET ${ticket}
            </span>
          </div>
          <table role="presentation" width="100%" style="border-collapse: collapse;">
            ${row("👤", "Cliente", appointment.client_name)}
            ${row("📱", "Telefono", appointment.client_phone)}
            ${row("✂️", "Servicio", `${appointment.service_name} (${appointment.duration_min} min)`)}
            ${row("📅", "Fecha", niceDate)}
            ${row("🕐", "Hora", appointment.time)}
            ${row("💰", "Valor", price)}
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding: 6px 28px 26px; text-align: center;">
          <p style="margin: 14px 0 0; font-size: 12.5px; color: #6b6157;">Revisa el panel del barbero para ver el detalle o gestionar esta cita. 🙌</p>
        </td>
      </tr>
    </table>
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
        subject: `💈 Nueva cita: ${appointment.client_name} · ${niceDate} ${appointment.time}`,
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
