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

## Notes
- `config.json`, `data/`, and `backup/` are git-ignored since they contain personal identity info and real ticket content.
- This repo contains only the application source — screenshots, repro artifacts, and diagnostic dumps generated during use are excluded.
