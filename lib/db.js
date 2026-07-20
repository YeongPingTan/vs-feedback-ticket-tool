/**
 * Database — the agent's persistent memory
 * Uses sql.js (pure JS SQLite) to store past analyses, ticket cache, and SLA tracking.
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const config = require('../agent-config');

let _db = null;

async function getDb() {
  if (_db) return _db;

  const SQL = await initSqlJs();
  const dbPath = path.resolve(config.db.path);
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    _db = new SQL.Database(buffer);
  } else {
    _db = new SQL.Database();
  }

  // Create tables
  _db.run(`
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      report TEXT NOT NULL,
      cross_ref_analysis TEXT,
      similar_ids TEXT,
      state TEXT,
      area_path TEXT,
      title TEXT
    )
  `);

  _db.run(`
    CREATE TABLE IF NOT EXISTS replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      reply_type TEXT NOT NULL,
      content TEXT NOT NULL
    )
  `);

  _db.run(`
    CREATE TABLE IF NOT EXISTS ticket_cache (
      id INTEGER PRIMARY KEY,
      data TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  save();
  return _db;
}

function save() {
  if (!_db) return;
  const dbPath = path.resolve(config.db.path);
  const data = _db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

// --- Public API ---

async function saveAnalysis(ticketId, report, crossRefAnalysis, similarIds, state, areaPath, title) {
  const db = await getDb();
  db.run(
    `INSERT INTO analyses (ticket_id, report, cross_ref_analysis, similar_ids, state, area_path, title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [ticketId, report, crossRefAnalysis || null, JSON.stringify(similarIds || []), state, areaPath, title]
  );
  save();
}

async function getAnalysisHistory(ticketId) {
  const db = await getDb();
  const results = db.exec(
    `SELECT * FROM analyses WHERE ticket_id = ? ORDER BY timestamp DESC LIMIT 10`,
    [ticketId]
  );
  return _resultToObjects(results);
}

async function saveReply(ticketId, replyType, content) {
  const db = await getDb();
  db.run(
    `INSERT INTO replies (ticket_id, reply_type, content) VALUES (?, ?, ?)`,
    [ticketId, replyType, content]
  );
  save();
}

async function cacheTicket(id, data) {
  const db = await getDb();
  db.run(
    `INSERT OR REPLACE INTO ticket_cache (id, data) VALUES (?, ?)`,
    [id, JSON.stringify(data)]
  );
  save();
}

async function getCachedTicket(id, maxAgeMinutes = 60) {
  const db = await getDb();
  const results = db.exec(
    `SELECT data FROM ticket_cache WHERE id = ?
     AND datetime(fetched_at, '+${maxAgeMinutes} minutes') > datetime('now')`,
    [id]
  );
  const rows = _resultToObjects(results);
  return rows.length > 0 ? JSON.parse(rows[0].data) : null;
}

async function getRecentAnalyses(limit = 20) {
  const db = await getDb();
  const results = db.exec(
    `SELECT id, ticket_id, timestamp, state, area_path, title FROM analyses ORDER BY timestamp DESC LIMIT ?`,
    [limit]
  );
  return _resultToObjects(results);
}

function _resultToObjects(results) {
  if (!results || results.length === 0) return [];
  const { columns, values } = results[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

module.exports = {
  getDb,
  saveAnalysis,
  getAnalysisHistory,
  saveReply,
  cacheTicket,
  getCachedTicket,
  getRecentAnalyses,
};
