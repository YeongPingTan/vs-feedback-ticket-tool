# 🎫 VS Feedback Tracker — Setup Guide

---

## 🚀 Setup (1 Step Only)

1. Save the `vs-feedback-tracker` folder anywhere on your machine (Downloads, Desktop, etc.)
2. Open **Copilot CLI** or **VS Code Copilot Chat** (from any location — you do NOT need to `cd` into the folder)
3. Copy the prompt below **as-is** and paste it — Copilot will handle everything automatically

---

## 🔧 Setup Prompt — Copy & Paste This

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

> **That's it!** Copilot will install prerequisites, detect your identity, move the folder, configure files, create a desktop shortcut, log you into Azure, and verify everything works.

---

## ✅ After Setup

### How to launch

| Method | What happens |
|--------|-------------|
| 🖱️ **Desktop shortcut** | Double-click **VS Feedback Tracker** → starts server silently in background → opens browser to `localhost:3000` |
| 📂 **VBS launcher** | Double-click `start.vbs` in the project folder (same as shortcut) |
| 💻 **Terminal** | `cd C:\Users\<alias>\vs-feedback-tracker && node app.js` then open http://localhost:3000 |

### How to stop the server

| Method | Command |
|--------|---------|
| **If launched via terminal** | Press `Ctrl+C` in the terminal |
| **If launched via shortcut / VBS** | Open Task Manager → find `node.exe` → End Task |
| **PowerShell** | `Get-Process node \| Stop-Process` |

> ⚠️ **First time?** You must run `az login` once before using the app. The setup prompt does this for you, but if your token expires, run it again.

---

## 📖 How the System Works

### Architecture

```
Desktop Shortcut (.lnk)
  → start.vbs (runs node silently + opens browser)
    → node app.js (Express server on port 3000)
      → lib/devdiv.js (fetches tickets from Azure DevOps via az cli token)
      → data/tickets.json (local storage)
      → public/ (HTML/CSS/JS frontend)
```

### What `start.vbs` does
1. Runs `node app.js` as a **hidden background process** (no terminal window)
2. Waits 1.5 seconds for the server to start
3. Opens your default browser to `http://localhost:3000`

### What the setup configures

| # | File | Change | Why |
|---|------|--------|-----|
| 1 | `config.json` | Your alias, email, full name | Single config — identifies your replies vs customer replies |
| 2 | `data/tickets.json` | Reset to empty `{}` | Start fresh with your own ticket list |
| 3 | Desktop | Shortcut with `tracker.ico` | One-click launch |

### Key files

| File | Purpose |
|------|---------|
| `config.json` | **Your identity** — alias, email, full name (only file to configure) |
| `app.js` | Express server — all API endpoints |
| `lib/devdiv.js` | Azure DevOps ticket fetcher + reply detection |
| `public/index.html` | Main UI |
| `public/script.js` | Frontend logic (add/remove tickets, refresh, etc.) |
| `public/style.css` | Styling |
| `data/tickets.json` | Local ticket storage (JSON) |
| `start.vbs` | Silent launcher (background server + open browser) |
| `tracker.ico` | App icon for desktop shortcut |

---

## 🔧 Troubleshooting

| Problem | Solution |
|---------|----------|
| `node: command not found` | Install: `winget install OpenJS.NodeJS.LTS` — then **restart terminal** |
| `az: command not found` | Install: `winget install Microsoft.AzureCLI` — then **restart terminal** |
| Tickets show "No auth" | Run `az login` in terminal — your token may have expired |
| Port 3000 already in use | Stop existing node: `Get-Process node \| Stop-Process`, then relaunch |
| Shortcut doesn't work | Right-click shortcut → Properties → check Target points to `start.vbs` |
| Browser opens but page is blank | Server may not have started — try `node app.js` manually to see errors |
| `npm install` fails | Check Node.js is installed: `node --version` (need v18+) |
