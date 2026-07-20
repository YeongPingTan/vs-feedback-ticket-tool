'use strict';

/**
 * vs-repro.js — Deterministic backbone for the §6 "Live VS Reproduction" workflow.
 *
 * These are REAL, executable functions (not a prompt handed to Copilot). They
 * implement the parts of §6 that can be done deterministically on this machine:
 *   - enumerate installed Visual Studio products via vswhere (§6.1 step 0b)
 *   - parse the customer's target edition/channel/year from the ticket (§6.1 step 0a)
 *   - pick the matching local install, with documented fallback (§6.1 steps 0d/0f)
 *   - check the latest published build for that product+channel (§6.1 step 0c)
 *   - launch the matching devenv.exe (§6.1 steps 0d / 1)
 *
 * The irreducibly-visual steps (screenshot -> look -> click coordinates ->
 * keystrokes -> verify the actual result, §6.1 steps 2-8) still require a
 * vision-capable agent (Copilot CLI --autopilot); this module resolves and
 * hands off concrete facts so the agent no longer has to "go figure it out".
 */

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const VSWHERE = process.env['ProgramFiles(x86)']
  ? path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  : 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';

const VS_INSTALLER = process.env['ProgramFiles(x86)']
  ? path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'setup.exe')
  : 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\setup.exe';

// Map a VS "year" (from the product slug) to its major install train.
const YEAR_TO_TRAIN = { '2017': 15, '2019': 16, '2022': 17, '2026': 18 };
const TRAIN_TO_YEAR = { 15: '2017', 16: '2019', 17: '2022', 18: '2026' };

// Channel manifest endpoints (§6.1 step 0c, Fallback 1). Keyed by `${train}-${channel}`.
// NOTE: the aka.ms short-link slug for "stable" is NOT consistent across VS
// trains — train 17 (VS 2022) uses "release", but train 18 (VS 2026) uses
// "stable" instead ("https://aka.ms/vs/18/release/channel" is a dead
// short-link that 302s to a Bing search page, not the manifest, so it always
// silently resolved to null and the "update available" check never fired).
// Verified directly against download.visualstudio.microsoft.com — do not
// "simplify" this back to a single pattern without re-verifying each train.
const CHANNEL_MANIFESTS = {
  '17-stable': 'https://aka.ms/vs/17/release/channel',
  '17-insiders': 'https://aka.ms/vs/17/pre/channel',
  '18-stable': 'https://aka.ms/vs/18/stable/channel',
  '18-insiders': 'https://aka.ms/vs/18/insiders/channel',
};

/**
 * §6.1 step 0b — Enumerate every VS product installed on this machine.
 * Authoritative source: vswhere. Returns [] if vswhere is missing or none found.
 */
function enumerateInstalls() {
  if (!fs.existsSync(VSWHERE)) return [];
  let raw;
  try {
    raw = execFileSync(VSWHERE, ['-all', '-prerelease', '-format', 'json'], {
      encoding: 'utf8',
      timeout: 20000,
    });
  } catch {
    return [];
  }
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((i) => {
    const productId = i.productId || '';
    const channelId = i.channelId || '';
    const edition = editionFromProductId(productId);
    const channel = channelFromChannelId(channelId);
    const train = i.installationVersion ? parseInt(String(i.installationVersion).split('.')[0], 10) : null;
    return {
      productId,
      channelId,
      edition,
      channel,
      train,
      year: train != null ? TRAIN_TO_YEAR[train] || String(train) : null,
      displayVersion: (i.catalog && i.catalog.productDisplayVersion) || i.installationVersion || '',
      installationPath: i.installationPath || '',
      devenvPath: i.installationPath
        ? path.join(i.installationPath, 'Common7', 'IDE', 'devenv.exe')
        : '',
    };
  });
}

function editionFromProductId(productId) {
  const p = String(productId).toLowerCase();
  if (p.endsWith('.enterprise')) return 'Enterprise';
  if (p.endsWith('.professional')) return 'Professional';
  if (p.endsWith('.community')) return 'Community';
  if (p.endsWith('.buildtools')) return 'BuildTools';
  return 'Unknown';
}

function channelFromChannelId(channelId) {
  const c = String(channelId);
  if (/Preview|IntPreview|Insiders/i.test(c)) return 'Insiders';
  if (/Release/i.test(c)) return 'Stable';
  return 'Unknown';
}

/**
 * §6.1 step 0a — Parse the customer's target from the ticket product slug + build.
 * Examples: "professional-2022", "community-2026", "enterprise-2026-insiders".
 */
function parseCustomerTarget(product, buildNumber, title) {
  const slug = String(product || '').toLowerCase();
  let edition = 'Unknown';
  if (slug.includes('enterprise')) edition = 'Enterprise';
  else if (slug.includes('professional') || slug.includes('/pro') || slug === 'pro') edition = 'Professional';
  else if (slug.includes('community')) edition = 'Community';

  const yearMatch = slug.match(/20(17|19|22|26)/);
  const year = yearMatch ? yearMatch[0] : null;
  const train = year ? YEAR_TO_TRAIN[year] || null : null;

  // Channel: an -insiders/-preview slug, an "Insiders" token in the title, OR
  // (most reliably) an "Insiders"/"Preview" token in the customer's own
  // reported build string (Microsoft.DevDiv.ProductVersion), e.g.
  // "Insiders [11918.235]". This buildNumber check was previously missing
  // entirely, so a ticket whose product slug was just "community-2026" (no
  // channel info) and whose title didn't mention "Insiders" either would
  // silently default to "Stable" even though the customer's own build string
  // said "Insiders" — causing live repro to run on the wrong channel install
  // despite an Insiders/Preview install being available locally. Confirmed
  // on ticket #3024329 (productVersion "Insiders [11918.235]").
  const insidersToken =
    /insider|preview/i.test(slug) ||
    /insider|preview/i.test(String(title || '')) ||
    /insider|preview/i.test(String(buildNumber || ''));
  const channel = insidersToken ? 'Insiders' : (edition !== 'Unknown' || year ? 'Stable' : 'Unknown');

  return {
    edition,
    year,
    train,
    channel,
    build: buildNumber ? String(buildNumber).trim() : '',
    raw: product || '',
  };
}

/**
 * §6.1 steps 0d/0f — Pick the local install matching edition + channel + year.
 * Falls back to same-edition, then same-channel/year, flagging the mismatch.
 */
function pickInstall(installs, target) {
  if (!installs.length) return { install: null, mismatch: 'no-vs-installed', reason: 'No Visual Studio installation found on this machine.' };

  const sameAll = installs.find(
    (i) => i.edition === target.edition && i.channel === target.channel && i.year === target.year
  );
  if (sameAll) return { install: sameAll, mismatch: null, reason: 'Exact match: edition + channel + year.' };

  // Same edition + year, any channel.
  const sameEdYear = installs.find((i) => i.edition === target.edition && i.year === target.year);
  if (sameEdYear)
    return {
      install: sameEdYear,
      mismatch: 'channel',
      reason: `Channel mismatch: customer on ${target.channel}, using ${sameEdYear.channel} (same edition + year).`,
    };

  // Same edition, any year/channel.
  const sameEd = installs.find((i) => i.edition === target.edition);
  if (sameEd)
    return {
      install: sameEd,
      mismatch: 'channel+year',
      reason: `Edition matched (${target.edition}) but year/channel differ: using ${sameEd.year} ${sameEd.channel}.`,
    };

  // Same year, any edition.
  const sameYear = installs.find((i) => i.year === target.year);
  if (sameYear)
    return {
      install: sameYear,
      mismatch: 'edition',
      reason: `Edition mismatch: customer on ${target.edition}, using ${sameYear.edition} (same year).`,
    };

  // Nothing close — use newest by train as last resort.
  const newest = [...installs].sort((a, b) => (b.train || 0) - (a.train || 0))[0];
  return {
    install: newest,
    mismatch: 'edition+channel+year',
    reason: `No close match; falling back to newest install (${newest.edition} ${newest.year} ${newest.channel}).`,
  };
}

/**
 * §6.1 step 0c (Fallback 1) — Fetch the latest published build for a train+channel
 * from the release-channel manifest. Returns null on any network/parse failure
 * (network is frequently blocked; the caller degrades gracefully).
 */
function latestBuildFromManifest(train, channel) {
  const key = `${train}-${(channel || 'stable').toLowerCase() === 'insiders' ? 'insiders' : 'stable'}`;
  const url = CHANNEL_MANIFESTS[key];
  if (!url) return Promise.resolve(null);
  return fetchJson(url)
    .then((json) => (json && json.info && json.info.productDisplayVersion) || null)
    .catch(() => null);
}

function fetchJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, { timeout: 15000 }, (resp) => {
      // aka.ms links redirect.
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        resp.resume();
        return resolve(fetchJson(resp.headers.location, redirects + 1));
      }
      if (resp.statusCode !== 200) {
        resp.resume();
        return reject(new Error(`HTTP ${resp.statusCode}`));
      }
      let data = '';
      resp.setEncoding('utf8');
      resp.on('data', (c) => (data += c));
      resp.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/**
 * Compare an installed build string against the latest published one.
 * Returns { updateAvailable: bool|null, installed, latest }.
 * null => couldn't determine (e.g., manifest unreachable).
 */
function compareBuilds(installed, latest) {
  if (!installed || !latest) return { updateAvailable: null, installed: installed || null, latest: latest || null };
  const cmp = compareVersionStrings(installed, latest);
  return { updateAvailable: cmp < 0, installed, latest };
}

function compareVersionStrings(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/**
 * §6.1 steps 0d / 1 — Launch the matching devenv.exe to the Start Window.
 * Detached so it outlives the request. Returns the pid.
 */
function launchDevenv(devenvPath) {
  if (!devenvPath || !fs.existsSync(devenvPath)) {
    throw new Error(`devenv.exe not found at: ${devenvPath || '(empty)'}`);
  }
  const child = spawn(devenvPath, [], { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

/**
 * Orchestrates the full deterministic §6 step-0 preparation for a ticket.
 * Does NOT launch VS by itself — returns everything the caller needs to decide
 * (including whether an update is available, which is a §6 blocking condition).
 */
async function prepareReproduction(ticketMeta = {}) {
  const installs = enumerateInstalls();
  const target = parseCustomerTarget(
    ticketMeta.product,
    ticketMeta.productVersion,
    ticketMeta.title
  );
  const picked = pickInstall(installs, target);

  let latest = null;
  let update = { updateAvailable: null, installed: null, latest: null };
  if (picked.install && picked.install.train) {
    latest = await latestBuildFromManifest(picked.install.train, picked.install.channel);
    update = compareBuilds(picked.install.displayVersion, latest);
  }

  return {
    vsInstalled: installs.length > 0,
    installs,
    target,
    matched: picked.install,
    mismatch: picked.mismatch,
    matchReason: picked.reason,
    update, // { updateAvailable: true|false|null, installed, latest }
    installerPath: fs.existsSync(VS_INSTALLER) ? VS_INSTALLER : null,
  };
}

module.exports = {
  enumerateInstalls,
  parseCustomerTarget,
  pickInstall,
  latestBuildFromManifest,
  compareBuilds,
  launchDevenv,
  prepareReproduction,
  VSWHERE,
  VS_INSTALLER,
};
