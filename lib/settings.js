/**
 * Settings store — user-configurable options for the tracker.
 * Persisted to data/settings.json. Missing keys fall back to DEFAULTS,
 * so old settings files keep working after new options are added.
 */
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'settings.json');

const DEFAULTS = {
  analysis: {
    // Cross-reference (potential-duplicate) analysis in Ticket Analyst.
    // When off, the duplicate search + cross-reference LLM pass are skipped
    // (faster analysis, fewer ADO calls).
    crossReference: true,
    // How many potential duplicates to fetch/show (0-5).
    maxSimilarTickets: 3,
    // Only search duplicates created within this many days.
    similarLookbackDays: 365,
    // Fetch VS Feedback diagnostic attachments (recordings, ETL/dump, logs)
    // from the VS Feedback backend during analysis.
    includeDiagnostics: true,
  },
  ai: {
    // Copilot model used by the analyst / reply generator.
    copilotModel: 'gpt-5.4-mini',
  },
  reply: {
    // Include ticket-specific "-Optional-" questions (🔍) in generated
    // NMI / enhanced replies. When off, only the 9 base questions are produced.
    includeOptionalQuestions: true,
  },
  interface: {
    // Auto-refresh all tickets when the dashboard loads.
    autoRefreshOnLoad: true,
    // Show the "Backlog Alert" banner for un-actioned old tickets.
    showBacklogAlert: true,
  },
  data: {
    // How many days of daily ticket backups to keep.
    backupRetentionDays: 30,
  },
};

// Deep-merge stored settings over defaults (one level of nesting is enough here).
function mergeWithDefaults(stored) {
  const out = {};
  for (const section of Object.keys(DEFAULTS)) {
    out[section] = { ...DEFAULTS[section], ...(stored?.[section] || {}) };
  }
  return out;
}

function getSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
      if (raw.trim()) return mergeWithDefaults(JSON.parse(raw));
    }
  } catch (err) {
    console.error('[settings] Failed to read settings, using defaults:', err.message);
  }
  return mergeWithDefaults({});
}

function saveSettings(patch) {
  // Re-merge each section so a partial patch (e.g. only "analysis") is preserved.
  const current = getSettings();
  const merged = mergeWithDefaults(current);
  for (const section of Object.keys(DEFAULTS)) {
    merged[section] = { ...current[section], ...(patch?.[section] || {}) };
  }
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

module.exports = { getSettings, saveSettings, DEFAULTS };
