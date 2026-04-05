import type { ScoredRFP, RunMetadata } from "./types.js";
import { categoryHue, daysUntil, stripHtml, truncate, esc, urgencyClass } from "./utils.js";

const ESBD_DETAIL_URL = "https://www.txsmartbuy.gov/esbd/#/esbd";
const ESBD_FILE_BASE = "https://www.txsmartbuy.gov";

function renderBadge(category: string): string {
  const hue = categoryHue(category);
  return `<span class="badge" style="background:hsl(${hue},55%,92%);color:hsl(${hue},60%,30%)">${esc(category)}</span>`;
}

function renderCard(rfp: ScoredRFP, rank: number): string {
  const days = daysUntil(rfp.responseDue);
  const dueClass = urgencyClass(days);
  const dueLabel =
    days < 0
      ? "PAST DUE"
      : days === 0
        ? "DUE TODAY"
        : `${days} day${days !== 1 ? "s" : ""} left`;

  const description = truncate(stripHtml(rfp.description));
  const detailLink = `${ESBD_DETAIL_URL}/${encodeURIComponent(rfp.solicitationId)}`;

  const attachmentHtml =
    rfp.attachments.length > 0
      ? `<div class="attachments">
          <strong>Attachments:</strong>
          ${rfp.attachments
            .map(
              (a) =>
                `<a href="${esc(ESBD_FILE_BASE + a.fileURL)}" target="_blank" class="attachment-link">${esc(a.fileName)}</a>`,
            )
            .join(" ")}
        </div>`
      : "";

  return `
    <div class="card">
      <div class="card-header">
        <span class="rank">#${rank}</span>
        <span class="score">Score: ${rfp.relevanceScore.toFixed(1)}</span>
        <div class="badges">${rfp.matchedCategories.map(renderBadge).join(" ")}</div>
      </div>

      <h2 class="card-title">
        <a href="${esc(detailLink)}" target="_blank">${esc(rfp.title)}</a>
      </h2>

      <div class="card-meta">
        <div class="meta-row">
          <span><strong>ID:</strong> ${esc(rfp.solicitationId)}</span>
          <span><strong>Agency:</strong> ${esc(rfp.agencyName)}</span>
        </div>
        <div class="meta-row">
          <span><strong>Posted:</strong> ${esc(rfp.postingDate)}</span>
          <span class="due ${dueClass}"><strong>Due:</strong> ${esc(rfp.responseDue)} ${esc(rfp.responseTime)} <em>(${dueLabel})</em></span>
        </div>
        ${rfp.value ? `<div class="meta-row"><span><strong>Value:</strong> $${esc(rfp.value)}</span></div>` : ""}
      </div>

      <div class="card-description">
        <p>${esc(description)}</p>
      </div>

      <div class="card-contact">
        ${rfp.contactName ? `<span><strong>Contact:</strong> ${esc(rfp.contactName)}</span>` : ""}
        ${rfp.contactNumber ? `<span><strong>Phone:</strong> ${esc(rfp.contactNumber)}</span>` : ""}
        ${rfp.contactEmail ? `<span><strong>Email:</strong> <a href="mailto:${esc(rfp.contactEmail)}">${esc(rfp.contactEmail)}</a></span>` : ""}
      </div>

      ${attachmentHtml}

      <div class="match-details">
        <em>Matched: ${esc(rfp.matchDetails)}</em>
      </div>
    </div>`;
}

function renderMethodology(): string {
  return `
    <section class="methodology" id="methodology">
      <h2>Methodology</h2>

      <h3>Data Source Discovery</h3>
      <p>
        I explored the Texas ESBD portal (<a href="https://www.txsmartbuy.gov/esbd">txsmartbuy.gov/esbd</a>)
        using Chrome DevTools. The site is a JavaScript SPA built on Oracle NetSuite SuiteCommerce Advanced.
        By monitoring network traffic in the Network tab, I discovered a JSON API endpoint that the frontend
        uses to fetch solicitation data — specifically a POST endpoint at
        <code>ESBD.Service.ss</code> for listings and a GET endpoint at
        <code>ESBD.Details.Service.ss</code> for full solicitation details.
      </p>

      <h3>Approach: Direct API Integration</h3>
      <p>I chose to query the JSON API directly rather than scraping rendered HTML because:</p>
      <ul>
        <li>Structured JSON data is more reliable than HTML parsing</li>
        <li>Faster execution — no browser rendering overhead (no Playwright/Selenium needed)</li>
        <li>Less fragile — API contracts change less often than HTML layout</li>
        <li>Allows efficient pagination and server-side filtering</li>
      </ul>

      <h3>Relevance Filtering</h3>
      <p>
        I built a weighted keyword scoring engine that maps each of the 50 vendor categories to a curated
        list of relevant keywords and subcategories. Each RFP is scored across multiple fields:
      </p>
      <ul>
        <li><strong>Title</strong> (weight 3.0) — strongest signal for what the RFP is about</li>
        <li><strong>NIGP codes</strong> (weight 2.5) — official commodity classification codes</li>
        <li><strong>Description</strong> (weight 2.0) — full context from the detail page</li>
        <li><strong>Agency name</strong> (weight 0.5) — weak but sometimes helpful signal</li>
      </ul>
      <p>
        A pre-filter runs on listing data (title + NIGP codes) to skip obviously irrelevant RFPs
        before making detail API calls, reducing network requests significantly.
      </p>

      <h3>Limitations &amp; Trade-offs</h3>
      <ul>
        <li>Keyword matching may miss RFPs that use unusual or highly specific terminology</li>
        <li>Some RFP details exist only inside attached PDF documents, which are not analyzed in the base version</li>
        <li>The relevance scoring is heuristic (keyword-based), not ML/semantic-based</li>
        <li>Self-imposed rate limiting (1.2s between requests) means full scrape takes several minutes</li>
        <li>API session cookies may expire during very long runs</li>
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
      margin-bottom: 0.75rem;
    }

    .card-title a {
      color: #1a56db;
      text-decoration: none;
    }

    .card-title a:hover {
      text-decoration: underline;
    }

    .card-meta {
      font-size: 0.88rem;
      color: #4b5563;
      margin-bottom: 0.75rem;
    }

    .meta-row {
      display: flex;
      flex-wrap: wrap;
      gap: 1.5rem;
      margin-bottom: 0.25rem;
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

    .match-details {
      font-size: 0.78rem;
      color: #9ca3af;
      border-top: 1px solid #f3f4f6;
      padding-top: 0.5rem;
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
      .meta-row { flex-direction: column; gap: 0.25rem; }
      .badges { margin-left: 0; }
      .card-contact { flex-direction: column; gap: 0.4rem; }
    }
  `;
}

export function generateHTML(
  results: ScoredRFP[],
  metadata: RunMetadata,
): string {
  const generatedStr = metadata.generatedAt.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const categorySummary = Object.entries(metadata.categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([cat, count]) => `${cat} (${count})`)
    .join(", ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LightRFP — Top ${results.length} Government RFPs</title>
  <style>${getCSS()}</style>
</head>
<body>
  <div class="container">
    <header>
      <h1>LightRFP — Government RFP Results</h1>
      <p>Top ${results.length} solicitations relevant to building maintenance &amp; construction vendors</p>
      <p style="font-size:0.8rem;color:#9ca3af">Generated: ${esc(generatedStr)} | Source: Texas ESBD</p>
    </header>

    <div class="summary-bar">
      <div class="summary-stat">
        <div class="num">${metadata.totalScanned}</div>
        <div class="label">Scanned</div>
      </div>
      <div class="summary-stat">
        <div class="num">${metadata.totalRelevant}</div>
        <div class="label">Relevant</div>
      </div>
      <div class="summary-stat">
        <div class="num">${results.length}</div>
        <div class="label">Top Results</div>
      </div>
      <div class="summary-stat">
        <div class="num">${metadata.elapsedSeconds.toFixed(0)}s</div>
        <div class="label">Runtime</div>
      </div>
    </div>

    ${categorySummary ? `<p style="text-align:center;font-size:0.85rem;color:#6b7280;margin-bottom:1.5rem"><strong>Top categories:</strong> ${esc(categorySummary)}</p>` : ""}

    ${results.map((rfp, i) => renderCard(rfp, i + 1)).join("\n")}

    ${renderMethodology()}

    <footer>
      LightRFP Scraper &mdash; Data sourced from
      <a href="https://www.txsmartbuy.gov/esbd" style="color:#6b7280">Texas ESBD</a>
    </footer>
  </div>
</body>
</html>`;
}
