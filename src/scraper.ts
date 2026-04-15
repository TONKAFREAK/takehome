import "dotenv/config";
import { writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ESBDClient, extractDocuments } from "./api.js";
import { NYCClient } from "./nyc-api.js";
import {
  isLikelyRelevant,
  scoreAll,
  selectTopPerSource,
  interleaveBySource,
  summarizeScores,
} from "./relevance.js";
import { rankByAI } from "./ai-ranker.js";
import { generateHTML } from "./html-generator.js";
import { summarizeRfps } from "./summarizer.js";
import { ensureDir, formatElapsed, deduplicateByField } from "./utils.js";
import type {
  RunMetadata,
  RFPDetail,
  SourceKey,
  SourceStats,
} from "./types.js";

const TOP_PER_SOURCE = 20;
const CANDIDATE_PER_SOURCE = 30;
const SKIP_AI = process.argv.includes("--noai");
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "..", "output");
const DATA_DIR = join(__dirname, "..", "data");

interface SourceBatch {
  source: SourceKey;
  scanned: number;
  relevant: number;
  details: RFPDetail[];
}

async function collectESBD(): Promise<SourceBatch> {
  console.log("\n[ESBD] Fetching solicitations...");
  const client = new ESBDClient();
  await client.initSession();

  const [open, addendum] = await Promise.all([
    client.fetchAllListings({ status: "1" }),
    client.fetchAllListings({ status: "6" }),
  ]);

  const combined = deduplicateByField([...open, ...addendum]);
  const relevant = combined.filter(isLikelyRelevant);
  console.log(
    `[ESBD] ${combined.length} scanned → ${relevant.length} pre-filtered (${((relevant.length / Math.max(combined.length, 1)) * 100).toFixed(1)}%)`,
  );

  const details = await client.fetchDetails(relevant);
  return { source: "esbd", scanned: combined.length, relevant: relevant.length, details };
}

async function collectNYC(): Promise<SourceBatch> {
  console.log("\n[NYC] Fetching OpenData catalog...");
  const client = new NYCClient();
  await client.initSession();

  const listings = await client.fetchAllListings();
  // NYC catalog is already filtered to "City Government"; no pre-filter needed.
  const details = await client.fetchDetails(listings);
  return { source: "nyc", scanned: listings.length, relevant: listings.length, details };
}

async function main(): Promise<void> {
  const startTime = Date.now();
  console.log("=== LightRFP — Multi-source RFP / Dataset Scraper ===");

  // 1. Fetch both sources in parallel
  const [esbdBatch, nycBatch] = await Promise.all([
    collectESBD(),
    collectNYC(),
  ]);

  // 2. Score ALL items together under one normalization baseline so scores are
  //    comparable across sources, then take top N per source, then sort merged.
  console.log(
    SKIP_AI
      ? "\nScoring with keyword matching (unified across sources)..."
      : "\nScoring with keyword + semantic matching (unified across sources)...",
  );
  const combined: RFPDetail[] = [...esbdBatch.details, ...nycBatch.details];
  const allScored = await scoreAll(combined, !SKIP_AI);

  // Diagnostics: show raw score distribution per source BEFORE selection
  const diagnostics = summarizeScores(allScored);
  console.log("\n--- Score diagnostics (post-normalization, all items) ---");
  for (const d of diagnostics) {
    console.log(
      `  ${d.source.padEnd(5)} n=${d.count.toString().padStart(4)}  ` +
        `min=${d.min.toFixed(1).padStart(5)}  ` +
        `median=${d.median.toFixed(1).padStart(5)}  ` +
        `mean=${d.mean.toFixed(1).padStart(5)}  ` +
        `max=${d.max.toFixed(1).padStart(5)}`,
    );
    for (const t of d.topTitles) {
      console.log(`    top: ${t.score.toFixed(1)}  ${t.title.slice(0, 80)}`);
    }
  }

  // 2a. Candidate pool: cheap keyword+semantic score narrows to N per source.
  //     With AI enabled, the LLM then re-ranks the full pool using a unified
  //     rubric (construction fit, actionability, urgency) — this is how we
  //     fairly compare RFPs (with due dates/value) against NYC datasets.
  const candidates = selectTopPerSource(
    allScored,
    SKIP_AI ? TOP_PER_SOURCE : CANDIDATE_PER_SOURCE,
  );
  console.log(
    `\nCandidate pool: ${candidates.length} items (${candidates.filter((c) => c.source === "esbd").length} ESBD + ${candidates.filter((c) => c.source === "nyc").length} NYC)`,
  );

  // 2b. AI re-ranks the pool (or keep keyword+semantic order with --noai).
  //     Then interleave per source so #1 is source A's best, #2 is source B's
  //     best, #3 is A's second, etc. Without interleave, live RFPs would
  //     always dominate the top of the merged list and bury every NYC item.
  let topResults;
  if (SKIP_AI) {
    topResults = interleaveBySource(candidates, TOP_PER_SOURCE);
  } else {
    console.log("\nRe-ranking candidate pool with AI...");
    const ranked = await rankByAI(candidates);
    topResults = interleaveBySource(ranked, TOP_PER_SOURCE);
  }

  const countBySource = topResults.reduce<Record<string, number>>((acc, r) => {
    acc[r.source] = (acc[r.source] ?? 0) + 1;
    return acc;
  }, {});
  const esbdTopN = countBySource.esbd ?? 0;
  const nycTopN = countBySource.nyc ?? 0;
  console.log(
    `\nFinal top ${esbdTopN} ESBD + ${nycTopN} NYC = ${topResults.length} total`,
  );

  // 3. Wipe data dir and download attachments (both sources, parallel)
  rmSync(DATA_DIR, { recursive: true, force: true });

  const esbd = new ESBDClient();
  const nyc = new NYCClient();
  await Promise.all([esbd.initSession(), nyc.initSession()]);

  const totalAttachments = topResults.reduce((n, r) => n + r.attachments.length, 0);
  console.log(
    `\nDownloading ${totalAttachments} attachments for ${topResults.length} top results...`,
  );
  await Promise.all([
    esbd.downloadAttachments(topResults, DATA_DIR),
    nyc.downloadAttachments(topResults, DATA_DIR),
  ]);

  // 4. Extract text from downloaded docs (handles PDF/DOCX/XLSX)
  console.log("\nExtracting text from documents...");
  await extractDocuments(topResults, DATA_DIR);

  // 5. AI summaries (optional)
  if (!SKIP_AI) {
    console.log("\nSummarizing with AI...");
    const summaries = await summarizeRfps(topResults, DATA_DIR);
    for (const rfp of topResults) {
      const result = summaries.get(rfp.solicitationId);
      if (result) {
        rfp.aiSummary = result.summary;
        rfp.aiShortSummary = result.shortSummary;
      }
    }
  } else {
    console.log("\nSkipping AI summarization (--noai)");
  }

  // 6. Metadata
  const categoryCounts: Record<string, number> = {};
  for (const rfp of topResults) {
    for (const cat of rfp.matchedCategories) {
      categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
    }
  }

  const sources: Record<SourceKey, SourceStats> = {
    esbd: {
      scanned: esbdBatch.scanned,
      relevant: esbdBatch.relevant,
      top: esbdTopN,
    },
    nyc: {
      scanned: nycBatch.scanned,
      relevant: nycBatch.relevant,
      top: nycTopN,
    },
  };

  const elapsedSeconds = (Date.now() - startTime) / 1000;

  const metadata: RunMetadata = {
    generatedAt: new Date(),
    totalScanned: esbdBatch.scanned + nycBatch.scanned,
    totalRelevant: esbdBatch.relevant + nycBatch.relevant,
    topCount: topResults.length,
    elapsedSeconds,
    categoryCounts,
    sources,
  };

  // 7. Render HTML
  console.log("\nGenerating HTML output...");
  const html = generateHTML(topResults, metadata);

  const outputPath = join(OUTPUT_DIR, "results.html");
  ensureDir(outputPath);
  writeFileSync(outputPath, html, "utf-8");

  // 8. Summary
  console.log(`\n=== Done in ${formatElapsed(elapsedSeconds)} ===`);
  console.log(`ESBD:  ${esbdBatch.scanned} scanned → ${esbdTopN} top`);
  console.log(`NYC:   ${nycBatch.scanned} scanned → ${nycTopN} top`);
  console.log(`Output: ${outputPath}`);

  if (topResults.length > 0) {
    const interleave = topResults
      .slice(0, 10)
      .map((r, i) => `  #${i + 1} [${r.source}] ${r.relevanceScore.toFixed(1)}  ${r.title.slice(0, 70)}`)
      .join("\n");
    console.log(`\nTop 10 merged:\n${interleave}`);
  }

  if (topResults.length > 0) {
    const topCats = Object.entries(categoryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cat, n]) => `${cat} (${n})`)
      .join(", ");
    if (topCats) console.log(`\nTop categories: ${topCats}`);
  }
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
