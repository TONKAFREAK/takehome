import type { RFPListing, RFPDetail, ScoredRFP } from "./types.js";
import { VENDOR_CATEGORIES } from "./categories.js";
import { stripHtml } from "./utils.js";
import { computeSemanticScores } from "./embeddings.js";

interface FieldWeight {
  text: string;
  weight: number;
}

/**
 *   title = 3.0
 *   nigpCodes = 2.5
 *   description = 2.0
 *   agency = 0.5
 */
/**
 * Score a single RFP against all vendor categories using keyword matching.
 * @param rfp - Full RFP detail record
 * @returns ScoredRFP with relevanceScore, matchedCategories, and matchDetails
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

/**
 * Quick pre-filter to check if a listing is potentially relevant based on title/NIGP/agency.
 * @param listing - Basic listing record (no full description)
 * @returns true if any vendor category keyword matches
 */
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
 * Select top results using keyword-only scoring (used with --noai).
 * @param rfps - Array of full RFP details
 * @param count - Number of top results to return (default 20)
 * @returns Sorted array of top scored RFPs
 */
export function selectTopResults(
  rfps: RFPDetail[],
  count: number = 20,
): ScoredRFP[] {
  const scored = rfps.map(scoreRFP).filter((r) => r.relevanceScore > 0);
  scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return scored.slice(0, count);
}

/**
 * Select top results using blended keyword (40%) + semantic embedding (60%) scoring.
 * @param rfps - Array of full RFP details
 * @param count - Number of top results to return (default 20)
 * @returns Sorted array of top scored RFPs with blended scores
 */
export async function selectTopResultsSemantic(
  rfps: RFPDetail[],
  count: number = 20,
): Promise<ScoredRFP[]> {
  // First pass: keyword scoring
  const scored = rfps.map(scoreRFP).filter((r) => r.relevanceScore > 0);

  const texts = scored.map(
    (rfp) =>
      `${rfp.title}. ${rfp.nigpCodes}. ${stripHtml(rfp.description).slice(0, 1000)}`,
  );

  // Get semantic scores
  const semanticScores = await computeSemanticScores(texts);

  // Normalize keyword scores to 0-1 range
  const maxKeyword = Math.max(...scored.map((r) => r.relevanceScore), 1);

  // Normalize semantic scores to 0-1 range
  const maxSemantic = Math.max(...semanticScores.map((s) => s.score), 1);

  // Blend: 40% keyword + 60% semantic
  for (let i = 0; i < scored.length; i++) {
    const rfp = scored[i]!;
    const semantic = semanticScores[i]!;

    const keywordNorm = rfp.relevanceScore / maxKeyword;
    const semanticNorm = semantic.score / maxSemantic;
    const blended = keywordNorm * 0.4 + semanticNorm * 0.6;

    // Merge semantic categories that keyword scoring missed
    for (const cat of semantic.topCategories) {
      if (!rfp.matchedCategories.includes(cat)) {
        rfp.matchedCategories.push(cat);
      }
    }

    rfp.relevanceScore = Math.round(blended * 100 * 10) / 10;
  }

  scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return scored.slice(0, count);
}
