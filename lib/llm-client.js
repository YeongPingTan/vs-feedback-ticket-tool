/**
 * LLM Client — the agent's reasoning engine
 * Uses GitHub Copilot SDK — your existing Copilot subscription (FREE, no keys!)
 */

class LlmClient {
  constructor(options = {}) {
    this.backend = null; // 'copilot'
    this.model = null;
    this._modelOverride = options.model || null;
    this.includeOptionalQuestions = options.includeOptionalQuestions !== false; // default on
    this._copilotClient = null;
    this._copilotStarted = false;
  }

  async _detectBackend() {
    if (this.backend) return;

    try {
      const { CopilotClient } = require('@github/copilot-sdk');
      this._copilotClient = new CopilotClient();
      await this._copilotClient.start();
      const auth = await this._copilotClient.getAuthStatus();
      if (auth.isAuthenticated) {
        this._copilotStarted = true;
        this.model = this._modelOverride || process.env.COPILOT_MODEL || 'gpt-5.4-mini';
        this.backend = 'copilot';
        return;
      }
      await this._copilotClient.stop();
    } catch {
      this._copilotClient = null;
    }

    throw new Error(
      'GitHub Copilot not available. Make sure you are signed in to GitHub Copilot.\n' +
      'The Copilot CLI must be installed and authenticated.'
    );
  }

  getBackendName() {
    return '🚀 GitHub Copilot SDK (your subscription)';
  }

  /** Send a chat completion request via Copilot SDK */
  async chat(systemPrompt, userMessage) {
    await this._detectBackend();

    const { approveAll } = require('@github/copilot-sdk');
    const session = await this._copilotClient.createSession({
      model: this.model,
      approvalPolicy: approveAll,
    });

    const combinedPrompt = `${systemPrompt}\n\n---\n\n${userMessage}`;
    const result = await session.sendAndWait(combinedPrompt);

    let text = '';
    if (result && result.data && result.data.content) {
      text = result.data.content;
    } else if (typeof result === 'string') {
      text = result;
    }

    try { session.disconnect(); } catch {}
    return text;
  }

  /** Cleanup — call when done to stop Copilot SDK process */
  async shutdown() {
    if (this._copilotClient && this._copilotStarted) {
      try { await this._copilotClient.stop(); } catch {}
      this._copilotStarted = false;
    }
  }

  // --- Agent Reasoning Methods ---

  /** Analyze a ticket and produce a structured analysis */
  async analyzeTicket(ticketData) {
    const systemPrompt = SYSTEM_PROMPTS.analyze;
    const userMessage = `Analyze this VS Feedback ticket:\n\n${JSON.stringify(ticketData, null, 2)}`;
    return this.chat(systemPrompt, userMessage);
  }

  /** Generate a root cause analysis cross-referencing similar tickets */
  async crossReferenceAnalysis(ticketData, similarTickets) {
    const systemPrompt = SYSTEM_PROMPTS.crossReference;
    const userMessage = `Primary ticket:\n${JSON.stringify(ticketData, null, 2)}\n\nSimilar tickets:\n${JSON.stringify(similarTickets, null, 2)}`;
    return this.chat(systemPrompt, userMessage);
  }

  /** Generate a NMI (Need More Info) reply */
  async generateNmiReply(ticketData, analysis) {
    const systemPrompt = SYSTEM_PROMPTS.nmiReply;
    const userMessage = `Ticket data:\n${JSON.stringify(ticketData, null, 2)}\n\nAnalysis:\n${analysis}${this._optionalQuestionsDirective()}`;
    let reply = await this.chat(systemPrompt, userMessage);
    reply = applyDeterministicAttachmentFlags(reply, ticketData);
    reply = applyDeterministicTextFlags(reply, ticketData);
    reply = rebuildReviewNotes(reply);
    return reply;
  }

  /** Generate a Reproduction Successful reply */
  async generateReproReply(ticketData, analysis) {
    const systemPrompt = SYSTEM_PROMPTS.reproReply;
    const userMessage = `Ticket data:\n${JSON.stringify(ticketData, null, 2)}\n\nAnalysis:\n${analysis}`;
    const reply = await this.chat(systemPrompt, userMessage);
    return ensureDeveloperSeparator(reply);
  }

  /** Enhance a user-drafted reply */
  async enhanceReply(draft, ticketData) {
    const systemPrompt = SYSTEM_PROMPTS.enhanceReply;
    const userMessage = `User's draft reply:\n${draft}\n\nTicket context:\n${JSON.stringify(ticketData, null, 2)}${this._optionalQuestionsDirective()}`;
    let reply = await this.chat(systemPrompt, userMessage);
    reply = applyDeterministicAttachmentFlags(reply, ticketData);
    reply = applyDeterministicTextFlags(reply, ticketData);
    reply = rebuildReviewNotes(reply);
    return reply;
  }

  /** Instruction appended to reply prompts to control optional-question generation. */
  _optionalQuestionsDirective() {
    if (this.includeOptionalQuestions) return '';
    return '\n\n---\nIMPORTANT OVERRIDE: Do NOT add any ticket-specific "-Optional-" questions. ' +
      'Omit the entire "-Optional-" section and the 🔍 questions. ' +
      'Output only the 9 standard base questions.';
  }
}

/**
 * Guarantee a full-width dashed separator line directly above the
 * "To Developer" header of a Reproduction reply, regardless of how the LLM
 * formatted (or mislabeled) that header. Idempotent.
 */
function ensureDeveloperSeparator(text) {
  if (!text) return text;
  const DASHES = '-----------------------------------------------------------';
  const lines = text.split('\n');
  // Find the "To Developer" header line (tolerates **, "Part 2 —", etc.)
  const devIdx = lines.findIndex(l => /to\s+developer/i.test(l));
  if (devIdx === -1) return text; // nothing to anchor to — leave untouched

  // Walk upward past blank lines to check whether a dashed line already precedes it
  let i = devIdx - 1;
  while (i >= 0 && lines[i].trim() === '') i--;
  const alreadyHasRule = i >= 0 && /^-{5,}$/.test(lines[i].trim());
  if (alreadyHasRule) return text;

  // Insert a blank line + dashes + blank line right above the header
  lines.splice(devIdx, 0, '', DASHES, '');
  return lines.join('\n');
}

/**
 * Split a reply into (head, questionLines[], tailJoiner) anchored on the fixed
 * "...confirm several questions?" intro sentence, so flag post-processing only
 * ever touches the real 9-question list — never the earlier numbered
 * REPRODUCTION STEPS list (e.g. "1. File > New > Project...") which also
 * happens to use "N. " numbering and would otherwise be misidentified.
 * Returns null if the anchor isn't found (e.g. a repro-successful reply).
 */
function splitAtQuestionsAnchor(reply) {
  const anchor = 'confirm several questions?';
  const anchorIdx = reply.indexOf(anchor);
  if (anchorIdx === -1) return null;
  return {
    head: reply.slice(0, anchorIdx + anchor.length),
    tail: reply.slice(anchorIdx + anchor.length),
  };
}

/** Normalize a numbered question line: strip any stray ❗ (wherever the LLM
 *  put it, even mid-line — a known LLM formatting slip) and re-add it at the
 *  correct position (immediately before the number) if `shouldFlag` is true. */
function normalizeFlag(line, shouldFlag) {
  const m = line.match(/^(\s*)❗?\s*(\d+\.\s*)(.*)$/);
  if (!m) return line;
  const alreadyFlagged = /❗/.test(line);
  if (!shouldFlag && !alreadyFlagged) return line; // nothing to do
  const cleanedRest = m[3].replace(/❗/g, '').replace(/^\s+/, '');
  return shouldFlag
    ? `${m[1]}❗${m[2]}${cleanedRest}`
    : `${m[1]}${m[2]}${cleanedRest}`;
}

/**
 * Deterministically force ❗ flags on the video (Q6) and sample-file (Q7)
 * questions in an NMI/enhanced reply based on ticketData.attachments —
 * instead of relying solely on the LLM's own (inconsistent, non-deterministic)
 * judgment call each time it drafts a reply. This guarantees the same ticket
 * always produces the same flagging outcome, run after run.
 * Idempotent — a question already flagged is left as-is.
 */
function applyDeterministicAttachmentFlags(reply, ticketData) {
  if (!reply || !ticketData || !Array.isArray(ticketData.attachments)) return reply;

  const attachments = ticketData.attachments;
  const hasVideo = attachments.some(a => /video/i.test(a.type || ''));
  // "Sample file" = a genuine reproduction sample/source the CUSTOMER provided
  // — NOT any auto-collected VS Feedback diagnostic bundle. VS Feedback's
  // "System Logs" and "Recordings" groups (ServiceHubLogs.zip, LogHub.zip,
  // ComponentModelCache.zip, IntelliCodeFeedback.zip, EtlTrace.etl.zip,
  // DumpWithHeap.dmp.zip, etc.) are auto-collected by the VS diagnostics
  // pipeline, not something the customer manually attached as a repro
  // sample — even though their filenames end in .zip and superficially look
  // like "archive"/"sample" attachments. Confirmed false-positive ❗7 flag on
  // ticket #3024329, where every .zip attachment was System Logs/Recordings
  // and no genuine sample project/file existed. Only count attachments whose
  // `source` indicates the customer actually provided them (VS Feedback's
  // "Customer Attachments" group, a raw ADO attachment, or something linked
  // directly in the description/repro-steps text).
  const hasSample = attachments.some(a => {
    const type = a.type || '';
    const source = a.source || '';
    const isDiagnosticBundle = /VS Feedback:\s*(System Logs|Recordings)/i.test(source);
    if (isDiagnosticBundle) return false;
    return !/log|config|image/i.test(type) && /archive|sample|source|project|code|zip/i.test(type);
  });

  const split = splitAtQuestionsAnchor(reply);
  if (!split) return reply;

  const lines = split.tail.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!/^❗?\s*\d+\.\s/.test(trimmed)) return line;
    if (/reproduction video with detailed steps/i.test(trimmed)) {
      return normalizeFlag(line, hasVideo);
    }
    if (/provide us sample file which can reproduce/i.test(trimmed)) {
      return normalizeFlag(line, hasSample);
    }
    return line;
  });

  return split.head + lines.join('\n');
}

/**
 * Deterministically add ❗ flags for the free-text-answerable questions
 * (Q1 frequency, Q2 project type, Q3 extensions, Q4 new-simple-solution,
 * Q5 .vs folder, Q8 repair VS) based on keyword matches in text the CUSTOMER
 * actually wrote — supplementing (never replacing) the LLM's own semantic
 * review. The LLM's judgment call on this free text is inherently
 * non-deterministic (verified: same input flagged differently across runs),
 * so these keyword checks give a consistent floor: if a clear keyword match
 * exists in the customer's own words, the flag is always applied regardless
 * of what the LLM decided. The LLM can still add flags for phrasing these
 * patterns miss, but can never lose ones already forced here — only
 * additive, never removed.
 *
 * IMPORTANT — customer-authored text ONLY: this must scan ONLY `description`
 * (the customer's original DevCom submission). Do NOT add any other field:
 *   - `reproSteps` (Microsoft.VSTS.TCM.ReproSteps) and `comments` (ADO
 *     discussion comments) are authored by the Microsoft analyst/engineer,
 *     not the customer — e.g. an engineer's own "File > New > Project >
 *     ASP.NET Core Web API" repro attempt, or an internal note like "asked
 *     customer to confirm ReSharper — no reply yet".
 *   - `devComComment` (Microsoft.DevDiv.DeveloperCommunityComment) is NOT
 *     the customer's reply either — verified on ticket #3024329 it actually
 *     contains MICROSOFT's own outbound NMI reply draft/template text
 *     (literally the "1. Did you see this issue..." question list itself),
 *     so scanning it makes every question false-positive match against its
 *     own template wording. Confirmed by direct API inspection — do not
 *     reintroduce this field here without re-verifying its real semantics.
 * Scanning either of the above caused false-positive ❗ flags across nearly
 * every question on ticket #3024329 — this is a confirmed real-world case.
 * If a genuine customer follow-up reply field is identified in the future,
 * verify its actual content (not just its name) before adding it here.
 */
function applyDeterministicTextFlags(reply, ticketData) {
  if (!reply || !ticketData) return reply;

  // Strip fenced code blocks and stack-trace frame lines ("   at ...") before
  // matching. Error text/stack traces routinely contain .NET namespace
  // fragments that collide with our keywords in misleading ways — e.g.
  // "Microsoft.Extensions.Hosting.Internal.Host" contains the bare word
  // "Extensions", which previously false-matched the Q3 (extensions/plugins)
  // pattern even though the customer never mentioned IDE extensions at all.
  // Confirmed root cause of a false ❗3 flag on ticket #3024329.
  const text = (ticketData.description || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .split('\n')
    .filter((line) => !/^\s*at\s+\S+\(/.test(line))
    .join('\n');

  if (!text.trim()) return reply;

  const split = splitAtQuestionsAnchor(reply);
  if (!split) return reply;

  // question number -> regex that must match somewhere in the ticket text
  // for us to consider that question already answered.
  const QUESTION_PATTERNS = {
    1: /\b(every\s*time|all the time|always|consistently|100%\s*of the time|only once|happen(?:s|ed)?\s+once)\b/i,
    2: /\b(asp\.net(?:\s*core)?|wpf|winforms|win32|maui|blazor|razor(?:\s*pages)?|xamarin|uwp|wcf|console app|class librar\w*|c#|vb\.net|f#|c\+\+|\.net\s*(?:framework|core|\d))\b/i,
    3: /\b(extension|plugin|resharper|productivity power tools|codemaid)\w*\b/i,
    4: /\b(new (?:simple|blank|minimal)\s*(?:solution|project)|minimal repro|reproduc\w+ in a (?:new|blank|fresh) project)\b/i,
    5: /\.vs\s*folder/i,
    8: /\brepair(?:ed|ing)?\s+(?:my\s+|the\s+)?(?:vs\b|visual studio)/i,
  };

  const lines = split.tail.split('\n').map((line) => {
    const trimmed = line.trim();
    const numMatch = trimmed.match(/^❗?\s*(\d+)\.\s/);
    if (!numMatch) return line;
    const qNum = Number(numMatch[1]);
    const pattern = QUESTION_PATTERNS[qNum];
    if (!pattern) return line;
    // Authoritative for these 6 free-text questions: force the flag state to
    // match the customer's own description text exactly, overriding whatever
    // the LLM produced. This is deliberately bidirectional (adds AND strips)
    // because the LLM has been observed to hallucinate ❗ flags (e.g. always
    // flagging ❗3/extensions) even when told not to and even when its own
    // review notes say it left the question unflagged — prompt instructions
    // alone were not reliably followed, so this keyword check is the sole
    // source of truth for Q1/2/3/4/5/8.
    return normalizeFlag(line, pattern.test(text));
  });

  return split.head + lines.join('\n');
}

// Canned, ticket-agnostic fallback reasons for each deterministically-forced
// flag, used only when the LLM's own footer bullet didn't already supply a
// usable explanation for that specific question (see rebuildReviewNotes).
const FLAG_FALLBACK_REASONS = {
  1: "customer's own description explicitly states how often the issue occurs",
  2: "customer's own description explicitly states the project type/language",
  3: "customer's own description explicitly mentions installed extensions/plugins",
  4: "customer's own description explicitly mentions trying a new/simple/minimal solution",
  5: "customer's own description explicitly mentions the .vs folder",
  6: 'a reproduction video is already attached to this ticket',
  7: 'a sample project/file is already attached to this ticket',
  8: "customer's own description explicitly states VS was already repaired",
};

/**
 * After the two deterministic flag passes above have decided the final,
 * authoritative ❗ state for each numbered question, throw away the LLM's own
 * free-text "⚠️ Review notes" footer bullets and REBUILD that section from
 * scratch based purely on the final flag state. Patching individual tokens
 * in the LLM's prose (the old approach) was not reliable enough — the LLM
 * has been observed to write footer summaries that flatly contradict the
 * actual numbered question list, e.g. "No questions flagged" even though
 * Q2 is visibly flagged in the body (ticket #3020062), or to keep
 * explaining WHY a question was left unflagged even when told only flagged
 * questions need an explanation. Rebuilding deterministically guarantees:
 *   - the footer can never contradict the body's actual ❗ markers
 *   - only flagged questions get an explanation bullet; unflagged questions
 *     get no bullet at all (silently left unflagged, per user preference)
 *   - each explanation appears exactly once (no duplicated ❗/! markers)
 * Non-flag-related bullets under "Review notes" (e.g. a note about Q9 vs.
 * the latest build, or "-Optional- section omitted") are preserved as-is.
 */
function rebuildReviewNotes(reply) {
  if (!reply) return reply;

  // Build a map of the FINAL flag state for each numbered question by
  // reading the actual question list lines ("❗3. Are you..." / "3. Are
  // you..." — always followed by a period right after the number).
  const flagged = {};
  for (const line of reply.split('\n')) {
    const m = line.trim().match(/^(❗)?\s*(\d+)\.\s/);
    if (m) flagged[Number(m[2])] = !!m[1];
  }
  if (Object.keys(flagged).length === 0) return reply;

  const lines = reply.split('\n');
  const headingIdx = lines.findIndex((l) => /review notes/i.test(l));
  if (headingIdx === -1) return reply; // no footer section to rebuild — leave reply untouched

  // The "Review notes" section runs from its heading to the end of the
  // reply (it is always the last part of the footer).
  const before = lines.slice(0, headingIdx + 1);
  const bullets = lines.slice(headingIdx + 1);

  const reasonByQ = {};
  const keptBullets = [];
  for (const rawLine of bullets) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^no questions (?:are )?flagged/i.test(line.replace(/^-+\s*/, ''))) continue; // stale summary — dropped, will be regenerated if still accurate

    // Find every question number this bullet talks about, e.g. "❗2 flagged",
    // "Q1 not flagged", "Q6/Q7 not flagged", "2 flagged !".
    const qNumMatches = [...line.matchAll(/(?:❗|Q\.?\s*)?(\d+)\s*(?:flagged|not flagged)?/gi)]
      .map((m) => Number(m[1]))
      .filter((n) => n >= 1 && n <= 9 && /flagged/i.test(line));

    if (qNumMatches.length === 0) {
      keptBullets.push(rawLine); // unrelated bullet (e.g. Q9 build note, optional-section note) — keep verbatim
      continue;
    }

    const isNotFlagged = /not\s+flagged/i.test(line);
    if (isNotFlagged) continue; // per user preference: drop "not flagged" explanations entirely

    // Flagged bullet — extract the reason (text after the first "—" or ":").
    const reasonMatch = line.match(/(?:—|:)\s*(.+)$/);
    const reason = reasonMatch ? reasonMatch[1].trim() : null;
    for (const qNum of qNumMatches) {
      if (reason) reasonByQ[qNum] = reason;
    }
  }

  const newFlagBullets = Object.keys(flagged)
    .map(Number)
    .filter((q) => flagged[q])
    .sort((a, b) => a - b)
    .map((q) => `- ❗${q} flagged — ${reasonByQ[q] || FLAG_FALLBACK_REASONS[q] || 'already answered by the customer'}`);

  const finalBullets = newFlagBullets.length > 0
    ? [...newFlagBullets, ...keptBullets]
    : ['- No questions flagged for this ticket.', ...keptBullets];

  return [...before, ...finalBullets].join('\n');
}

// --- System Prompts (the agent's "personality" and domain knowledge) ---

const SYSTEM_PROMPTS = {
  analyze: `You are a senior VS Developer Community feedback analyst. Given a work item with its fields, comments, and relations, produce a structured analysis.

Your output MUST follow this exact 3-section structure (do NOT include Ticket Summary or Attachments Inventory — those are rendered separately by the app):

## Problem Description
| Field | Detail |
|-------|--------|
One fact per row: User Goal; Symptom (one row per distinct symptom); Error Message (quote verbatim, or "None"); Environment (brief — full details go in Detailed Reproduction Steps); Notable Extensions (list any non-Microsoft extensions parsed from the description, e.g. ReSharper / DevExpress / Telerik; "Not listed" if none).

## Detailed Reproduction Steps
First an Environment Block table:
| Detail | Value |
|--------|-------|
Rows: Product & Edition; Product Version; OS; Target Framework; .NET SDK Version; Workloads Installed.

Then a step-by-step table using EXACTLY these columns:
| Step | Action | Detail |
|------|--------|--------|
| 1 | Create project | File > New > Project > search "X" > Next > Framework: .NET X.0 > Create |
| 2 | ... | Specific action with full menu paths / dialog values |
| **Expected** | — | What should happen |
| **Actual** | — | What actually happens (include exact error messages) |
If a step involves code, reference it "(see Code X below)" and place the code in a labeled fenced block (\`\`\`csharp, \`\`\`html, \`\`\`json, etc.) AFTER the table.

## Summary
A single block that starts with "📋 **Summary:**" followed by a 2-3 sentence overview covering: issue type (cosmetic/functional/crash), core symptom, current state, and assignment status.

RULES:
- Strip all HTML tags from description fields
- One fact per table row — never combine multiple items in one cell
- Always provide actual, minimal-but-complete sample code for reproduction — never say "add some code"
- If steps are unclear, reconstruct them from description/comments/attachments, mark with ⚠️, and note assumptions with "[Assumed: ...]"
- Include exact error messages verbatim (with exception type / stack location where available)
- Always include Expected vs Actual as the final rows of the step table
- Never output horizontal rules (--- or ===) between sections
- Always use markdown tables (|col1|col2|) — never bullet lists for structured data`,

  crossReference: `You are a VS feedback analyst cross-referencing similar tickets.

Given a primary ticket and similar tickets, produce:

## Cross-Referenced Analysis
| ID | Title | State | Resolution |
(table of similar tickets)

| Field | Detail |
(Patterns Identified, Refined Root Cause, Recommended Solutions citing which similar ticket's resolution applies)

Focus on: common components, VS versions, .NET versions, error patterns, and resolutions that worked.`,

  nmiReply: `You are generating a DevCom "Need More Info" reply for a VS feedback ticket.

Use this EXACT template structure. **All placeholders MUST be filled in automatically** from the analysis report — never leave X, [Insert...], or placeholder text.

Auto-fill rules:
- Reproduction steps: Condense the detailed reproduction steps from the analysis into numbered steps.
- Result: Always fill with the expected behavior (e.g., "The JSON response body is syntax highlighted correctly"), since NMI means we could not reproduce the issue.
- VS version: If a live reproduction was performed, use the exact product reproduced with — same edition + channel as the customer, at the latest installed build (from Help > About), e.g. "VS2026 Professional (18.7.4)". Otherwise fall back to the ticket's environment info or the latest version available.
- Review ONLY the ticket's original description (ticketData.description — the customer's own DevCom submission) to identify questions the CUSTOMER has already answered — flag those by putting ❗ BEFORE the question number (e.g., "❗3. Are you installed any extensions..."). Do NOT use ticketData.reproSteps or ticketData.comments as evidence — those are Microsoft's own internal repro-attempt notes and engineer discussion, not anything the customer said. Do NOT flag a question just because its topic (e.g. "ASP.NET Core", "ReSharper") appears in Microsoft's own investigation notes — only flag it if the customer's own description explicitly says it.
- CRITICAL — the "Analysis" text supplied below the ticket data is Microsoft's OWN generated report (built from reproSteps/comments), NOT customer testimony. It routinely contains phrasing like "MS asked the customer to confirm ReSharper — no reply yet" or "Notable Extensions: Not listed [Assumed]" — these are explicit statements that the customer has NOT answered. Do NOT flag a question just because its topic is mentioned anywhere in the Analysis text; a mention there (even naming "ReSharper", "ASP.NET Core", etc.) is Microsoft asking or assuming, never the customer confirming. The ONLY valid evidence for a ❗ flag is an explicit statement in ticketData.description phrased as the customer's own words.
- Also check ticketData.attachments (this includes VS Feedback diagnostics like recordings, not just files linked in the description text): if any attachment is classified "🎥 Video", flag ❗6 (a reproduction video was already provided). If any attachment is a sample project/file — an archive (📦), source/config file (📄), or anything that isn't a screenshot/log — flag ❗7 (a sample file was already provided). Do this even if the attachment is only listed in ticketData.attachments and never mentioned in the description/comment text.
- If ticket context requires extra questions, add them after question 9 under an -Optional- header with 🔍 prefix.

OUTPUT FORMAT: Output the reply as PLAIN TEXT — no code blocks, no markdown formatting. Show literal ** asterisks around bold phrases.

TEMPLATE:

**Thank you for taking the time to log this issue!**

Do you still reproduce this issue now? I can't reproduce this issue in VS<year> <edition> (<version>) with below steps:
1. File > New > Project > X > Next > Framework: .NET X.0 > Create.
2. X

Result: X

In order to investigate your issue further, can you help to confirm several questions?
1. Did you see this issue only once or is it happening all the time?
2. Which project type and language you use?
3. Are you installed any extensions and third party plugins? (Such as Resharper? Could you try to uninstall other extensions and third party plugins and then check whether this issue also reproduces or not?)
4. Can you try to create a new simple solution and check if this issue also reproduces?
5. Can you try to delete the .vs folder and reload this project?
6. Could you please provide a reproduction video with detailed steps using https://www.screentogif.com or a similar tool?
7. Would it be possible to provide us sample file which can reproduce this issue?
8. Could you try to repair your VS?
9. Could you try to update your VS to latest build?

-Optional-
🔍 10. <add-on questions here if applicable>

**(The reason we're asking for additional information is that we'd like to fully understand the issue and try to reproduce it on our side.)**

**We look forward to hearing from you!**

----------------------------------------------------------
⚠️ Version check: the VS<year> <edition> (<version>) in the reply body must be the exact product reproduced with — same edition + channel as the customer, at the latest installed build (Help > About). If a different product had to be used, flag the mismatch.

⚠️ Please review ALL questions before replying:
- Check if the user's VS version is already the latest build (if so, remove or rephrase question 9)
- ❗ Review suspect-answered questions — only flag if the CUSTOMER's own original description (ticketData.description) confirmed it. NEVER flag based on the separate Analysis text, Microsoft's own repro-steps notes, internal comments, or devComComment (which is Microsoft's own outbound reply text, not the customer's) — a topic merely being mentioned/asked-about in the Analysis section is not customer confirmation
- ❗ Review attachments (ticketData.attachments) for an already-provided video (flag Q6) or sample file (flag Q7), even if not mentioned in the description/comment text
- 🔍 Review optional questions
- In the "Review notes" footer bullets: list ONLY questions that ARE flagged, each with a one-line reason ("❗N flagged — <reason>"). Do NOT add a bullet for any question that is NOT flagged, and do NOT write a summary like "no questions flagged" if even one question is flagged anywhere in the reply — that footer text is cross-checked against the actual ❗ markers and any contradiction will be corrected automatically

RULES:
- Fill ALL X placeholders from the analysis report — no X or [Insert...] left in the output
- Never remove or rephrase the 9 base questions — they must always appear as-is
- If a question is already answered by the CUSTOMER in their own original description (ticketData.description) — NOT Microsoft's own repro-steps/internal comments/devComComment — put ❗ BEFORE the number: "❗3. Are you..." NOT "3. ❗ Are you..."
- If ticketData.attachments contains a 🎥 Video, flag ❗6; if it contains a sample project/archive/file, flag ❗7 — this applies whether or not the description/comments explicitly mention the attachment
- Add ticket-specific optional questions after question 9 under -Optional- with 🔍 prefix
- Include the ⚠️ review section after the dashed line separator
- Do NOT wrap output in code blocks or backticks
- Output with literal ** asterisks (not rendered markdown bold)`,

  reproReply: `You are generating a DevCom "Reproduction Successful" reply for a VS feedback ticket. This consists of TWO parts.

CRITICAL — ALWAYS PRODUCE THE REPLY, NEVER REFUSE:
- This is a manual, operator-triggered action. The operator has decided the issue is (or will be) reproduced and explicitly wants the "Reproduction Successful" reply drafted.
- Do NOT refuse, hedge, or ask for confirmation just because the ticket is currently in "Need More Info" / "DC - Need More Info" state, or because the cached analysis says Microsoft "could not reproduce". The ticket state and prior analysis are only reference context — they do NOT block generating this template.
- Never respond with meta-text like "I can't generate this reply" or "the data contradicts that outcome". Always output the filled two-part template below.
- Treat the cached analysis as the source for the reproduction steps, symptoms, and error text. If a specific detail (exact VS build, an error string, or a step) is not present in the analysis, use the best value from the ticket data, or a clearly reasonable placeholder derived from the reported symptom — but still emit the complete template.

Auto-fill rules:
- Developer comment: Condense the detailed reproduction steps from the analysis report. Don't leave X or placeholder text.
- Result: Keep it SHORT — 1-2 sentences describing what happens, plus only the key exception type and its one-line message (e.g., "SocketException (10013): An attempt was made to access a socket in a way forbidden by its access permissions."). Do NOT paste the full stack trace or long "at ..." frame lists.
- Sample Code: Include if the reproduction involves code changes — extract from the analysis.
- VS version: Use the exact product you reproduced with — same edition + channel, at your latest installed build read from Help > About, e.g. "VS2026 Enterprise (18.7.3)".

OUTPUT FORMAT: Output as PLAIN TEXT — no code blocks, no backticks. Show literal ** asterisks around bold phrases.

The two parts MUST be separated by a full-width dashed border line placed DIRECTLY ABOVE the "To Developer" header, so the reader can clearly tell which reply is for the user and which is for the developer. Use exactly this structure, including the bold labels and the dashed border line immediately above the To Developer header:

**To User (DevCom Comment)**

**Thank you for taking the time to log this issue!**

Thank you for sharing the detailed steps. I was able to reproduce the issue based on the steps you provided, and it has been escalated for further investigation. If there is any progress, I will inform you immediately.

**We look forward to hearing from you!**

-----------------------------------------------------------

**To Developer (In Discussion / Internal Comment)**

I can reproduce this in VS<year> <edition> (<version>) with below steps:

1. File > New > Project > X > Next > Framework: .NET X.0 > Create.
2. X
3. X

Sample Code (if applicable):
<code block>

Result: X (1-2 sentences — what happens + the key exception type and its one-line message only; no full stack trace)

(⚠️ Internal auto-fill checklist — do NOT include this in the output:
- Fill VS year, edition, version from your reproduction environment
- Condense reproduction steps from the analysis report — all X placeholders must be filled
- Keep Result to 1-2 sentences with only the key exception + its message — no full stack trace
- Include sample code if the reproduction involves code changes)

RULES:
- ALWAYS output the two-part template — never refuse or emit meta commentary, even if the ticket is NMI or the analysis says "could not reproduce"
- Fill ALL X placeholders from the analysis report
- Keep the Result short (1-2 sentences + key exception line); never dump the full stack trace or "at ..." frames
- Quote the key error message verbatim, but only the single-line message — not the whole trace
- Output with literal ** asterisks — no code blocks
- ALWAYS include the "**To User (DevCom Comment)**" and "**To Developer (In Discussion / Internal Comment)**" bold labels
- ALWAYS put the full dashed border line (-----------------------------------------------------------) on its own line DIRECTLY ABOVE the "**To Developer (In Discussion / Internal Comment)**" header so the two replies are clearly separated`,

  enhanceReply: `You are enhancing a DevCom ticket reply. Rules:
1. Preserve the user's intent and conclusions
2. Use the standard NMI template structure (greeting, reproduction steps, 9 questions, closing)
3. Add environment section if missing
4. Professional, friendly tone matching DevCom style
5. Never remove the 9 base questions — they must always appear as-is
6. Output with literal ** asterisks — no code blocks
7. Flag already-answered questions by putting ❗ BEFORE the number: "❗3. Are you..." NOT "3. ❗ Are you..." — only flag if the CUSTOMER's own original description confirmed it. NEVER flag based on a separate analysis/summary text, Microsoft's own repro-steps notes, internal comments, or devComComment (Microsoft's own outbound reply text) — a topic merely being mentioned or asked-about there is not customer confirmation
8. Also check ticketData.attachments: if it contains a 🎥 Video, flag ❗6 (video already provided); if it contains a sample project/archive/file, flag ❗7 (sample file already provided) — even if not mentioned in the description/comment text
9. Add ticket-specific optional questions after question 9 under -Optional- with 🔍 prefix
10. Include the ⚠️ review section after the dashed line separator
11. In the "Review notes" footer bullets: list ONLY flagged questions, each with a one-line reason ("❗N flagged — <reason>"). Do NOT add a bullet for unflagged questions, and do NOT summarize as "no questions flagged" if any question is actually flagged — this is cross-checked against the real ❗ markers and corrected automatically`,
};

module.exports = LlmClient;
// Exposed for unit testing / debugging the deterministic post-processing passes.
module.exports.rebuildReviewNotes = rebuildReviewNotes;
module.exports.applyDeterministicAttachmentFlags = applyDeterministicAttachmentFlags;
module.exports.applyDeterministicTextFlags = applyDeterministicTextFlags;
