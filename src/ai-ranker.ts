import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import type { ScoredRFP } from "./types.js";
import { stripHtml, truncate } from "./utils.js";

interface AIRankEntry {
  id: string;
  score: number;
  reason: string;
}

function createModel(): ChatOpenAI {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) throw new Error("AI_API_KEY is not set in .env");
  const model = process.env.AI_MODEL;
  if (!model) throw new Error("AI_MODEL is not set in .env");

  return new ChatOpenAI({
    model,
    apiKey,
    configuration: { baseURL: process.env.AI_API_BASE_URL },
    maxTokens: 8192,
    temperature: 0.1,
  });
}

function buildPrompt(candidates: ScoredRFP[]): string {
  const items = candidates.map((c) => ({
    id: c.solicitationId,
    source: c.source,
    title: c.title,
    agency: c.agencyName,
    due: c.responseDue || null,
    value: c.value || null,
    description: truncate(stripHtml(c.description), 300),
  }));

  return `You are ranking opportunities for a mid-size building maintenance and construction vendor. The list mixes two kinds of records:

- "esbd" — live Texas government solicitations (RFPs). These have a due date and sometimes an estimated value. Direct bid opportunities.
- "nyc"  — NYC OpenData datasets. NOT bid opportunities, but some contain information useful for a construction vendor (building permits, DOB filings, inspections, violations, cooling towers, planimetric layers). Most are unrelated (parking tickets, voter turnout, etc.).

Score each item 0–100 on overall value to this vendor. Consider:
- Direct construction/maintenance fit (strongest signal)
- For ESBD: how clear the scope is, whether a value is stated, and how soon it's due (past due = big penalty, <7 days = urgent, far future = still fine). Past-due items should rank very low.
- For NYC: whether the data meaningfully helps a construction vendor (business intelligence, lead generation, market context). Unrelated datasets should score low (0–20).
- Specificity and actionability beat vague language.

Return ONLY a JSON array, ranked best→worst, including EVERY id exactly once:
[{"id":"abc","score":92,"reason":"short justification"},...]

No prose before or after the JSON.

ITEMS:
${JSON.stringify(items, null, 2)}`;
}

function extractJsonArray(raw: string): AIRankEntry[] {
  // Strip markdown code fences if present, then grab the first [...] block.
  const cleaned = raw.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("no JSON array found in AI response");
  }
  const parsed = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("response is not an array");
  return parsed.map((e) => ({
    id: String(e.id),
    score: typeof e.score === "number" ? e.score : 0,
    reason: typeof e.reason === "string" ? e.reason : "",
  }));
}

/**
 * Re-rank candidates via a single LLM call. Returns candidates in AI-determined
 * order with relevanceScore replaced by the AI score. On failure, falls back to
 * the input order unchanged.
 */
export async function rankByAI(candidates: ScoredRFP[]): Promise<ScoredRFP[]> {
  if (candidates.length <= 1) return candidates;

  console.log(`  Asking LLM to rank ${candidates.length} candidates...`);

  let entries: AIRankEntry[];
  try {
    const model = createModel();
    const response = await model.invoke([
      new HumanMessage(buildPrompt(candidates)),
    ]);
    const raw =
      typeof response.content === "string"
        ? response.content
        : response.content.map((c) => ("text" in c ? c.text : "")).join("");
    entries = extractJsonArray(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  AI rank failed (${msg}); keeping keyword+semantic order`);
    return candidates;
  }

  const byId = new Map(candidates.map((c) => [c.solicitationId, c]));
  const ordered: ScoredRFP[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const c = byId.get(entry.id);
    if (!c || seen.has(entry.id)) continue;
    seen.add(entry.id);
    ordered.push({
      ...c,
      relevanceScore: Math.round(entry.score * 10) / 10,
      matchDetails: entry.reason
        ? `${c.matchDetails}${c.matchDetails ? "; " : ""}AI: ${entry.reason}`
        : c.matchDetails,
    });
  }

  // Any candidate the LLM forgot: append at the tail with their previous score.
  for (const c of candidates) {
    if (!seen.has(c.solicitationId)) ordered.push(c);
  }

  console.log(`  AI ranked ${ordered.length} items`);
  return ordered;
}
