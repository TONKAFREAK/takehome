import type { RFPListing, RFPDetail, ScoredRFP } from "./types.js";
import { VENDOR_CATEGORIES } from "./categories.js";
import { stripHtml } from "./utils.js";

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

export function selectTopResults(
  rfps: RFPDetail[],
  count: number = 20,
): ScoredRFP[] {
  const scored = rfps.map(scoreRFP).filter((r) => r.relevanceScore > 0);

  scored.sort((a, b) => b.relevanceScore - a.relevanceScore);

  return scored.slice(0, count);
}
