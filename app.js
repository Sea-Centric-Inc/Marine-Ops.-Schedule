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

  // The company's 3 main project categories. A task's category comes from
  // its own Smartsheet column when mapped (config/smartsheet-map.json); until
  // that column exists, any task with a known vessel defaults to "Vessels"
  // so the filter is useful immediately rather than showing nothing.
  const CATEGORIES = ["Vessels", "ECMI", "Lewisporte"];

  const state = {
    tasks: [],
    zoom: "week",
    search: "",
    statusFilter: "",
    categoryFilter: "",
    hideCompleted: false,
    dateFrom: null, // Date or null; null = auto-fit to task data
    dateTo: null,
    vessel: "",
    availabilityExpanded: false,
    extensionsExpanded: false,
    extensions: {}, // taskId -> { start: string, end: string, reason: string }, persisted to localStorage
    printFitWidth: null // set while printing so the whole timeline fits one page width
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
      [t.plannedStart, t.plannedEnd, t.actualStart, t.actualEnd].forEach((v) => {
        const d = parseDate(v);
        if (!d) return;
        if (!min || d < min) min = d;
        if (!max || d > max) max = d;
      });
      const ext = getExtensionRange(t);
      if (ext) {
        if (!min || ext.start < min) min = ext.start;
        if (!max || ext.end > max) max = ext.end;
      }
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
    const ext = getExtensionRange(task);
    if (ext) {
      if (!min || ext.start < min) min = ext.start;
      if (!max || ext.end > max) max = ext.end;
    }
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

  // See CATEGORIES above for the fallback rule.
  function getCategory(task) {
    const raw = String(task.category || "").trim();
    if (raw) return raw;
    return getVessel(task) ? "Vessels" : "";
  }

  // Extensions are their own independent date range (not necessarily right
  // after the task's actual/anticipated dates - an extension can start
  // weeks or months later). Returns null until both dates are set.
  function getExtensionRange(task) {
    const ext = state.extensions[task.id];
    if (!ext) return null;
    const start = parseDate(ext.start);
    const end = parseDate(ext.end);
    if (!start || !end || end < start) return null;
    return { start, end };
  }

  // A task "occupies" the vessel for its actual dates if known (ground
  // truth), an actual-start-to-planned-end estimate if the work has begun
  // but has no recorded end yet, or its anticipated dates otherwise (a
  // future booking that hasn't started). Returns null if no usable dates.
  function taskOccupiedInterval(task) {
    const plannedStart = parseDate(task.plannedStart);
    const plannedEnd = parseDate(task.plannedEnd);
    const actualStart = parseDate(task.actualStart);
    const actualEnd = parseDate(task.actualEnd);
    if (actualStart && actualEnd) return { start: actualStart, end: actualEnd };
    if (actualStart && plannedEnd) return { start: actualStart, end: plannedEnd };
    if (plannedStart && plannedEnd) return { start: plannedStart, end: plannedEnd };
    return null;
  }

  // All the date spans a task occupies its vessel for: its own dates plus,
  // separately, its extension range if one is set - these don't have to be
  // adjacent or overlapping.
  function taskBusyIntervals(task) {
    const intervals = [];
    const base = taskOccupiedInterval(task);
    if (base) intervals.push(base);
    const ext = getExtensionRange(task);
    if (ext) intervals.push(ext);
    return intervals;
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
      .flatMap(taskBusyIntervals)
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
    const extEntry = state.extensions[task.id];
    const extRange = getExtensionRange(task);
    tooltipEl.innerHTML =
      "<strong>" + escapeHtml(task.name) + "</strong>" +
      "<div class='tt-row'><span>Category</span><span>" + escapeHtml(getCategory(task) || "—") + "</span></div>" +
      "<div class='tt-row'><span>Status</span><span>" + escapeHtml(displayStatusText(task, status)) + "</span></div>" +
      "<div class='tt-row'><span>Anticipated</span><span>" + formatDate(plannedStart) + " → " + formatDate(plannedEnd) + "</span></div>" +
      "<div class='tt-row'><span>Actual</span><span>" + formatDate(actualStart) + " → " + formatDate(actualEnd) + "</span></div>" +
      "<div class='tt-row'><span>Variance</span><span>" + variance + "</span></div>" +
      (task.percentComplete !== undefined && task.percentComplete !== null
        ? "<div class='tt-row'><span>% Complete</span><span>" + task.percentComplete + "%</span></div>" : "") +
      (task.assignedTo ? "<div class='tt-row'><span>Owner</span><span>" + escapeHtml(task.assignedTo) + "</span></div>" : "") +
      (extRange
        ? "<div class='tt-row'><span>Extension</span><span>" + formatDate(extRange.start) + " → " + formatDate(extRange.end) + "</span></div>"
        : "") +
      (extRange && extEntry && extEntry.reason
        ? "<div class='tt-row'><span>Reason</span><span>" + escapeHtml(extEntry.reason) + "</span></div>" : "");
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
        state.extensions[task.id] = { start: "", end: "", reason: "" };
        expandExtensionsPanel();
      } else {
        delete state.extensions[task.id];
      }
      saveExtensions();
      render();
    });
    extLabel.appendChild(checkbox);
    extLabel.appendChild(document.createTextNode(existing ? "Extension (set dates below)" : "Extension"));
    extRow.appendChild(extLabel);

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
    if (state.categoryFilter && getCategory(task) !== state.categoryFilter) return false;
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
      updateUrlFromState();
      return;
    }

    const range = computeRange(tasks);
    const totalDays = daysBetween(range.start, range.end);

    // Printing needs the whole timeline width to fit one page (no
    // horizontal scrolling on paper), so shrink pxPerDay to fit instead of
    // using the on-screen zoom level.
    let pxPerDay = ZOOM_PX_PER_DAY[state.zoom];
    if (state.printFitWidth) {
      const availableTimelineWidth = Math.max(state.printFitWidth - LABEL_WIDTH - 20, 100);
      pxPerDay = Math.max(availableTimelineWidth / totalDays, 0.5);
    }
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
      if (state.vessel && getVessel(task) === state.vessel) row.classList.add("vessel-highlight");
      row.style.height = ROW_HEIGHT + "px";

      const label = document.createElement("div");
      label.className = "row-label";
      const status = statusSlug(task.status);
      const nameEl = document.createElement(task.link ? "a" : "div");
      nameEl.className = "task-name";
      if (task.link) {
        nameEl.href = task.link;
        nameEl.target = "_blank";
        nameEl.rel = "noopener noreferrer";
        nameEl.title = "Open this row in Smartsheet";
      }
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
      }

      // Extension is its own independent date range - it can fall anywhere
      // on the timeline, not just right after the task's own dates.
      const extRange = getExtensionRange(task);
      if (extRange) {
        const bar = document.createElement("div");
        bar.className = "bar bar-extension";
        bar.style.left = daysBetween(range.start, extRange.start) * pxPerDay + "px";
        bar.style.width = Math.max(daysBetween(extRange.start, extRange.end) * pxPerDay, 3) + "px";
        bar.style.top = "46px";
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
    renderExtensionsSummary();
    updateUrlFromState();
  }

  function expandExtensionsPanel() {
    state.extensionsExpanded = true;
    const body = document.getElementById("extensions-body");
    body.classList.remove("collapsed");
    const btn = document.getElementById("extensions-toggle");
    btn.setAttribute("aria-expanded", "true");
    // Text gets its final "(N)" count from the next renderExtensionsSummary() call.
  }

  function renderExtensionsSummary() {
    const results = document.getElementById("extensions-results");
    const toggle = document.getElementById("extensions-toggle");
    const entries = state.tasks
      .map((t) => ({ task: t, ext: state.extensions[t.id] }))
      .filter((e) => e.ext);

    toggle.textContent = (state.extensionsExpanded ? "Hide" : "Show") + " (" + entries.length + ")";

    if (!entries.length) {
      results.innerHTML = "<p class='status-message'>No extensions applied yet. Check \"Extension\" on a task row to add one.</p>";
      return;
    }

    const list = document.createElement("ul");
    list.className = "ext-summary-list";
    entries.forEach(({ task, ext }) => {
      const item = document.createElement("li");
      item.className = "ext-summary-item";

      const top = document.createElement("div");
      top.className = "ext-summary-top";
      const nameEl = document.createElement(task.link ? "a" : "span");
      nameEl.className = "ext-summary-name";
      if (task.link) {
        nameEl.href = task.link;
        nameEl.target = "_blank";
        nameEl.rel = "noopener noreferrer";
        nameEl.title = "Open this row in Smartsheet";
      }
      nameEl.textContent = task.name;
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "ext-remove-btn";
      removeBtn.title = "Remove extension";
      removeBtn.textContent = "✕";
      removeBtn.addEventListener("click", () => {
        delete state.extensions[task.id];
        saveExtensions();
        render();
      });
      top.appendChild(nameEl);
      top.appendChild(removeBtn);
      item.appendChild(top);

      const range = getExtensionRange(task);
      const detailEl = document.createElement("div");
      detailEl.className = "ext-summary-detail";
      const dayCount = range ? daysBetween(range.start, range.end) + 1 : null;
      detailEl.textContent = getVessel(task) + (dayCount ? " • " + dayCount + " day" + (dayCount === 1 ? "" : "s") : " • pick both dates below");
      item.appendChild(detailEl);

      const controls = document.createElement("div");
      controls.className = "ext-summary-controls";

      const startInput = document.createElement("input");
      startInput.type = "date";
      startInput.className = "ext-date-input";
      startInput.value = ext.start || "";
      startInput.setAttribute("aria-label", "Extension start date");
      startInput.addEventListener("change", (e) => {
        state.extensions[task.id] = { start: e.target.value, end: ext.end, reason: ext.reason || "" };
        saveExtensions();
        render();
      });

      const arrow = document.createElement("span");
      arrow.textContent = "→";

      const endInput = document.createElement("input");
      endInput.type = "date";
      endInput.className = "ext-date-input";
      endInput.value = ext.end || "";
      endInput.setAttribute("aria-label", "Extension end date");
      endInput.addEventListener("change", (e) => {
        state.extensions[task.id] = { start: ext.start, end: e.target.value, reason: ext.reason || "" };
        saveExtensions();
        render();
      });

      const reasonInput = document.createElement("input");
      reasonInput.type = "text";
      reasonInput.className = "ext-reason-input";
      reasonInput.placeholder = "reason / requested by";
      reasonInput.value = ext.reason || "";
      reasonInput.addEventListener("change", (e) => {
        state.extensions[task.id] = { start: ext.start, end: ext.end, reason: e.target.value.trim() };
        saveExtensions();
        render();
      });

      controls.appendChild(startInput);
      controls.appendChild(arrow);
      controls.appendChild(endInput);
      controls.appendChild(reasonInput);
      item.appendChild(controls);

      list.appendChild(item);
    });

    results.innerHTML = "";
    results.appendChild(list);
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
    const totalRangeDays = daysBetween(range.start, rangeEnd) + 1;

    if (!gaps.length) {
      results.innerHTML = "<p class='status-message'>" + escapeHtml(state.vessel) + " has no open availability in this date range &ndash; fully booked (100% utilized).</p>";
      return;
    }

    const totalFreeDays = gaps.reduce((sum, g) => sum + daysBetween(g.start, g.end) + 1, 0);
    const utilizationPct = Math.round(((totalRangeDays - totalFreeDays) / totalRangeDays) * 100);
    const summary = document.createElement("p");
    summary.className = "gap-summary";
    summary.textContent = gaps.length + " open gap" + (gaps.length === 1 ? "" : "s") + ", " + totalFreeDays + " free day" +
      (totalFreeDays === 1 ? "" : "s") + " total (" + utilizationPct + "% utilized over this range).";

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

  function populateCategoryFilter() {
    const select = document.getElementById("category-filter");
    CATEGORIES.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
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

  // Keeps the URL query string in sync with filter/view state (not panel
  // collapse state) so the current view can be shared via a plain link.
  function updateUrlFromState() {
    const params = new URLSearchParams();
    if (state.search) params.set("q", state.search);
    if (state.statusFilter) params.set("status", state.statusFilter);
    if (state.categoryFilter) params.set("category", state.categoryFilter);
    if (state.hideCompleted) params.set("hideCompleted", "1");
    if (state.vessel) params.set("vessel", state.vessel);
    if (state.dateFrom) params.set("from", formatDateInput(state.dateFrom));
    if (state.dateTo) params.set("to", formatDateInput(state.dateTo));
    if (state.zoom !== "week") params.set("zoom", state.zoom);
    const qs = params.toString();
    const newUrl = window.location.pathname + (qs ? "?" + qs : "");
    window.history.replaceState(null, "", newUrl);
  }

  function restoreStateFromUrl() {
    const params = new URLSearchParams(window.location.search);

    if (params.has("q")) {
      state.search = params.get("q");
      document.getElementById("search").value = state.search;
    }
    if (params.has("status")) {
      state.statusFilter = params.get("status");
      document.getElementById("status-filter").value = state.statusFilter;
    }
    if (params.has("category")) {
      state.categoryFilter = params.get("category");
      document.getElementById("category-filter").value = state.categoryFilter;
    }
    if (params.get("hideCompleted") === "1") {
      state.hideCompleted = true;
      document.getElementById("hide-completed").checked = true;
    }
    if (params.has("vessel")) {
      const vesselSelect = document.getElementById("vessel-select");
      vesselSelect.value = params.get("vessel");
      if (vesselSelect.value === params.get("vessel")) {
        state.vessel = params.get("vessel");
        state.availabilityExpanded = true;
        document.getElementById("availability-body").classList.remove("collapsed");
        const toggle = document.getElementById("availability-toggle");
        toggle.textContent = "Hide";
        toggle.setAttribute("aria-expanded", "true");
      }
    }
    if (params.has("from")) {
      const d = parseDate(params.get("from"));
      if (d) state.dateFrom = d;
    }
    if (params.has("to")) {
      const d = parseDate(params.get("to"));
      if (d) state.dateTo = d;
    }
    if (state.dateFrom && !state.dateTo) state.dateTo = addDays(state.dateFrom, 30);
    if (state.dateTo && !state.dateFrom) state.dateFrom = addDays(state.dateTo, -30);

    if (params.has("zoom") && ZOOM_PX_PER_DAY[params.get("zoom")]) {
      state.zoom = params.get("zoom");
      document.querySelectorAll(".zoom-buttons button").forEach((b) => {
        b.classList.toggle("active", b.dataset.zoom === state.zoom);
      });
    }
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
    document.getElementById("category-filter").addEventListener("change", (e) => {
      state.categoryFilter = e.target.value;
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
    document.getElementById("print-btn").addEventListener("click", () => {
      window.print();
    });
    document.getElementById("availability-toggle").addEventListener("click", () => {
      state.availabilityExpanded = !state.availabilityExpanded;
      document.getElementById("availability-body").classList.toggle("collapsed", !state.availabilityExpanded);
      const btn = document.getElementById("availability-toggle");
      btn.textContent = state.availabilityExpanded ? "Hide" : "Show";
      btn.setAttribute("aria-expanded", String(state.availabilityExpanded));
    });
    document.getElementById("extensions-toggle").addEventListener("click", () => {
      state.extensionsExpanded = !state.extensionsExpanded;
      document.getElementById("extensions-body").classList.toggle("collapsed", !state.extensionsExpanded);
      document.getElementById("extensions-toggle").setAttribute("aria-expanded", String(state.extensionsExpanded));
      renderExtensionsSummary();
    });

    tooltipEl = document.createElement("div");
    tooltipEl.className = "tooltip";
    document.body.appendChild(tooltipEl);

    populateVesselSelect();
    populateCategoryFilter();

    // Shrink the whole timeline to fit one page width so printing/exporting
    // captures the entire Gantt chart in a single view instead of cutting
    // it off horizontally. Covers both the Print button and Ctrl+P.
    window.addEventListener("beforeprint", () => {
      state.printFitWidth = document.documentElement.clientWidth || window.innerWidth;
      render();
    });
    window.addEventListener("afterprint", () => {
      state.printFitWidth = null;
      render();
    });
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
      restoreStateFromUrl();

      const auto = computeAutoRange(state.tasks);
      document.getElementById("range-from").value = formatDateInput(state.dateFrom || auto.start);
      document.getElementById("range-to").value = formatDateInput(state.dateTo || addDays(auto.end, -1));
      render();
    } catch (err) {
      root.innerHTML = "<p class='status-message'>Could not load schedule data: " + escapeHtml(err.message) + "</p>";
    }
  }

  init();
})();
