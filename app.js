(function () {
  "use strict";

  const DATA_URL = "data/gantt-data.json";
  const ROW_HEIGHT = 42;
  const LABEL_WIDTH = 260;
  const ZOOM_PX_PER_DAY = { day: 36, week: 14, month: 5 };

  const STATUS_ALIASES = {
    "complete": "complete",
    "completed": "complete",
    "done": "complete",
    "closed": "complete",
    "in progress": "in-progress",
    "in-progress": "in-progress",
    "ongoing": "in-progress",
    "active": "in-progress",
    "on track": "in-progress",
    "green": "in-progress",
    "at risk": "at-risk",
    "at-risk": "at-risk",
    "risk": "at-risk",
    "caution": "at-risk",
    "on hold": "at-risk",
    "hold": "at-risk",
    "yellow": "at-risk",
    "amber": "at-risk",
    "delayed": "delayed",
    "late": "delayed",
    "behind": "delayed",
    "critical": "delayed",
    "red": "delayed",
    "not started": "not-started",
    "not-started": "not-started",
    "pending": "not-started",
    "cancelled": "not-started",
    "canceled": "not-started",
    "gray": "not-started",
    "grey": "not-started",
    "": "not-started"
  };

  const state = {
    tasks: [],
    zoom: "week",
    search: "",
    statusFilter: ""
  };

  const root = document.getElementById("gantt-root");
  let tooltipEl = null;

  function parseDate(value) {
    if (!value) return null;
    const s = String(value).trim();
    if (!s) return null;
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  }

  function formatDate(date) {
    if (!date) return "—";
    return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  }

  function daysBetween(a, b) {
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }

  function addDays(date, n) {
    return new Date(date.getTime() + n * 86400000);
  }

  function todayUTC() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  function statusSlug(rawStatus, task) {
    const key = String(rawStatus || "").trim().toLowerCase();
    if (STATUS_ALIASES[key]) return STATUS_ALIASES[key];
    return deriveStatus(task);
  }

  function deriveStatus(task) {
    const plannedEnd = parseDate(task.plannedEnd);
    const actualStart = parseDate(task.actualStart);
    const actualEnd = parseDate(task.actualEnd);
    const today = todayUTC();
    if (actualEnd) {
      return plannedEnd && actualEnd.getTime() > plannedEnd.getTime() ? "delayed" : "complete";
    }
    if (actualStart) {
      return plannedEnd && today.getTime() > plannedEnd.getTime() ? "at-risk" : "in-progress";
    }
    return "not-started";
  }

  function statusLabel(slug) {
    return {
      "complete": "Complete",
      "in-progress": "In Progress",
      "at-risk": "At Risk",
      "delayed": "Delayed",
      "not-started": "Not Started"
    }[slug] || "Unknown";
  }

  function displayStatusText(task, slug) {
    const raw = String(task.status || "").trim();
    return raw || statusLabel(slug);
  }

  async function loadData() {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load " + DATA_URL + " (" + res.status + ")");
    return res.json();
  }

  function computeRange(tasks) {
    let min = null, max = null;
    tasks.forEach((t) => {
      [t.plannedStart, t.plannedEnd, t.actualStart, t.actualEnd].forEach((v) => {
        const d = parseDate(v);
        if (!d) return;
        if (!min || d < min) min = d;
        if (!max || d > max) max = d;
      });
    });
    const today = todayUTC();
    if (!min || today < min) min = today;
    if (!max || today > max) max = today;
    return { start: addDays(min, -4), end: addDays(max, 5) };
  }

  function buildHeader(range, pxPerDay, totalWidth) {
    const header = document.createElement("div");
    header.className = "gantt-timeline-header";
    header.style.width = totalWidth + "px";
    header.style.height = "32px";

    const totalDays = daysBetween(range.start, range.end);

    if (state.zoom === "day") {
      for (let i = 0; i <= totalDays; i++) {
        const d = addDays(range.start, i);
        const x = i * pxPerDay;
        header.appendChild(gridline(x, "100%"));
        if (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
          header.appendChild(weekendShade(x, pxPerDay, "32px", true));
        }
        const label = document.createElement("div");
        label.className = "day-label";
        label.style.left = x + "px";
        label.style.width = pxPerDay + "px";
        label.textContent = d.getUTCDate();
        header.appendChild(label);
      }
    } else {
      // week / month zoom: label at week boundaries (Mondays) or month boundaries
      let cursor = new Date(range.start);
      // align to Monday
      const dow = cursor.getUTCDay();
      const offsetToMonday = (dow + 6) % 7;
      cursor = addDays(cursor, -offsetToMonday);

      let lastMonth = -1;
      while (cursor <= range.end) {
        const x = daysBetween(range.start, cursor) * pxPerDay;
        header.appendChild(gridline(x, "100%"));
        if (state.zoom === "week") {
          const label = document.createElement("div");
          label.className = "day-label";
          label.style.left = x + "px";
          label.textContent = cursor.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
          header.appendChild(label);
        } else if (cursor.getUTCMonth() !== lastMonth) {
          lastMonth = cursor.getUTCMonth();
          const label = document.createElement("div");
          label.className = "month-label";
          label.style.left = x + "px";
          label.textContent = cursor.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
          header.appendChild(label);
        }
        cursor = addDays(cursor, 7);
      }
    }

    return header;
  }

  function gridline(x, height) {
    const el = document.createElement("div");
    el.className = "gridline";
    el.style.left = x + "px";
    el.style.height = height;
    return el;
  }

  function weekendShade(x, pxPerDay, height, single) {
    const el = document.createElement("div");
    el.className = "weekend-shade";
    el.style.left = x + "px";
    el.style.width = pxPerDay + "px";
    el.style.height = height;
    return el;
  }

  function showTooltip(evt, task, status) {
    if (!tooltipEl) return;
    const plannedStart = parseDate(task.plannedStart);
    const plannedEnd = parseDate(task.plannedEnd);
    const actualStart = parseDate(task.actualStart);
    const actualEnd = parseDate(task.actualEnd);
    let variance = "—";
    if (plannedEnd && actualEnd) {
      const diff = daysBetween(plannedEnd, actualEnd);
      variance = diff === 0 ? "On time" : (diff > 0 ? "+" + diff + "d late" : diff + "d early");
    }
    tooltipEl.innerHTML =
      "<strong>" + escapeHtml(task.name) + "</strong>" +
      "<div class='tt-row'><span>Status</span><span>" + escapeHtml(displayStatusText(task, status)) + "</span></div>" +
      "<div class='tt-row'><span>Anticipated</span><span>" + formatDate(plannedStart) + " → " + formatDate(plannedEnd) + "</span></div>" +
      "<div class='tt-row'><span>Actual</span><span>" + formatDate(actualStart) + " → " + formatDate(actualEnd) + "</span></div>" +
      "<div class='tt-row'><span>Variance</span><span>" + variance + "</span></div>" +
      (task.percentComplete !== undefined && task.percentComplete !== null
        ? "<div class='tt-row'><span>% Complete</span><span>" + task.percentComplete + "%</span></div>" : "") +
      (task.assignedTo ? "<div class='tt-row'><span>Owner</span><span>" + escapeHtml(task.assignedTo) + "</span></div>" : "");
    tooltipEl.style.display = "block";
    positionTooltip(evt);
  }

  function positionTooltip(evt) {
    if (!tooltipEl) return;
    const pad = 14;
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;
    const rect = tooltipEl.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) x = evt.clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight) y = evt.clientY - rect.height - pad;
    tooltipEl.style.left = x + "px";
    tooltipEl.style.top = y + "px";
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = "none";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function matchesFilters(task) {
    const q = state.search.trim().toLowerCase();
    if (q) {
      const hay = (task.name + " " + (task.assignedTo || "")).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (state.statusFilter) {
      const slug = statusSlug(task.status, task);
      if (slug !== state.statusFilter) return false;
    }
    return true;
  }

  function render() {
    root.innerHTML = "";
    const tasks = state.tasks;
    if (!tasks.length) {
      root.innerHTML = "<p class='status-message'>No tasks found in the schedule data.</p>";
      return;
    }

    const pxPerDay = ZOOM_PX_PER_DAY[state.zoom];
    const range = computeRange(tasks);
    const totalDays = daysBetween(range.start, range.end);
    const totalWidth = totalDays * pxPerDay;

    const scroll = document.createElement("div");
    scroll.className = "gantt-scroll";
    scroll.style.setProperty("--label-width", LABEL_WIDTH + "px");

    const headerRow = document.createElement("div");
    headerRow.className = "gantt-header-row";
    const corner = document.createElement("div");
    corner.className = "gantt-corner";
    corner.textContent = "Task";
    headerRow.appendChild(corner);
    headerRow.appendChild(buildHeader(range, pxPerDay, totalWidth));
    scroll.appendChild(headerRow);

    const body = document.createElement("div");
    body.className = "gantt-body";

    const visibleTasks = tasks.filter(matchesFilters);

    visibleTasks.forEach((task) => {
      const row = document.createElement("div");
      row.className = "gantt-row";
      row.style.height = ROW_HEIGHT + "px";

      const label = document.createElement("div");
      label.className = "row-label";
      const status = statusSlug(task.status, task);
      const nameEl = document.createElement("div");
      nameEl.className = "task-name";
      nameEl.textContent = task.name;
      const metaEl = document.createElement("div");
      metaEl.className = "task-meta";
      const metaParts = [];
      if (task.assignedTo) metaParts.push(task.assignedTo);
      metaParts.push(displayStatusText(task, status));
      if (task.percentComplete !== undefined && task.percentComplete !== null) metaParts.push(task.percentComplete + "%");
      metaEl.textContent = metaParts.join(" • ");
      label.appendChild(nameEl);
      label.appendChild(metaEl);

      const timeline = document.createElement("div");
      timeline.className = "row-timeline";
      timeline.style.width = totalWidth + "px";
      timeline.style.height = ROW_HEIGHT + "px";

      const plannedStart = parseDate(task.plannedStart);
      const plannedEnd = parseDate(task.plannedEnd);
      const actualStart = parseDate(task.actualStart);
      const actualEnd = parseDate(task.actualEnd);

      if (plannedStart && plannedEnd) {
        const bar = document.createElement("div");
        bar.className = "bar bar-planned";
        bar.style.left = daysBetween(range.start, plannedStart) * pxPerDay + "px";
        bar.style.width = Math.max(daysBetween(plannedStart, plannedEnd) * pxPerDay, 3) + "px";
        bar.style.top = "5px";
        bar.style.height = "11px";
        bar.addEventListener("mousemove", (e) => showTooltip(e, task, status));
        bar.addEventListener("mouseleave", hideTooltip);
        timeline.appendChild(bar);
      }

      if (actualStart && actualEnd) {
        const bar = document.createElement("div");
        bar.className = "bar bar-actual status-" + status;
        bar.style.left = daysBetween(range.start, actualStart) * pxPerDay + "px";
        bar.style.width = Math.max(daysBetween(actualStart, actualEnd) * pxPerDay, 3) + "px";
        bar.style.top = "22px";
        bar.style.height = "11px";
        bar.addEventListener("mousemove", (e) => showTooltip(e, task, status));
        bar.addEventListener("mouseleave", hideTooltip);
        timeline.appendChild(bar);
      } else if (actualStart && !actualEnd) {
        // in-progress: draw from actual start to today
        const end = todayUTC();
        const bar = document.createElement("div");
        bar.className = "bar bar-actual status-" + status;
        bar.style.left = daysBetween(range.start, actualStart) * pxPerDay + "px";
        bar.style.width = Math.max(daysBetween(actualStart, end) * pxPerDay, 3) + "px";
        bar.style.top = "22px";
        bar.style.height = "11px";
        bar.addEventListener("mousemove", (e) => showTooltip(e, task, status));
        bar.addEventListener("mouseleave", hideTooltip);
        timeline.appendChild(bar);
      }

      row.appendChild(label);
      row.appendChild(timeline);
      body.appendChild(row);
    });

    body.style.width = (LABEL_WIDTH + totalWidth) + "px";

    const today = todayUTC();
    if (today >= range.start && today <= range.end) {
      const todayLine = document.createElement("div");
      todayLine.className = "today-line";
      todayLine.style.left = (LABEL_WIDTH + daysBetween(range.start, today) * pxPerDay) + "px";
      todayLine.style.height = (visibleTasks.length * ROW_HEIGHT) + "px";
      body.style.position = "relative";
      body.appendChild(todayLine);
    }

    scroll.appendChild(body);
    root.appendChild(scroll);
  }

  function populateStatusFilter(tasks) {
    const select = document.getElementById("status-filter");
    const seen = new Set();
    tasks.forEach((t) => seen.add(statusSlug(t.status, t)));
    ["complete", "in-progress", "at-risk", "delayed", "not-started"].forEach((slug) => {
      if (!seen.has(slug)) return;
      const opt = document.createElement("option");
      opt.value = slug;
      opt.textContent = statusLabel(slug);
      select.appendChild(opt);
    });
  }

  function wireControls() {
    document.getElementById("search").addEventListener("input", (e) => {
      state.search = e.target.value;
      render();
    });
    document.getElementById("status-filter").addEventListener("change", (e) => {
      state.statusFilter = e.target.value;
      render();
    });
    document.querySelectorAll(".zoom-buttons button").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".zoom-buttons button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.zoom = btn.dataset.zoom;
        render();
      });
    });

    tooltipEl = document.createElement("div");
    tooltipEl.className = "tooltip";
    document.body.appendChild(tooltipEl);
  }

  async function init() {
    wireControls();
    try {
      const data = await loadData();
      state.tasks = data.tasks || [];
      document.getElementById("sheet-name").textContent = data.sheetName || "Marine Operations Schedule";
      const generated = data.generatedAt ? new Date(data.generatedAt) : null;
      document.getElementById("generated-at").textContent = generated
        ? "Data as of " + generated.toLocaleString()
        : "";
      populateStatusFilter(state.tasks);
      render();
    } catch (err) {
      root.innerHTML = "<p class='status-message'>Could not load schedule data: " + escapeHtml(err.message) + "</p>";
    }
  }

  init();
})();
