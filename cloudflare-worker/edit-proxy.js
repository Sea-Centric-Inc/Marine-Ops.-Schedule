/**
 * Cloudflare Worker: accepts date-edit requests from the Gantt site and
 * writes them to Smartsheet. This is the ONLY place the write-capable
 * Smartsheet token is used - it never reaches the browser.
 *
 * Required environment (set via `wrangler secret put NAME` or the
 * Cloudflare dashboard's Settings -> Variables for this Worker):
 *   SMARTSHEET_ACCESS_TOKEN  (secret) - a Smartsheet API token with edit access
 *   EDIT_PIN                 (secret) - shared PIN the site must send to allow a write
 *   SHEET_ID                 (var)    - the Smartsheet sheet ID
 *   CONFIG_URL                (var)   - public URL of config/smartsheet-map.json
 *                                       (e.g. https://<user>.github.io/Marine-Operations/config/smartsheet-map.json)
 *   ALLOWED_ORIGIN            (var)   - the site origin allowed to call this,
 *                                       e.g. https://<user>.github.io
 *
 * Only the four date fields below can ever be written - this Worker has no
 * path that can change status, names, or anything else.
 */

const EDITABLE_FIELDS = ["plannedStart", "plannedEnd", "actualStart", "actualEnd"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405, corsHeaders);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ ok: false, error: "Invalid JSON body" }, 400, corsHeaders);
    }

    const rowId = body && body.rowId;
    const pin = body && body.pin;
    const fields = body && body.fields;

    if (!env.EDIT_PIN) {
      return json({ ok: false, error: "Server misconfigured: EDIT_PIN not set" }, 500, corsHeaders);
    }
    if (!pin || pin !== env.EDIT_PIN) {
      return json({ ok: false, error: "Incorrect PIN" }, 401, corsHeaders);
    }
    if (!rowId || !/^\d+$/.test(String(rowId))) {
      return json({ ok: false, error: "Missing or invalid rowId" }, 400, corsHeaders);
    }
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      return json({ ok: false, error: "Missing fields" }, 400, corsHeaders);
    }

    const updates = {};
    for (const key of Object.keys(fields)) {
      if (!EDITABLE_FIELDS.includes(key)) {
        return json({ ok: false, error: "Field not editable: " + key }, 400, corsHeaders);
      }
      const v = fields[key];
      if (v !== "" && !DATE_RE.test(String(v))) {
        return json({ ok: false, error: "Invalid date for " + key + " (expected YYYY-MM-DD)" }, 400, corsHeaders);
      }
      updates[key] = v;
    }
    if (!Object.keys(updates).length) {
      return json({ ok: false, error: "No fields to update" }, 400, corsHeaders);
    }

    // Resolve field -> Smartsheet column title from the site's own public config.
    let map;
    try {
      const mapRes = await fetch(env.CONFIG_URL);
      if (!mapRes.ok) throw new Error("status " + mapRes.status);
      map = await mapRes.json();
    } catch (e) {
      return json({ ok: false, error: "Could not load column config: " + e.message }, 502, corsHeaders);
    }

    // Resolve those titles -> Smartsheet column IDs.
    let columns;
    try {
      const colRes = await fetch(
        "https://api.smartsheet.com/2.0/sheets/" + encodeURIComponent(env.SHEET_ID) + "/columns",
        { headers: { Authorization: "Bearer " + env.SMARTSHEET_ACCESS_TOKEN } }
      );
      if (!colRes.ok) throw new Error("status " + colRes.status);
      const colData = await colRes.json();
      columns = colData.data || [];
    } catch (e) {
      return json({ ok: false, error: "Could not load sheet columns: " + e.message }, 502, corsHeaders);
    }

    const cells = [];
    for (const field of Object.keys(updates)) {
      const title = map[field];
      if (!title || Array.isArray(title)) {
        return json({ ok: false, error: "No single column configured for " + field }, 400, corsHeaders);
      }
      const col = columns.find((c) => c.title === title);
      if (!col) {
        return json({ ok: false, error: "Column not found in sheet: " + title }, 400, corsHeaders);
      }
      cells.push({ columnId: col.id, value: updates[field] === "" ? null : updates[field] });
    }

    try {
      const updateRes = await fetch(
        "https://api.smartsheet.com/2.0/sheets/" + encodeURIComponent(env.SHEET_ID) + "/rows",
        {
          method: "PUT",
          headers: {
            Authorization: "Bearer " + env.SMARTSHEET_ACCESS_TOKEN,
            "Content-Type": "application/json"
          },
          body: JSON.stringify([{ id: Number(rowId), cells }])
        }
      );
      const updateData = await updateRes.json().catch(() => ({}));
      if (!updateRes.ok) {
        const msg = (updateData && updateData.message) || ("status " + updateRes.status);
        return json({ ok: false, error: "Smartsheet rejected the update: " + msg }, 502, corsHeaders);
      }

      // Optional: kick off an immediate GitHub Action sync so the site
      // reflects this edit within a minute instead of waiting for the next
      // scheduled run. Skipped entirely if these aren't configured, and
      // never fails the response - the Smartsheet write already succeeded.
      if (env.GITHUB_DISPATCH_TOKEN && env.GITHUB_REPO) {
        try {
          await fetch(
            "https://api.github.com/repos/" + env.GITHUB_REPO + "/actions/workflows/update-data.yml/dispatches",
            {
              method: "POST",
              headers: {
                Authorization: "Bearer " + env.GITHUB_DISPATCH_TOKEN,
                Accept: "application/vnd.github+json",
                "User-Agent": "marine-ops-edit-proxy"
              },
              body: JSON.stringify({ ref: "main" })
            }
          );
        } catch (e) {
          // Non-fatal - the edit already succeeded in Smartsheet.
        }
      }

      return json({ ok: true }, 200, corsHeaders);
    } catch (e) {
      return json({ ok: false, error: "Request to Smartsheet failed: " + e.message }, 502, corsHeaders);
    }
  }
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ "Content-Type": "application/json" }, headers)
  });
}
