import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { OpenAIEmbeddings } from "@langchain/openai";
import { VENDOR_CATEGORIES } from "./categories.js";
import { ensureDir } from "./utils.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, "..", "data", "category_embeddings.json");

interface CachedEmbeddings {
  model: string;
  categories: Record<string, number[]>;
}

function createEmbeddings(): OpenAIEmbeddings {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) throw new Error("AI_API_KEY is not set in .env");

  const model = process.env.AI_EMBED_MODEL;
  if (!model) throw new Error("AI_EMBED_MODEL is not set in .env");

  return new OpenAIEmbeddings({
    model,
    apiKey,
    configuration: {
      baseURL: process.env.AI_API_BASE_URL,
    },
  });
}

function buildCategoryText(name: string, keywords: string[]): string {
  return `${name}: ${keywords.join(", ")}`;
}

async function getCategoryEmbeddings(
  embedder: OpenAIEmbeddings,
): Promise<Record<string, number[]>> {
  const model = process.env.AI_EMBED_MODEL!;

  if (existsSync(CACHE_PATH)) {
    const cached: CachedEmbeddings = JSON.parse(
      readFileSync(CACHE_PATH, "utf-8"),
    );
    if (
      cached.model === model &&
      Object.keys(cached.categories).length ===
        Object.keys(VENDOR_CATEGORIES).length
    ) {
      console.log("  Using cached category embeddings");
      return cached.categories;
    }
  }

  console.log("  Computing category embeddings...");
  const entries = Object.entries(VENDOR_CATEGORIES);
  const texts = entries.map(([name, kws]) => buildCategoryText(name, kws));
  const vectors = await embedder.embedDocuments(texts);

  const categories: Record<string, number[]> = {};
  for (let i = 0; i < entries.length; i++) {
    categories[entries[i]![0]] = vectors[i]!;
  }

  ensureDir(CACHE_PATH);
  writeFileSync(CACHE_PATH, JSON.stringify({ model, categories }), "utf-8");
  console.log("  Cached category embeddings to disk");

  return categories;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface SemanticScore {
  score: number;
  topCategories: string[];
}

/**
 * Compute semantic similarity scores for RFP texts against all vendor categories.
 * Uses cached category embeddings when available.
 * @param texts - Array of RFP text strings to score
 * @returns Array of SemanticScore with score and top matching categories per RFP
 */
export async function computeSemanticScores(
  texts: string[],
): Promise<SemanticScore[]> {
  const embedder = createEmbeddings();
  const categoryEmbeddings = await getCategoryEmbeddings(embedder);
  const categoryNames = Object.keys(categoryEmbeddings);
  const categoryVectors = Object.values(categoryEmbeddings);

  console.log(`  Embedding ${texts.length} RFPs...`);
  const rfpVectors = await embedder.embedDocuments(texts);

  const results: SemanticScore[] = [];
  for (const rfpVec of rfpVectors) {
    const similarities: { name: string; sim: number }[] = [];
    for (let j = 0; j < categoryVectors.length; j++) {
      similarities.push({
        name: categoryNames[j]!,
        sim: cosineSimilarity(rfpVec!, categoryVectors[j]!),
      });
    }

    similarities.sort((a, b) => b.sim - a.sim);
    const topMatches = similarities.filter((s) => s.sim > 0.3);
    const topCats = topMatches.slice(0, 5).map((s) => s.name);

    const score = topMatches.reduce((sum, s) => sum + s.sim, 0) * 10;

    results.push({ score, topCategories: topCats });
  }

  return results;
}
