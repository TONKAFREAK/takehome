import type { RFPListing, RFPDetail, ScoredRFP, SourceKey } from "./types.js";
import { VENDOR_CATEGORIES } from "./categories.js";
import { stripHtml } from "./utils.js";
import { computeSemanticScores } from "./embeddings.js";

interface FieldWeight {
  text: string;
  weight: number;
}

/**
 * Score a single RFP against all vendor categories using keyword matching.
 * Weights: title 3.0, NIGP/tags 2.5, description 2.0, agency 0.5.
 */
export function scoreRFP(rfp: RFPDetail): ScoredRFP {
  const fields: Record<string, FieldWeight> = {
    title: { text: rfp.title.toLowerCase(), weight: 3.0 },
    nigpCodes: { text: rfp.nigpCodes.toLowerCase(), weight: 2.5 },
    description: {
      text: stripHtml(rfp.description).toLowerCase(),
      weight: 2.0,
    },
    agency: { text: rfp.agencyName.toLowerCase(), weight: 0.5 },
  };

  let totalScore = 0;
  const matchedCategories: string[] = [];
  const matchParts: string[] = [];

  for (const [category, keywords] of Object.entries(VENDOR_CATEGORIES)) {
    let categoryScore = 0;
    const hits: string[] = [];

    for (const keyword of keywords) {
      for (const [fieldName, field] of Object.entries(fields)) {
        if (field.text.includes(keyword)) {
          categoryScore += field.weight;
          hits.push(`"${keyword}" in ${fieldName}`);
        }
      }
    }

    if (categoryScore > 0) {
      totalScore += categoryScore;
      matchedCategories.push(category);
      matchParts.push(`${category}: ${hits.join(", ")}`);
    }
  }

  return {
    ...rfp,
    relevanceScore: totalScore,
    matchedCategories,
    matchDetails: matchParts.join("; "),
  };
}

/** Quick pre-filter on listing-level fields. */
export function isLikelyRelevant(listing: RFPListing): boolean {
  const text = [listing.title, listing.nigpCodes, listing.agencyName]
    .join(" ")
    .toLowerCase();

  for (const keywords of Object.values(VENDOR_CATEGORIES)) {
    for (const keyword of keywords) {
      if (text.includes(keyword)) return true;
    }
  }

  return false;
}

/**
 * Score every RFP against every category with a single normalization baseline
 * so scores are comparable across sources. Returns all items, sorted by score descending.
 *
 * @param rfps - All RFP details, possibly mixed sources
 * @param useSemantic - When true, blends 40% keyword + 60% embedding similarity.
 */
export async function scoreAll(
  rfps: RFPDetail[],
  useSemantic: boolean,
): Promise<ScoredRFP[]> {
  if (rfps.length === 0) return [];

  const scored = rfps.map(scoreRFP);

  if (!useSemantic) {
    const maxKw = Math.max(1, ...scored.map((r) => r.relevanceScore));
    for (const r of scored) {
      r.relevanceScore = Math.round((r.relevanceScore / maxKw) * 100 * 10) / 10;
    }
    scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return scored;
  }

  const texts = scored.map(
    (rfp) =>
      `${rfp.title}. ${rfp.nigpCodes}. ${stripHtml(rfp.description).slice(0, 1000)}`,
  );
  const semanticScores = await computeSemanticScores(texts);

  const maxKw = Math.max(1, ...scored.map((r) => r.relevanceScore));
  const maxSem = Math.max(1, ...semanticScores.map((s) => s.score));

  for (let i = 0; i < scored.length; i++) {
    const rfp = scored[i]!;
    const sem = semanticScores[i]!;
    const kwNorm = rfp.relevanceScore / maxKw;
    const semNorm = sem.score / maxSem;
    const blended = kwNorm * 0.4 + semNorm * 0.6;

    for (const cat of sem.topCategories) {
      if (!rfp.matchedCategories.includes(cat)) {
        rfp.matchedCategories.push(cat);
      }
    }

    rfp.relevanceScore = Math.round(blended * 100 * 10) / 10;
  }

  scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return scored;
}

/**
 * Take top N from each source, then merge and sort by global score.
 * Ensures every source gets equal representation while preserving overall ranking.
 */
export function selectTopPerSource(
  scored: ScoredRFP[],
  perSource: number,
): ScoredRFP[] {
  const bySource = new Map<SourceKey, ScoredRFP[]>();
  for (const r of scored) {
    const arr = bySource.get(r.source) ?? [];
    arr.push(r);
    bySource.set(r.source, arr);
  }

  const picked: ScoredRFP[] = [];
  for (const arr of bySource.values()) {
    // scored[] is already globally sorted desc, so arr is too
    picked.push(...arr.slice(0, perSource));
  }

  picked.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return picked;
}

/**
 * Round-robin interleave items across sources, preserving per-source input order.
 * Input should already be sorted (e.g. by AI rank) — per-source order is kept
 * so position 0 of each bucket lands first, then position 1, etc.
 *
 * Used for final display order so each source gets a turn at the top instead of
 * one source (live RFPs) always dominating the merged sort.
 */
export function interleaveBySource(
  scored: ScoredRFP[],
  perSource: number,
): ScoredRFP[] {
  const bySource = new Map<SourceKey, ScoredRFP[]>();
  for (const r of scored) {
    const arr = bySource.get(r.source) ?? [];
    arr.push(r);
    bySource.set(r.source, arr);
  }

  const buckets: ScoredRFP[][] = [];
  for (const arr of bySource.values()) {
    buckets.push(arr.slice(0, perSource));
  }

  const out: ScoredRFP[] = [];
  let i = 0;
  while (buckets.some((b) => i < b.length)) {
    for (const b of buckets) {
      if (i < b.length) out.push(b[i]!);
    }
    i++;
  }
  return out;
}

/** Keyword-only top N (single-source legacy helper). */
export function selectTopResults(
  rfps: RFPDetail[],
  count: number = 20,
): ScoredRFP[] {
  const scored = rfps.map(scoreRFP).filter((r) => r.relevanceScore > 0);
  scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return scored.slice(0, count);
}

/** Semantic+keyword top N (single-source legacy helper). */
export async function selectTopResultsSemantic(
  rfps: RFPDetail[],
  count: number = 20,
): Promise<ScoredRFP[]> {
  const scored = await scoreAll(rfps, true);
  return scored.slice(0, count);
}

// ---------- diagnostics ----------

export interface SourceDiagnostic {
  source: SourceKey;
  count: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  topTitles: { title: string; score: number }[];
}

export function summarizeScores(scored: ScoredRFP[]): SourceDiagnostic[] {
  const bySource = new Map<SourceKey, ScoredRFP[]>();
  for (const r of scored) {
    const arr = bySource.get(r.source) ?? [];
    arr.push(r);
    bySource.set(r.source, arr);
  }

  const out: SourceDiagnostic[] = [];
  for (const [source, arr] of bySource.entries()) {
    const scores = arr.map((r) => r.relevanceScore).sort((a, b) => a - b);
    const n = scores.length;
    const mean = scores.reduce((a, b) => a + b, 0) / Math.max(n, 1);
    const median =
      n === 0
        ? 0
        : n % 2 === 1
          ? scores[(n - 1) / 2]!
          : (scores[n / 2 - 1]! + scores[n / 2]!) / 2;

    out.push({
      source,
      count: n,
      min: scores[0] ?? 0,
      max: scores[n - 1] ?? 0,
      mean: Math.round(mean * 10) / 10,
      median: Math.round(median * 10) / 10,
      topTitles: arr
        .slice()
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .slice(0, 3)
        .map((r) => ({ title: r.title, score: r.relevanceScore })),
    });
  }

  return out;
}
