import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { ESBDClient } from "./api.js";
import { isLikelyRelevant, selectTopResults } from "./relevance.js";
import { generateHTML } from "./html-generator.js";
import { ensureDir, formatElapsed, deduplicateByField } from "./utils.js";
import type { RunMetadata } from "./types.js";

const TOP_COUNT = 20;
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "..", "output");

async function main(): Promise<void> {
  const startTime = Date.now();
  console.log("=== LightRFP — Government RFP Scraper ===\n");

  // 1. Initialize session
  console.log("Initializing session...");
  const client = new ESBDClient();
  await client.initSession();

  // 2. Fetch open + addendum-posted solicitations in parallel
  console.log("\nFetching open & addendum-posted solicitations...");
  const [allListings, addendumListings] = await Promise.all([
    client.fetchAllListings({ status: "1" }),
    client.fetchAllListings({ status: "6" }),
  ]);

  const combined = deduplicateByField([...allListings, ...addendumListings]);
  console.log(`\nTotal unique open listings: ${combined.length}`);

  // 3. Pre-filter for relevance
  const relevant = combined.filter(isLikelyRelevant);
  console.log(
    `Pre-filtered to ${relevant.length} potentially relevant listings (${((relevant.length / combined.length) * 100).toFixed(1)}%)`
  );

  // 4. Fetch details for relevant listings
  console.log("\nFetching details for relevant solicitations...");
  const details = await client.fetchDetails(relevant);
  console.log(`\nFetched ${details.length} detail records`);

  // 5. Score and rank
  console.log("\nScoring and ranking...");
  const topResults = selectTopResults(details, TOP_COUNT);

  // 6. Build metadata
  const categoryCounts: Record<string, number> = {};
  for (const rfp of topResults) {
    for (const cat of rfp.matchedCategories) {
      categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1;
    }
  }

  const elapsedSeconds = (Date.now() - startTime) / 1000;

  const metadata: RunMetadata = {
    generatedAt: new Date(),
    totalScanned: combined.length,
    totalRelevant: relevant.length,
    topCount: topResults.length,
    elapsedSeconds,
    categoryCounts,
  };

  // 7. Generate HTML
  console.log("\nGenerating HTML output...");
  const html = generateHTML(topResults, metadata);

  const outputPath = join(OUTPUT_DIR, "results.html");
  ensureDir(outputPath);
  writeFileSync(outputPath, html, "utf-8");

  // 8. Summary
  console.log(`\n=== Done in ${formatElapsed(elapsedSeconds)} ===`);
  console.log(`Scanned:  ${combined.length} open solicitations`);
  console.log(`Relevant: ${relevant.length} passed pre-filter`);
  console.log(`Details:  ${details.length} fetched`);
  console.log(`Top ${topResults.length} written to: ${outputPath}`);

  if (topResults.length > 0) {
    console.log(`\nTop categories: ${Object.entries(categoryCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cat, n]) => `${cat} (${n})`)
      .join(", ")}`);
    console.log(`\nHighest score: ${topResults[0]!.relevanceScore.toFixed(1)} — ${topResults[0]!.title}`);
  }
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
