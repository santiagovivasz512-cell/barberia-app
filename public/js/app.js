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

  // Colombia usa formato de 12 horas (a. m. / p. m.), no 24h.
  function to12h(hhmm) {
    if (!hhmm) return hhmm;
    const [h, m] = hhmm.split(":").map(Number);
    return new Date(2000, 0, 1, h, m).toLocaleTimeString("es-CO", { hour: "numeric", minute: "2-digit", hour12: true });
  }

  function niceDateTime(dateTimeStr) {
    if (!dateTimeStr) return dateTimeStr;
    const [date, time] = dateTimeStr.split(" ");
    return `${niceDate(date)} · ${to12h(time)}`;
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
        $("#app").classList.toggle("panel-mode", target === "panel");
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

  function slotMinutes(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  }

  function slotButtonsHtml(times) {
    return times.map((t) => `<button class="slot-btn" data-time="${t}">${to12h(t)}</button>`).join("");
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
      const morning = res.slots.filter((t) => slotMinutes(t) < 720);
      const afternoon = res.slots.filter((t) => slotMinutes(t) >= 720);
      let html = "";
      if (morning.length) {
        html += `
          <div class="slot-group">
            <h4 class="slot-group-title">Mañana</h4>
            <div class="slot-grid">${slotButtonsHtml(morning)}</div>
          </div>
        `;
      }
      if (afternoon.length) {
        html += `
          <div class="slot-group">
            <h4 class="slot-group-title">Tarde</h4>
            <div class="slot-grid">${slotButtonsHtml(afternoon)}</div>
          </div>
        `;
      }
      list.innerHTML = html;
      list.querySelectorAll(".slot-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          list.querySelectorAll(".slot-btn").forEach((b) => b.classList.remove("active"));
          btn.classList.add("active");
          booking.time = btn.dataset.time;
          $("#chosenTimeLine").textContent = `${niceDate(booking.date)} · ${to12h(booking.time)}`;
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
        <dt>Hora</dt><dd>${to12h(apt.time)}</dd>
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
          <div class="mb-info">${niceDate(apt.date)} · ${to12h(apt.time)} · <span class="status-tag status-${apt.status}">${statusLabel(apt.status)}</span></div>
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
    return {
      pending: "Pendiente",
      confirmed: "Confirmada",
      done: "Completada",
      cancelled: "Cancelada",
      no_show: "No asistio",
    }[s] || s;
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
      loadDashboard("inicio");
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

    $$(".panel-nav-btn:not(.logout)").forEach((btn) => {
      btn.addEventListener("click", () => {
        $$(".panel-nav-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        $$(".subview").forEach((v) => { v.hidden = v.dataset.subview !== btn.dataset.subtab; });
        const label = $("#panelNavCurrentLabel");
        if (label) label.textContent = btn.dataset.label || btn.textContent.trim();
        collapsePanelNav();
        loadDashboard(btn.dataset.subtab);
      });
    });

    initPanelNavToggle();
  }

  function initPanelNavToggle() {
    const toggle = $("#panelNavToggle");
    const nav = $("#panelNav");
    if (!toggle || !nav) return;
    toggle.addEventListener("click", () => {
      const isOpen = nav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(isOpen));
    });
  }

  function collapsePanelNav() {
    const nav = $("#panelNav");
    const toggle = $("#panelNavToggle");
    if (!nav) return;
    nav.classList.remove("open");
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  }

  async function loadDashboard(which) {
    try {
      await refreshStatRow();
      if (which === "inicio") await renderTodayView();
      if (which === "agenda") await renderCalendarView();
      if (which === "clientes") await renderClientesView();
      if (which === "servicios") await renderServicesAdmin();
      if (which === "horarios") await renderHoursAdmin();
      if (which === "estadisticas") await renderMovimientosView();
      if (which === "configuracion") await renderSettingsAdmin();
    } catch (e) {
      if (e.status === 401) {
        localStorage.removeItem("barberia_token");
        enterPanel();
      }
    }
  }

  function comingSoonPanel(icon, title, description) {
    return `
      <div class="coming-soon">
        <div class="coming-soon-icon">${icon}</div>
        <h3>${title}</h3>
        <p>${description}</p>
        <span class="coming-soon-tag">Proximamente</span>
      </div>
    `;
  }

  const CLASS_LABELS = { nuevo: "Nuevo", frecuente: "Frecuente", vip: "VIP", inactivo: "Inactivo", regular: "Regular" };
  const clientsState = { search: "", filter: "all" };

  async function downloadCsv(path, filename) {
    const token = localStorage.getItem("barberia_token");
    try {
      const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error("Error al exportar.");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert("No se pudo exportar el archivo.");
    }
  }

  function clientRow(c) {
    return `
      <div class="client-row" data-view-client="${c.id}">
        <div class="client-main">
          <strong>${escapeHtml(c.name)}</strong>
          <span class="client-badge badge-${c.classification}">${CLASS_LABELS[c.classification] || c.classification}</span>
          <div class="client-sub">${escapeHtml(c.phone)}${c.email ? " · " + escapeHtml(c.email) : ""}</div>
        </div>
        <div class="client-stat"><span class="label">Citas</span><span class="value">${c.appointmentCount}</span></div>
        <div class="client-stat"><span class="label">Ultima visita</span><span class="value">${c.lastVisit ? niceDate(c.lastVisit) : "—"}</span></div>
        <div class="client-stat"><span class="label">Proxima cita</span><span class="value">${c.nextAppointment ? niceDateTime(c.nextAppointment) : "—"}</span></div>
        <div class="client-stat"><span class="label">Gastado</span><span class="value">${money(c.totalSpent)}</span></div>
      </div>
    `;
  }

  async function renderClientesView() {
    const view = $('[data-subview="clientes"]');
    view.innerHTML = `
      <h3 class="panel-section-title">Clientes</h3>
      <div class="clients-toolbar">
        <input type="search" id="clientSearch" placeholder="Buscar por nombre, telefono o correo..." value="${escapeHtml(clientsState.search)}" />
        <div class="filter-chips" id="clientFilters">
          <button class="chip ${clientsState.filter === "all" ? "active" : ""}" data-filter="all">Todos</button>
          <button class="chip ${clientsState.filter === "nuevo" ? "active" : ""}" data-filter="nuevo">Nuevos</button>
          <button class="chip ${clientsState.filter === "frecuente" ? "active" : ""}" data-filter="frecuente">Frecuentes</button>
          <button class="chip ${clientsState.filter === "vip" ? "active" : ""}" data-filter="vip">VIP</button>
          <button class="chip ${clientsState.filter === "inactivo" ? "active" : ""}" data-filter="inactivo">Inactivos</button>
        </div>
        <button class="btn-secondary" id="exportClientsBtn">Exportar CSV</button>
      </div>
      <div id="clientsList" class="clients-list"></div>
    `;

    $("#clientSearch").addEventListener("input", debounce((e) => {
      clientsState.search = e.target.value;
      loadClientsList();
    }, 350));

    $$("#clientFilters .chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        clientsState.filter = chip.dataset.filter;
        $$("#clientFilters .chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        loadClientsList();
      });
    });

    $("#exportClientsBtn").addEventListener("click", () => downloadCsv("/api/admin/clients/export.csv", "clientes.csv"));

    await loadClientsList();
  }

  async function loadClientsList() {
    const params = new URLSearchParams();
    if (clientsState.search) params.set("search", clientsState.search);
    if (clientsState.filter !== "all") params.set("filter", clientsState.filter);
    const clients = await api(`/api/admin/clients?${params.toString()}`);
    const list = $("#clientsList");
    if (!list) return;
    list.innerHTML = clients.length
      ? clients.map(clientRow).join("")
      : `<p class="empty-note-block">No hay clientes que coincidan con la busqueda.</p>`;
    list.querySelectorAll("[data-view-client]").forEach((row) => {
      row.addEventListener("click", () => renderClientProfile(row.dataset.viewClient));
    });
  }

  function clientHistoryRow(a) {
    return `
      <div class="apt-row status-${a.status}">
        <div class="stripe"></div>
        <div class="apt-time">${niceDate(a.date)}</div>
        <div class="apt-main">
          <div class="apt-client">${escapeHtml(a.service_name)} <span class="status-tag status-${a.status}">${statusLabel(a.status)}</span></div>
          <div class="apt-detail">${to12h(a.time)} · ${a.duration_min} min · ${money(a.price)}</div>
        </div>
      </div>
    `;
  }

  async function renderClientProfile(id) {
    const view = $('[data-subview="clientes"]');
    view.innerHTML = `<p class="empty-note-block">Cargando ficha del cliente...</p>`;
    const c = await api(`/api/admin/clients/${id}`);
    const s = c.stats;
    view.innerHTML = `
      <button class="link-back" id="backToClients">&larr; Volver a clientes</button>
      <h3 class="panel-section-title" style="margin-top:10px;">${escapeHtml(c.name)}</h3>
      <p class="hint-text" style="margin-top:-6px;">${escapeHtml(c.phone)}${c.email ? " · " + escapeHtml(c.email) : ""} · Cliente desde ${niceDate(c.created_at.slice(0, 10))}</p>

      <div class="stat-row client-profile-stats">
        <div class="stat-tile"><div class="label">Total citas</div><div class="value">${s.totalAppointments}</div></div>
        <div class="stat-tile"><div class="label">Completadas</div><div class="value">${s.completed}</div></div>
        <div class="stat-tile"><div class="label">Canceladas</div><div class="value">${s.cancelled}</div></div>
        <div class="stat-tile"><div class="label">No asistio</div><div class="value">${s.noShow}</div></div>
        <div class="stat-tile"><div class="label">Gastado</div><div class="value">${money(s.totalSpent)}</div></div>
        <div class="stat-tile"><div class="label">Ultima visita</div><div class="value value-sm">${s.lastVisit ? niceDate(s.lastVisit) : "—"}</div></div>
        <div class="stat-tile"><div class="label">Proxima cita</div><div class="value value-sm">${s.nextAppointment ? niceDateTime(s.nextAppointment) : "—"}</div></div>
      </div>

      <h3 class="panel-section-title">Historial de citas</h3>
      <div>
        ${c.appointments.length ? c.appointments.map(clientHistoryRow).join("") : `<p class="empty-note-block">Sin citas registradas.</p>`}
      </div>

      <h3 class="panel-section-title">Notas internas</h3>
      <p class="hint-text">Solo visibles para el negocio, el cliente nunca las ve.</p>
      <form class="settings-form" id="clientNotesForm">
        <textarea id="clientNotesInput" rows="4" placeholder="Ej: Prefiere degradado bajo. No usar maquina #0.">${escapeHtml(c.notes || "")}</textarea>
        <button type="submit" class="btn-primary">Guardar notas</button>
        <p class="save-note" id="notesSaveNote" hidden>Notas guardadas.</p>
      </form>
    `;

    $("#backToClients").addEventListener("click", renderClientesView);
    $("#clientNotesForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      await api(`/api/admin/clients/${id}`, { method: "PATCH", body: JSON.stringify({ notes: $("#clientNotesInput").value }) });
      const note = $("#notesSaveNote");
      note.hidden = false;
      setTimeout(() => { note.hidden = true; }, 2500);
    });
  }

  async function refreshStatRow() {
    const today = isoDate(new Date());
    const summary = await api(`/api/admin/summary?date=${today}`);
    $("#statRow").innerHTML = `
      <div class="stat-tile"><div class="label">Citas hoy</div><div class="value">${summary.count}</div></div>
      <div class="stat-tile"><div class="label">Ingresos estimados hoy</div><div class="value">${money(summary.revenue)}</div></div>
      <div class="stat-tile"><div class="label">Proxima cita</div><div class="value">${summary.next ? to12h(summary.next.time) : "—"}</div></div>
    `;
  }

  function appointmentActions(apt) {
    const actions = [];
    if (apt.status === "pending") actions.push({ status: "confirmed", cls: "confirm", label: "Confirmar" });
    if (apt.status === "pending" || apt.status === "confirmed") {
      actions.push({ status: "done", cls: "done", label: "Completada" });
      actions.push({ status: "no_show", cls: "no_show", label: "No asistio" });
      actions.push({ status: "cancelled", cls: "cancel", label: "Cancelar" });
    }
    return actions;
  }

  function appointmentRow(apt) {
    const actions = appointmentActions(apt);
    const canReschedule = apt.status === "pending" || apt.status === "confirmed" || apt.status === "no_show";
    return `
      <div class="apt-row status-${apt.status}">
        <div class="stripe"></div>
        <div class="apt-time">${to12h(apt.time)}</div>
        <div class="apt-main">
          <div class="apt-client">${escapeHtml(apt.client_name)} <span class="status-tag status-${apt.status}">${statusLabel(apt.status)}</span></div>
          <div class="apt-detail">${escapeHtml(apt.service_name)} · ${apt.duration_min} min · ${money(apt.price)} · ${escapeHtml(apt.client_phone)}</div>
        </div>
        <div class="apt-actions">
          ${actions.map((a) => `<button class="pill-btn ${a.cls}" data-status="${a.status}" data-id="${apt.id}">${a.label}</button>`).join("")}
          ${canReschedule ? `<button class="pill-btn reschedule" data-reschedule-toggle="${apt.id}">Reprogramar</button>` : ""}
        </div>
        ${canReschedule ? `<div class="reschedule-box" data-reschedule-box="${apt.id}" data-apt-date="${apt.date}" data-apt-time="${apt.time}" hidden></div>` : ""}
      </div>
    `;
  }

  function rescheduleFormHtml(apt) {
    return `
      <div class="reschedule-form">
        <label>Nueva fecha <input type="date" class="resched-date" value="${apt.date}" /></label>
        <label>Nueva hora
          <select class="resched-time"><option value="">Elige una fecha</option></select>
        </label>
        <button type="button" class="btn-primary resched-save" disabled>Guardar cambio</button>
        <button type="button" class="btn-secondary resched-cancel">Cancelar</button>
        <p class="form-error resched-error" hidden></p>
      </div>
    `;
  }

  async function loadRescheduleOptions(box, id, date) {
    const select = box.querySelector(".resched-time");
    const saveBtn = box.querySelector(".resched-save");
    select.innerHTML = `<option value="">Cargando...</option>`;
    saveBtn.disabled = true;
    try {
      const res = await api(`/api/admin/appointments/${id}/reschedule-options?date=${date}`);
      if (!res.slots.length) {
        select.innerHTML = `<option value="">Sin horarios disponibles ese dia</option>`;
        return;
      }
      select.innerHTML = `<option value="">Elige una hora</option>` + res.slots.map((t) => `<option value="${t}">${to12h(t)}</option>`).join("");
      select.addEventListener("change", () => { saveBtn.disabled = !select.value; }, { once: true });
    } catch (e) {
      select.innerHTML = `<option value="">No se pudo cargar</option>`;
    }
  }

  function bindAppointmentRows(container, reload) {
    container.querySelectorAll("[data-status]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api(`/api/admin/appointments/${btn.dataset.id}`, { method: "PATCH", body: JSON.stringify({ status: btn.dataset.status }) });
        reload();
      });
    });

    container.querySelectorAll("[data-reschedule-toggle]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.rescheduleToggle;
        const box = container.querySelector(`[data-reschedule-box="${id}"]`);
        if (!box) return;
        const willOpen = box.hidden;
        container.querySelectorAll(".reschedule-box").forEach((b) => { b.hidden = true; b.innerHTML = ""; });
        if (!willOpen) return;
        box.hidden = false;
        box.innerHTML = rescheduleFormHtml({ date: box.dataset.aptDate, time: box.dataset.aptTime });
        loadRescheduleOptions(box, id, box.dataset.aptDate);

        box.querySelector(".resched-date").addEventListener("change", (e) => {
          loadRescheduleOptions(box, id, e.target.value);
        });
        box.querySelector(".resched-cancel").addEventListener("click", () => {
          box.hidden = true;
          box.innerHTML = "";
        });
        box.querySelector(".resched-save").addEventListener("click", async () => {
          const date = box.querySelector(".resched-date").value;
          const time = box.querySelector(".resched-time").value;
          const errBox = box.querySelector(".resched-error");
          errBox.hidden = true;
          try {
            await api(`/api/admin/appointments/${id}/reschedule`, { method: "POST", body: JSON.stringify({ date, time }) });
            reload();
          } catch (e) {
            errBox.textContent = e.message;
            errBox.hidden = false;
          }
        });
      });
    });
  }

  function timeAgo(iso) {
    const diffMs = Date.now() - new Date(iso).getTime();
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return "hace un momento";
    if (min < 60) return `hace ${min} min`;
    const h = Math.floor(min / 60);
    if (h < 24) return `hace ${h} h`;
    const d = Math.floor(h / 24);
    if (d === 1) return "ayer";
    return `hace ${d} dias`;
  }

  function activityLabel(item) {
    const name = escapeHtml(item.clientName);
    switch (item.type) {
      case "booked": return `${name} reservo ${escapeHtml(item.serviceName)}`;
      case "rescheduled": return `${name} reprogramo su cita`;
      case "done": return `${name} completo su cita`;
      case "cancelled": return `${name} cancelo su cita`;
      case "no_show": return `${name} no asistio a su cita`;
      default: return `${name} actualizo su cita`;
    }
  }

  function activityRow(item) {
    return `
      <div class="activity-row">
        <span class="activity-dot activity-${item.type}"></span>
        <span class="activity-text">${activityLabel(item)}</span>
        <span class="activity-time">${timeAgo(item.at)}</span>
      </div>
    `;
  }

  async function renderTodayView() {
    const today = isoDate(new Date());
    const rows = await api(`/api/admin/appointments?from=${today}&to=${today}`);
    const view = $('[data-subview="inicio"]');
    view.innerHTML = `
      <h3 class="panel-section-title">Citas de hoy</h3>
      <div id="todayApptList">
        ${rows.length ? rows.map(appointmentRow).join("") : `<p class="empty-day">No hay citas agendadas para hoy.</p>`}
      </div>
    `;
    bindAppointmentRows($("#todayApptList"), renderTodayView);
  }

  async function renderMovimientosView() {
    const today = isoDate(new Date());
    const [stats, activity] = await Promise.all([
      api(`/api/admin/dashboard-stats?date=${today}`),
      api(`/api/admin/activity?date=${today}`),
    ]);
    const view = $('[data-subview="estadisticas"]');
    view.innerHTML = `
      <h3 class="panel-section-title">Movimientos del negocio</h3>
      <div class="stat-row secondary-stats">
        <div class="stat-tile"><div class="label">Citas esta semana</div><div class="value">${stats.weekCount}</div></div>
        <div class="stat-tile"><div class="label">Clientes totales</div><div class="value">${stats.totalClients}</div></div>
        <div class="stat-tile"><div class="label">Clientes nuevos (mes)</div><div class="value">${stats.newClientsThisMonth}</div></div>
        <div class="stat-tile"><div class="label">Completadas (mes)</div><div class="value">${stats.completedThisMonth}</div></div>
        <div class="stat-tile"><div class="label">Canceladas (mes)</div><div class="value">${stats.cancelledThisMonth}</div></div>
        <div class="stat-tile"><div class="label">No asistio (mes)</div><div class="value">${stats.noShowThisMonth}</div></div>
        <div class="stat-tile"><div class="label">Ocupacion (semana)</div><div class="value">${stats.occupancyPercent}%</div></div>
        <div class="stat-tile"><div class="label">Servicio mas pedido</div><div class="value value-sm">${stats.topService ? escapeHtml(stats.topService.name) : "—"}</div></div>
      </div>

      <h3 class="panel-section-title">Actividad reciente</h3>
      <div class="activity-list">
        ${activity.length ? activity.map(activityRow).join("") : `<p class="empty-note-block">Sin actividad reciente todavia.</p>`}
      </div>
    `;
  }

  function toMinutesLocal(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  }
  function toHHMMLocal(mins) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
  function shortDateLabel(d) {
    return d.toLocaleDateString("es-CO", { day: "numeric", month: "short" });
  }
  function startOfWeek(d) {
    const date = new Date(d);
    const day = date.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    date.setDate(date.getDate() + diff);
    date.setHours(0, 0, 0, 0);
    return date;
  }

  const calendarState = { mode: "week", anchor: new Date() };

  async function renderCalendarView() {
    const view = $('[data-subview="agenda"]');
    view.innerHTML = `
      <div class="cal-toolbar">
        <div class="cal-nav">
          <button class="btn-secondary" id="calPrev">&larr;</button>
          <button class="btn-secondary" id="calToday">Hoy</button>
          <button class="btn-secondary" id="calNext">&rarr;</button>
        </div>
        <div class="cal-range-label" id="calRangeLabel"></div>
        <div class="cal-mode-toggle">
          <button class="cal-mode-btn ${calendarState.mode === "week" ? "active" : ""}" data-cal-mode="week">Semana</button>
          <button class="cal-mode-btn ${calendarState.mode === "day" ? "active" : ""}" data-cal-mode="day">Dia</button>
        </div>
        <button class="btn-secondary" id="exportApptsBtn">Exportar CSV</button>
      </div>
      <div class="cal-grid-scroll"><div id="calGridWrap"></div></div>
    `;
    $("#calPrev").addEventListener("click", () => shiftCalendar(-1));
    $("#calNext").addEventListener("click", () => shiftCalendar(1));
    $("#calToday").addEventListener("click", () => { calendarState.anchor = new Date(); renderCalendarBody(); });
    $("#exportApptsBtn").addEventListener("click", () => downloadCsv("/api/admin/appointments/export.csv", "citas.csv"));
    $$("[data-cal-mode]").forEach((btn) => {
      btn.addEventListener("click", () => {
        calendarState.mode = btn.dataset.calMode;
        renderCalendarView();
      });
    });
    await renderCalendarBody();
  }

  function shiftCalendar(dir) {
    const days = calendarState.mode === "week" ? 7 : 1;
    calendarState.anchor.setDate(calendarState.anchor.getDate() + dir * days);
    renderCalendarBody();
  }

  async function renderCalendarBody() {
    const isWeek = calendarState.mode === "week";
    const start = isWeek ? startOfWeek(calendarState.anchor) : new Date(calendarState.anchor);
    start.setHours(0, 0, 0, 0);
    const count = isWeek ? 7 : 1;
    const days = [];
    for (let i = 0; i < count; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      days.push(d);
    }
    const from = isoDate(days[0]);
    const to = isoDate(days[days.length - 1]);

    $("#calRangeLabel").textContent = isWeek
      ? `${shortDateLabel(days[0])} - ${shortDateLabel(days[6])}`
      : niceDate(from);

    const hoursCfg = await api("/api/admin/hours");
    const openDays = hoursCfg.filter((h) => !h.closed && h.open_time && h.close_time);
    let dayStartMin = 8 * 60;
    let dayEndMin = 20 * 60;
    if (openDays.length) {
      dayStartMin = Math.min(...openDays.map((h) => toMinutesLocal(h.open_time)));
      dayEndMin = Math.max(...openDays.map((h) => toMinutesLocal(h.close_time)));
    }
    const slotMin = 30;
    const rowCount = Math.max(1, Math.ceil((dayEndMin - dayStartMin) / slotMin));

    const appts = await api(`/api/admin/appointments?from=${from}&to=${to}`);
    const byDate = {};
    appts.forEach((a) => { (byDate[a.date] = byDate[a.date] || []).push(a); });

    let cells = `<div class="cal-corner" style="grid-column:1; grid-row:1"></div>`;
    for (let r = 0; r < rowCount; r++) {
      const mins = dayStartMin + r * slotMin;
      if (mins % 60 === 0) {
        cells += `<div class="cal-time-label" style="grid-column:1; grid-row:${r + 2}">${toHHMMLocal(mins)}</div>`;
      }
    }
    for (let r = 0; r < rowCount; r++) {
      for (let c = 0; c < count; c++) {
        cells += `<div class="cal-cell" style="grid-column:${c + 2}; grid-row:${r + 2}"></div>`;
      }
    }
    days.forEach((d, i) => {
      const iso = isoDate(d);
      const isToday = iso === isoDate(new Date());
      cells += `<div class="cal-day-header ${isToday ? "is-today" : ""}" style="grid-column:${i + 2}; grid-row:1">${weekdayShort(iso)} ${d.getDate()}</div>`;
      (byDate[iso] || []).forEach((a) => {
        const startMin = toMinutesLocal(a.time);
        const endMin = startMin + a.duration_min;
        const r1 = Math.max(2, Math.round((startMin - dayStartMin) / slotMin) + 2);
        const r2 = Math.max(r1 + 1, Math.round((endMin - dayStartMin) / slotMin) + 2);
        cells += `
          <div class="cal-appt status-${a.status}" style="grid-column:${i + 2}; grid-row:${r1} / ${r2}" title="${escapeHtml(a.client_name)} - ${escapeHtml(a.service_name)} (${statusLabel(a.status)})">
            <span class="cal-appt-time">${a.time}</span> <span class="cal-appt-name">${escapeHtml(a.client_name)}</span>
          </div>
        `;
      });
    });

    $("#calGridWrap").innerHTML = `
      <div class="cal-grid" style="grid-template-columns: 56px repeat(${count}, minmax(90px, 1fr)); grid-template-rows: 32px repeat(${rowCount}, 26px);">
        ${cells}
      </div>
    `;
  }

  async function renderServicesAdmin() {
    const services = await api("/api/admin/services");
    const view = $('[data-subview="servicios"]');
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
    const view = $('[data-subview="horarios"]');
    view.innerHTML = `
      <h3 class="panel-section-title">Horario semanal</h3>
      <div class="hours-grid">
        ${hours.map((h) => {
          const hasBreak = !!(h.break_start && h.break_end);
          return `
          <div class="hours-row" data-day="${h.day_of_week}">
            <strong>${DOW_NAMES[h.day_of_week]}</strong>
            <label class="closed-toggle"><input type="checkbox" data-field="closed" ${h.closed ? "checked" : ""} /> Cerrado</label>
            <input type="time" data-field="open_time" value="${h.open_time || "09:00"}" ${h.closed ? "disabled" : ""} />
            <input type="time" data-field="close_time" value="${h.close_time || "19:00"}" ${h.closed ? "disabled" : ""} />
            <label class="closed-toggle"><input type="checkbox" data-field="has_break" ${hasBreak ? "checked" : ""} ${h.closed ? "disabled" : ""} /> Descanso</label>
            <input type="time" data-field="break_start" value="${h.break_start || "13:00"}" ${!hasBreak || h.closed ? "disabled" : ""} />
            <input type="time" data-field="break_end" value="${h.break_end || "14:00"}" ${!hasBreak || h.closed ? "disabled" : ""} />
          </div>
        `;
        }).join("")}
      </div>
      <button class="btn-primary" id="saveHoursBtn">Guardar horario</button>
      <p class="save-note" id="hoursSaveNote" hidden>Horario guardado.</p>

      <h3 class="panel-section-title">Bloqueos manuales</h3>
      <p class="hint-text">Bloquea espacios puntuales (almuerzo, cita personal, dia no disponible). Los clientes no podran reservar sobre estos horarios.</p>
      <div id="timeBlocksList" class="time-blocks-list"></div>
      <form class="service-form" id="newBlockForm">
        <label>Fecha <input type="date" name="date" required /></label>
        <label class="closed-toggle" style="align-self:center;"><input type="checkbox" name="allDay" id="blockAllDay" /> Todo el dia</label>
        <label>Desde <input type="time" name="startTime" value="13:00" /></label>
        <label>Hasta <input type="time" name="endTime" value="14:00" /></label>
        <label>Motivo (opcional) <input type="text" name="reason" placeholder="Ej: Cita personal" /></label>
        <button type="submit" class="btn-primary">Agregar bloqueo</button>
      </form>
    `;

    view.querySelectorAll(".hours-row").forEach((row) => {
      row.querySelector('[data-field="closed"]').addEventListener("change", (e) => {
        row.querySelector('[data-field="open_time"]').disabled = e.target.checked;
        row.querySelector('[data-field="close_time"]').disabled = e.target.checked;
        row.querySelector('[data-field="has_break"]').disabled = e.target.checked;
        row.querySelector('[data-field="break_start"]').disabled = e.target.checked || !row.querySelector('[data-field="has_break"]').checked;
        row.querySelector('[data-field="break_end"]').disabled = e.target.checked || !row.querySelector('[data-field="has_break"]').checked;
      });
      row.querySelector('[data-field="has_break"]').addEventListener("change", (e) => {
        row.querySelector('[data-field="break_start"]').disabled = !e.target.checked;
        row.querySelector('[data-field="break_end"]').disabled = !e.target.checked;
      });
    });

    $("#saveHoursBtn").addEventListener("click", async () => {
      const days = view.querySelectorAll(".hours-row");
      const payload = Array.from(days).map((row) => ({
        day_of_week: Number(row.dataset.day),
        closed: row.querySelector('[data-field="closed"]').checked,
        open_time: row.querySelector('[data-field="open_time"]').value,
        close_time: row.querySelector('[data-field="close_time"]').value,
        break_start: row.querySelector('[data-field="has_break"]').checked ? row.querySelector('[data-field="break_start"]').value : null,
        break_end: row.querySelector('[data-field="has_break"]').checked ? row.querySelector('[data-field="break_end"]').value : null,
      }));
      await api("/api/admin/hours", { method: "PUT", body: JSON.stringify(payload) });
      const note = $("#hoursSaveNote");
      note.hidden = false;
      setTimeout(() => { note.hidden = true; }, 2500);
    });

    await renderTimeBlocksList();

    $("#blockAllDay").addEventListener("change", (e) => {
      const form = $("#newBlockForm");
      form.querySelector('[name="startTime"]').disabled = e.target.checked;
      form.querySelector('[name="endTime"]').disabled = e.target.checked;
    });

    $("#newBlockForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      await api("/api/admin/time-blocks", { method: "POST", body: JSON.stringify({
        date: fd.get("date"),
        allDay: fd.get("allDay") === "on",
        startTime: fd.get("startTime"),
        endTime: fd.get("endTime"),
        reason: fd.get("reason"),
      }) });
      e.target.reset();
      await renderTimeBlocksList();
    });
  }

  async function renderTimeBlocksList() {
    const today = isoDate(new Date());
    const blocks = await api(`/api/admin/time-blocks?from=${today}`);
    const box = $("#timeBlocksList");
    if (!box) return;
    box.innerHTML = blocks.length
      ? blocks.map((b) => `
        <div class="time-block-row">
          <div>
            <strong>${niceDate(b.date)}</strong>
            <span class="mb-info">${b.all_day ? "Todo el dia" : `${b.start_time} - ${b.end_time}`}${b.reason ? ` · ${escapeHtml(b.reason)}` : ""}</span>
          </div>
          <button class="pill-btn cancel" data-delete-block="${b.id}">Eliminar</button>
        </div>
      `).join("")
      : `<p class="empty-note-block">No hay bloqueos proximos.</p>`;

    box.querySelectorAll("[data-delete-block]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await api(`/api/admin/time-blocks/${btn.dataset.deleteBlock}`, { method: "DELETE" });
        renderTimeBlocksList();
      });
    });
  }

  async function renderSettingsAdmin() {
    const settings = await api("/api/admin/settings");
    const view = $('[data-subview="configuracion"]');
    view.innerHTML = `
      <form class="settings-form" id="shopSettingsForm">
        <h3>Datos del negocio</h3>
        <label>Nombre de la barberia <input type="text" name="shopName" value="${escapeHtml(settings.shopName)}" /></label>
        <label>Nombre del barbero <input type="text" name="barberName" value="${escapeHtml(settings.barberName)}" /></label>
        <label>Descripcion corta (aparece en la pagina de reservas) <textarea name="description" rows="2" placeholder="Ej: Barberia de barrio, cortes clasicos y degradados.">${escapeHtml(settings.description || "")}</textarea></label>
        <label>Telefono <input type="text" name="phone" value="${escapeHtml(settings.phone || "")}" placeholder="Ej: 3001234567" /></label>
        <label>Correo <input type="email" name="email" value="${escapeHtml(settings.email || "")}" placeholder="Ej: contacto@mibarberia.com" /></label>
        <label>Direccion <input type="text" name="address" value="${escapeHtml(settings.address || "")}" placeholder="Ej: Calle 10 #5-20, Bogota" /></label>
        <label>Instagram (usuario, sin @) <input type="text" name="instagram" value="${escapeHtml(settings.instagram || "")}" placeholder="Ej: mibarberia" /></label>
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
        description: fd.get("description"), phone: fd.get("phone"), email: fd.get("email"),
        address: fd.get("address"), instagram: fd.get("instagram"),
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

    const root = document.documentElement.style;
    if (SETTINGS.colorPrimary) root.setProperty("--accent", SETTINGS.colorPrimary);
    if (SETTINGS.colorSecondary) root.setProperty("--accent-strong", SETTINGS.colorSecondary);

    const logoSlot = $("#brandLogo");
    const poleIcon = $(".pole");
    if (logoSlot) {
      if (SETTINGS.logoUrl) {
        logoSlot.innerHTML = `<img src="${escapeHtml(SETTINGS.logoUrl)}" alt="${escapeHtml(SETTINGS.shopName)}" />`;
        logoSlot.hidden = false;
        if (poleIcon) poleIcon.hidden = true;
      } else {
        logoSlot.hidden = true;
        if (poleIcon) poleIcon.hidden = false;
      }
    }

    $("#sidebarShopName").textContent = SETTINGS.shopName;
    const descBox = $("#sidebarDescription");
    if (SETTINGS.description) {
      descBox.textContent = SETTINGS.description;
      descBox.hidden = false;
    } else {
      descBox.hidden = true;
    }

    const contactList = $("#sidebarContactList");
    const contactItems = [];
    if (SETTINGS.address) contactItems.push(`<li>📍 ${escapeHtml(SETTINGS.address)}</li>`);
    if (SETTINGS.phone) contactItems.push(`<li>📞 ${escapeHtml(SETTINGS.phone)}</li>`);
    if (SETTINGS.instagram) contactItems.push(`<li>📷 <a href="https://instagram.com/${encodeURIComponent(SETTINGS.instagram)}" target="_blank" rel="noopener">@${escapeHtml(SETTINGS.instagram)}</a></li>`);
    if (contactItems.length) {
      contactList.innerHTML = contactItems.join("");
      $("#sidebarContactSection").hidden = false;
    } else {
      $("#sidebarContactSection").hidden = true;
    }
  }

  async function renderBookingHoursSidebar() {
    const hoursBox = $("#sidebarHoursList");
    if (!hoursBox) return;
    try {
      const hours = await api("/api/hours");
      const todayDow = new Date().getDay();
      hoursBox.innerHTML = hours
        .slice()
        .sort((a, b) => a.day_of_week - b.day_of_week)
        .map((h) => `
          <li class="${h.day_of_week === todayDow ? "is-today" : ""}">
            <span class="dow">${DOW_NAMES[h.day_of_week]}</span>
            <span class="hrs">${h.closed ? "Cerrado" : `${to12h(h.open_time)} - ${to12h(h.close_time)}`}</span>
          </li>
        `)
        .join("");
    } catch (e) {
      hoursBox.innerHTML = "";
    }
  }

  async function init() {
    initTabs();
    initBackLinks();
    initBookingForm();
    initMyBookingsToggle();
    initLogin();
    await loadPublicSettings();
    await renderBookingHoursSidebar();
    await loadServices();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
