/**
 * ADO API Client — the agent's perception layer
 * Handles all communication with Azure DevOps REST APIs.
 */
const { execSync } = require('child_process');
const config = require('../agent-config');

class AdoClient {
  constructor() {
    this._token = null;
    this._tokenExpiry = 0;
    this.baseUrl = config.ado.baseUrl;
    this.project = config.ado.project;
  }

  // --- Authentication ---

  async getToken() {
    // Use PAT if configured
    if (config.ado.pat) return config.ado.pat;

    // Check cached token (refresh 5 min before expiry)
    if (this._token && Date.now() < this._tokenExpiry - 300000) {
      return this._token;
    }

    try {
      // Refresh PATH to find az CLI
      const machinePath = execSync(
        '[System.Environment]::GetEnvironmentVariable("PATH", "Machine")',
        { shell: 'powershell.exe', encoding: 'utf8' }
      ).trim();
      const userPath = execSync(
        '[System.Environment]::GetEnvironmentVariable("PATH", "User")',
        { shell: 'powershell.exe', encoding: 'utf8' }
      ).trim();
      process.env.PATH = `${machinePath};${userPath}`;

      const tokenJson = execSync(
        'az account get-access-token --resource "499b84ac-1321-427f-aa17-267ca6975798" -o json',
        { encoding: 'utf8', timeout: 30000 }
      );
      const parsed = JSON.parse(tokenJson);
      this._token = parsed.accessToken;
      this._tokenExpiry = new Date(parsed.expiresOn).getTime();
      return this._token;
    } catch (err) {
      throw new Error(`Failed to get ADO token: ${err.message}. Set ADO_PAT env var as fallback.`);
    }
  }

  async headers() {
    const token = await this.getToken();
    return {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  // --- Core API Methods ---

  /** Fetch a single work item with all relations */
  async fetchWorkItem(id) {
    const url = `${this.baseUrl}/_apis/wit/workitems/${id}?$expand=all&api-version=7.1`;
    const resp = await fetch(url, { headers: await this.headers() });
    if (!resp.ok) throw new Error(`Failed to fetch WI ${id}: ${resp.status} ${resp.statusText}`);
    return resp.json();
  }

  /** Fetch comments for a work item (project-scoped) */
  async fetchComments(id) {
    const url = `${this.baseUrl}/${this.project}/_apis/wit/workitems/${id}/comments?api-version=7.1-preview.4`;
    const resp = await fetch(url, { headers: await this.headers() });
    if (!resp.ok) throw new Error(`Failed to fetch comments for WI ${id}: ${resp.status}`);
    return resp.json();
  }

  /** Run a WIQL query (with $top limit for performance) */
  async wiqlSearch(query, top = 5) {
    const url = `${this.baseUrl}/${this.project}/_apis/wit/wiql?$top=${top}&api-version=7.1`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify({ query }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`WIQL failed: ${resp.status} — ${text}`);
    }
    return resp.json();
  }

  /** Batch fetch multiple work items by IDs */
  async batchFetch(ids, fields = null) {
    if (!ids || ids.length === 0) return { value: [] };
    const url = `${this.baseUrl}/_apis/wit/workitemsbatch?api-version=7.1`;
    const body = {
      ids: ids.slice(0, 200), // API limit
      fields: fields || [
        'System.Id', 'System.Title', 'System.State', 'System.AreaPath',
        'Microsoft.VSTS.Common.Priority', 'System.Description',
        'Microsoft.DevDiv.DeveloperCommunityLink',
      ],
    };
    const resp = await fetch(url, {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Batch fetch failed: ${resp.status}`);
    return resp.json();
  }

  /**
   * Fetch VS Feedback diagnostic attachments (Customer Attachments, Recordings,
   * System Logs, etc.). These files are NOT stored on the ADO work item — they
   * live in the VS Feedback backend and are surfaced in the work item form by the
   * "ms-vs-feedback.vsts-devcom-ui" extension's Diagnostic Info tab.
   * Endpoint reverse-engineered from that extension:
   *   GET https://vsfeedback.azurewebsites.net/api/diagnostics
   *     ?areaPath=&developerCommunityId=&developerCommunityUrl=
   * Returns [] on any failure so analysis never breaks over missing diagnostics.
   */
  async fetchFeedbackDiagnostics(fields) {
    try {
      const devComId = fields?.['Microsoft.DevDiv.DeveloperCommunityId'];
      const devComUrl = fields?.['Microsoft.DevDiv.DeveloperCommunityLink'] || '';
      const areaPath = fields?.['System.AreaPath'] || '';
      if (!devComId) return [];

      const qs = new URLSearchParams({
        areaPath,
        developerCommunityId: String(devComId),
        developerCommunityUrl: devComUrl,
      }).toString();
      const url = `https://vsfeedback.azurewebsites.net/api/diagnostics?${qs}`;
      const resp = await fetch(url, { headers: await this.headers() });
      if (!resp.ok) return [];

      const data = await resp.json();
      return (data.items || [])
        // Keep only real file attachments (they carry a transferId); skip the
        // Telemetry group entries, which are dashboard links (PRISM/PerfWatson), not files.
        .filter(it => it.friendlyName && it.transferId)
        .map(it => ({
          friendlyName: it.friendlyName,
          groupName: it.groupName || '',
          url: it.url || '',
          transferId: it.transferId || '',
          sizeBytes: it.sizeBytes || 0,
          creationDate: it.creationDate || 0,
          userRealName: it.userRealName || '',
          analysisUrl: it.analysisUrl || '',
        }));
    } catch {
      return [];
    }
  }

  // --- Search Strategies (from instructions §2.5) ---

  /** Find potential duplicate tickets using 3-tier WIQL search */
  async searchSimilar(title, areaPath, excludeId, lookbackDays = 365) {
    const keywords = this._extractKeywords(title);
    const areaLevel2 = this._getAreaLevel2(areaPath);

    // Build 3 search tiers (narrow → medium → broad)
    const tiers = this._buildSearchTiers(keywords, areaLevel2, excludeId, lookbackDays);

    // Run all tiers in parallel
    const results = await Promise.allSettled(
      tiers.map(t => this.wiqlSearch(t.query, 3))
    );

    // Collect and deduplicate — prioritize narrow matches first
    const idSet = new Set();
    const allIds = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.workItems) {
        for (const wi of result.value.workItems) {
          if (!idSet.has(wi.id)) {
            idSet.add(wi.id);
            allIds.push(wi.id);
          }
        }
      }
    }

    return allIds.slice(0, 3); // Top 3 potential duplicates only
  }

  /** Extract meaningful keywords from ticket title */
  _extractKeywords(title) {
    const stopWords = new Set([
      'visual', 'studio', 'error', 'issue', 'problem', 'bug', 'not', 'working',
      'does', 'the', 'and', 'for', 'with', 'when', 'after', 'from', 'into',
      'that', 'this', 'are', 'was', 'were', 'been', 'being', 'have', 'has',
      'had', 'having', 'will', 'would', 'could', 'should', 'can', 'may',
      'many', 'feature', 'unable', 'use', 'using', 'due', 'internal',
      'available', 'longer', 'adds', 'added', 'add', 'get', 'getting',
    ]);
    return title
      .replace(/\[.*?\]/g, '') // Remove bracketed version info
      .split(/[\s\-\/,.:;()+]+/)
      .filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()))
      .slice(0, 5);
  }

  /** Get level-2 area path (e.g., "DevDiv\NET Tools") */
  _getAreaLevel2(areaPath) {
    if (!areaPath) return null;
    const parts = areaPath.split('\\');
    return parts.length >= 2 ? `${parts[0]}\\${parts[1]}` : areaPath;
  }

  /** Escape a value for safe interpolation into a WIQL string literal (doubles embedded single quotes) */
  _escapeWiql(value) {
    return String(value).replace(/'/g, "''");
  }

  /** Build 3 WIQL queries for narrow/medium/broad search */
  _buildSearchTiers(keywords, areaLevel2, excludeId, lookbackDays = 365) {
    const areaFilter = areaLevel2
      ? `AND [System.AreaPath] UNDER '${this._escapeWiql(areaLevel2)}'`
      : '';
    const excludeFilter = excludeId ? `AND [System.Id] <> ${excludeId}` : '';
    // Only search tickets created in the last N days (like ADO's potential duplicates)
    const days = Number.isFinite(lookbackDays) && lookbackDays > 0 ? Math.floor(lookbackDays) : 365;
    const recentFilter = `AND [System.CreatedDate] >= @Today - ${days}`;
    const base = `SELECT [System.Id], [System.Title], [System.State] FROM workitems WHERE [System.TeamProject] = 'DevDiv' AND [System.WorkItemType] = 'FeedbackTicket' ${areaFilter} ${excludeFilter} ${recentFilter}`;

    const tiers = [];

    // Narrow: 3+ specific keywords ANDed — most likely duplicates
    if (keywords.length >= 3) {
      const conditions = keywords.slice(0, 3).map(k => `[System.Title] CONTAINS '${this._escapeWiql(k)}'`).join(' AND ');
      tiers.push({ tier: 'narrow', query: `${base} AND ${conditions} ORDER BY [System.CreatedDate] DESC` });
    }

    // Medium: first 2 keywords ANDed
    if (keywords.length >= 2) {
      const conditions = keywords.slice(0, 2).map(k => `[System.Title] CONTAINS '${this._escapeWiql(k)}'`).join(' AND ');
      tiers.push({ tier: 'medium', query: `${base} AND ${conditions} ORDER BY [System.CreatedDate] DESC` });
    }

    // Broad: most specific keyword (longest word) in same area
    if (keywords.length >= 1) {
      const specific = [...keywords].sort((a, b) => b.length - a.length)[0];
      const conditions = `[System.Title] CONTAINS '${this._escapeWiql(specific)}'`;
      tiers.push({ tier: 'broad', query: `${base} AND ${conditions} ORDER BY [System.CreatedDate] DESC` });
    }

    return tiers;
  }

  // --- Utility ---

  /** Extract linked ticket IDs from relations and comments */
  extractLinkedIds(workItem, comments) {
    const ids = new Set();

    // From relations
    if (workItem.relations) {
      for (const rel of workItem.relations) {
        if (rel.url) {
          const match = rel.url.match(/workItems\/(\d+)/);
          if (match) ids.add(parseInt(match[1]));
        }
      }
    }

    // From comments text
    if (comments && comments.comments) {
      for (const c of comments.comments) {
        const text = c.text || '';
        // Match: FeedbackTicket 1234, #1234, _workitems/edit/1234
        const patterns = [
          /FeedbackTicket\s+(\d{5,7})/gi,
          /(?:^|\s)#(\d{5,7})\b/g,
          /_workitems\/edit\/(\d+)/g,
        ];
        for (const pat of patterns) {
          let m;
          while ((m = pat.exec(text)) !== null) {
            ids.add(parseInt(m[1]));
          }
        }
      }
    }

    // Remove self
    if (workItem.id) ids.delete(workItem.id);
    return [...ids];
  }
}

module.exports = AdoClient;
