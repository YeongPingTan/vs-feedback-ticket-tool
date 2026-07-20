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

## Copilot Prompts

Use these prompts in GitHub Copilot Chat (VS Code or github.com) while working on this repo:

### Understand the codebase
```
Explain how a ticket flows from the ADO API through the orchestrator to the UI in this app.
```
```
What does lib/devdiv.js do and how does it identify which comments belong to the team vs the customer?
```

### Make changes
```
Add a new Express route in app.js that returns the 10 most recently updated tickets from the local store.
```
```
Refactor the LLM call in lib/llm-client.js to support a configurable system prompt passed as a parameter.
```

### Debug / investigate
```
Why might the app throw on startup when config.json is missing? Walk me through the startup path.
```
```
The ADO client is returning 401. What environment variables or login state should I check first?
```

### AI / agent work
```
Write a new orchestrator action that summarizes all open tickets by priority and returns a markdown report.
```
```
Extend the agent in lib/orchestrator.js to detect if a ticket has had no reply in 7+ days and flag it.
```

## Notes
- `config.json`, `data/`, and `backup/` are git-ignored since they contain personal identity info and real ticket content.
- This repo contains only the application source — screenshots, repro artifacts, and diagnostic dumps generated during use are excluded.
