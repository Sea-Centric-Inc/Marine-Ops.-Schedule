(function () {
  "use strict";

  const DATA_URL = "data/gantt-data.json";
  const EXTENSIONS_KEY = "marineOpsExtensions_v1";
  const ROW_HEIGHT = 84;
  const LABEL_WIDTH = 320;
  const ZOOM_PX_PER_DAY = { day: 36, week: 14, month: 5 };

  // Project Status is one of: Not Started, Planning Phase, Active, Complete.
  // Color is a direct 1:1 mapping from that text; anything blank/unrecognized
  // falls back to Not Started (red).
  const COMPLETE_WORDS = ["complete", "completed", "done", "closed"];
  const ACTIVE_WORDS = ["active"];
  const PLANNING_WORDS = ["planning phase", "planning"];

  const VESSELS = ["Connor Murphy", "Patrick & William", "Strait Signet", "Strait Hunter", "Strait Explorer"];

  const state = {
    tasks: [],
    zoom: "week",
    search: "",
    statusFilter: "",
    hideCompleted: false,
    dateFrom: null, // Date or null; null = auto-fit to task data
    dateTo: null,
    vessel: "",
    extensions: {} // taskId -> { days: number }, persisted to localStorage
  };

  function loadExtensions() {
    try {
      const raw = localStorage.getItem(EXTENSIONS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function saveExtensions() {
    try {
      localStorage.setItem(EXTENSIONS_KEY, JSON.stringify(state.extensions));
    } catch (e) {
      // localStorage unavailable (e.g. private browsing) - extensions just won't persist across reloads
    }
  }

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

  function statusSlug(rawStatus) {
    const key = String(rawStatus || "").trim().toLowerCase();
    if (COMPLETE_WORDS.includes(key)) return "complete";
    if (ACTIVE_WORDS.includes(key)) return "active";
    if (PLANNING_WORDS.includes(key)) return "in-progress";
    return "not-started";
  }

  function statusLabel(slug) {
    return {
      "complete": "Complete",
      "in-progress": "Planning",
      "active": "Active",
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

  function computeAutoRange(tasks) {
    let min = null, max = null;
    tasks.forEach((t) => {
      let taskMax = null;
      [t.plannedStart, t.plannedEnd, t.actualStart, t.actualEnd].forEach((v) => {
        const d = parseDate(v);
        if (!d) return;
        if (!min || d < min) min = d;
        if (!taskMax || d > taskMax) taskMax = d;
      });
      const days = extensionDays(t);
      if (taskMax && days > 0) taskMax = addDays(taskMax, days);
      if (taskMax && (!max || taskMax > max)) max = taskMax;
    });
    const today = todayUTC();
    if (!min || today < min) min = today;
    if (!max || today > max) max = today;
    return { start: addDays(min, -4), end: addDays(max, 5) };
  }

  function computeRange(tasks) {
    if (state.dateFrom && state.dateTo) {
      return { start: state.dateFrom, end: addDays(state.dateTo, 1) };
    }
    return computeAutoRange(tasks);
  }

  function taskDateExtent(task) {
    let min = null, max = null;
    [task.plannedStart, task.plannedEnd, task.actualStart, task.actualEnd].forEach((v) => {
      const d = parseDate(v);
      if (!d) return;
      if (!min || d < min) min = d;
      if (!max || d > max) max = d;
    });
    const days = extensionDays(task);
    if (max && days > 0) max = addDays(max, days);
    return min ? { min, max } : null;
  }

  function formatDateInput(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
  }

  // Vessel comes from its own field when available (fetched directly from the
  // Smartsheet "Vessel" column); older cached data falls back to parsing it
  // back out of "Vessel – RFP/Quote No." task names.
  function getVessel(task) {
    const raw = task.vessel || String(task.name || "").split(" – ")[0];
    return raw.replace(/\s+/g, " ").trim();
  }

  function extensionDays(task) {
    const ext = state.extensions[task.id];
    return ext && ext.days > 0 ? ext.days : 0;
  }

  // A task "occupies" the vessel for its actual dates if known (ground
  // truth), an actual-start-to-planned-end estimate if the work has begun
  // but has no recorded end yet, or its anticipated dates otherwise (a
  // future booking that hasn't started). An entered extension pushes the end
  // out further. Returns null if no usable dates.
  function taskOccupiedInterval(task) {
    const plannedStart = parseDate(task.plannedStart);
    const plannedEnd = parseDate(task.plannedEnd);
    const actualStart = parseDate(task.actualStart);
    const actualEnd = parseDate(task.actualEnd);
    let interval = null;
    if (actualStart && actualEnd) interval = { start: actualStart, end: actualEnd };
    else if (actualStart && plannedEnd) interval = { start: actualStart, end: plannedEnd };
    else if (plannedStart && plannedEnd) interval = { start: plannedStart, end: plannedEnd };
    if (!interval) return null;
    const days = extensionDays(task);
    return days > 0 ? { start: interval.start, end: addDays(interval.end, days) } : interval;
  }

  function mergeIntervals(intervals) {
    const sorted = intervals.slice().sort((a, b) => a.start - b.start);
    const merged = [];
    sorted.forEach((iv) => {
      const last = merged[merged.length - 1];
      if (last && iv.start <= addDays(last.end, 1)) {
        if (iv.end > last.end) last.end = iv.end;
      } else {
        merged.push({ start: iv.start, end: iv.end });
      }
    });
    return merged;
  }

  // Free gaps for one vessel within [rangeStart, rangeEnd], both inclusive.
  function computeVesselGaps(vessel, tasks, rangeStart, rangeEnd) {
    const busy = tasks
      .filter((t) => getVessel(t) === vessel)
      .map(taskOccupiedInterval)
      .filter(Boolean)
      .map((iv) => ({
        start: iv.start < rangeStart ? rangeStart : iv.start,
        end: iv.end > rangeEnd ? rangeEnd : iv.end
      }))
      .filter((iv) => iv.start <= iv.end);

    const merged = mergeIntervals(busy);
    const gaps = [];
    let cursor = rangeStart;
    merged.forEach((iv) => {
      if (iv.start > cursor) gaps.push({ start: cursor, end: addDays(iv.start, -1) });
      if (iv.end >= cursor) cursor = addDays(iv.end, 1);
    });
    if (cursor <= rangeEnd) gaps.push({ start: cursor, end: rangeEnd });
    return gaps;
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
    const extDays = extensionDays(task);
    const extAnchor = actualEnd || plannedEnd;
    tooltipEl.innerHTML =
      "<strong>" + escapeHtml(task.name) + "</strong>" +
      "<div class='tt-row'><span>Status</span><span>" + escapeHtml(displayStatusText(task, status)) + "</span></div>" +
      "<div class='tt-row'><span>Anticipated</span><span>" + formatDate(plannedStart) + " → " + formatDate(plannedEnd) + "</span></div>" +
      "<div class='tt-row'><span>Actual</span><span>" + formatDate(actualStart) + " → " + formatDate(actualEnd) + "</span></div>" +
      "<div class='tt-row'><span>Variance</span><span>" + variance + "</span></div>" +
      (task.percentComplete !== undefined && task.percentComplete !== null
        ? "<div class='tt-row'><span>% Complete</span><span>" + task.percentComplete + "%</span></div>" : "") +
      (task.assignedTo ? "<div class='tt-row'><span>Owner</span><span>" + escapeHtml(task.assignedTo) + "</span></div>" : "") +
      (extDays > 0 && extAnchor
        ? "<div class='tt-row'><span>Extension</span><span>+" + extDays + "d, through " + formatDate(addDays(extAnchor, extDays)) + "</span></div>" : "");
    tooltipEl.style.display = "block";
    positionTooltip(evt);
  }

  function buildExtensionRow(task) {
    const extRow = document.createElement("div");
    extRow.className = "ext-row";

    const existing = state.extensions[task.id];

    const extLabel = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = !!existing;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        state.extensions[task.id] = { days: (existing && existing.days) || 1 };
      } else {
        delete state.extensions[task.id];
      }
      saveExtensions();
      render();
    });
    extLabel.appendChild(checkbox);
    extLabel.appendChild(document.createTextNode("Extension"));
    extRow.appendChild(extLabel);

    if (existing) {
      const daysInput = document.createElement("input");
      daysInput.type = "number";
      daysInput.min = "1";
      daysInput.className = "ext-days-input";
      daysInput.value = existing.days;
      daysInput.addEventListener("change", (e) => {
        const v = Math.max(1, parseInt(e.target.value, 10) || 1);
        state.extensions[task.id] = { days: v };
        saveExtensions();
        render();
      });
      extRow.appendChild(daysInput);
      const suffix = document.createElement("span");
      suffix.textContent = "days";
      extRow.appendChild(suffix);
    }

    return extRow;
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
    const slug = statusSlug(task.status);
    if (state.statusFilter && slug !== state.statusFilter) return false;
    if (state.hideCompleted && slug === "complete") return false;

    if (state.dateFrom && state.dateTo) {
      const extent = taskDateExtent(task);
      if (extent && (extent.max < state.dateFrom || extent.min > state.dateTo)) return false;
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
      const status = statusSlug(task.status);
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
      label.appendChild(buildExtensionRow(task));

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
        bar.style.top = "27px";
        bar.style.height = "11px";
        bar.addEventListener("mousemove", (e) => showTooltip(e, task, status));
        bar.addEventListener("mouseleave", hideTooltip);
        timeline.appendChild(bar);
      }

      let extensionAnchor = null; // { date, top } - where the extension bar continues from

      if (actualStart && actualEnd) {
        const bar = document.createElement("div");
        bar.className = "bar bar-actual status-" + status;
        bar.style.left = daysBetween(range.start, actualStart) * pxPerDay + "px";
        bar.style.width = Math.max(daysBetween(actualStart, actualEnd) * pxPerDay, 3) + "px";
        bar.style.top = "46px";
        bar.style.height = "11px";
        bar.addEventListener("mousemove", (e) => showTooltip(e, task, status));
        bar.addEventListener("mouseleave", hideTooltip);
        timeline.appendChild(bar);
        extensionAnchor = { date: actualEnd, top: "46px" };
      } else if (actualStart && !actualEnd) {
        // in-progress: draw from actual start to today
        const end = todayUTC();
        const bar = document.createElement("div");
        bar.className = "bar bar-actual status-" + status;
        bar.style.left = daysBetween(range.start, actualStart) * pxPerDay + "px";
        bar.style.width = Math.max(daysBetween(actualStart, end) * pxPerDay, 3) + "px";
        bar.style.top = "46px";
        bar.style.height = "11px";
        bar.addEventListener("mousemove", (e) => showTooltip(e, task, status));
        bar.addEventListener("mouseleave", hideTooltip);
        timeline.appendChild(bar);
      } else if (plannedStart && plannedEnd) {
        extensionAnchor = { date: plannedEnd, top: "27px" };
      }

      const extDays = extensionDays(task);
      if (extDays > 0 && extensionAnchor) {
        const extStart = addDays(extensionAnchor.date, 1);
        const extEnd = addDays(extensionAnchor.date, extDays);
        const bar = document.createElement("div");
        bar.className = "bar bar-extension";
        bar.style.left = daysBetween(range.start, extStart) * pxPerDay + "px";
        bar.style.width = Math.max(daysBetween(extStart, extEnd) * pxPerDay, 3) + "px";
        bar.style.top = extensionAnchor.top;
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

    renderVesselAvailability(range);
  }

  function renderVesselAvailability(range) {
    const results = document.getElementById("availability-results");
    const rangeLabel = document.getElementById("availability-range-label");
    rangeLabel.textContent = "within " + formatDate(range.start) + " – " + formatDate(addDays(range.end, -1));

    if (!state.vessel) {
      results.innerHTML = "<p class='status-message'>Pick a vessel to see open date gaps within the current date range above.</p>";
      return;
    }

    const rangeEnd = addDays(range.end, -1); // range.end is exclusive in computeRange()
    const gaps = computeVesselGaps(state.vessel, state.tasks, range.start, rangeEnd);

    if (!gaps.length) {
      results.innerHTML = "<p class='status-message'>" + escapeHtml(state.vessel) + " has no open availability in this date range &ndash; fully booked.</p>";
      return;
    }

    const totalFreeDays = gaps.reduce((sum, g) => sum + daysBetween(g.start, g.end) + 1, 0);
    const summary = document.createElement("p");
    summary.className = "gap-summary";
    summary.textContent = gaps.length + " open gap" + (gaps.length === 1 ? "" : "s") + ", " + totalFreeDays + " free day" + (totalFreeDays === 1 ? "" : "s") + " total.";

    const list = document.createElement("ul");
    list.className = "gap-list";
    gaps.forEach((g) => {
      const days = daysBetween(g.start, g.end) + 1;
      const item = document.createElement("li");
      item.className = "gap-item";
      const dates = document.createElement("span");
      dates.className = "gap-dates";
      dates.textContent = formatDate(g.start) + " → " + formatDate(g.end);
      const count = document.createElement("span");
      count.className = "gap-days";
      count.textContent = days + " day" + (days === 1 ? "" : "s");
      item.appendChild(dates);
      item.appendChild(count);
      list.appendChild(item);
    });

    results.innerHTML = "";
    results.appendChild(summary);
    results.appendChild(list);
  }

  function populateVesselSelect() {
    const select = document.getElementById("vessel-select");
    VESSELS.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      select.appendChild(opt);
    });
  }

  function populateStatusFilter(tasks) {
    const select = document.getElementById("status-filter");
    const seen = new Set();
    tasks.forEach((t) => seen.add(statusSlug(t.status)));
    ["complete", "in-progress", "active", "not-started"].forEach((slug) => {
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
    document.getElementById("hide-completed").addEventListener("change", (e) => {
      state.hideCompleted = e.target.checked;
      render();
    });
    document.getElementById("vessel-select").addEventListener("change", (e) => {
      state.vessel = e.target.value;
      render();
    });
    document.getElementById("range-from").addEventListener("change", (e) => {
      state.dateFrom = parseDate(e.target.value);
      if (state.dateFrom && !state.dateTo) state.dateTo = addDays(state.dateFrom, 30);
      render();
    });
    document.getElementById("range-to").addEventListener("change", (e) => {
      state.dateTo = parseDate(e.target.value);
      if (state.dateTo && !state.dateFrom) state.dateFrom = addDays(state.dateTo, -30);
      render();
    });
    document.getElementById("range-reset").addEventListener("click", () => {
      state.dateFrom = null;
      state.dateTo = null;
      const auto = computeAutoRange(state.tasks);
      document.getElementById("range-from").value = formatDateInput(auto.start);
      document.getElementById("range-to").value = formatDateInput(addDays(auto.end, -1));
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

    populateVesselSelect();
  }

  async function init() {
    wireControls();
    state.extensions = loadExtensions();
    try {
      const data = await loadData();
      state.tasks = data.tasks || [];
      document.getElementById("sheet-name").textContent = data.sheetName || "Marine Operations Schedule";
      const generated = data.generatedAt ? new Date(data.generatedAt) : null;
      document.getElementById("generated-at").textContent = generated
        ? "Data as of " + generated.toLocaleString()
        : "";
      populateStatusFilter(state.tasks);
      const auto = computeAutoRange(state.tasks);
      document.getElementById("range-from").value = formatDateInput(auto.start);
      document.getElementById("range-to").value = formatDateInput(addDays(auto.end, -1));
      render();
    } catch (err) {
      root.innerHTML = "<p class='status-message'>Could not load schedule data: " + escapeHtml(err.message) + "</p>";
    }
  }

  init();
})();
