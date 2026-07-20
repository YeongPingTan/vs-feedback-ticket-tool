# Copilot instructions for this repo

This is a small Node.js/Express app (no build step, no TypeScript, no bundler).

## Setting up the environment
1. Install dependencies: `npm install`
2. Copy `config.json.example` to `config.json` and fill in a real alias/email/fullName
   (required — `lib/devdiv.js` reads this synchronously at startup and will throw if missing)
3. Auth to Azure DevOps: either run `az login` (the app calls `az account get-access-token`
   at runtime), or set the `ADO_PAT` environment variable to a personal access token
4. Run the app: `npm start` (equivalent to `node app.js`), served on port 3000
   (override with the `PORT` env var, consumed by `agent-config.js`)

## Conventions
- Plain CommonJS (`require`/`module.exports`), no ES modules, no TypeScript
- Server code lives in `app.js` (Express routes) and `lib/*.js` (ADO client, DB, LLM client, orchestrator, settings, VS repro helpers)
- Frontend is plain HTML/CSS/JS in `public/` — no framework, no build step
- Ticket data persists to `data/tickets.json`; daily snapshots go to `backup/` — both are git-ignored, do not commit real ticket content
- `agent-config.js` is the single source of runtime config (Copilot model, ADO org/project, server port, DB path), all overridable via environment variables
- There is no automated test suite; validate changes by running `node app.js` and exercising the affected route/UI manually
