## Setup

```bash
npm install
```

Create a `.env` file:

```
AI_API_KEY=your-openrouter-api-key
AI_API_BASE_URL=https://openrouter.ai/api/v1
AI_MODEL=google/gemini-2.5-flash-lite
AI_EMBED_MODEL=openai/text-embedding-3-small
```

## Run

```bash
# Full run
npm run start

# Without AI
npm run noai
```

Output goes to `output/results.html`.

## How This Works

### Finding the data

All of this comes from the [Texas ESBD portal](https://www.txsmartbuy.gov/esbd). I opened DevTools, watched the network requests, and found two JSON endpoints the site's frontend uses behind the scenes: one for paginated listings, one for full solicitation details. The site runs on NetSuite SuiteCommerce, everything is a JavaScript SPA talking to these APIs. So rather than spinning up a headless browser to scrape rendered HTML, I just hit the API directly. Faster, cleaner, and doesn't break when they change their CSS.

### Speed

There are hundreds of listings across dozens of pages. Going one at a time would be painfully slow, so everything runs concurrently, all listing pages fetch at once, detail requests go out in batches of 10, attachment downloads fire off in parallel too. Retries with backoff handle any flaky responses. Both "Open" and "Addendum Posted" statuses are pulled simultaneously and deduplicated.

### Scoring: keywords + embeddings

Relevance scoring happens in two layers.

**Layer 1: keyword matching.** 50 vendor categories (HVAC, roofing, electrical, plumbing, painting, etc.) each have a curated keyword list. Every solicitation is checked against those keywords across four fields:

| Field | Weight | Why |
|-------|--------|-----|
| Title | 3.0x | Usually the clearest indicator of what the RFP is |
| NIGP codes | 2.5x | Standardized commodity codes from the state |
| Description | 2.0x | Full detail text, lots of signal but also noise |
| Agency name | 0.5x | Occasionally useful, often not |

**Layer 2: semantic embeddings.** Keywords only go so far. An RFP about "climate control system upgrades" should match HVAC, but there's no keyword overlap. So after keyword scoring, the tool converts each RFP's text and each category description into vector embeddings (using OpenAI embeddings, costs less than a cent per whole run). Cosine similarity between those vectors measures how close they are *in meaning*, not just in shared words.

The two scores get normalized to the same 0-1 scale and blended: **40% keyword + 60% semantic = final score**. This way, exact keyword matches still count, but the ranking is mostly driven by actual meaning. Category embeddings are cached to disk so subsequent runs don't recompute them.

Before any of this, a quick pre-filter on title and NIGP codes skips obviously irrelevant listings so we don't waste time fetching details for things like office supply contracts.

### Document extraction

For the top results, every attachment gets downloaded. PDFs are parsed with pdf-parse, Word docs go through mammoth, and plain text files are read as-is. The extracted text is saved alongside the originals and fed into the AI step.

### AI summaries

Each solicitation's metadata plus all its extracted document text gets sent to an LLM. It comes back with a short one-liner (what you see on the card) and a detailed breakdown: scope, bid requirements, timeline, estimated value, and a recommendation on whether it's worth pursuing. All requests fire in parallel. The AI step is optional, `--noai` skips it entirely and you get keyword-only scoring with no external API calls beyond the embeddings.

### Limitations

- If an RFP uses terminology that's not in the keyword lists *and* is too far from the category descriptions for the embedding model to pick up, it won't show up here
- Scanned PDFs (images, not selectable text) come back empty from extraction
- Excel files, zip archives, and anything that isn't PDF/DOCX/TXT gets ignored
- Embeddings are good at catching meaning but not perfect, edge cases exist
