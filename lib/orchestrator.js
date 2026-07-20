/**
 * Orchestrator — the agent's core pipeline
 * Coordinates: fetch → search similar → analyze → cross-reference → report
 * This is the "brain loop" — the Step 1-4 workflow from the instructions.
 */
const AdoClient = require('./ado-client');
const LlmClient = require('./llm-client');
const db = require('./db');

class Orchestrator {
  constructor(options = {}) {
    this.ado = new AdoClient();
    this.llm = new LlmClient({
      model: options.model,
      includeOptionalQuestions: options.includeOptionalQuestions,
    });
    this.onProgress = options.onProgress || (() => {});
    // Analysis behaviour (overridable via settings).
    this.crossReference = options.crossReference !== false; // default on
    this.maxSimilarTickets = Number.isFinite(options.maxSimilarTickets)
      ? options.maxSimilarTickets
      : 3;
    this.similarLookbackDays = Number.isFinite(options.similarLookbackDays)
      ? options.similarLookbackDays
      : 365;
    this.includeDiagnostics = options.includeDiagnostics !== false; // default on
  }

  /**
   * Full analysis pipeline — the agent's main action
   * @param {number} ticketId - ADO work item ID
   * @returns {object} { report, crossRefAnalysis, similarTickets, workItem, comments }
   */
  async analyze(ticketId) {
    this.onProgress({ step: 'start', message: `Starting analysis of ticket ${ticketId}...` });

    // Step 1: Fetch work item + comments in parallel
    this.onProgress({ step: 'fetch', message: 'Fetching work item and comments...' });
    const [workItem, commentsResult] = await Promise.all([
      this.ado.fetchWorkItem(ticketId),
      this.ado.fetchComments(ticketId),
    ]);

    const fields = workItem.fields || {};
    const title = fields['System.Title'] || 'Unknown';
    const state = fields['System.State'] || 'Unknown';
    const areaPath = fields['System.AreaPath'] || '';

    // Fetch VS Feedback diagnostic attachments (screen recordings, ETL/dump, logs).
    // These are not on the work item — they live in the VS Feedback backend.
    // Skipped when the "Include diagnostic attachments" setting is off.
    const diagnostics = this.includeDiagnostics
      ? await this.ado.fetchFeedbackDiagnostics(fields).catch(() => [])
      : [];

    this.onProgress({
      step: 'fetched',
      message: `Fetched: "${title}" [${state}]`,
    });

    // Step 1b: Search for potential duplicate tickets (skipped when cross-reference is off)
    let allRelatedIds = [];
    if (this.crossReference && this.maxSimilarTickets > 0) {
      this.onProgress({ step: 'search', message: 'Searching for potential duplicates...' });
      const [similarIds, linkedIds] = await Promise.all([
        this.ado.searchSimilar(title, areaPath, ticketId, this.similarLookbackDays).catch(err => {
          this.onProgress({ step: 'warn', message: `Duplicate search failed: ${err.message}` });
          return [];
        }),
        Promise.resolve(this.ado.extractLinkedIds(workItem, commentsResult)),
      ]);

      // Merge and deduplicate — capped by maxSimilarTickets
      allRelatedIds = [...new Set([...similarIds, ...linkedIds])].slice(0, this.maxSimilarTickets);
      this.onProgress({ step: 'searched', message: `Found ${allRelatedIds.length} potential duplicates` });
    } else {
      this.onProgress({ step: 'searched', message: 'Cross-reference analysis disabled — skipping duplicate search' });
    }

    // Step 2: Fetch duplicate ticket details (batch)
    let similarTickets = [];
    if (allRelatedIds.length > 0) {
      this.onProgress({ step: 'batch', message: 'Fetching duplicate ticket details...' });
      try {
        const batchResult = await this.ado.batchFetch(allRelatedIds);
        similarTickets = (batchResult.value || []).map(wi => ({
          id: wi.id,
          title: wi.fields?.['System.Title'],
          state: wi.fields?.['System.State'],
          areaPath: wi.fields?.['System.AreaPath'],
          priority: wi.fields?.['Microsoft.VSTS.Common.Priority'],
          description: this._truncate(wi.fields?.['System.Description'], 500),
          devComLink: wi.fields?.['Microsoft.DevDiv.DeveloperCommunityLink'],
        }));
      } catch (err) {
        this.onProgress({ step: 'warn', message: `Batch fetch failed: ${err.message}` });
      }
    }

    // Step 3: LLM Analysis — detect backend first, then analyze
    await this.llm._detectBackend();
    this.onProgress({ step: 'analyze', message: `Analyzing ticket with ${this.llm.getBackendName()}...` });

    const ticketData = this._buildTicketData(workItem, commentsResult, diagnostics);

    // Run analysis sequentially for Copilot SDK (it manages one session at a time)
    const report = await this.llm.analyzeTicket(ticketData);
    const crossRefAnalysis = similarTickets.length > 0
      ? await this.llm.crossReferenceAnalysis(ticketData, similarTickets)
      : null;

    // Step 4: Persist to database
    this.onProgress({ step: 'save', message: 'Saving analysis to memory...' });
    await db.saveAnalysis(ticketId, report, crossRefAnalysis, allRelatedIds, state, areaPath, title);

    // Cleanup LLM resources
    await this.llm.shutdown();

    this.onProgress({ step: 'done', message: 'Analysis complete!' });

    return {
      ticketId,
      title,
      state,
      report,
      crossRefAnalysis,
      similarTickets,
      attachments: ticketData.attachments,
      workItem,
      comments: commentsResult,
    };
  }

  /**
   * Generate a reply for a ticket
   * @param {number} ticketId
   * @param {'nmi'|'repro'|'enhance'} type
   * @param {string} [draft] - user draft for enhance type
   * @param {string} [liveReproNotes] - actual observations from a live VS
   *   reproduction (build used, exact steps taken, exact error/result seen).
   *   When provided, this is appended to the analysis context so the reply
   *   templates get filled with what Copilot actually observed instead of
   *   the analyst's earlier (pre-repro) assumptions.
   */
  async generateReply(ticketId, type, draft, liveReproNotes) {
    // Check for cached analysis
    const history = await db.getAnalysisHistory(ticketId);
    let analysis;

    if (history.length > 0) {
      analysis = history[0].report;
      this.onProgress({ step: 'cache', message: 'Using cached analysis...' });
    } else {
      // Need to analyze first
      this.onProgress({ step: 'analyze', message: 'No cached analysis, running full analysis first...' });
      const result = await this.analyze(ticketId);
      analysis = result.report;
    }

    if (liveReproNotes && liveReproNotes.trim()) {
      analysis += `\n\n---\nLIVE VS REPRODUCTION — ACTUAL OBSERVATIONS (authoritative; use these exact facts — build, steps, and result — over any earlier assumption in the analysis above):\n${liveReproNotes.trim()}`;
    }

    // Fetch ticket data for context — INCLUDING comments and VS Feedback
    // diagnostic attachments (recordings/videos/etc.), same as analyze()
    // does. Without these, the reply-flagging logic (❗ already-answered
    // questions, "customer already attached a video/sample file") has no
    // visibility into anything the customer said in a comment or attached
    // outside the description field, so it silently never flags them.
    const [workItem, commentsResult] = await Promise.all([
      this.ado.fetchWorkItem(ticketId),
      this.ado.fetchComments(ticketId).catch(() => null),
    ]);
    const diagnostics = this.includeDiagnostics
      ? await this.ado.fetchFeedbackDiagnostics(workItem.fields || {}).catch(() => [])
      : [];
    const ticketData = this._buildTicketData(workItem, commentsResult, diagnostics);

    this.onProgress({ step: 'reply', message: `Generating ${type} reply...` });

    let reply;
    switch (type) {
      case 'nmi':
        reply = await this.llm.generateNmiReply(ticketData, analysis);
        break;
      case 'repro':
        reply = await this.llm.generateReproReply(ticketData, analysis);
        break;
      case 'enhance':
        if (!draft) throw new Error('Draft text required for enhance mode');
        reply = await this.llm.enhanceReply(draft, ticketData);
        break;
      default:
        throw new Error(`Unknown reply type: ${type}`);
    }

    await db.saveReply(ticketId, type, reply);
    this.onProgress({ step: 'done', message: 'Reply generated!' });

    return reply;
  }

  // --- Helpers ---

  _buildTicketData(workItem, comments = null, diagnostics = []) {
    const f = workItem.fields || {};
    const rawDesc = f['System.Description'] || '';
    const rawReproSteps = f['Microsoft.VSTS.TCM.ReproSteps'] || '';

    // Extract file references from raw HTML/markdown before stripping,
    // then merge VS Feedback diagnostic attachments (recordings, ETL/dump, logs).
    const attachments = this._extractAttachments(rawDesc, rawReproSteps, workItem.relations, diagnostics);

    return {
      id: workItem.id,
      title: f['System.Title'],
      state: f['System.State'],
      type: f['System.WorkItemType'],
      areaPath: f['System.AreaPath'],
      assignedTo: f['System.AssignedTo']?.displayName || 'Unassigned',
      priority: f['Microsoft.VSTS.Common.Priority'],
      createdDate: f['System.CreatedDate'],
      tags: f['System.Tags'],
      description: this._stripHtml(rawDesc),
      reproSteps: this._stripHtml(rawReproSteps),
      product: f['Microsoft.DevDiv.Product'],
      productVersion: f['Microsoft.DevDiv.ProductVersion'],
      devComLink: f['Microsoft.DevDiv.DeveloperCommunityLink'],
      devComComment: f['Microsoft.DevDiv.DeveloperCommunityComment'],
      lastInfoProvidedDate: f['Microsoft.DevDiv.LastInfoProvidedDate'],
      lastMsActivityDate: f['Microsoft.DevDiv.LastMicrosoftActivityDate'],
      attachments,
      relations: (workItem.relations || []).map(r => ({
        rel: r.rel,
        url: r.url,
        name: r.attributes?.name,
        comment: r.attributes?.comment,
      })),
      comments: comments?.comments?.map(c => ({
        author: c.createdBy?.displayName,
        date: c.createdDate,
        text: this._stripHtml(c.text || ''),
      })) || [],
    };
  }

  /** Extract attachments from description, repro steps, relations, and VS Feedback diagnostics */
  _extractAttachments(rawDesc, rawReproSteps, relations, diagnostics = []) {
    const files = new Map(); // filename -> { type, source }

    // 0. VS Feedback diagnostic attachments (Customer Attachments, Recordings,
    //    System Logs, etc.) — the primary source for "Report a Problem" tickets.
    for (const d of (diagnostics || [])) {
      const name = d.friendlyName;
      if (!name) continue;
      files.set(name, {
        name,
        type: this._classifyFile(name),
        source: d.groupName ? `VS Feedback: ${d.groupName}` : 'VS Feedback Diagnostics',
        url: d.url || undefined,
        sizeBytes: d.sizeBytes || undefined,
      });
    }

    // 1. From ADO relations (AttachedFile type)
    if (relations) {
      for (const r of relations) {
        if (r.rel === 'AttachedFile' && r.attributes?.name) {
          const name = r.attributes.name;
          files.set(name, { name, type: this._classifyFile(name), source: 'ADO Attachment' });
        }
      }
    }

    // 2. From markdown image references: ![alt](url)
    const imgPattern = /!\[([^\]]*)\]\(([^)]+)\)/g;
    for (const raw of [rawDesc, rawReproSteps]) {
      let m;
      while ((m = imgPattern.exec(raw)) !== null) {
        const alt = m[1] || 'image';
        const url = m[2];
        // Extract filename from URL or alt text
        const nameMatch = url.match(/name=([^&]+)/i) || url.match(/([^/]+\.\w+)(?:\?|$)/);
        const name = nameMatch ? decodeURIComponent(nameMatch[1]).replace(/^.*_(\d{8}-\d{6}-)/, '$1') : alt;
        if (!files.has(name)) {
          files.set(name, { name, type: '🖼️ Image', source: 'Description (DevCom)' });
        }
      }
    }

    // 3. From HTML img tags: <img src="...">
    const imgTagPattern = /<img[^>]+src="([^"]+)"/gi;
    for (const raw of [rawDesc, rawReproSteps]) {
      let m;
      while ((m = imgTagPattern.exec(raw)) !== null) {
        const url = m[1];
        const nameMatch = url.match(/name=([^&]+)/i) || url.match(/([^/]+\.\w+)(?:\?|$)/);
        const name = nameMatch ? decodeURIComponent(nameMatch[1]).replace(/^.*_(\d{8}-\d{6}-)/, '$1') : 'image.png';
        if (!files.has(name)) {
          files.set(name, { name, type: '🖼️ Image', source: 'Description (DevCom)' });
        }
      }
    }

    // 4. From href links to files
    const hrefPattern = /href="([^"]*(?:\.png|\.jpg|\.jpeg|\.gif|\.zip|\.log|\.xml|\.txt|\.json|\.etl|\.ini|\.csv|\.vml)[^"]*)"/gi;
    for (const raw of [rawDesc, rawReproSteps]) {
      let m;
      while ((m = hrefPattern.exec(raw)) !== null) {
        const url = m[1];
        const nameMatch = url.match(/([^/]+\.\w+)(?:\?|$)/);
        const name = nameMatch ? decodeURIComponent(nameMatch[1]) : url;
        if (!files.has(name)) {
          files.set(name, { name, type: this._classifyFile(name), source: 'Description link' });
        }
      }
    }

    return Array.from(files.values());
  }

  _classifyFile(name) {
    const lower = (name || '').toLowerCase();
    // Compound diagnostic extensions (e.g. EtlTrace.etl.zip, DumpWithHeap.dmp.zip)
    // should be classified as ETL/Dump, not generic Archive.
    if (/\.(etl|dmp|dump|cab)(\.(zip|gz|7z|cab))?$/.test(lower)) return '🔍 ETL/Dump';
    const ext = (name.match(/\.(\w+)$/) || [])[1]?.toLowerCase();
    if (['png','jpg','jpeg','gif','bmp','svg'].includes(ext)) return '🖼️ Image';
    if (['mp4','avi','mov','wmv','webm'].includes(ext)) return '🎥 Video';
    if (['etl','dmp','dump','cab'].includes(ext)) return '🔍 ETL/Dump';
    if (['zip','7z','rar','tar','gz'].includes(ext)) return '📦 Archive';
    if (['log','txt','xml','json','ini','csv'].includes(ext)) return '📄 Log/Config';
    return '📄 Other';
  }

  _stripHtml(html) {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(p|div|li|tr|td|th|h[1-6])[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  _truncate(text, maxLen) {
    if (!text) return '';
    const stripped = this._stripHtml(text);
    return stripped.length > maxLen ? stripped.slice(0, maxLen) + '...' : stripped;
  }
}

module.exports = Orchestrator;
