# VS Feedback Tracker

A local web app + AI agent for tracking, analyzing, and drafting replies to Visual Studio Developer Community (DevCom) feedback tickets, backed by Azure DevOps.

## Features
- Pulls ticket details/comments from Azure DevOps (DevDiv) and Developer Community
- Web dashboard (`public/`) to browse and manage tickets
- AI agent (`lib/orchestrator.js` + GitHub Copilot SDK) to analyze tickets and draft replies
- Local SQLite-backed cache (`sql.js`) and JSON ticket store with daily backups

## Requirements
- Node.js >= 18
- Azure CLI (`az`) logged in with access to the `devdiv` Azure DevOps org, **or** an `ADO_PAT` personal access token
- A GitHub Copilot subscription (used via `@github/copilot-sdk`, no separate API key needed)

## Setup
1. `npm install`
2. `Copy-Item config.json.example config.json` and fill in your alias, email, and full name
   (used to distinguish your replies from customer replies on a ticket)
3. Optionally set environment variables to override defaults in `agent-config.js`:
   - `ADO_ORG`, `ADO_PROJECT`, `ADO_BASE_URL`, `ADO_PAT`
   - `COPILOT_MODEL`
   - `PORT`, `DB_PATH`
4. `npm start` (or `node app.js`) — the server starts on `http://localhost:3000` (see `PORT` in `app.js`/`agent-config.js`)

## Project layout
```
app.js                  Express server, ticket cache, REST API
agent-config.js         Central config (Copilot model, ADO org/project, server port, DB path)
lib/
  ado-client.js         Azure DevOps REST/API client
  devdiv.js             Developer Community ticket + comment fetching, identity matching
  db.js                 sql.js-backed local database
  llm-client.js         Copilot SDK wrapper for AI analysis/replies
  orchestrator.js        Agent orchestration logic
  settings.js           Runtime settings persistence
  vs-repro.js            Visual Studio live-repro automation helpers
public/                 Static dashboard UI (index.html, agent.html, script.js, style.css)
data/                   Local ticket store (tickets.json) — created at runtime, not committed
backup/                 Daily ticket backups — created at runtime, not committed
```

See `SETUP-GUIDE.md` for a step-by-step walkthrough and `TECHNICAL-OVERVIEW.md` for architecture details.

## 🚀 Setup with Copilot

Open **VS Code Copilot Chat** or **Copilot CLI**, then paste the prompt below — Copilot will handle the full setup automatically.

````
I just received the vs-feedback-tracker project and need to set it up on my machine.
Copilot, please do ALL of the following steps automatically:

STEP 1 — CHECK & INSTALL PREREQUISITES
- Check if Node.js (v18+) is installed by running: node --version
  If not installed, run: winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
- Check if Azure CLI is installed by running: az --version
  If not installed, run: winget install Microsoft.AzureCLI --accept-source-agreements --accept-package-agreements
- IMPORTANT: If you installed anything above, restart the terminal session so the new
  commands are available in PATH before continuing.

STEP 2 — DETECT MY IDENTITY
- Get my Windows alias by running: $env:USERNAME
  (this gives just the alias, e.g., "v-xxx")
- Get my full name by running: net user $env:USERNAME /domain 2>$null | Select-String "Full Name"
  (extract just the name part after "Full Name", e.g., "John Smith")
- Set these variables:
  - MY_ALIAS = the alias from above (e.g., v-xxx)
  - MY_EMAIL = MY_ALIAS@microsoft.com
  - MY_FULL_NAME = the full name from above, in lowercase (e.g., john smith)
- Show me the detected values and ask me to confirm before proceeding.

STEP 3 — LOCATE & MOVE PROJECT FOLDER
- Search for the vs-feedback-tracker folder on my machine. Check these locations:
  - C:\Users\MY_ALIAS\vs-feedback-tracker (already in place — skip move)
  - C:\Users\MY_ALIAS\Downloads\vs-feedback-tracker
  - C:\Users\MY_ALIAS\Downloads\vs-feedback-ticket-tool-main\vs-feedback-ticket-tool-main
  - C:\Users\MY_ALIAS\Desktop\vs-feedback-tracker
  - C:\Users\MY_ALIAS\Documents\vs-feedback-tracker
- If found outside the target path, COPY it (don't move — in case terminal has a lock) to:
  C:\Users\MY_ALIAS\vs-feedback-tracker
- If not found in any of the above, ask me where I saved it.

STEP 4 — CONFIGURE THE PROJECT
- Edit C:\Users\MY_ALIAS\vs-feedback-tracker\config.json — this is the ONLY config
  file. Replace all 3 values with my detected identity:
  {
    "alias": "MY_ALIAS",
    "email": "MY_EMAIL",
    "fullName": "MY_FULL_NAME"
  }
  (The app reads this file automatically — no need to edit any other source files.)

- Create the ticket data file at
  C:\Users\MY_ALIAS\vs-feedback-tracker\data\tickets.json with this content:
  { "tickets": [] }

STEP 5 — INSTALL DEPENDENCIES
- cd into C:\Users\MY_ALIAS\vs-feedback-tracker
- Run: npm install

STEP 6 — CREATE DESKTOP SHORTCUT
- Create a Windows shortcut (.lnk) on my desktop:
  - Name: VS Feedback Tracker
  - Target: C:\Users\MY_ALIAS\vs-feedback-tracker\start.vbs
  - Start in: C:\Users\MY_ALIAS\vs-feedback-tracker
  - Icon: C:\Users\MY_ALIAS\vs-feedback-tracker\tracker.ico
- Use PowerShell with WScript.Shell COM object to create the .lnk file.

STEP 7 — AZURE LOGIN
- Run: az login
- Wait for me to complete the browser login flow before continuing.

STEP 8 — VERIFY
- cd into C:\Users\MY_ALIAS\vs-feedback-tracker
- Run: node app.js
- Confirm the server starts and is accessible at http://localhost:3000
- After verifying, stop the server (Ctrl+C).
- Tell me setup is complete and I can use the desktop shortcut to launch the app.

IMPORTANT:
- Don't change anything else in the project files.
- Use full absolute paths (not relative) for all file operations.
- Replace MY_ALIAS, MY_EMAIL, MY_FULL_NAME with the actual detected values everywhere.
````

> See `SETUP-GUIDE.md` for the full walkthrough including how to launch and stop the app.

## Notes
- `config.json`, `data/`, and `backup/` are git-ignored since they contain personal identity info and real ticket content.
- This repo contains only the application source — screenshots, repro artifacts, and diagnostic dumps generated during use are excluded.
