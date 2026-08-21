# Marine Operations Schedule

Entails commercial/project side WRT Smartsheet API & Instruction Documents.

A Gantt chart for the marine operations schedule, showing **anticipated** (planned)
and **actual** dates on separate bars for every task. Data is pulled from a
Smartsheet on a schedule and displayed as a static site on GitHub Pages.

Live site (once Pages is enabled, see below):
`https://stephensquires329-dotcom.github.io/Marine-Operations/`

## How it works

```
Smartsheet  --(GitHub Action, every 30 min)-->  data/gantt-data.json  --> index.html (GitHub Pages)
```

- `scripts/fetch-smartsheet.js` calls the Smartsheet API and writes the result to
  `data/gantt-data.json`.
- `.github/workflows/update-data.yml` runs that script on a schedule (and on
  demand) using a token stored as a GitHub secret, then commits the updated
  JSON file. **The Smartsheet token never reaches the browser** - only the
  already-fetched data does.
- `index.html` / `app.js` / `style.css` are a plain static site (no build step)
  that reads `data/gantt-data.json` and renders the dual-bar Gantt chart,
  with search, status filtering, and day/week/month zoom.

Right now `data/gantt-data.json` contains sample data so you can see the chart
working immediately. Once you wire up Smartsheet (below), the Action will
overwrite it with real data.

## Features

- **Dual-bar Gantt** - dashed "Anticipated" bar and a solid, status-colored
  "Actual" bar per task.
- **Overdue banner** - always-visible alert (regardless of active filters)
  listing any task whose anticipated end date has passed with no actual
  completion recorded, plus an "Overdue only" filter.
- **Search, status filter, hide-completed, date range** - the toolbar above
  the chart; the date range also narrows what the Vessel Availability panel
  considers.
- **Vessel Availability** - pick a vessel, see its open date gaps and percent
  utilization within the current date range.
- **Extensions** - per-task checkbox to add extra days (with an optional
  reason/requested-by note), shown as a purple bar segment on the chart and
  factored into Vessel Availability. An **Active Extensions** panel lists
  every task currently extended with a one-click remove. Extension data is
  stored in your browser's local storage only - it does not sync to
  Smartsheet, the repo, or other devices/teammates.
- **Shareable links** - your current search, filters, vessel selection, date
  range, and zoom level are kept in the URL, so you can copy/paste a link to
  a specific view.
- **Print / Export PDF** - button in the header; use your browser's print
  dialog to save as PDF.

## One-time setup

### 1. Enable GitHub Pages

Repo **Settings → Pages → Build and deployment → Source**: "Deploy from a
branch", branch `main`, folder `/ (root)`. Save. The site will be live in a
minute or two at the URL above.

### 2. Create a Smartsheet API access token

In Smartsheet: click your account avatar → **Apps & Integrations** →
**API Access** → **Generate new access token**. Copy it immediately - it's
only shown once.

### 3. Get the Sheet ID

Open the sheet in Smartsheet → **File → Properties** (or right-click the
sheet's tab/name → **Properties**) and copy the **Sheet ID**.

### 4. Add repo secrets

Repo **Settings → Secrets and variables → Actions → New repository secret**,
add two secrets:

| Name | Value |
|---|---|
| `SMARTSHEET_ACCESS_TOKEN` | the token from step 2 |
| `SMARTSHEET_SHEET_ID` | the sheet ID from step 3 |

### 5. Match the column mapping to your sheet

[`config/smartsheet-map.json`](config/smartsheet-map.json) already reflects
this sheet's columns:

```json
{
  "taskName": ["Vessel", "RFP / Quote No."],
  "vessel": "Vessel",
  "plannedStart": "Anticipated Start Date",
  "plannedEnd": "Anticipated End Date",
  "actualStart": "Actual Start Date",
  "actualEnd": "Actual End Date",
  "percentComplete": "",
  "assignedTo": "",
  "status": "Project Status"
}
```

A field can be:
- a single column title,
- an array of titles, joined together (used here for the task name, so each
  row reads as "Vessel – RFP/Quote No."), or
- `""` if you don't have that column - it's simply omitted from the chart
  instead of showing a misleading `0%` or blank owner.

`vessel` is a separate copy of the same "Vessel" column, kept distinct from
the combined `taskName` so the Vessel Availability panel (below) can group
tasks by vessel reliably.

`status` reads your sheet's **Project Status** column directly and displays
that exact text on each row and in the tooltip. Bar color is a direct mapping
from that text (see `COMPLETE_WORDS` / `ACTIVE_WORDS` / `PLANNING_WORDS` /
`statusSlug` near the top of [`app.js`](app.js)):

- **Complete** → green
- **Active** → gold
- **Planning Phase** → blue (shown as "Planning" in the legend)
- **Not Started**, blank, or anything unrecognized → red

If your "Project Status" picklist uses different wording for any of these,
add it to the matching word list in `app.js`.

If you rename or add columns later, edit this file and commit to `main` -
pushing a change to it automatically triggers a data refresh (see workflow
triggers below).

### 6. Run the sync once

Repo **Actions** tab → **Update Gantt Data** → **Run workflow**. After it
finishes, `data/gantt-data.json` will have your real schedule, and the Pages
site will pick it up automatically.

After that, it runs automatically every 30 minutes. Adjust the cron schedule
in [`.github/workflows/update-data.yml`](.github/workflows/update-data.yml) if
you want it more or less frequent.

### Customizing the vessel list

The Vessel Availability and gap calculations use a fixed list of vessels
(`VESSELS` near the top of [`app.js`](app.js)) rather than deriving them from
the data, so a vessel with zero current tasks still shows up as "fully
available." Edit that array to add, rename, or remove a vessel.

## Local development

```bash
npm install --no-save   # no dependencies currently, but future-proofs the step
node scripts/fetch-smartsheet.js   # requires SMARTSHEET_ACCESS_TOKEN / SMARTSHEET_SHEET_ID env vars
python -m http.server 8000         # or any static file server
# open http://localhost:8000
```

## Data shape

`data/gantt-data.json`:

```json
{
  "generatedAt": "2026-08-18T00:00:00Z",
  "source": "smartsheet",
  "sheetName": "Marine Operations Schedule",
  "tasks": [
    {
      "id": "1",
      "name": "Anchor Handling",
      "plannedStart": "2026-07-15",
      "plannedEnd": "2026-07-25",
      "actualStart": "2026-07-19",
      "actualEnd": "2026-08-02",
      "percentComplete": 100,
      "assignedTo": "Deck Crew A",
      "status": "Delayed"
    }
  ]
}
```

## Extending this into a fuller dashboard

The pipeline is deliberately simple so it's easy to build on:

- Add more fetch scripts (e.g. `scripts/fetch-<other-sheet>.js`) that write
  additional JSON files under `data/`, and add more views/pages that read them.
- Add summary tiles (on-time %, delayed count, upcoming milestones) computed
  client-side from `data/gantt-data.json` in a new script, no extra backend
  needed.
- If you outgrow "refresh every 30 minutes," swap the GitHub Action for a
  small serverless proxy that calls Smartsheet live on page load - the
  frontend's `fetch("data/gantt-data.json")` call is the only place that would
  need to change.
