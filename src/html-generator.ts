import type { ScoredRFP, RunMetadata } from "./types.js";
import {
  categoryHue,
  daysUntil,
  stripHtml,
  truncate,
  esc,
  urgencyClass,
  formatCurrency,
} from "./utils.js";

const ESBD_DETAIL_URL = "https://www.txsmartbuy.gov/esbd";
const ESBD_FILE_BASE = "https://www.txsmartbuy.gov";
const NYC_FILE_BASE = "https://data.cityofnewyork.us";

const SOURCE_LABEL: Record<string, string> = {
  esbd: "Texas ESBD",
  nyc: "NYC OpenData",
};

function renderMarkdown(md: string): string {
  const escaped = esc(md);
  const lines = escaped.split("\n");
  const html: string[] = [];
  let inList = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      continue;
    }
    // Headings
    const h = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      if (inList) {
        html.push("</ul>");
        inList = false;
      }
      const level = h[1]!.length + 1; // ## -> h3, ### -> h4 (offset since it's inside a card)
      html.push(`<h${level}>${h[2]}</h${level}>`);
      continue;
    }
    // List items
    const li = trimmed.match(/^[-*]\s+(.+)$/);
    if (li) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${li[1]}</li>`);
      continue;
    }
    // Numbered list
    const oli = trimmed.match(/^\d+\.\s+(.+)$/);
    if (oli) {
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${oli[1]}</li>`);
      continue;
    }
    // Paragraph
    if (inList) {
      html.push("</ul>");
      inList = false;
    }
    html.push(`<p>${trimmed}</p>`);
  }
  if (inList) html.push("</ul>");

  return html
    .join("\n")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

function renderBadge(category: string): string {
  const hue = categoryHue(category);
  return `<span class="badge" style="background:hsl(${hue},55%,92%);color:hsl(${hue},60%,30%)">${esc(category)}</span>`;
}

function buildAttachmentUrl(rfp: ScoredRFP, fileURL: string): string {
  if (rfp.source === "nyc") {
    return fileURL.startsWith("http") ? fileURL : NYC_FILE_BASE + fileURL;
  }
  return fileURL.startsWith("http") ? fileURL : ESBD_FILE_BASE + fileURL;
}

function buildDetailLink(rfp: ScoredRFP): string {
  if (rfp.detailUrl) return rfp.detailUrl;
  if (rfp.source === "nyc") return `${NYC_FILE_BASE}/d/${encodeURIComponent(rfp.solicitationId)}`;
  return `${ESBD_DETAIL_URL}/${encodeURIComponent(rfp.solicitationId)}`;
}

function renderCard(rfp: ScoredRFP, rank: number): string {
  const hasDueDate = rfp.source === "esbd" && !!rfp.responseDue;
  const days = hasDueDate ? daysUntil(rfp.responseDue) : 999;
  const dueClass = urgencyClass(days);
  const dueLabel = !hasDueDate
    ? ""
    : days < 0
      ? "PAST DUE"
      : days === 0
        ? "DUE TODAY"
        : `${days} day${days !== 1 ? "s" : ""} left`;

  const description = stripHtml(rfp.description);
  const detailLink = buildDetailLink(rfp);
  const sourceLabel = SOURCE_LABEL[rfp.source] ?? rfp.source;

  const attachmentHtml =
    rfp.attachments.length > 0
      ? `<div class="attachments">
          <strong>Attachments:</strong>
          ${rfp.attachments
            .map(
              (a) =>
                `<a href="${esc(buildAttachmentUrl(rfp, a.fileURL))}" target="_blank" class="attachment-link">${esc(a.fileName)}</a>`,
            )
            .join(" ")}
        </div>`
      : "";

  const sourceBadge = `<span class="source-badge source-${esc(rfp.source)}">${esc(sourceLabel)}</span>`;

  return `
    <div class="card" data-source="${esc(rfp.source)}" data-categories="${rfp.matchedCategories.map(esc).join(",")}">
      <div class="card-header">
        <h2 class="card-title">
          <a href="${esc(detailLink)}" target="_blank"><span class="rank">#${rank}</span> ${esc(rfp.title)}</a>
        </h2>
        <div class="badges">${sourceBadge}</div>
      </div>

      <div class="card-meta">
        <span><strong>ID:</strong> ${esc(rfp.solicitationId)}</span>
        ${rfp.agencyName ? `<span><strong>Agency:</strong> ${esc(rfp.agencyName)}</span>` : ""}
        ${rfp.postingDate ? `<span><strong>Posted:</strong> ${esc(rfp.postingDate)}</span>` : ""}
        ${hasDueDate ? `<span class="due ${dueClass}"><strong>Due:</strong> ${esc(rfp.responseDue)} ${esc(rfp.responseTime)} <em>(${dueLabel})</em></span>` : ""}
        ${rfp.value && parseFloat(rfp.value.replace(/,/g, "")) >= 1 ? `<span><strong>Value:</strong> $${esc(formatCurrency(rfp.value))}</span>` : ""}
      </div>

      <div class="card-contact">
        ${rfp.contactName ? `<span><strong>Contact:</strong> ${esc(rfp.contactName)}</span>` : ""}
        ${rfp.contactNumber ? `<span><strong>Phone:</strong> ${esc(rfp.contactNumber)}</span>` : ""}
        ${rfp.contactEmail ? `<span><strong>Email:</strong> <a href="mailto:${esc(rfp.contactEmail)}">${esc(rfp.contactEmail)}</a></span>` : ""}
      </div>

      <div class="card-description">
        <p>${rfp.aiShortSummary ? esc(rfp.aiShortSummary) : esc(description)}</p>
      </div>

      ${
        rfp.aiShortSummary && description
          ? `<details class="card-dropdown">
        <summary>Original description</summary>
        <p>${esc(description)}</p>
      </details>`
          : ""
      }

      ${
        rfp.aiSummary
          ? `<details class="card-dropdown">
        <summary>AI Summary</summary>
        <div class="ai-summary-content">${renderMarkdown(rfp.aiSummary)}</div>
      </details>`
          : ""
      }

      <details class="card-dropdown">
        <summary>Matched tags</summary>
        <p>${esc(rfp.matchDetails)}</p>
      </details>

       ${attachmentHtml}
    </div>`;
}

function renderMethodology(): string {
  return `
    <section class="methodology" id="methodology">
      <h2>How This Works</h2>

      <h3>Finding the data</h3>
      <p>
        All of this comes from the
        <a href="https://www.txsmartbuy.gov/esbd">Texas ESBD portal</a>.
        I opened DevTools, watched the network requests, and found two JSON endpoints
        the site's frontend uses behind the scenes: one for paginated listings, one for
        full solicitation details. The site runs on NetSuite SuiteCommerce, everything
        is a JavaScript SPA talking to these APIs. So rather than spinning up a headless
        browser to scrape rendered HTML, I just hit the API directly. Faster, cleaner, and
        doesn't break when they change their CSS.
      </p>

      <h3>Speed</h3>
      <p>
        There are hundreds of listings across dozens of pages. Going one at a time would be
        painfully slow, so everything runs concurrently, all listing pages fetch at
        once, detail requests go out in batches of 10, attachment downloads fire off in
        parallel too. Retries with backoff handle any flaky responses. Both "Open" and
        "Addendum Posted" statuses are pulled simultaneously and deduplicated.
      </p>

      <h3>Scoring: keywords + embeddings</h3>
      <p>
        Relevance scoring happens in two layers.
      </p>
      <p>
        <strong>Layer 1: keyword matching.</strong>
        50 vendor categories (HVAC, roofing, electrical, plumbing, painting, etc.) each have
        a curated keyword list. Every solicitation is checked against those keywords across
        four fields:
      </p>
      <table class="weight-table">
        <tr><td>Title</td><td>3.0x</td><td>Usually the clearest indicator of what the RFP is</td></tr>
        <tr><td>NIGP codes</td><td>2.5x</td><td>Standardized commodity codes from the state</td></tr>
        <tr><td>Description</td><td>2.0x</td><td>Full detail text, lots of signal but also noise</td></tr>
        <tr><td>Agency name</td><td>0.5x</td><td>Occasionally useful, often not</td></tr>
      </table>
      <p>
        <strong>Layer 2: semantic embeddings.</strong>
        Keywords only go so far. An RFP about "climate control system upgrades" should match
        HVAC, but there's no keyword overlap. So after keyword scoring, the tool converts each
        RFP's text and each category description into vector embeddings (using OpenAI embeddings, costs less than a cent per whole run). Cosine similarity between those vectors measures
        how close they are <em>in meaning</em>, not just in shared words.
      </p>
      <p>
        The two scores get normalized to the same 0&ndash;1 scale and blended:
        <strong>40% keyword + 60% semantic = final score</strong>.
        This way, exact keyword matches still count, but the ranking is mostly driven by
        actual meaning. Category embeddings are cached to disk so subsequent runs don't
        recompute them.
      </p>
      <p>
        Before any of this, a quick pre-filter on title and NIGP codes skips obviously
        irrelevant listings so we don't waste time fetching details for things like
        office supply contracts.
      </p>

      <h3>Document extraction</h3>
      <p>
        For the top results, every attachment gets downloaded. PDFs are parsed with pdf-parse,
        Word docs go through mammoth, and plain text files are read as-is. The extracted text
        is saved alongside the originals and fed into the AI step.
      </p>

      <h3>AI summaries</h3>
      <p>
        Each solicitation's metadata plus all its extracted document text gets sent to an LLM.
        It comes back with a short one-liner (what you see on the card) and a detailed
        breakdown: scope, bid requirements, timeline, estimated value, and a recommendation
        on whether it's worth pursuing. All requests fire in parallel.
        The AI step is optional, <code>--noai</code> skips it entirely and you get
        keyword-only scoring with no external API calls beyond the embeddings.
      </p>

      <h3>limitations</h3>
      <ul>
        <li>If an RFP uses terminology that's not in the keyword lists <em>and</em> is too
            far from the category descriptions for the embedding model to pick up, it won't
            show up here</li>
        <li>Scanned PDFs (images, not selectable text) come back empty from extraction</li>
        <li>Excel files, zip archives, and anything that isn't PDF/DOCX/TXT gets ignored</li>
        <li>Embeddings are good at catching meaning but not perfect, edge cases exist</li>
      </ul>
    </section>`;
}

function getCSS(): string {
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
                   "Helvetica Neue", Arial, sans-serif;
      background: #f0f2f5;
      color: #1f2937;
      line-height: 1.6;
      padding: 2rem 1rem;
    }

    .container {
      max-width: 920px;
      margin: 0 auto;
    }

    header {
      text-align: center;
      margin-bottom: 2rem;
    }

    header h1 {
      font-size: 1.8rem;
      color: #111827;
      margin-bottom: 0.25rem;
    }

    header p {
      color: #6b7280;
      font-size: 0.95rem;
    }

    .summary-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
      justify-content: center;
      background: #fff;
      border-radius: 8px;
      padding: 1rem 1.5rem;
      margin-bottom: 2rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }

    .summary-stat {
      text-align: center;
    }

    .summary-stat .num {
      font-size: 1.4rem;
      font-weight: 700;
      color: #1a56db;
    }

    .summary-stat .label {
      font-size: 0.8rem;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .card {
      background: #fff;
      border-radius: 8px;
      padding: 1.5rem;
      margin-bottom: 1.25rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }

    .card-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 0.5rem;
      flex-wrap: wrap;
    }

    .rank {
      font-weight: 700;
      font-size: 1.1rem;
      color: #1a56db;
    }

    .score {
      font-size: 0.85rem;
      color: #059669;
      font-weight: 600;
    }

    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
      margin-left: auto;
    }

    .badge {
      display: inline-block;
      padding: 0.15rem 0.55rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      white-space: nowrap;
    }

    .card-title {
      font-size: 1.1rem;
      margin: 0;
    }

    .card-title a {
      color: #1a56db;
      text-decoration: none;
    }

    .card-title a:hover {
      text-decoration: underline;
    }

    .card-meta {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.25rem 1.5rem;
      font-size: 0.88rem;
      color: #4b5563;
      margin-bottom: 0.75rem;
    }

    .due.overdue { color: #991b1b; font-weight: 700; }
    .due.urgent  { color: #dc2626; font-weight: 700; }
    .due.soon    { color: #d97706; font-weight: 600; }
    .due.normal  { color: #4b5563; }

    .card-description {
      font-size: 0.9rem;
      color: #374151;
      margin-bottom: 0.75rem;
      border-left: 3px solid #e5e7eb;
      padding-left: 0.75rem;
    }

    .card-dropdown {
      font-size: 0.82rem;
      color: #6b7280;
      margin-bottom: 0.5rem;
    }

    .card-dropdown summary {
      cursor: pointer;
      user-select: none;
      color: #9ca3af;
      font-size: 0.78rem;
    }

    .card-dropdown > p {
      margin-top: 0.35rem;
      border-left: 2px solid #e5e7eb;
      padding-left: 0.75rem;
    }

    .card-contact {
      display: flex;
      flex-wrap: wrap;
      gap: 1.25rem;
      font-size: 0.85rem;
      color: #4b5563;
      margin-bottom: 0.5rem;
    }

    .card-contact a {
      color: #1a56db;
      text-decoration: none;
    }

    .card-contact a:hover {
      text-decoration: underline;
    }

    .attachments {
      font-size: 0.83rem;
      color: #4b5563;
      margin-bottom: 0.5rem;
    }

    .attachment-link {
      display: inline-block;
      background: #f3f4f6;
      padding: 0.15rem 0.5rem;
      border-radius: 4px;
      color: #1a56db;
      text-decoration: none;
      font-size: 0.78rem;
      margin: 0.15rem 0.2rem;
    }

    .attachment-link:hover {
      background: #e5e7eb;
    }

    .ai-summary-content {
      margin-top: 0.5rem;
      padding-left: 0.75rem;
      line-height: 1.6;
    }

    .ai-summary-content p {
      margin-bottom: 0.4rem;
    }

    .ai-summary-content ul {
      padding-left: 1.5rem;
      margin-bottom: 0.5rem;
    }

    .ai-summary-content li {
      margin-bottom: 0.2rem;
    }

    .ai-summary-content h3,
    .ai-summary-content h4 {
      margin-top: 0.6rem;
      margin-bottom: 0.25rem;
      color: #1f2937;
    }

    .methodology {
      background: #fff;
      border-radius: 8px;
      padding: 2rem;
      margin-top: 2.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }

    .methodology h2 {
      font-size: 1.4rem;
      margin-bottom: 1rem;
      color: #111827;
    }

    .methodology h3 {
      font-size: 1.05rem;
      margin-top: 1.25rem;
      margin-bottom: 0.5rem;
      color: #1f2937;
    }

    .methodology p,
    .methodology li {
      font-size: 0.92rem;
      color: #374151;
      margin-bottom: 0.5rem;
    }

    .methodology ul {
      padding-left: 1.5rem;
      margin-bottom: 0.75rem;
    }

    .methodology code {
      background: #f3f4f6;
      padding: 0.1rem 0.4rem;
      border-radius: 3px;
      font-size: 0.85rem;
    }

    .weight-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.88rem;
      margin: 0.5rem 0 0.75rem;
    }

    .weight-table td {
      padding: 0.3rem 0.6rem;
      border-bottom: 1px solid #e5e7eb;
    }

    .weight-table td:nth-child(2) {
      font-weight: 600;
      color: #1a56db;
      white-space: nowrap;
    }

    .weight-table td:nth-child(3) {
      color: #6b7280;
    }

    .top-categories {
      text-align: center;
      font-size: 0.85rem;
      color: #6b7280;
      margin-bottom: 1.5rem;
    }

    .top-categories strong {
      color: #4b5563;
    }

    .cat-link {
      color: #6b7280;
      cursor: pointer;
      border: none;
      background: none;
      font: inherit;
      padding: 0;
    }

    .cat-link:hover {
      color: #1a56db;
    }

    .cat-link.active {
      color: #1a56db;
      font-weight: 600;
    }

    .card.hidden-by-filter,
    .card.hidden-by-source {
      display: none;
    }

    .source-filter {
      display: flex;
      justify-content: center;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
      flex-wrap: wrap;
    }

    .source-btn {
      background: #fff;
      border: 1px solid #d1d5db;
      color: #4b5563;
      padding: 0.4rem 0.9rem;
      border-radius: 9999px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .source-btn:hover {
      border-color: #1a56db;
      color: #1a56db;
    }

    .source-btn.active {
      background: #1a56db;
      color: #fff;
      border-color: #1a56db;
    }

    .source-btn .count {
      opacity: 0.75;
      font-weight: 500;
      margin-left: 0.25rem;
    }

    .source-badge {
      display: inline-block;
      padding: 0.15rem 0.55rem;
      border-radius: 9999px;
      font-size: 0.72rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .source-badge.source-esbd {
      background: #fef3c7;
      color: #92400e;
    }

    .source-badge.source-nyc {
      background: #dbeafe;
      color: #1e40af;
    }

    footer {
      text-align: center;
      color: #9ca3af;
      font-size: 0.8rem;
      margin-top: 2rem;
      padding-top: 1rem;
      border-top: 1px solid #e5e7eb;
    }

    @media (max-width: 640px) {
      body { padding: 1rem 0.5rem; }
      .card-meta { grid-template-columns: 1fr; }
      .badges { margin-left: 0; }
      .card-contact { flex-direction: column; gap: 0.4rem; }
}
  `;
}

/**
 * Generate the full HTML results page.
 * @param results - Array of scored and optionally AI-summarized RFPs
 * @param metadata - Run metadata (timestamps, counts, category stats)
 * @returns Complete HTML document string
 */
export function generateHTML(
  results: ScoredRFP[],
  metadata: RunMetadata,
): string {
  const generatedStr = metadata.generatedAt.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const sources = metadata.sources ?? ({} as RunMetadata["sources"]);
  const sourceEntries = (Object.entries(sources) as [
    keyof typeof sources,
    { top: number },
  ][]).filter(([, s]) => s && s.top > 0);

  const sourceFilter =
    sourceEntries.length > 1
      ? `<div class="source-filter">
      <button class="source-btn active" data-source="all">All <span class="count">(${results.length})</span></button>
      ${sourceEntries
        .map(
          ([key, s]) =>
            `<button class="source-btn" data-source="${esc(key)}">${esc(SOURCE_LABEL[key] ?? key)} <span class="count">(${s.top})</span></button>`,
        )
        .join("")}
    </div>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LightRFP — Top ${results.length} Government Opportunities</title>
  <style>${getCSS()}</style>
</head>
<body>
  <div class="container">
    ${sourceFilter}

    <p class="top-categories"><strong>Top categories:</strong> ${Object.entries(
      metadata.categoryCounts,
    )
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(
        ([cat, count]) =>
          `<button class="cat-link" data-category="${esc(cat)}">${esc(cat)} (${count})</button>`,
      )
      .join(", ")}</p>

    ${results.map((rfp, i) => renderCard(rfp, i + 1)).join("\n")}

    ${renderMethodology()}

    <footer>
      LightRFP &mdash; ${esc(generatedStr)} &mdash; Data sourced from
      <a href="https://www.txsmartbuy.gov/esbd" style="color:#6b7280">Texas ESBD</a>
      and
      <a href="https://data.cityofnewyork.us" style="color:#6b7280">NYC OpenData</a>
    </footer>
  </div>
  <script>
    (function() {
      var activeCat = null;
      var activeSource = 'all';
      var catLinks = document.querySelectorAll('.cat-link');
      var sourceBtns = document.querySelectorAll('.source-btn');
      var cards = document.querySelectorAll('.card');

      function applySource(src) {
        activeSource = src;
        sourceBtns.forEach(function(b) {
          b.classList.toggle('active', b.getAttribute('data-source') === src);
        });
        cards.forEach(function(card) {
          var cardSrc = card.getAttribute('data-source');
          var hide = src !== 'all' && cardSrc !== src;
          card.classList.toggle('hidden-by-source', hide);
        });
      }

      function applyCategory(category) {
        activeCat = category;
        catLinks.forEach(function(l) {
          l.classList.toggle('active', l.getAttribute('data-category') === category);
        });
        cards.forEach(function(card) {
          var cats = (card.getAttribute('data-categories') || '').split(',');
          card.classList.toggle('hidden-by-filter', cats.indexOf(category) === -1);
        });
      }

      function clearCategory() {
        activeCat = null;
        catLinks.forEach(function(l) { l.classList.remove('active'); });
        cards.forEach(function(c) { c.classList.remove('hidden-by-filter'); });
      }

      catLinks.forEach(function(link) {
        link.addEventListener('click', function() {
          var cat = link.getAttribute('data-category');
          if (activeCat === cat) { clearCategory(); } else { applyCategory(cat); }
        });
        link.addEventListener('dblclick', clearCategory);
      });

      sourceBtns.forEach(function(btn) {
        btn.addEventListener('click', function() {
          applySource(btn.getAttribute('data-source') || 'all');
        });
      });
    })();
  </script>
</body>
</html>`;
}
