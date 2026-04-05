import axios, { type AxiosInstance } from "axios";
import { writeFileSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import type {
  ESBDListResponse,
  ESBDListRequest,
  RFPDetail,
  RFPListing,
} from "./types.js";
import { withRetry, runConcurrent, ensureDir } from "./utils.js";

const BASE_URL = "https://www.txsmartbuy.gov";
const SERVICES_PATH = "/app/extensions/CPA/CPAMain/1.0.0/services";

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Referer: `${BASE_URL}/esbd`,
};

export class ESBDClient {
  private client: AxiosInstance;
  private cookies: string = "";

  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      timeout: 30_000,
      headers: DEFAULT_HEADERS,
    });
  }

  async initSession(): Promise<void> {
    const res = await this.client.get("/esbd", {
      maxRedirects: 5,
      validateStatus: () => true,
    });

    const setCookies: string[] = res.headers["set-cookie"] ?? [];
    this.cookies = setCookies.map((c: string) => c.split(";")[0]!).join("; ");

    if (this.cookies) {
      console.log(`Session initialized (${setCookies.length} cookies)`);
    } else {
      console.log(
        "Session initialized (no cookies returned — proceeding anyway)",
      );
    }
  }

  async fetchListings(
    page: number = 1,
    filters: Partial<ESBDListRequest> = {},
  ): Promise<ESBDListResponse> {
    const body: ESBDListRequest = {
      page,
      urlRoot: "esbd",
      status: "1",
      ...filters,
    };

    const res = await withRetry(() =>
      this.client.post<ESBDListResponse>(
        `${SERVICES_PATH}/ESBD.Service.ss`,
        body,
        {
          headers: this.cookies ? { Cookie: this.cookies } : {},
        },
      ),
    );

    return res.data;
  }

  async fetchAllListings(
    filters: Partial<ESBDListRequest> = {},
    concurrency: number = 6,
  ): Promise<RFPListing[]> {
    const first = await this.fetchListings(1, filters);
    const totalPages = Math.ceil(
      first.totalRecordsFound / first.recordsPerPage,
    );

    console.log(
      `Found ${first.totalRecordsFound} solicitations (${totalPages} pages)`,
    );

    if (totalPages <= 1) return first.lines;

    const tasks = Array.from({ length: totalPages - 1 }, (_, i) => {
      const page = i + 2;
      return () => this.fetchListings(page, filters);
    });

    const results = await runConcurrent(tasks, concurrency);
    const allListings: RFPListing[] = [...first.lines];

    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === "fulfilled") {
        allListings.push(...r.value.lines);
      } else {
        console.warn(`  Page ${i + 2} failed: ${r.reason}`);
      }
    }

    console.log(`  Fetched ${allListings.length} listings across ${totalPages} pages`);
    return allListings;
  }

  async fetchDetail(solicitationId: string): Promise<RFPDetail> {
    const res = await withRetry(() =>
      this.client.get<RFPDetail>(`${SERVICES_PATH}/ESBD.Details.Service.ss`, {
        params: {
          urlRoot: "esbd",
          identification: solicitationId,
        },
        headers: this.cookies ? { Cookie: this.cookies } : {},
      }),
    );

    return res.data;
  }

  async fetchDetails(
    listings: RFPListing[],
    concurrency: number = 10,
  ): Promise<RFPDetail[]> {
    const tasks = listings.map((listing) => {
      return () => this.fetchDetail(listing.solicitationId);
    });

    const results = await runConcurrent(tasks, concurrency);
    const details: RFPDetail[] = [];
    let failed = 0;

    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === "fulfilled") {
        details.push(r.value);
      } else {
        failed++;
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.warn(
          `  Detail ${listings[i]!.solicitationId} ✗ (${msg})`,
        );
      }
    }

    console.log(`  Fetched ${details.length}/${listings.length} details${failed > 0 ? ` (${failed} failed)` : ""}`);
    return details;
  }

  async downloadAttachments(
    rfps: RFPDetail[],
    dataDir: string,
    concurrency: number = 10,
  ): Promise<number> {
    const tasks: (() => Promise<string>)[] = [];

    for (const rfp of rfps) {
      for (const att of rfp.attachments) {
        const dir = join(dataDir, rfp.solicitationId);
        const filePath = join(dir, att.fileName);
        tasks.push(() => this.downloadFile(att.fileURL, filePath));
      }
    }

    if (tasks.length === 0) {
      console.log("  No attachments to download");
      return 0;
    }

    const results = await runConcurrent(tasks, concurrency);
    let downloaded = 0;
    let failed = 0;

    for (const r of results) {
      if (r.status === "fulfilled") {
        downloaded++;
      } else {
        failed++;
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        console.warn(`  Download failed: ${msg}`);
      }
    }

    console.log(`  Downloaded ${downloaded}/${tasks.length} attachments${failed > 0 ? ` (${failed} failed)` : ""}`);
    return downloaded;
  }

  private async downloadFile(fileURL: string, filePath: string): Promise<string> {
    const res = await withRetry(() =>
      this.client.get(fileURL, {
        responseType: "arraybuffer",
        headers: this.cookies ? { Cookie: this.cookies } : {},
      }),
    );

    ensureDir(filePath);
    writeFileSync(filePath, Buffer.from(res.data));
    return filePath;
  }
}

export async function extractDocuments(
  rfps: RFPDetail[],
  dataDir: string,
  concurrency: number = 10,
): Promise<number> {
  const tasks: (() => Promise<string>)[] = [];

  for (const rfp of rfps) {
    const rfpDir = join(dataDir, rfp.solicitationId);
    let files: string[];
    try {
      files = readdirSync(rfpDir);
    } catch {
      continue;
    }

    const extractedDir = join(rfpDir, "extracted");

    for (const file of files) {
      const lower = file.toLowerCase();
      const filePath = join(rfpDir, file);

      if (lower.endsWith(".pdf")) {
        const txtPath = join(extractedDir, file.replace(/\.pdf$/i, ".txt"));
        tasks.push(async () => {
          const buf = readFileSync(filePath);
          const parser = new PDFParse({ data: new Uint8Array(buf) });
          const result = await parser.getText();
          await parser.destroy();
          ensureDir(txtPath);
          writeFileSync(txtPath, result.text, "utf-8");
          return txtPath;
        });
      } else if (lower.endsWith(".docx")) {
        const txtPath = join(extractedDir, file.replace(/\.docx$/i, ".txt"));
        tasks.push(async () => {
          const buf = readFileSync(filePath);
          const result = await mammoth.extractRawText({ buffer: buf });
          ensureDir(txtPath);
          writeFileSync(txtPath, result.value, "utf-8");
          return txtPath;
        });
      }
    }
  }

  if (tasks.length === 0) {
    console.log("  No documents to extract");
    return 0;
  }

  const results = await runConcurrent(tasks, concurrency);
  let extracted = 0;
  let failed = 0;

  for (const r of results) {
    if (r.status === "fulfilled") {
      extracted++;
    } else {
      failed++;
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.warn(`  Extract failed: ${msg}`);
    }
  }

  console.log(`  Extracted ${extracted}/${tasks.length} documents${failed > 0 ? ` (${failed} failed)` : ""}`);
  return extracted;
}
