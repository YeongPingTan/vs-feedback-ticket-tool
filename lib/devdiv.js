/**
 * DevDiv Feedback Ticket Fetcher
 * Fetches ticket info from Azure DevOps using az cli authentication.
 * Falls back to placeholder data if az cli is not available.
 */

const path = require('path');
const fs = require('fs');
const AdoClient = require('./ado-client');

const ORG_URL = 'https://devdiv.visualstudio.com';
const PROJECT = 'DevDiv';

// Load identity from config.json (single source of truth)
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const MY_IDENTIFIERS = [config.email, config.alias, config.fullName];

// Delegate token acquisition to AdoClient — it already refreshes the Machine+User
// PATH before invoking `az` (required because a fresh `node` process doesn't
// always inherit an up-to-date PATH containing the az CLI) and caches the token
// with expiry. Keeping a second, separate token-fetch implementation here (as
// this module used to) was a latent bug: this module's own getAzToken() never
// did the PATH refresh, so it could fail to find `az` and silently show
// "No auth — run az login" placeholders in the ticket list even when the
// analysis pipeline (which goes through AdoClient) worked fine.
const adoClient = new AdoClient();

async function getAzToken() {
  try {
    return await adoClient.getToken();
  } catch (e) {
    console.error('Failed to get az cli token:', e.message);
    console.error('Make sure you are logged in: az login');
    return null;
  }
}

function isMe(authorEmail, authorName) {
  const email = (authorEmail || '').toLowerCase();
  const name = (authorName || '').toLowerCase();
  return MY_IDENTIFIERS.some(id => {
    const lower = id.toLowerCase();
    return email.includes(lower) || name.includes(lower);
  });
}

async function fetchTicketFromDevDiv(ticketId) {
  const token = await getAzToken();

  if (!token) {
    return createPlaceholder(ticketId, 'No auth — run "az login"');
  }

  try {
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };

    // Fetch work item details
    const wiUrl = `${ORG_URL}/${PROJECT}/_apis/wit/workitems/${ticketId}?api-version=7.1`;
    const response = await fetch(wiUrl, { headers });

    if (!response.ok) {
      console.error(`Failed to fetch ticket ${ticketId}: ${response.status}`);
      return createPlaceholder(ticketId, `Error: HTTP ${response.status}`);
    }

    const data = await response.json();
    const fields = data.fields || {};

    // Determine last reply — only two people matter: ME and the REPORTED USER.
    // Limitation: DevComm syncs via service account, so LastInfoProvidedDate
    // tracks ANY non-MSFT user reply (reporter + other community members).
    // We assume LastInfoProvidedDate = reported user (true in most cases).
    // For edge cases (other user replied), the UI provides a manual override.
    let lastReplyBy = 'unknown';
    let lastReplyDate = null;

    const lastInfoDate = fields['Microsoft.DevDiv.LastInfoProvidedDate'];
    const infoTime = lastInfoDate ? new Date(lastInfoDate).getTime() : 0;

    // Find my last activity date from revision history
    let myLastTime = 0;
    let myLastDate = null;

    try {
      const updatesUrl = `${ORG_URL}/${PROJECT}/_apis/wit/workitems/${ticketId}/updates?api-version=7.1`;
      const updatesRes = await fetch(updatesUrl, { headers });

      if (updatesRes.ok) {
        const updatesData = await updatesRes.json();
        const updates = updatesData.value || [];

        // Walk backwards to find my most recent revision
        for (let i = updates.length - 1; i >= 0; i--) {
          const update = updates[i];
          const byName = update.revisedBy?.displayName || '';
          const byEmail = update.revisedBy?.uniqueName || '';
          if (isMe(byEmail, byName)) {
            myLastDate = update.revisedDate || update.fields?.['System.ChangedDate']?.newValue;
            myLastTime = myLastDate ? new Date(myLastDate).getTime() : 0;
            break;
          }
        }
      }
    } catch (e) {
      console.error(`Failed to fetch updates for ${ticketId}:`, e.message);
    }

    if (myLastTime > 0 && myLastTime >= infoTime) {
      // I replied after the reported user (or reported user never replied)
      lastReplyBy = 'me';
      lastReplyDate = myLastDate;
    } else if (infoTime > 0) {
      // Someone replied after me — assume it's the reported user
      lastReplyBy = 'user';
      lastReplyDate = lastInfoDate;
    }

    return {
      id: ticketId,
      title: fields['System.Title'] || `Ticket #${ticketId}`,
      state: fields['System.State'] || 'Unknown',
      area: fields['System.AreaPath'] || '',
      iteration: fields['System.IterationPath'] || '',
      reportedDate: fields['System.CreatedDate'] || new Date().toISOString(),
      reportedBy: fields['System.CreatedBy']?.displayName || '',
      lastReplyBy: lastReplyBy,
      lastReplyDate: lastReplyDate,
      commentCount: fields['System.CommentCount'] || 0,
      priority: fields['Microsoft.VSTS.Common.Priority'] || 0,
      score: fields['Microsoft.DevDiv.Score'] || 0,
      tags: (fields['System.Tags'] || '').split(';').map(t => t.trim()).filter(Boolean),
      devComLink: fields['Microsoft.DevDiv.DeveloperCommunityLink'] || '',
      url: fields['Microsoft.DevDiv.DeveloperCommunityLink'] || `${ORG_URL}/${PROJECT}/_workitems/edit/${ticketId}`
    };
  } catch (error) {
    console.error(`Error fetching ticket ${ticketId}:`, error.message);
    return createPlaceholder(ticketId, `Error: ${error.message}`);
  }
}

function createPlaceholder(ticketId, errorMsg) {
  return {
    id: ticketId,
    title: `Ticket #${ticketId} (${errorMsg})`,
    state: 'Unknown',
    area: '',
    iteration: '',
    reportedDate: new Date().toISOString(),
    reportedBy: '',
    lastReplyBy: 'unknown',
    lastReplyDate: null,
    commentCount: 0,
    priority: 0,
    score: 0,
    tags: [],
    url: `${ORG_URL}/${PROJECT}/_workitems/edit/${ticketId}`
  };
}

// Fetch multiple tickets using ADO batch API (single call for up to 200 work items)
async function fetchMultipleTickets(ticketIds) {
  const token = await getAzToken();
  if (!token) {
    return ticketIds.map(id => createPlaceholder(id, 'No auth — run "az login"'));
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  const results = [];

  // ADO batch API supports up to 200 IDs per call
  const BATCH_SIZE = 200;
  for (let i = 0; i < ticketIds.length; i += BATCH_SIZE) {
    const batchIds = ticketIds.slice(i, i + BATCH_SIZE);

    try {
      // Single API call to fetch all work items in this batch
      const batchUrl = `${ORG_URL}/_apis/wit/workitemsbatch?api-version=7.1`;
      const batchRes = await fetch(batchUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ids: batchIds.map(Number), fields: [
          'System.Title', 'System.State', 'System.AreaPath', 'System.IterationPath',
          'System.CreatedDate', 'System.CreatedBy', 'System.CommentCount', 'System.Tags',
          'Microsoft.VSTS.Common.Priority', 'Microsoft.DevDiv.Score',
          'Microsoft.DevDiv.DeveloperCommunityLink', 'Microsoft.DevDiv.LastInfoProvidedDate'
        ]})
      });

      if (!batchRes.ok) {
        // Fallback to individual fetches
        console.warn(`Batch API failed (${batchRes.status}), falling back to individual fetches`);
        for (const id of batchIds) {
          results.push(await fetchTicketFromDevDiv(id));
        }
        continue;
      }

      const batchData = await batchRes.json();
      const wiMap = new Map();
      for (const wi of (batchData.value || [])) {
        wiMap.set(String(wi.id), wi);
      }

      // Fetch update histories in parallel (concurrency-limited)
      const UPDATE_CONCURRENCY = 10;
      const replyInfo = new Map();
      for (let j = 0; j < batchIds.length; j += UPDATE_CONCURRENCY) {
        const chunk = batchIds.slice(j, j + UPDATE_CONCURRENCY);
        const updateResults = await Promise.all(chunk.map(async (id) => {
          try {
            const updatesUrl = `${ORG_URL}/${PROJECT}/_apis/wit/workitems/${id}/updates?api-version=7.1`;
            const updatesRes = await fetch(updatesUrl, { headers });
            if (!updatesRes.ok) return { id, myLastDate: null, myLastTime: 0 };
            const updatesData = await updatesRes.json();
            const updates = updatesData.value || [];
            for (let k = updates.length - 1; k >= 0; k--) {
              const update = updates[k];
              const byName = update.revisedBy?.displayName || '';
              const byEmail = update.revisedBy?.uniqueName || '';
              if (isMe(byEmail, byName)) {
                const d = update.revisedDate || update.fields?.['System.ChangedDate']?.newValue;
                return { id, myLastDate: d, myLastTime: d ? new Date(d).getTime() : 0 };
              }
            }
            return { id, myLastDate: null, myLastTime: 0 };
          } catch (e) {
            return { id, myLastDate: null, myLastTime: 0 };
          }
        }));
        for (const r of updateResults) replyInfo.set(r.id, r);
      }

      // Combine work item data with reply info
      for (const id of batchIds) {
        const wi = wiMap.get(id);
        if (!wi) {
          results.push(createPlaceholder(id, 'Not found in batch'));
          continue;
        }
        const fields = wi.fields || {};
        const info = replyInfo.get(id) || { myLastDate: null, myLastTime: 0 };

        const lastInfoDate = fields['Microsoft.DevDiv.LastInfoProvidedDate'];
        const infoTime = lastInfoDate ? new Date(lastInfoDate).getTime() : 0;

        let lastReplyBy = 'unknown';
        let lastReplyDate = null;

        if (info.myLastTime > 0 && info.myLastTime >= infoTime) {
          lastReplyBy = 'me';
          lastReplyDate = info.myLastDate;
        } else if (infoTime > 0) {
          lastReplyBy = 'user';
          lastReplyDate = lastInfoDate;
        }

        results.push({
          id,
          title: fields['System.Title'] || `Ticket #${id}`,
          state: fields['System.State'] || 'Unknown',
          area: fields['System.AreaPath'] || '',
          iteration: fields['System.IterationPath'] || '',
          reportedDate: fields['System.CreatedDate'] || new Date().toISOString(),
          reportedBy: fields['System.CreatedBy']?.displayName || '',
          lastReplyBy,
          lastReplyDate,
          commentCount: fields['System.CommentCount'] || 0,
          priority: fields['Microsoft.VSTS.Common.Priority'] || 0,
          score: fields['Microsoft.DevDiv.Score'] || 0,
          tags: (fields['System.Tags'] || '').split(';').map(t => t.trim()).filter(Boolean),
          devComLink: fields['Microsoft.DevDiv.DeveloperCommunityLink'] || '',
          url: fields['Microsoft.DevDiv.DeveloperCommunityLink'] || `${ORG_URL}/${PROJECT}/_workitems/edit/${id}`
        });
      }
    } catch (e) {
      console.error('Batch fetch error:', e.message);
      for (const id of batchIds) {
        results.push(createPlaceholder(id, `Error: ${e.message}`));
      }
    }
  }
  return results;
}

module.exports = { fetchTicketFromDevDiv, fetchMultipleTickets };
