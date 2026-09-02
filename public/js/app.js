(() => {
  "use strict";

  // ---------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  function isoDate(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  let SETTINGS = { shopName: "Mi Barberia", barberName: "Barbero", currency: "COP", locale: "es-CO", slotIntervalMin: 15 };

  function money(cents) {
    try {
      return new Intl.NumberFormat(SETTINGS.locale, { style: "currency", currency: SETTINGS.currency, maximumFractionDigits: 0 }).format(cents);
    } catch (e) {
      return `$${cents}`;
    }
  }

  function weekdayShort(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("es-CO", { weekday: "short" }).replace(".", "");
  }

  function dayNum(dateStr) { return Number(dateStr.split("-")[2]); }

  function niceDate(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long" });
  }

  async function api(path, opts = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    const token = localStorage.getItem("barberia_token");
    if (token && path.startsWith("/api/admin")) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    let data = null;
    try { data = await res.json(); } catch (e) { /* sin cuerpo */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------------------------------------------------------------
  // Tabs (Reservar / Panel)
  // ---------------------------------------------------------------
  function initBackLinks() {
    $$("[data-back]").forEach((btn) => {
      btn.addEventListener("click", () => goToStep(Number(btn.dataset.back)));
    });
  }

  function initTabs() {
    $$(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".tab-btn").forEach((b) => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
        btn.classList.add("active");
        btn.setAttribute("aria-selected", "true");
        const target = btn.dataset.tab;
        $("#view-booking").hidden = target !== "booking";
        $("#view-panel").hidden = target !== "panel";
        if (target === "panel") enterPanel();
      });
    });
  }

  // ---------------------------------------------------------------
  // Booking flow
  // ---------------------------------------------------------------
  const booking = { service: null, date: null, time: null };

  function goToStep(n) {
    $$(".step-panel").forEach((p) => { p.hidden = p.dataset.stepPanel !== String(n); });
    $$("#stepIndicator li").forEach((li) => {
      const step = Number(li.dataset.step);
      li.classList.toggle("active", step === n);
      li.classList.toggle("done", step < n);
    });
  }

  async function loadServices() {
    const services = await api("/api/services");
    const list = $("#serviceList");
    list.innerHTML = services.map((s) => `
      <button class="service-card" data-id="${s.id}" data-name="${escapeHtml(s.name)}" data-duration="${s.duration_min}" data-price="${s.price}">
        <span class="svc-name">${escapeHtml(s.name)}</span>
        <span class="svc-meta"><span>${s.duration_min} min</span><span class="svc-price">${money(s.price)}</span></span>
      </button>
    `).join("") || `<p class="empty-note">Aun no hay servicios configurados.</p>`;

    list.querySelectorAll(".service-card").forEach((card) => {
      card.addEventListener("click", () => {
        booking.service = {
          id: card.dataset.id, name: card.dataset.name,
          duration: Number(card.dataset.duration), price: Number(card.dataset.price),
        };
        $("#chosenServiceLine").textContent = `${booking.service.name} · ${booking.service.duration} min · ${money(booking.service.price)}`;
        buildDateStrip();
        goToStep(2);
      });
    });
  }

  function buildDateStrip() {
    const strip = $("#dateStrip");
    const today = new Date();
    let html = "";
    for (let i = 0; i < 21; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const iso = isoDate(d);
      html += `<button class="date-chip" data-date="${iso}">
        <span class="dow">${weekdayShort(iso)}</span>
        <span class="dnum">${dayNum(iso)}</span>
      </button>`;
    }
    strip.innerHTML = html;
    strip.querySelectorAll(".date-chip").forEach((chip) => {
      chip.addEventListener("click", async () => {
        strip.querySelectorAll(".date-chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        booking.date = chip.dataset.date;
        $("#chosenDateLine").textContent = niceDate(booking.date);
        await loadSlots();
        goToStep(3);
      });
    });
  }

  async function loadSlots() {
    const list = $("#slotList");
    list.innerHTML = `<p class="empty-note">Cargando horarios...</p>`;
    try {
      const res = await api(`/api/availability?date=${booking.date}&serviceId=${booking.service.id}`);
      if (!res.slots.length) {
        list.innerHTML = `<p class="empty-note">No hay horarios disponibles ese dia. Prueba con otra fecha.</p>`;
        return;
      }
      list.innerHTML = res.slots.map((t) => `<button class="slot-btn" data-time="${t}">${t}</button>`).join("");
      list.querySelectorAll(".slot-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          list.querySelectorAll(".slot-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          booking.time = btn.dataset.time;
          $("#chosenTimeLine").textContent = `${niceDate(booking.date)} · ${booking.time}`;
          goToStep(4);
        });
      });
    } catch (e) {
      list.innerHTML = `<p class="empty-note">No se pudo cargar la disponibilidad. Intenta de nuevo.</p>`;
    }
  }

  function saveMyBooking(appointment) {
    const mine = JSON.parse(localStorage.getItem("barberia_my_bookings") || "[]");
    mine.unshift({ token: appointment.public_token, ticketNumber: appointment.ticketNumber || appointment.ticket_number });
    localStorage.setItem("barberia_my_bookings", JSON.stringify(mine.slice(0, 20)));
  }

  function initBookingForm() {
    $("#bookingForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errBox = $("#bookingError");
      errBox.hidden = true;
      const fd = new FormData(e.target);
      const payload = {
        clientName: fd.get("clientName"),
        clientPhone: fd.get("clientPhone"),
        serviceId: booking.service.id,
        date: booking.date,
        time: booking.time,
      };
      try {
        const apt = await api("/api/appointments", { method: "POST", body: JSON.stringify(payload) });
        saveMyBooking(apt);
        renderConfirmation(apt);
        goToStep("confirm");
        e.target.reset();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
      }
    });

    $("#bookAnotherBtn").addEventListener("click", () => {
      booking.service = null; booking.date = null; booking.time = null;
      goToStep(1);
    });
  }

  function renderConfirmation(apt) {
    $("#confirmStub").innerHTML = `
      <span class="ticket-num">N.&deg; ${String(apt.ticketNumber || apt.ticket_number).padStart(4, "0")}</span>
      <dl>
        <dt>Servicio</dt><dd>${escapeHtml(apt.service_name)}</dd>
        <dt>Fecha</dt><dd>${niceDate(apt.date)}</dd>
        <dt>Hora</dt><dd>${apt.time}</dd>
        <dt>Nombre</dt><dd>${escapeHtml(apt.client_name)}</dd>
        <dt>Valor</dt><dd>${money(apt.price)}</dd>
      </dl>
    `;
    renderMyBookings();
  }

  async function renderMyBookings() {
    const mine = JSON.parse(localStorage.getItem("barberia_my_bookings") || "[]");
    const box = $("#myBookingsList");
    if (!mine.length) { box.innerHTML = `<p class="empty-note">Todavia no tienes reservas guardadas en este dispositivo.</p>`; return; }
    const rows = await Promise.all(mine.map(async (m) => {
      try {
        const apt = await api(`/api/appointments/${m.token}`);
        return { m, apt };
      } catch (e) { return { m, apt: null }; }
    }));
    box.innerHTML = rows.filter((r) => r.apt).map(({ apt }) => `
      <div class="my-booking-row" data-token="${apt.public_token}">
        <div>
          <strong>N.&deg; ${String(apt.ticket_number).padStart(4, "0")} &middot; ${escapeHtml(apt.service_name)}</strong>
          <div class="mb-info">${niceDate(apt.date)} · ${apt.time} · <span class="status-tag status-${apt.status}">${statusLabel(apt.status)}</span></div>
        </div>
        ${apt.status === "confirmed" ? `<button class="btn-cancel" data-cancel="${apt.public_token}">Cancelar</button>` : ""}
      </div>
    `).join("");

    box.querySelectorAll("[data-cancel]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!confirm("¿Cancelar esta reserva?")) return;
        await api(`/api/appointments/${btn.dataset.cancel}`, { method: "DELETE" });
        renderMyBookings();
      });
    });
  }

  function statusLabel(s) {
    return { confirmed: "Confirmada", done: "Atendida", cancelled: "Cancelada" }[s] || s;
  }

  function initMyBookingsToggle() {
    $("#toggleMyBookings").addEventListener("click", () => {
      const list = $("#myBookingsList");
      list.hidden = !list.hidden;
      if (!list.hidden) renderMyBookings();
    });
  }

  // ---------------------------------------------------------------
  // Panel (dashboard del barbero)
  // ---------------------------------------------------------------
  function isLoggedIn() { return !!localStorage.getItem("barberia_token"); }

  function enterPanel() {
    if (isLoggedIn()) {
      $("#loginBox").hidden = true;
      $("#dashboard").hidden = false;
      loadDashboard("today");
    } else {
      $("#loginBox").hidden = false;
      $("#dashboard").hidden = true;
    }
  }

  function initLogin() {
    $("#loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errBox = $("#loginError");
      errBox.hidden = true;
      const fd = new FormData(e.target);
      try {
        const res = await api("/api/login", { method: "POST", body: JSON.stringify({ password: fd.get("password") }) });
        localStorage.setItem("barberia_token", res.token);
        e.target.reset();
        enterPanel();
      } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
      }
    });

    $("#logoutBtn").addEventListener("click", () => {
      localStorage.removeItem("barberia_token");
      enterPanel();
    });

    $$(".subtab-btn:not(.logout)").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".subtab-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        $$(".subview").forEach((v) => { v.hidden = v.dataset.subview !== btn.dataset.subtab; });
        loadDashboard(btn.dataset.subtab);
      });
    });
  }

  async function loadDashboard(which) {
    try {
      await refreshStatRow();
      if (which === "today") await renderTodayView();
      if (which === "upcoming") await renderUpcomingView();
      if (which === "services") await renderServicesAdmin();
      if (which === "hours") await renderHoursAdmin();
      if (which === "settings") await renderSettingsAdmin();
    } catch (e) {
      if (e.status === 401) {
        localStorage.removeItem("barberia_token");
        enterPanel();
      }
    }
  }

  async function refreshStatRow() {
    const today = isoDate(new Date());
    const summary = await api(`/api/admin/summary?date=${today}`);
    $("#statRow").innerHTML = `
      <div class="stat-tile"><div class="label">Citas hoy</div><div class="value">${summary.count}</div></div>
      <div class="stat-tile"><div class="label">Ingresos estimados hoy</div><div class="value">${money(summary.revenue)}</div></div>
      <div class="stat-tile"><div class="label">Proxima cita</div><div class="value">${summary.next ? summary.next.time : "—"}</div></div>
    `;
  }

  function appointmentRow(apt) {
    return `
      <div class="apt-row status-${apt.status}">
        <div class="stripe"></div>
        <div class="apt-time">${apt.time}</div>
        <div class="apt-main">
          <div class="apt-client">${escapeHtml(apt.client_name)} <span class="status-tag status-${apt.status}">${statusLabel(apt.status)}</span></div>
          <div class="apt-detail">${escapeHtml(apt.service_name)} · ${apt.duration_min} min · ${money(apt.price)} · ${escapeHtml(apt.client_phone)}</div>
        </div>
        <div class="apt-actions">
          ${apt.status === "confirmed" ? `<button class="pill-btn done" data-status="done" data-id="${apt.id}">Completada</button>` : ""}
          ${apt.status !== "cancelled" ? `<button class="pill-btn cancel" data-status="cancelled" data-id="${apt.id}">Cancelar</button>` : ""}
        </div>
      </div>
    `;
  }

  function bindStatusButtons(container) {
    container.querySelectorAll("[data-status]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api(`/api/admin/appointments/${btn.dataset.id}`, { method: "PATCH", body: JSON.stringify({ status: btn.dataset.status }) });
        const active = $(".subtab-btn.active").dataset.subtab;
        loadDashboard(active);
      });
    });
  }

  async function renderTodayView() {
    const today = isoDate(new Date());
    const rows = await api(`/api/admin/appointments?from=${today}&to=${today}`);
    const view = $('[data-subview="today"]');
    view.innerHTML = rows.length
      ? rows.map(appointmentRow).join("")
      : `<p class="empty-day">No hay citas agendadas para hoy.</p>`;
    bindStatusButtons(view);
  }

  async function renderUpcomingView() {
    const today = new Date();
    const to = new Date(today); to.setDate(to.getDate() + 13);
    const rows = await api(`/api/admin/appointments?from=${isoDate(today)}&to=${isoDate(to)}&status=confirmed`);
    const view = $('[data-subview="upcoming"]');
    if (!rows.length) { view.innerHTML = `<p class="empty-day">No hay citas confirmadas en los proximos 14 dias.</p>`; return; }
    const byDate = {};
    rows.forEach((r) => { (byDate[r.date] = byDate[r.date] || []).push(r); });
    view.innerHTML = Object.keys(byDate).sort().map((date) => `
      <div class="day-group">
        <h3>${niceDate(date)}</h3>
        ${byDate[date].map(appointmentRow).join("")}
      </div>
    `).join("");
    bindStatusButtons(view);
  }

  async function renderServicesAdmin() {
    const services = await api("/api/admin/services");
    const view = $('[data-subview="services"]');
    view.innerHTML = `
      <div class="service-admin-list">
        ${services.map((s) => `
          <div class="service-admin-row" data-id="${s.id}">
            <input type="text" value="${escapeHtml(s.name)}" data-field="name" />
            <input type="number" class="svc-dur" value="${s.duration_min}" data-field="durationMin" min="5" step="5" />
            <input type="number" class="svc-price" value="${s.price}" data-field="price" min="0" step="1000" />
            <label class="hours-row-toggle" style="font-size:0.8rem;color:var(--muted);display:flex;align-items:center;gap:4px;">
              <input type="checkbox" data-field="active" ${s.active ? "checked" : ""} /> Activo
            </label>
            <button class="pill-btn cancel" data-delete="${s.id}">Eliminar</button>
          </div>
        `).join("")}
      </div>
      <form class="service-form" id="newServiceForm">
        <label>Nombre <input type="text" name="name" required placeholder="Ej: Corte + cejas" /></label>
        <label>Duracion (min) <input type="number" name="durationMin" required min="5" step="5" value="30" /></label>
        <label>Precio <input type="number" name="price" required min="0" step="1000" value="20000" /></label>
        <button type="submit" class="btn-primary">Agregar servicio</button>
      </form>
    `;

    view.querySelectorAll(".service-admin-row").forEach((row) => {
      const save = debounce(async () => {
        const id = row.dataset.id;
        const name = row.querySelector('[data-field="name"]').value;
        const durationMin = row.querySelector('[data-field="durationMin"]').value;
        const price = row.querySelector('[data-field="price"]').value;
        const active = row.querySelector('[data-field="active"]').checked;
        await api(`/api/admin/services/${id}`, { method: "PATCH", body: JSON.stringify({ name, durationMin, price, active }) });
      }, 500);
      row.querySelectorAll("input").forEach((inp) => inp.addEventListener("input", save));
      row.querySelector("[data-delete]").addEventListener("click", async () => {
        if (!confirm("¿Eliminar este servicio?")) return;
        await api(`/api/admin/services/${row.dataset.id}`, { method: "DELETE" });
        renderServicesAdmin();
      });
    });

    $("#newServiceForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      await api("/api/admin/services", { method: "POST", body: JSON.stringify({
        name: fd.get("name"), durationMin: fd.get("durationMin"), price: fd.get("price"),
      }) });
      renderServicesAdmin();
    });
  }

  const DOW_NAMES = ["Domingo", "Lunes", "Martes", "Miercoles", "Jueves", "Viernes", "Sabado"];

  async function renderHoursAdmin() {
    const hours = await api("/api/admin/hours");
    const view = $('[data-subview="hours"]');
    view.innerHTML = `
      <div class="hours-grid">
        ${hours.map((h) => `
          <div class="hours-row" data-day="${h.day_of_week}">
            <strong>${DOW_NAMES[h.day_of_week]}</strong>
            <label class="closed-toggle"><input type="checkbox" data-field="closed" ${h.closed ? "checked" : ""} /> Cerrado</label>
            <input type="time" data-field="open_time" value="${h.open_time || "09:00"}" ${h.closed ? "disabled" : ""} />
            <input type="time" data-field="close_time" value="${h.close_time || "19:00"}" ${h.closed ? "disabled" : ""} />
          </div>
        `).join("")}
      </div>
      <button class="btn-primary" id="saveHoursBtn">Guardar horario</button>
      <p class="save-note" id="hoursSaveNote" hidden>Horario guardado.</p>
    `;

    view.querySelectorAll(".hours-row").forEach((row) => {
      row.querySelector('[data-field="closed"]').addEventListener("change", (e) => {
        row.querySelector('[data-field="open_time"]').disabled = e.target.checked;
        row.querySelector('[data-field="close_time"]').disabled = e.target.checked;
      });
    });

    $("#saveHoursBtn").addEventListener("click", async () => {
      const days = view.querySelectorAll(".hours-row");
      const payload = Array.from(days).map((row) => ({
        day_of_week: Number(row.dataset.day),
        closed: row.querySelector('[data-field="closed"]').checked,
        open_time: row.querySelector('[data-field="open_time"]').value,
        close_time: row.querySelector('[data-field="close_time"]').value,
      }));
      await api("/api/admin/hours", { method: "PUT", body: JSON.stringify(payload) });
      const note = $("#hoursSaveNote");
      note.hidden = false;
      setTimeout(() => { note.hidden = true; }, 2500);
    });
  }

  async function renderSettingsAdmin() {
    const settings = await api("/api/admin/settings");
    const view = $('[data-subview="settings"]');
    view.innerHTML = `
      <form class="settings-form" id="shopSettingsForm">
        <h3>Datos del negocio</h3>
        <label>Nombre de la barberia <input type="text" name="shopName" value="${escapeHtml(settings.shopName)}" /></label>
        <label>Nombre del barbero <input type="text" name="barberName" value="${escapeHtml(settings.barberName)}" /></label>
        <label>Minutos de anticipacion minima para reservar <input type="number" name="minNoticeMin" value="${settings.minNoticeMin}" min="0" step="5" /></label>
        <label>Intervalo entre horarios disponibles (min) <input type="number" name="slotIntervalMin" value="${settings.slotIntervalMin}" min="5" step="5" /></label>
        <button type="submit" class="btn-primary">Guardar cambios</button>
        <p class="save-note" id="settingsSaveNote" hidden>Cambios guardados.</p>
      </form>

      <form class="settings-form" id="passwordForm">
        <h3>Cambiar contrasena del panel</h3>
        <label>Contrasena actual <input type="password" name="currentPassword" required /></label>
        <label>Nueva contrasena <input type="password" name="newPassword" required minlength="4" /></label>
        <button type="submit" class="btn-secondary">Actualizar contrasena</button>
        <p class="form-error" id="passwordError" hidden></p>
        <p class="save-note" id="passwordSaveNote" hidden>Contrasena actualizada.</p>
      </form>
    `;

    $("#shopSettingsForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      await api("/api/admin/settings", { method: "PUT", body: JSON.stringify({
        shopName: fd.get("shopName"), barberName: fd.get("barberName"),
        minNoticeMin: fd.get("minNoticeMin"), slotIntervalMin: fd.get("slotIntervalMin"),
      }) });
      await loadPublicSettings();
      const note = $("#settingsSaveNote");
      note.hidden = false;
      setTimeout(() => { note.hidden = true; }, 2500);
    });

    $("#passwordForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errBox = $("#passwordError");
      errBox.hidden = true;
      const fd = new FormData(e.target);
      try {
        await api("/api/admin/change-password", { method: "POST", body: JSON.stringify({
          currentPassword: fd.get("currentPassword"), newPassword: fd.get("newPassword"),
        }) });
        e.target.reset();
        const note = $("#passwordSaveNote");
        note.hidden = false;
        setTimeout(() => { note.hidden = true; }, 2500);
      } catch (err) {
        errBox.textContent = err.message;
        errBox.hidden = false;
      }
    });
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // ---------------------------------------------------------------
  // Arranque
  // ---------------------------------------------------------------
  async function loadPublicSettings() {
    SETTINGS = await api("/api/settings");
    $("#shopName").textContent = SETTINGS.shopName;
    $("#barberSub").textContent = SETTINGS.barberName;
    document.title = `${SETTINGS.shopName} · Agenda`;
  }

  async function init() {
    initTabs();
    initBackLinks();
    initBookingForm();
    initMyBookingsToggle();
    initLogin();
    await loadPublicSettings();
    await loadServices();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
