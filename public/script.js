// ============================================
// VS Feedback Ticket Tracker — Frontend Logic
// ============================================

const API = '/api';
let allTickets = [];
let weeklyChart = null;
let statusChart = null;
let reproChart = null;
let appSettings = null;

// Force scroll to top on page load/refresh
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

// ---- INIT ----
document.addEventListener('DOMContentLoaded', async () => {
  window.scrollTo(0, 0);
  await loadSettings();
  initDefaults();
  bindEvents();
  updateHeaderClock();
  setInterval(updateHeaderClock, 1000);
  await loadTickets();
  loadDashboard();
  loadBacklog();

  // Track which tickets have a live Ticket Analyst tab open (via heartbeat)
  refreshAnalyzingState();
  setInterval(refreshAnalyzingState, ANALYZING_POLL_MS);
  window.addEventListener('storage', (e) => {
    if (e.key && e.key.startsWith(ANALYZING_PREFIX)) refreshAnalyzingState();
  });

  // Auto-refresh tickets on page load (respects the "Auto-refresh on load" setting)
  if (allTickets.length > 0 && appSettings?.interface?.autoRefreshOnLoad !== false) {
    refreshAll();
  }
});

// ---- ANALYZING STATE (live agent-tab detection) ----
// Primary signal is the Web Locks API: each Ticket Analyst tab holds a lock named
// "analyzing:<id>" for its whole lifetime, and the browser releases it automatically
// the instant the tab closes, crashes, or is discarded (e.g. Edge "sleeping tabs").
// The tracker reads live locks via navigator.locks.query(), so the badge clears
// promptly and reliably without depending on the closing tab to run cleanup code.
//
// A localStorage heartbeat is kept as (a) a short optimistic bridge that lights the
// badge from the moment you click until the new tab acquires its lock, and (b) a
// fallback liveness signal (with a generous stale window to tolerate background-tab
// timer throttling) for any browser lacking the Web Locks API.
const ANALYZING_PREFIX = 'analyzing:';
const ANALYZING_STALE_MS = 300000; // 5 min: tolerate background-tab timer throttling
const ANALYZING_POLL_MS = 2000;    // how often the tracker re-evaluates the heartbeats
const ANALYZING_BRIDGE_MS = 12000; // short optimistic-bridge window: from click until the
                                   // new analyst tab acquires its Web Lock (locks-capable browsers)
let analyzingTickets = new Set();

async function computeAnalyzingTickets() {
  const now = Date.now();
  const set = new Set();

  // 1) Authoritative signal: Web Locks held by live analyst tabs. The browser
  //    releases a lock the instant its tab closes, crashes, or is discarded — with
  //    no reliance on beforeunload/pagehide and immune to background-timer
  //    throttling — so the badge clears promptly when a tab is actually gone.
  let locksSupported = false;
  try {
    if (navigator.locks && navigator.locks.query) {
      locksSupported = true;
      const state = await navigator.locks.query();
      const live = [...(state.held || []), ...(state.pending || [])];
      for (const l of live) {
        if (l.name && l.name.startsWith(ANALYZING_PREFIX)) set.add(l.name.slice(ANALYZING_PREFIX.length));
      }
    }
  } catch (e) { locksSupported = false; }

  // 2) localStorage heartbeats: an optimistic bridge (just-clicked, tab not yet
  //    holding its lock) when locks are supported, or the full liveness signal when
  //    they are not. A stale/garbage entry is pruned.
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(ANALYZING_PREFIX)) continue;
    const id = key.slice(ANALYZING_PREFIX.length);
    if (set.has(id)) continue;
    const ts = parseInt(localStorage.getItem(key), 10);
    const windowMs = locksSupported ? ANALYZING_BRIDGE_MS : ANALYZING_STALE_MS;
    if (ts && now - ts < windowMs) {
      set.add(id);
    } else {
      // No live lock and outside the bridge/stale window → the tab is gone.
      localStorage.removeItem(key);
    }
  }
  return set;
}

function analyzingSetsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

async function refreshAnalyzingState() {
  const next = await computeAnalyzingTickets();
  if (!analyzingSetsEqual(next, analyzingTickets)) {
    analyzingTickets = next;
    if (allTickets.length > 0) renderTickets();
  }
}

function updateHeaderClock() {
  const now = new Date();
  const opts = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
  document.getElementById('header-datetime').textContent = now.toLocaleDateString('en-US', opts);
}

function initDefaults() {
  const now = new Date();
  const monthSelect = document.getElementById('input-month');

  // Generate months from Jan 2026 to current month
  const months = [];
  const startDate = new Date(2026, 0, 1); // Jan 2026
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  for (let d = new Date(startDate); d <= now; d.setMonth(d.getMonth() + 1)) {
    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = `${names[d.getMonth()]} ${d.getFullYear()}`;
    months.push({ val, label });
  }

  monthSelect.innerHTML = months.map(m =>
    `<option value="${m.val}">${m.label}</option>`
  ).join('');

  // Default to current month
  const currentMonth = getCurrentMonth();
  monthSelect.value = currentMonth;

  // When month changes, update week options
  monthSelect.addEventListener('change', updateInputWeeks);

  // Load weeks for current month
  updateInputWeeks();
}

async function updateInputWeeks() {
  const month = document.getElementById('input-month').value;
  const weekSelect = document.getElementById('input-week');
  if (!month) return;

  try {
    const res = await fetch(`${API}/weeks/${month}`);
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const data = await res.json();

    const currentMonth = getCurrentMonth();
    const curWeek = getCurrentWeek();

    // For current month, only show weeks up to current week
    let weeks = data.weeks;
    if (month === currentMonth) {
      weeks = weeks.filter(w => w.week <= curWeek);
    }

    weekSelect.innerHTML = weeks.map(w =>
      `<option value="${w.week}">${w.label}</option>`
    ).join('');

    // Default to current week if it's the current month
    if (month === currentMonth) {
      const todayWeek = weeks.find(w => w.week === curWeek);
      if (todayWeek) weekSelect.value = todayWeek.week;
    }
  } catch (e) {
    weekSelect.innerHTML = [1, 2, 3, 4, 5].map(w => `<option value="${w}">Week ${w}</option>`).join('');
  }
}

function bindEvents() {
  // Modal
  document.getElementById('btn-open-modal').addEventListener('click', openModal);
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-cancel-modal').addEventListener('click', closeModal);
  document.getElementById('add-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });

  // Add tickets
  document.getElementById('btn-add').addEventListener('click', addTickets);
  document.getElementById('btn-refresh-all').addEventListener('click', refreshAll);

  // Settings
  document.getElementById('btn-open-settings').addEventListener('click', openSettings);
  document.getElementById('btn-cancel-settings').addEventListener('click', cancelSettings);
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);
  document.getElementById('btn-reset-settings').addEventListener('click', resetSettings);
  document.getElementById('settings-modal').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) cancelSettings();
  });

  // Settings jump-to sidebar: click to scroll, plus scroll-spy highlight
  (function initSettingsNav() {
    const nav = document.getElementById('settings-nav');
    const content = document.getElementById('settings-content');
    if (!nav || !content) return;
    const links = Array.from(nav.querySelectorAll('a'));

    links.forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const target = document.querySelector(a.getAttribute('href'));
        if (!target) return;
        const dy = target.getBoundingClientRect().top - content.getBoundingClientRect().top;
        content.scrollBy({ top: dy - 8, behavior: 'smooth' });
        links.forEach(x => x.classList.remove('active'));
        a.classList.add('active');
      });
    });

    content.addEventListener('scroll', () => {
      const contentTop = content.getBoundingClientRect().top;
      let current = links[0];
      links.forEach(a => {
        const t = document.querySelector(a.getAttribute('href'));
        if (t && t.getBoundingClientRect().top - contentTop <= 24) current = a;
      });
      links.forEach(x => x.classList.toggle('active', x === current));
    }, { passive: true });

    if (links[0]) links[0].classList.add('active');
  })();

  // Export / Import
  document.getElementById('btn-export-json').addEventListener('click', () => exportTickets('json'));
  document.getElementById('btn-export-csv').addEventListener('click', () => exportTickets('csv'));
  document.getElementById('btn-import').addEventListener('click', () => document.getElementById('import-file').click());
  document.getElementById('import-file').addEventListener('change', importTickets);

  // Filters
  document.getElementById('filter-month').addEventListener('change', () => {
    updateWeekFilter();
    renderTickets();
    // Sync dashboard month with ticket list month
    const filterVal = document.getElementById('filter-month').value;
    const dashMonth = document.getElementById('dashboard-month');
    if (filterVal && dashMonth) {
      dashMonth.value = filterVal;
      loadDashboard();
    }
  });
  document.getElementById('filter-week').addEventListener('change', renderTickets);
  document.getElementById('filter-status').addEventListener('change', renderTickets);
  document.getElementById('btn-clear-filters').addEventListener('click', clearFilters);

  // Dashboard month filter
  document.getElementById('dashboard-month')?.addEventListener('change', () => {
    loadDashboard();
    // Sync ticket list month with dashboard month
    const dashVal = document.getElementById('dashboard-month').value;
    const filterMonth = document.getElementById('filter-month');
    if (dashVal && filterMonth && filterMonth.value !== dashVal) {
      filterMonth.value = dashVal;
      updateWeekFilter();
      renderTickets();
    }
  });

  // Search
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');
  searchInput.addEventListener('input', () => {
    const query = searchInput.value.trim();
    if (!query) {
      searchResults.classList.remove('open');
      return;
    }
    const matches = allTickets.filter(t =>
      t.id.includes(query) || (t.title && t.title.toLowerCase().includes(query.toLowerCase()))
    ).slice(0, 10);
    if (matches.length === 0) {
      searchResults.innerHTML = '<div class="search-result-item" style="color:#9ca3af;">No tickets found</div>';
    } else {
      searchResults.innerHTML = matches.map(t =>
        `<button class="search-result-item" tabindex="0" onclick="scrollToTicket('${t.id}')">
          <span class="result-id">#${t.id}</span>
          <span class="result-title">${escapeHtml((t.title || '').substring(0, 60))}</span>
        </button>`
      ).join('');
    }
    searchResults.classList.add('open');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrapper')) {
      searchResults.classList.remove('open');
    }
  });
}

// ---- MODAL ----
function openModal() {
  // Always reset to current month and current week
  const currentMonth = getCurrentMonth();
  document.getElementById('input-month').value = currentMonth;
  updateInputWeeks();
  document.getElementById('add-modal').style.display = 'flex';
}

function closeModal() {
  document.getElementById('add-modal').style.display = 'none';
}

// ---- SETTINGS ----
const SETTINGS_DEFAULTS = {
  analysis: { crossReference: true, maxSimilarTickets: 3, similarLookbackDays: 365, includeDiagnostics: true },
  ai: { copilotModel: 'gpt-5.4-mini' },
  reply: { includeOptionalQuestions: true },
  interface: { autoRefreshOnLoad: true, showBacklogAlert: true },
  data: { backupRetentionDays: 30 },
};

// Snapshot of the form state when the modal was opened — used to detect unsaved changes.
let settingsSnapshot = null;

async function loadSettings() {
  try {
    const res = await fetch(`${API}/settings`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    appSettings = data.settings || SETTINGS_DEFAULTS;
  } catch (e) {
    appSettings = JSON.parse(JSON.stringify(SETTINGS_DEFAULTS));
  }
}

function populateSettingsForm(s) {
  document.getElementById('set-crossReference').checked = s.analysis.crossReference !== false;
  document.getElementById('set-maxSimilarTickets').value = s.analysis.maxSimilarTickets;
  document.getElementById('set-similarLookbackDays').value = s.analysis.similarLookbackDays;
  document.getElementById('set-includeDiagnostics').checked = s.analysis.includeDiagnostics !== false;
  document.getElementById('set-copilotModel').value = s.ai.copilotModel;
  document.getElementById('set-includeOptionalQuestions').checked = s.reply.includeOptionalQuestions !== false;
  document.getElementById('set-autoRefreshOnLoad').checked = s.interface.autoRefreshOnLoad !== false;
  document.getElementById('set-showBacklogAlert').checked = s.interface.showBacklogAlert !== false;
  document.getElementById('set-backupRetentionDays').value = s.data.backupRetentionDays;
}

function openSettings() {
  populateSettingsForm(appSettings || SETTINGS_DEFAULTS);
  settingsSnapshot = JSON.stringify(readSettingsForm());
  document.getElementById('settings-modal').style.display = 'flex';
  // Reset the jump-to sidebar: scroll content to top, highlight first section
  const content = document.getElementById('settings-content');
  const nav = document.getElementById('settings-nav');
  if (content) content.scrollTop = 0;
  if (nav) {
    const links = nav.querySelectorAll('a');
    links.forEach((a, i) => a.classList.toggle('active', i === 0));
  }
}

function closeSettings() {
  document.getElementById('settings-modal').style.display = 'none';
}

// Cancel with an unsaved-changes guard (OK = save, Cancel = discard).
async function cancelSettings() {
  const dirty = settingsSnapshot !== null && JSON.stringify(readSettingsForm()) !== settingsSnapshot;
  if (dirty) {
    const save = window.confirm(
      'You have unsaved changes.\n\nOK — Save changes\nCancel — Discard changes'
    );
    if (save) {
      await saveSettings();
      return;
    }
  }
  closeSettings();
}

function readSettingsForm() {
  const clamp = (v, min, max, def) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  };
  return {
    analysis: {
      crossReference: document.getElementById('set-crossReference').checked,
      maxSimilarTickets: clamp(document.getElementById('set-maxSimilarTickets').value, 0, 5, 3),
      similarLookbackDays: clamp(document.getElementById('set-similarLookbackDays').value, 1, 3650, 365),
      includeDiagnostics: document.getElementById('set-includeDiagnostics').checked,
    },
    ai: {
      copilotModel: document.getElementById('set-copilotModel').value,
    },
    reply: {
      includeOptionalQuestions: document.getElementById('set-includeOptionalQuestions').checked,
    },
    interface: {
      autoRefreshOnLoad: document.getElementById('set-autoRefreshOnLoad').checked,
      showBacklogAlert: document.getElementById('set-showBacklogAlert').checked,
    },
    data: {
      backupRetentionDays: clamp(document.getElementById('set-backupRetentionDays').value, 1, 365, 30),
    },
  };
}

async function saveSettings() {
  const patch = readSettingsForm();
  try {
    const res = await fetch(`${API}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    appSettings = data.settings;
    settingsSnapshot = JSON.stringify(readSettingsForm());
    closeSettings();
    showToast('✅ Settings saved');
    // Re-apply interface settings that affect the current view
    loadBacklog();
  } catch (e) {
    showToast(`❌ Failed to save settings: ${e.message}`, 'warn');
  }
}

function resetSettings() {
  populateSettingsForm(JSON.parse(JSON.stringify(SETTINGS_DEFAULTS)));
  showToast('Defaults loaded — click Save to apply');
}

// ---- EXPORT / IMPORT ----
function exportTickets(format) {
  if (!allTickets.length) {
    showToast('No tickets to export', 'warn');
    return;
  }
  // Trigger a browser download from the export endpoint.
  const a = document.createElement('a');
  a.href = `${API}/tickets/export?format=${format}`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast(`⬇️ Exporting tickets as ${format.toUpperCase()}...`);
}

async function importTickets(e) {
  const input = e.target;
  const file = input.files && input.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('File is not valid JSON');
    }
    const tickets = Array.isArray(parsed) ? parsed : parsed.tickets;
    if (!Array.isArray(tickets)) {
      throw new Error('Expected a JSON export with a "tickets" array');
    }

    const proceed = window.confirm(
      `Import ${tickets.length} ticket(s)?\n\n` +
      'Existing tickets with the same ID will be updated; new ones will be added.'
    );
    if (!proceed) return;

    const res = await fetch(`${API}/tickets/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tickets, mode: 'merge' }),
    });
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // Server returned a non-JSON body (e.g. an HTML error page).
      throw new Error(
        res.status === 413
          ? 'File too large for the server to accept. Restart the app to pick up the increased upload limit.'
          : `Server returned an unexpected response (HTTP ${res.status})`
      );
    }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    showToast(`✅ ${data.message} (${data.added} added, ${data.updated} updated)`);
    await loadTickets();
    loadDashboard();
    loadBacklog();
    // Import is applied immediately (no separate save step), so close the
    // Settings modal automatically to avoid confusing the user about
    // whether they still need to click "Save Settings".
    closeSettings();
  } catch (err) {
    showToast(`❌ Import failed: ${err.message}`, 'warn');
  } finally {
    // Reset so selecting the same file again re-triggers change.
    input.value = '';
  }
}

function scrollToTicket(id) {
  // Clear filters to show all tickets so the target is visible
  document.getElementById('filter-month').value = '';
  document.getElementById('filter-week').innerHTML = '<option value="">All Weeks</option>';
  document.getElementById('filter-week').value = '';
  renderTickets();

  // Close search
  document.getElementById('search-results').classList.remove('open');
  document.getElementById('search-input').value = '';

  // Find and scroll to ticket card
  setTimeout(() => {
    const cards = document.querySelectorAll('.ticket-card');
    for (const card of cards) {
      if (card.querySelector(`.ticket-id`)?.textContent === `#${id}`) {
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        card.style.outline = '2px solid #4a9eff';
        setTimeout(() => card.style.outline = '', 2000);
        break;
      }
    }
  }, 100);
}

function clearFilters() {
  document.getElementById('filter-month').value = getCurrentMonth();
  document.getElementById('filter-status').value = '';
  updateWeekFilter();
}

// ---- TICKETS ----
async function loadTickets() {
  try {
    const res = await fetch(`${API}/tickets`);
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const data = await res.json();
    allTickets = data.tickets || [];
    updateMonthFilters();
    renderTickets();
  } catch (e) {
    showToast('Failed to load tickets');
  }
}

async function addTickets() {
  const input = document.getElementById('ticket-ids-input').value.trim();
  if (!input) return showToast('Please enter ticket IDs');

  const ids = input.split(/[\n,\s]+/).map(id => id.replace(/\D/g, '')).filter(Boolean);
  if (ids.length === 0) return showToast('No valid IDs found');

  // Detect duplicate IDs within the input
  const seen = new Set();
  const inputDuplicates = [];
  const uniqueInputIds = [];
  for (const id of ids) {
    if (seen.has(id)) {
      if (!inputDuplicates.includes(id)) inputDuplicates.push(id);
    } else {
      seen.add(id);
      uniqueInputIds.push(id);
    }
  }
  if (inputDuplicates.length > 0) {
    const dupList = inputDuplicates.map(id => `#${id}`).join(', ');
    alert(`⚠️ Duplicate ticket IDs detected in your input:\n\n${dupList}\n\nDuplicates have been removed. Only one copy of each will be added.`);
  }

  const month = document.getElementById('input-month').value;
  const week = parseInt(document.getElementById('input-week').value);

  const btn = document.getElementById('btn-add');
  btn.disabled = true;
  btn.textContent = 'Adding...';

  try {
    const res = await fetch(`${API}/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticketIds: uniqueInputIds, month, week })
    });
    const data = await res.json();

    // Show failed ticket warnings (non-existent or errors)
    if (data.failed && data.failed.length > 0) {
      const failMsg = data.failed.map(id => `#${id}`).join(', ');
      alert(`❌ Ticket(s) not found or invalid:\n\n${failMsg}\n\nThese were not added.`);
    }

    // Show duplicate warnings
    if (data.duplicates && data.duplicates.length > 0) {
      const dupMsg = data.duplicates.map(d =>
        `#${d.id} — already in ${formatMonth(d.month)} Week ${d.week}`
      ).join('\n');
      alert(`⚠️ Duplicate tickets skipped:\n\n${dupMsg}`);
    }

    if (data.added > 0) {
      showToast(`Added ${data.added} ticket(s)`);
      document.getElementById('ticket-ids-input').value = '';
      closeModal();
      await loadTickets();
      loadDashboard();
      loadBacklog();
      window.scrollTo(0, 0);
    } else if (!data.duplicates || data.duplicates.length === 0) {
      showToast('No tickets added');
    }
  } catch (e) {
    showToast('Error adding tickets');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add Tickets';
  }
}

async function refreshAll() {
  const btn = document.getElementById('btn-refresh-all');
  btn.disabled = true;
  btn.textContent = 'Refreshing...';

  const total = allTickets.length;
  if (total === 0) {
    showToast('No tickets saved to refresh');
    btn.disabled = false;
    btn.textContent = '↻ Refresh Tickets';
    return;
  }

  // Show progress bar
  const progressEl = document.getElementById('refresh-progress');
  const progressText = document.getElementById('progress-text');
  const progressPercent = document.getElementById('progress-percent');
  const progressFill = document.getElementById('progress-fill');
  progressEl.style.display = 'flex';
  progressFill.style.width = '0%';
  progressPercent.textContent = '0%';
  progressText.textContent = `Refreshing 0/${total}...`;

  // Use SSE for real-time per-ticket progress
  return new Promise((resolve) => {
    const evtSource = new EventSource(`${API}/tickets/refresh-stream`);
    let finalRefreshed = 0;

    evtSource.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'progress') {
        progressText.textContent = `Refreshing ${msg.done}/${msg.total}... (#${msg.id})`;
        progressFill.style.width = `${msg.pct}%`;
        progressPercent.textContent = `${msg.pct}%`;
        finalRefreshed = msg.refreshed;
      } else if (msg.type === 'done') {
        evtSource.close();
        finalRefreshed = msg.refreshed;
        progressText.textContent = `Done! Refreshed ${msg.refreshed}/${msg.total} tickets.`;
        progressFill.style.width = '100%';
        progressPercent.textContent = '100%';

        setTimeout(() => {
          progressEl.style.display = 'none';
        }, 1500);

        loadTickets().then(() => {
          loadDashboard();
          loadBacklog();
          window.scrollTo(0, 0);
        });

        if (msg.failed > 0) {
          showToast(`Refreshed ${msg.refreshed}/${msg.total} (${msg.failed} failed)`, 'warning');
        } else {
          showToast(`Refreshed ${msg.refreshed} ticket(s)`);
        }
        btn.disabled = false;
        btn.textContent = '↻ Refresh Tickets';
        resolve();
      }
    };

    evtSource.onerror = () => {
      evtSource.close();
      progressText.textContent = 'Refresh failed. Please try again.';
      setTimeout(() => { progressEl.style.display = 'none'; }, 2000);
      btn.disabled = false;
      btn.textContent = '↻ Refresh Tickets';
      resolve();
    };
  });
}

function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function getCurrentWeek() {
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const firstMonday = new Date(firstOfMonth);
  const dayOfWeek = firstOfMonth.getDay();
  const offset = dayOfWeek === 0 ? 1 : (dayOfWeek === 1 ? 0 : 8 - dayOfWeek);
  firstMonday.setDate(1 + offset);

  if (now < firstMonday) return 1;
  const diffDays = Math.floor((now - firstMonday) / (1000 * 60 * 60 * 24));
  return Math.floor(diffDays / 7) + (firstOfMonth.getDay() === 1 ? 1 : 2);
}

function isBacklog(ticket) {
  if (isClosedState(ticket.state)) return false;
  if (!ticket.month || !ticket.week) return false;
  const curMonth = getCurrentMonth();
  const curWeek = getCurrentWeek();
  if (ticket.month > curMonth) return false;
  if (ticket.month === curMonth && ticket.week >= curWeek) return false;
  const ann = ticket.annotations || {};
  const hasReproStatus = ann.reproStatus && ann.reproStatus !== '';
  const hasNotes = ann.notes && ann.notes.trim() !== '';
  const hasReplied = ticket.lastReplyBy === 'me';
  return !hasReplied && !hasReproStatus && !hasNotes;
}

async function removeTicket(id) {
  if (!confirm(`Remove ticket #${id} from tracking?`)) return;
  try {
    const res = await fetch(`${API}/tickets/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('Ticket removed');
    await loadTickets();
    loadBacklog();
  } catch (e) {
    showToast('Error removing ticket');
  }
}

async function refreshTicket(id) {
  try {
    const res = await fetch(`${API}/tickets/${id}/refresh`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showToast('Ticket refreshed');
    await loadTickets();
    loadBacklog();
  } catch (e) {
    showToast('Error refreshing ticket');
  }
}

async function updateAnnotation(id, field, value) {
  try {
    const res = await fetch(`${API}/tickets/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ annotations: { [field]: value } })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Update local ticket data and refresh backlog
    const ticket = allTickets.find(t => t.id === String(id));
    if (ticket) {
      if (!ticket.annotations) ticket.annotations = {};
      ticket.annotations[field] = value;
      renderTickets();
    }
    loadBacklog();
  } catch (e) {
    showToast('Error saving');
  }
}

// ---- RENDERING ----
function renderTickets() {
  const container = document.getElementById('ticket-list');
  let tickets = [...allTickets];

  // Apply filters
  const filterMonth = document.getElementById('filter-month').value;
  const filterWeek = document.getElementById('filter-week').value;
  const filterStatus = document.getElementById('filter-status').value;

  if (filterMonth) tickets = tickets.filter(t => t.month === filterMonth);
  if (filterWeek) tickets = tickets.filter(t => t.week === parseInt(filterWeek));

  // Update status filter counts based on month/week filtered tickets
  updateStatusFilterCounts(tickets);

  if (filterStatus) tickets = tickets.filter(t => getStatusColor(t) === filterStatus);

  // Sort: backlog first, then by urgency
  tickets.sort((a, b) => {
    const aBacklog = isBacklog(a) ? 0 : 1;
    const bBacklog = isBacklog(b) ? 0 : 1;
    if (aBacklog !== bBacklog) return aBacklog - bBacklog;
    return getUrgencyScore(a) - getUrgencyScore(b);
  });

  if (tickets.length === 0) {
    const weekLabel = filterWeek ? ` Week ${filterWeek}` : '';
    const monthLabel = filterMonth ? formatMonth(filterMonth) : '';
    container.innerHTML = `<p class="empty-state">No tickets added for ${monthLabel}${weekLabel} yet.</p>`;
    return;
  }

  container.innerHTML = tickets.map(t => renderTicketCard(t)).join('');
}

function renderTicketCard(ticket) {
  const color = getStatusColor(ticket);
  const adoUrl = `https://devdiv.visualstudio.com/DevDiv/_workitems/edit/${ticket.id}`;
  const devComUrl = ticket.devComLink || ticket.url || '';
  const ann = ticket.annotations || {};

  let replyHtml = '';
  if (isClosedState(ticket.state)) {
    replyHtml = '<span class="ticket-reply reply-closed">✅ Closed</span>';
  } else if (ticket.lastReplyBy === 'user') {
    replyHtml = `<span class="ticket-reply reply-user">💬 Last reply: Reporter (needs my reply)</span>
      <button class="btn-dismiss-reply" onclick="overrideReplyToMe('${ticket.id}', event)" title="Not the reporter? Click to mark as Me">❌ Not reporter</button>`;
  } else if (ticket.lastReplyBy === 'me') {
    replyHtml = '<span class="ticket-reply reply-me">💬 Last reply: Me (awaiting reply)</span>';
  } else {
    replyHtml = '<span class="ticket-reply reply-user">💬 Never replied (needs my reply)</span>';
  }

  const backlogFlag = isBacklog(ticket);
  const analyzingFlag = analyzingTickets.has(String(ticket.id));

  return `
    <div class="ticket-card status-${color} ${backlogFlag ? 'ticket-backlog' : ''} ${analyzingFlag ? 'analyzing' : ''}">
      <div class="ticket-header">
        <div class="ticket-title">
          <span class="ticket-id">#${ticket.id}</span>
          ${escapeHtml(cleanTitle(ticket))}
          ${backlogFlag ? '<span class="backlog-badge">🚩 BACKLOG</span>' : ''}
          ${analyzingFlag ? '<span class="analyzing-badge">🔍 ANALYZING</span>' : ''}
        </div>
      </div>
      <div class="ticket-meta">
        ${replyHtml}
        ${ticket.state && ticket.state !== 'Unknown' ? `<span>📌 ${escapeHtml(ticket.state)}</span>` : ''}
        <span>🏷️ ${ticket.month || ''} W${ticket.week || ''}</span>
        ${ticket.area ? `<span>📁 ${escapeHtml(ticket.area)}</span>` : ''}
      </div>
      <div class="ticket-annotations">
        <div class="input-group">
          <label>Reproduction Status</label>
          <select onchange="updateAnnotation('${ticket.id}','reproStatus',this.value)">
            <option value="">-- Select --</option>
            <option value="Successful" ${ann.reproStatus === 'Successful' ? 'selected' : ''}>Successful</option>
            <option value="Partial Successful" ${ann.reproStatus === 'Partial Successful' ? 'selected' : ''}>Partial Successful</option>
            <option value="Unsuccessful" ${ann.reproStatus === 'Unsuccessful' ? 'selected' : ''}>Unsuccessful</option>
            <option value="Others" ${ann.reproStatus === 'Others' ? 'selected' : ''}>Others</option>
          </select>
        </div>
        <div class="input-group notes-group">
          <label>Notes</label>
          <input type="text" value="${escapeHtml(ann.notes || '')}" 
                 onchange="updateAnnotation('${ticket.id}','notes',this.value)" 
                 placeholder="Add notes...">
        </div>
      </div>
      <div class="ticket-actions">
        <div class="ticket-actions-left">
          <a href="${adoUrl}" target="_blank" rel="noopener noreferrer">Internal Ticket</a>
          ${devComUrl ? `<a href="${devComUrl}" target="_blank" rel="noopener noreferrer">Website</a>` : ''}
          <button class="btn btn-small btn-secondary" onclick="refreshTicket('${ticket.id}')">Refresh</button>
          <button class="btn btn-small btn-copilot" onclick="openFeedbackAgent('${ticket.id}')">Ticket Analyst</button>
        </div>
        <button class="btn btn-small btn-danger" onclick="removeTicket('${ticket.id}')">Remove</button>
      </div>
    </div>`;
}

// ---- BACKLOG NOTIFICATION ----
async function loadBacklog() {
  try {
    // Respect the "Show backlog alert" setting
    if (appSettings?.interface?.showBacklogAlert === false) {
      const el = document.getElementById('backlog-notification');
      if (el) el.style.display = 'none';
      return;
    }
    const res = await fetch(`${API}/backlog`);
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const data = await res.json();
    const el = document.getElementById('backlog-notification');

    if (data.count > 0) {
      document.getElementById('backlog-count').textContent = data.count;
      document.getElementById('backlog-details').innerHTML = data.backlog.map(t =>
        `<div class="backlog-item">
          <span class="backlog-id">#${t.id}</span>
          <span class="backlog-title">${escapeHtml((t.title || '').substring(0, 80))}</span>
          <span class="backlog-tag">📌 ${escapeHtml(t.state || '')} · 🏷️ ${t.month} W${t.week}</span>
          <button class="btn btn-small btn-primary" style="margin-left:8px;" onclick="scrollToTicket('${t.id}')">Go</button>
        </div>`
      ).join('');
      el.style.display = 'block';
    } else {
      el.style.display = 'none';
    }
  } catch (e) {
    // silently fail
  }
}

function toggleBacklogDetails() {
  const details = document.getElementById('backlog-details');
  const btn = details.previousElementSibling.querySelector('button');
  if (details.style.display === 'none') {
    details.style.display = 'flex';
    btn.textContent = 'Hide Details';
  } else {
    details.style.display = 'none';
    btn.textContent = 'Show Details';
  }
}

// ---- DASHBOARD ----
async function loadDashboard() {
  const month = document.getElementById('dashboard-month').value || getCurrentMonth();

  try {
    // Fetch both all-time and month-specific data
    const [allRes, monthRes] = await Promise.all([
      fetch(`${API}/dashboard`),
      fetch(`${API}/dashboard?month=${month}`)
    ]);
    if (!allRes.ok || !monthRes.ok) throw new Error('Dashboard API error');
    const allData = await allRes.json();
    const monthData = await monthRes.json();

    // All-time summary
    document.getElementById('stat-all-total').textContent = allData.total;
    document.getElementById('stat-all-closed').textContent = allData.closed;
    document.getElementById('stat-all-pending').textContent = allData.total - allData.closed;

    // Monthly summary
    renderDashboard(monthData);
  } catch (e) {
    showToast('Failed to load dashboard');
  }
}

function renderDashboard(data) {
  document.getElementById('stat-total').textContent = data.total;
  document.getElementById('stat-closed').textContent = data.closed;
  document.getElementById('stat-red').textContent = data.red;
  document.getElementById('stat-yellow').textContent = data.yellow;

  // Weekly chart — dynamic week count
  const weekKeys = Object.keys(data.weekly).map(Number).sort((a, b) => a - b);
  const weekLabels = weekKeys.map(w => `Week ${w}`);
  const weeklyCtx = document.getElementById('chart-weekly').getContext('2d');
  if (weeklyChart) weeklyChart.destroy();
  weeklyChart = new Chart(weeklyCtx, {
    type: 'bar',
    data: {
      labels: weekLabels,
      datasets: [
        {
          label: 'Closed',
          data: weekKeys.map(w => data.weeklyClosed[w] || 0),
          backgroundColor: '#22c55e99'
        },
        {
          label: 'Total',
          data: weekKeys.map(w => data.weekly[w] || 0),
          backgroundColor: '#3b82f699'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#4a5568', font: { size: 11 }, boxWidth: 12 } } },
      scales: {
        x: { ticks: { color: '#6b7280' }, grid: { color: '#e5e7eb' } },
        y: { ticks: { color: '#6b7280' }, grid: { color: '#e5e7eb' }, beginAtZero: true }
      }
    }
  });

  // Status pie chart
  const statusCtx = document.getElementById('chart-status').getContext('2d');
  if (statusChart) statusChart.destroy();
  statusChart = new Chart(statusCtx, {
    type: 'doughnut',
    data: {
      labels: ['Closed', 'Needs My Reply', 'Awaiting Reply', 'Other'],
      datasets: [{
        data: [data.closed, data.red, data.yellow, data.total - data.closed - data.red - data.yellow],
        backgroundColor: ['#22c55e', '#ef4444', '#f59e0b', '#9ca3af']
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#4a5568', font: { size: 11 }, boxWidth: 12 } } }
    }
  });

  // Repro chart
  const reproCtx = document.getElementById('chart-repro').getContext('2d');
  if (reproChart) reproChart.destroy();
  const reproLabels = Object.keys(data.repro).filter(k => k !== '');
  const reproValues = reproLabels.map(k => data.repro[k]);
  reproChart = new Chart(reproCtx, {
    type: 'doughnut',
    data: {
      labels: reproLabels.length ? reproLabels : ['No data'],
      datasets: [{
        data: reproValues.length ? reproValues : [1],
        backgroundColor: ['#22c55e', '#ef4444', '#f59e0b', '#3b82f6', '#9ca3af']
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#4a5568', font: { size: 11 }, boxWidth: 12 } } }
    }
  });
}

// ---- REPLY OVERRIDE ----
async function overrideReplyToMe(ticketId, event) {
  event.stopPropagation();
  // The "Reported User" reply was actually from another user (not the reporter)
  // Override to "me" and lock it until a NEW reply comes in
  const ticket = allTickets.find(t => t.id === ticketId);
  try {
    await fetch(`${API}/tickets/${ticketId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lastReplyBy: 'me',
        replyOverride: true,
        overrideInfoDate: ticket?.lastReplyDate || null
      })
    });
    await loadTickets();
    loadDashboard();
    loadBacklog();
  } catch (e) {
    console.error('Failed to override reply:', e);
  }
}

// ---- HELPERS ----
function getStatusColor(ticket) {
  if (isClosedState(ticket.state)) return 'green';
  if (ticket.lastReplyBy === 'me') return 'yellow';
  return 'red'; // reported user replied, unknown, or never touched — needs me
}

function isClosedState(state) {
  if (!state) return false;
  const s = state.toLowerCase();
  return s.includes('closed') || s.includes('resolved') || s.includes('completed');
}

function getUrgencyScore(ticket) {
  const color = getStatusColor(ticket);
  if (color === 'red') return 0; // highest priority
  if (color === 'yellow') return 5;
  return 100; // green/closed = lowest urgency
}

function updateMonthFilters() {
  const currentMonth = getCurrentMonth();

  // Precompute month counts in one pass
  const monthCounts = new Map();
  for (const t of allTickets) {
    if (t.month) monthCounts.set(t.month, (monthCounts.get(t.month) || 0) + 1);
  }
  // Always include current month even if no tickets yet
  if (!monthCounts.has(currentMonth)) {
    monthCounts.set(currentMonth, 0);
  }
  const months = [...monthCounts.keys()].sort().reverse();

  // Ticket filter
  const filterMonth = document.getElementById('filter-month');
  const currentFilter = filterMonth.value || currentMonth;
  filterMonth.innerHTML = `<option value="">All Months (${allTickets.length})</option>` +
    months.map(m =>
      `<option value="${m}" ${m === currentFilter ? 'selected' : ''}>${formatMonth(m)} (${monthCounts.get(m)})</option>`
    ).join('');

  // Default to current month on first load
  if (!filterMonth.dataset.initialized) {
    filterMonth.value = currentMonth;
    filterMonth.dataset.initialized = 'true';
  }

  // Dashboard filter — default to current month
  const dashMonth = document.getElementById('dashboard-month');
  if (dashMonth) {
    const dashCurrent = dashMonth.value;
    dashMonth.innerHTML = months.map(m =>
      `<option value="${m}" ${m === (dashCurrent || currentMonth) ? 'selected' : ''}>${formatMonth(m)}</option>`
    ).join('');

    if (!dashMonth.dataset.initialized) {
      dashMonth.value = currentMonth;
      dashMonth.dataset.initialized = 'true';
    }
  }

  // Update week filter based on selected month
  updateWeekFilter();
}

function updateWeekFilter() {
  const filterMonth = document.getElementById('filter-month').value;
  const filterWeek = document.getElementById('filter-week');
  const isCurrentMonth = filterMonth === getCurrentMonth();

  if (filterMonth) {
    fetch(`${API}/weeks/${filterMonth}`).then(r => {
      if (!r.ok) throw new Error(`API error ${r.status}`);
      return r.json();
    }).then(data => {
      // Precompute week counts in one pass
      const weekCounts = new Map();
      let monthTotal = 0;
      for (const t of allTickets) {
        if (t.month === filterMonth) {
          monthTotal++;
          if (t.week) weekCounts.set(t.week, (weekCounts.get(t.week) || 0) + 1);
        }
      }

      // Include weeks with tickets + current week (if current month)
      const curWeekNum = isCurrentMonth ? getCurrentWeek() : null;
      const availableWeeks = data.weeks.filter(w => weekCounts.has(w.week) || w.week === curWeekNum);

      filterWeek.innerHTML = `<option value="">All Weeks (${monthTotal})</option>` +
        availableWeeks.map(w => {
          const count = weekCounts.get(w.week) || 0;
          return `<option value="${w.week}">${w.label} (${count})</option>`;
        }).join('');

      // Current month: default to current week; past month: default to All Weeks
      if (isCurrentMonth) {
        const curWeek = String(getCurrentWeek());
        if (availableWeeks.some(w => String(w.week) === curWeek)) {
          filterWeek.value = curWeek;
        }
      } else {
        filterWeek.value = '';
      }

      renderTickets();
    }).catch(e => {
      console.error('Failed to load weeks:', e.message);
    });
  } else {
    filterWeek.innerHTML = `<option value="">All Weeks (${allTickets.length})</option>`;
  }
}

function updateStatusFilterCounts(tickets) {
  const filterStatus = document.getElementById('filter-status');
  const currentVal = filterStatus.value;
  let red = 0, yellow = 0, green = 0;
  for (const t of tickets) {
    const c = getStatusColor(t);
    if (c === 'red') red++;
    else if (c === 'yellow') yellow++;
    else green++;
  }
  filterStatus.innerHTML =
    `<option value="">All Status (${tickets.length})</option>` +
    `<option value="red" ${currentVal === 'red' ? 'selected' : ''}>🔴 Needs My Reply (${red})</option>` +
    `<option value="yellow" ${currentVal === 'yellow' ? 'selected' : ''}>🟡 Awaiting Reply (${yellow})</option>` +
    `<option value="green" ${currentVal === 'green' ? 'selected' : ''}>✅ Closed (${green})</option>`;
}

function formatMonth(m) {
  if (!m) return '';
  const [y, mon] = m.split('-');
  const names = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${names[parseInt(mon)]} ${y}`;
}

function cleanTitle(ticket) {
  let title = ticket.title || '';
  // Remove "Ticket #ID (manually added)" pattern
  title = title.replace(/^Ticket #\d+\s*\(manually added\)$/i, '');
  title = title.replace(/^Ticket #\d+\s*\(Error:.*?\)$/i, '');
  // Remove "FeedbackTicket ID:" prefix since ID is already shown in badge
  title = title.replace(/^FeedbackTicket\s*\d+\s*:\s*/i, '');
  // If title is empty after cleaning, show a placeholder
  return title || '(No title — edit in DevDiv)';
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(msg, type) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast show' + (type === 'warn' ? ' toast-warn' : '');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toast.className = 'toast'; }, 4000);
}

/** Open Ticket Analyst in a new tab (same server) */
function openFeedbackAgent(ticketId) {
  // Light up the ANALYZING badge immediately; the analyst tab keeps it alive via heartbeat.
  try { localStorage.setItem(ANALYZING_PREFIX + ticketId, String(Date.now())); } catch (e) {}
  analyzingTickets.add(String(ticketId));
  renderTickets();
  window.open(`/agent.html?ticket=${ticketId}`, '_blank');
}

// Keyboard shortcut: Escape to close overlay
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('add-modal');
    if (modal && modal.style.display === 'flex') closeModal();
  }
});
