#!/usr/bin/env node
"use strict";

/**
 * Pulls a sheet from Smartsheet and writes it to data/gantt-data.json in the
 * shape the Gantt chart frontend expects. Run via `npm run fetch-data`.
 *
 * Required environment variables:
 *   SMARTSHEET_ACCESS_TOKEN - Smartsheet API access token
 *   SMARTSHEET_SHEET_ID     - Numeric ID of the sheet to pull
 *
 * Column mapping (which Smartsheet column title feeds which field) lives in
 * config/smartsheet-map.json so it can be edited without touching this script.
 */

const fs = require("fs");
const path = require("path");

const TOKEN = process.env.SMARTSHEET_ACCESS_TOKEN;
const SHEET_ID = process.env.SMARTSHEET_SHEET_ID;
const MAP_PATH = path.join(__dirname, "..", "config", "smartsheet-map.json");
const OUTPUT_PATH = path.join(__dirname, "..", "data", "gantt-data.json");

function fail(message) {
  console.error("ERROR: " + message);
  process.exit(1);
}

function cellValue(cell) {
  if (!cell) return "";
  let value = "";
  if (cell.displayValue !== undefined && cell.displayValue !== null && cell.displayValue !== "") {
    value = cell.displayValue;
  } else if (cell.value !== undefined && cell.value !== null) {
    value = cell.value;
  }
  // Smartsheet text cells can contain embedded line breaks that render fine
  // in a browser (CSS collapses them) but break exact-match comparisons in
  // JS, e.g. matching a vessel name against a fixed list.
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value;
}

function toDateString(raw) {
  if (raw === undefined || raw === null || raw === "") return "";
  const s = String(raw);
  const match = s.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : "";
}

function toPercent(raw) {
  if (raw === undefined || raw === null || raw === "") return 0;
  const n = Number(raw);
  if (Number.isNaN(n)) return 0;
  const pct = n <= 1 ? n * 100 : n;
  return Math.round(pct);
}

async function main() {
  if (!TOKEN) fail("SMARTSHEET_ACCESS_TOKEN environment variable is not set.");
  if (!SHEET_ID) fail("SMARTSHEET_SHEET_ID environment variable is not set.");

  const rawMap = JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
  const fieldToTitle = {};
  Object.keys(rawMap).forEach((key) => {
    if (key.startsWith("_")) return;
    fieldToTitle[key] = rawMap[key];
  });

  const url = "https://api.smartsheet.com/2.0/sheets/" + encodeURIComponent(SHEET_ID) + "?include=rowPermalink";
  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + TOKEN }
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    fail("Smartsheet API request failed (" + res.status + " " + res.statusText + "): " + body);
  }

  const sheet = await res.json();

  const columnIdsByField = {};
  Object.keys(fieldToTitle).forEach((field) => {
    const titles = fieldToTitle[field];
    if (!titles) return; // "" means this field has no column in the sheet

    const titleList = Array.isArray(titles) ? titles : [titles];
    const ids = [];
    titleList.forEach((title) => {
      const col = (sheet.columns || []).find((c) => c.title === title);
      if (col) {
        ids.push(col.id);
      } else {
        console.warn("WARNING: no column titled \"" + title + "\" found for field \"" + field + "\". Check config/smartsheet-map.json.");
      }
    });
    columnIdsByField[field] = ids;
  });

  if (!columnIdsByField.taskName || columnIdsByField.taskName.length === 0) {
    fail("Could not find the task name column(s) in the sheet. Update config/smartsheet-map.json to match your sheet's column titles.");
  }

  const tasks = [];
  (sheet.rows || []).forEach((row) => {
    const cellByColumnId = {};
    (row.cells || []).forEach((cell) => {
      cellByColumnId[cell.columnId] = cell;
    });

    const get = (field) => {
      const ids = columnIdsByField[field] || [];
      return ids
        .map((id) => cellValue(cellByColumnId[id]))
        .filter((v) => v !== "" && v !== undefined && v !== null)
        .join(" – ");
    };

    const name = get("taskName");
    if (!name) return; // skip blank / section-header rows

    const task = {
      id: String(row.id),
      name: String(name),
      vessel: String(get("vessel") || ""),
      plannedStart: toDateString(get("plannedStart")),
      plannedEnd: toDateString(get("plannedEnd")),
      actualStart: toDateString(get("actualStart")),
      actualEnd: toDateString(get("actualEnd")),
      status: String(get("status") || ""),
      link: row.permalink || ""
    };
    if ((columnIdsByField.percentComplete || []).length) {
      task.percentComplete = toPercent(get("percentComplete"));
    }
    if ((columnIdsByField.assignedTo || []).length) {
      task.assignedTo = String(get("assignedTo") || "");
    }
    if ((columnIdsByField.category || []).length) {
      task.category = String(get("category") || "");
    }
    tasks.push(task);
  });

  const output = {
    generatedAt: new Date().toISOString(),
    source: "smartsheet",
    sheetName: sheet.name || "Marine Operations Schedule",
    tasks
  };

  if (tasks.length && !tasks.some((t) => t.link)) {
    console.warn("WARNING: none of the fetched rows had a permalink. Row links on the chart won't work. Check that this Smartsheet account/API supports ?include=rowPermalink.");
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log("Wrote " + tasks.length + " task(s) from \"" + output.sheetName + "\" to " + path.relative(process.cwd(), OUTPUT_PATH));
}

main().catch((err) => fail(err.stack || err.message || String(err)));
