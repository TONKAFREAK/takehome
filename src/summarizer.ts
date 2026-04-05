import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";
import type { RFPDetail } from "./types.js";
import { ensureDir, runConcurrent, stripHtml } from "./utils.js";

function createModel(): ChatOpenAI {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) throw new Error("AI_API_KEY is not set in .env");

  const model = process.env.AI_MODEL;
  if (!model) throw new Error("AI_MODEL is not set in .env");

  return new ChatOpenAI({
    model,
    apiKey,
    configuration: {
      baseURL: process.env.AI_API_BASE_URL,
    },
    maxTokens: 1024,
    temperature: 0.2,
  });
}

function buildPrompt(rfp: RFPDetail, extractedTexts: string[]): string {
  const description = stripHtml(rfp.description);
  const pdfContent =
    extractedTexts.length > 0
      ? extractedTexts
          .map((t, i) => `--- Attachment ${i + 1} ---\n${t}`)
          .join("\n\n")
      : "(No PDF attachments)";

  return `You are a government contract analyst. Summarize this solicitation for a building maintenance and construction vendor deciding whether to bid.

SOLICITATION DETAILS:
- ID: ${rfp.solicitationId}
- Title: ${rfp.title}
- Agency: ${rfp.agencyName}
- Posted: ${rfp.postingDate}
- Due: ${rfp.responseDue} ${rfp.responseTime}
- Value: ${rfp.value || "Not specified"}
- NIGP Codes: ${rfp.nigpCodes}
- Description: ${description}
- Contact: ${rfp.contactName} | ${rfp.contactEmail} | ${rfp.contactNumber}

ATTACHED DOCUMENT TEXT:
${pdfContent}

Provide a concise summary with these sections:
1. **Overview**: What is being solicited in 2-3 sentences.
2. **Scope of Work**: Key deliverables and requirements.
3. **Bid Requirements**: Qualifications, certifications, bonds, or insurance needed.
4. **Timeline**: Important dates (submission deadline, project start, completion).
5. **Estimated Value**: Contract value if stated, or infer from scope if possible.
6. **Recommendation**: Should a mid-size building maintenance/construction vendor pursue this? Why or why not?`;
}

function loadExtractedTexts(rfpDir: string): string[] {
  const extractedDir = join(rfpDir, "extracted");
  let files: string[];
  try {
    files = readdirSync(extractedDir).filter((f) => f.endsWith(".txt"));
  } catch {
    return [];
  }
  return files.map((f) => readFileSync(join(extractedDir, f), "utf-8"));
}

export async function summarizeRfps(
  rfps: RFPDetail[],
  dataDir: string,
  concurrency: number = 5,
): Promise<Map<string, string>> {
  const model = createModel();
  const summaries = new Map<string, string>();

  const tasks = rfps.map((rfp) => async () => {
    const rfpDir = join(dataDir, rfp.solicitationId);
    const summaryPath = join(rfpDir, "summary.md");
    const extractedTexts = loadExtractedTexts(rfpDir);

    const prompt = buildPrompt(rfp, extractedTexts);
    const response = await model.invoke([new HumanMessage(prompt)]);
    const summary =
      typeof response.content === "string"
        ? response.content
        : response.content.map((c) => ("text" in c ? c.text : "")).join("");

    ensureDir(summaryPath);
    writeFileSync(summaryPath, summary, "utf-8");
    return { id: rfp.solicitationId, summary };
  });

  const results = await runConcurrent(tasks, concurrency);
  let failed = 0;

  for (const r of results) {
    if (r.status === "fulfilled") {
      summaries.set(r.value.id, r.value.summary);
    } else {
      failed++;
      const msg =
        r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.warn(`  Summary failed: ${msg}`);
    }
  }

  console.log(
    `  Summarized ${summaries.size}/${rfps.length} RFPs${failed > 0 ? ` (${failed} failed)` : ""}`,
  );
  return summaries;
}
