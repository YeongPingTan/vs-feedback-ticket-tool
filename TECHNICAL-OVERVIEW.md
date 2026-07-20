# VS Feedback Tracker — Technical Overview

A deep, easy-to-understand explanation of how the VS Feedback Tracker works: the tech stack, how it runs in the background, and how each major piece is built.

---

## What it is

A **local web app** that tracks Visual Studio Developer Community feedback tickets from Azure DevOps (the `devdiv` org / `DevDiv` project). It fetches tickets, detects who last replied, tracks SLA/repro status, renders a dashboard, and runs AI-powered ticket analysis via GitHub Copilot.

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Runtime | **Node.js** (>= 18) |
| Web server | **Express 4** (`app.js`) |
| Frontend | Vanilla **HTML/CSS/JS** (`public/`) — no framework |
| Ticket storage | **JSON file** (`data/tickets.json`) with in-memory cache |
| Agent storage | **SQLite** via `sql.js` (pure-JS, no native build) -> `data/agent.db` |
| AI engine | **`@github/copilot-sdk`** — uses your Copilot subscription (no API keys) |
| ADO auth | **Azure CLI** (`az account get-access-token`) |
| Launcher | **VBScript** (`start.vbs`) + Windows `.lnk` shortcut |

---

## How it runs in the background

The "background" behavior is a Windows trick, not a service:

1. Desktop shortcut (`.lnk`) -> points to **`start.vbs`**.
2. `start.vbs` runs:
   ```vbs
   WshShell.Run "cmd /c cd /d ""<folder>"" && node app.js", 0, False
   ```
   The `0` window-style = **hidden** (no console), `False` = don't wait -> the Node/Express server runs silently.
3. Waits 2.5s, then opens `http://localhost:3000` in the default browser.

So it's a hidden `node.exe` process serving on port 3000. You stop it via Task Manager or `Get-Process node | Stop-Process`. There is no auto-restart/daemon — it lives only while the process runs.

---

## Architecture / data flow

```
Shortcut -> start.vbs -> node app.js (Express :3000)
   |-- lib/devdiv.js        -> ADO REST API (az cli token) -> fetch ticket + comments
   |-- data/tickets.json    -> local cache (atomic write + .bak + daily backup/)
   |-- public/              -> dashboard UI
   |__ lib/orchestrator.js  -> AI analysis pipeline
          |-- lib/ado-client.js  -> work items, comments, VS Feedback diagnostics
          |-- lib/llm-client.js  -> @github/copilot-sdk (model: gpt-5.4-mini)
          |__ lib/db.js          -> sql.js SQLite (analyses history, SLA)
```

---

## 1. How a ticket gets added (the "add" flow)

When you paste ticket IDs in the UI and hit add (`POST /api/tickets`):

1. **Clean the input** — strips everything non-numeric, so `#3024329` or `AB-3024329` both become `3024329`.
2. **Skip duplicates** — checks your existing list; already-tracked IDs are reported back as duplicates, not re-added.
3. **Fetch from Azure DevOps** — calls the ADO API for each new ID.
4. **Filter out failures** — if a ticket came back as `"Error:"` or `"No auth"`, it's dropped (not saved as junk).
5. **Stamp metadata** — each valid ticket gets a `month`, `week`, empty `annotations` (repro status, notes, actions), and timestamps.
6. **Save** — written safely to `tickets.json`.

Mental model: *clean -> dedupe -> fetch -> validate -> tag -> save.*

---

## 2. "Who replied last?" — the traffic-light logic

This is the heart of the tracker. For each ticket, `devdiv.js` reads all comments and runs `isMe()`, comparing each comment's author against your `config.json` (email / alias / full name).

- Last comment was **the customer** -> `lastReplyBy = user` -> **RED** (they're waiting on *you*).
- Last comment was **you** -> `lastReplyBy = me` -> **YELLOW** (you're waiting on *them*).
- Ticket state is closed/resolved -> **CLOSED**.

That's what makes the dashboard instantly show "what needs my attention."

### The "override" safety net (`applyOverrideLogic`)

Sometimes you manually mark a ticket as "I replied" (e.g. you answered outside the tool). That's an **override**. On the next refresh:

- It compares the **date** of the newest customer reply against the date you overrode.
- If the customer has posted something **new** since -> the override is cleared, real data wins.
- If nothing new -> your override is kept.

So a refresh never wrongly wipes your manual status, but a genuine new customer reply still "unlocks" it. Refresh also carefully preserves your `annotations`, `month`, `week` — only the live ADO fields get updated.

---

## 3. Live refresh with a progress bar (SSE)

`GET /api/tickets/refresh-stream` uses **Server-Sent Events** — a one-way live stream from server to browser. Instead of waiting for all tickets to finish and returning one big response, it pushes an update **as each ticket finishes**:

```
data: {"type":"progress","done":12,"total":40,"pct":30,...}
```

Two clever bits:

- **Concurrency limit of 10** — it refreshes 10 tickets at once (not all 40 -> avoids hammering ADO), and as each one finishes it launches the next. Like a 10-lane queue that stays full.
- The browser reads each `progress` event and animates the % bar, then a final `done` event closes the stream.

Token caching helps too: the ADO access token is fetched once from `az` and reused across all refreshes until it nearly expires.

---

## 4. The AI analysis pipeline (`orchestrator.js`)

When you click analyze (`POST /api/analyze`), the **orchestrator** runs a 4-step "brain loop." Every step reports progress so the UI shows what's happening:

1. **Fetch** — pulls the work item + all comments *in parallel*, plus VS Feedback **diagnostics** (screen recordings, ETL/dump, logs — these live in a separate VS Feedback backend, not on the ADO item).
2. **Find duplicates** — searches ADO for similar tickets by title/area, merges them with any linked IDs, keeps the **top 3**, and fetches their details.
3. **Think (LLM)** — sends the ticket data to GitHub Copilot for a structured analysis, and (if duplicates exist) a cross-reference "is this the same root cause?" analysis.
4. **Remember** — saves the report into the **SQLite** database (`agent.db`) so it's cached next time.

Every external call is wrapped in `.catch()` — if duplicate search or diagnostics fail, the analysis still completes instead of crashing.

---

## 5. The AI engine (`llm-client.js`) — no API keys

Instead of OpenAI keys, it uses the **`@github/copilot-sdk`**, which piggybacks on your existing GitHub Copilot subscription:

1. On first use it starts a Copilot client and checks `isAuthenticated`. If you're not signed in, it throws a clear error.
2. For each request it opens a **session** with `approveAll` (so it doesn't pause asking for permission), combines a *system prompt* + your ticket data, and calls `sendAndWait`.
3. When done, it stops the Copilot process to free resources.

There are pre-written **system prompts** for each job: `analyze`, `crossReference`, `nmiReply`, `reproReply`, `enhanceReply`. So generating a "Need More Info" reply vs a "Reproduced successfully" reply is just swapping the prompt.

One nice detail: `ensureDeveloperSeparator()` post-processes repro replies to guarantee a clean dashed line above the "To Developer" section — even if the AI formats it inconsistently. It's **idempotent** (running it twice won't add two lines).

---

## 6. Two databases, two jobs

| Store | Format | Holds | Why this choice |
|-------|--------|-------|-----------------|
| `data/tickets.json` | plain JSON | your tracked ticket list + annotations | simple, human-readable, easy to back up |
| `data/agent.db` | SQLite (`sql.js`) | AI analysis history, replies, SLA | queryable "memory" so past analyses are cached |

`sql.js` is **pure JavaScript SQLite** — no native compilation, so `npm install` never fails on a missing C++ build tool. It loads the DB file into memory and writes it back as a buffer.

---

## 7. Why the data is hard to lose

`tickets.json` is your real asset, so writes are defensive:

1. Build the JSON and **validate** it parses.
2. Copy the current file to `.bak`.
3. Write to a `.tmp` file, then **atomically rename** it over the real file (a rename can't leave a half-written file).
4. On startup, if the main file is corrupt, it **auto-recovers from `.bak`**.
5. A timer runs a **daily backup** into the `backup/` folder with a date stamp.

There's even a write-queue (`writeInProgress` / `writePending`) so two saves at once can't collide.

---

## API endpoints (reference)

| Method + path | Purpose |
|---------------|---------|
| `GET /api/tickets` | List all tracked tickets |
| `POST /api/tickets` | Add tickets by ID |
| `PUT /api/tickets/:id` | Update annotations (repro status, notes, actions) |
| `DELETE /api/tickets/:id` | Remove a ticket |
| `POST /api/tickets/refresh-batch` | Bulk refresh by IDs |
| `GET /api/tickets/refresh-stream` | Live refresh with SSE progress |
| `POST /api/tickets/:id/refresh` | Refresh a single ticket |
| `GET /api/backlog` | Older untouched tickets |
| `GET /api/dashboard` | Weekly / repro statistics |
| `GET /api/weeks/:month` | Week breakdown for a month |
| `POST /api/copilot/open-cli` | Open Copilot CLI with the ticket prompt |
| `POST /api/analyze` | AI-powered ticket analysis |
| `POST /api/reply` | Generate an AI reply (nmi / repro / enhance) |
| `GET /api/history` | Past AI analyses from SQLite |

---

## Mental model of the whole thing

> A hidden Node server is your **local backend**. The browser page is a **remote control**. Azure CLI is the **key** to ADO. Copilot is the **analyst**. JSON is your **ticket notebook**, SQLite is the analyst's **memory**, and `.bak` / `backup/` are the **safety nets**.
