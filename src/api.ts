import axios, { type AxiosInstance } from "axios";
import { writeFileSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
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

/** Client for the Texas ESBD (Electronic State Business Daily) API. */
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

  /** Initialize a session by visiting the ESBD page and capturing cookies. */
  async initSession(): Promise<void> {
    const res = await this.client.get("/esbd", {
      maxRedirects: 5,
      validateStatus: () => true,
    });

    const setCookies: string[] = res.headers["set-cookie"] ?? [];
    this.cookies = setCookies.map((c: string) => c.split(";")[0]!).join("; ");

    if (this.cookies) {
      console.log(`ESBD session initialized (${setCookies.length} cookies)`);
    } else {
      console.log("ESBD session initialized (no cookies — proceeding anyway)");
    }
  }

  /** Fetch a single page of solicitation listings. */
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
        { headers: this.cookies ? { Cookie: this.cookies } : {} },
      ),
    );

    return res.data;
  }

  /** Fetch all listing pages concurrently. */
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

    const tagSource = (l: RFPListing): RFPListing => ({ ...l, source: "esbd" });

    if (totalPages <= 1) return first.lines.map(tagSource);

    const tasks = Array.from({ length: totalPages - 1 }, (_, i) => {
      const page = i + 2;
      return () => this.fetchListings(page, filters);
    });

    const results = await runConcurrent(tasks, concurrency);
    const allListings: RFPListing[] = first.lines.map(tagSource);

    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === "fulfilled") {
        allListings.push(...r.value.lines.map(tagSource));
      } else {
        console.warn(`  Page ${i + 2} failed: ${r.reason}`);
      }
    }

    console.log(
      `  Fetched ${allListings.length} listings across ${totalPages} pages`,
    );
    return allListings;
  }

  /** Fetch full details for a single solicitation. */
  async fetchDetail(solicitationId: string): Promise<RFPDetail> {
    const res = await withRetry(() =>
      this.client.get<RFPDetail>(`${SERVICES_PATH}/ESBD.Details.Service.ss`, {
        params: { urlRoot: "esbd", identification: solicitationId },
        headers: this.cookies ? { Cookie: this.cookies } : {},
      }),
    );
    return res.data;
  }

  /** Fetch details for multiple listings concurrently. */
  async fetchDetails(
    listings: RFPListing[],
    concurrency: number = 10,
  ): Promise<RFPDetail[]> {
    const tasks = listings.map(
      (listing) => () => this.fetchDetail(listing.solicitationId),
    );

    const results = await runConcurrent(tasks, concurrency);
    const details: RFPDetail[] = [];
    let failed = 0;

    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      if (r.status === "fulfilled") {
        details.push({ ...r.value, source: "esbd" });
      } else {
        failed++;
        const msg =
          r.reason instanceof Error
            ? r.reason.message
            : String(r.reason ?? "unknown error");
        console.warn(`  Detail ${listings[i]!.solicitationId} ✗ (${msg})`);
      }
    }

    console.log(
      `  Fetched ${details.length}/${listings.length} details${failed > 0 ? ` (${failed} failed)` : ""}`,
    );
    return details;
  }

  /** Download all ESBD attachments for the given RFPs to dataDir/{id}/. */
  async downloadAttachments(
    rfps: RFPDetail[],
    dataDir: string,
    concurrency: number = 10,
  ): Promise<number> {
    const tasks: (() => Promise<string>)[] = [];

    for (const rfp of rfps) {
      if (rfp.source !== "esbd") continue;
      for (const att of rfp.attachments) {
        const dir = join(dataDir, rfp.solicitationId);
        const filePath = join(dir, att.fileName);
        tasks.push(() => this.downloadFile(att.fileURL, filePath));
      }
    }

    if (tasks.length === 0) return 0;

    const results = await runConcurrent(tasks, concurrency);
    let downloaded = 0;
    let failed = 0;

    for (const r of results) {
      if (r.status === "fulfilled") downloaded++;
      else {
        failed++;
        const msg =
          r.reason instanceof Error
            ? r.reason.message
            : String(r.reason ?? "unknown error");
        console.warn(`  ESBD download failed: ${msg}`);
      }
    }

    console.log(
      `  Downloaded ${downloaded}/${tasks.length} ESBD attachments${failed > 0 ? ` (${failed} failed)` : ""}`,
    );
    return downloaded;
  }

  private async downloadFile(
    fileURL: string,
    filePath: string,
  ): Promise<string> {
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

/**
 * Convert an xlsx workbook buffer to plain-text CSV dump for all sheets.
 */
function xlsxToText(buf: Buffer): string {
  const wb = XLSX.read(buf, { type: "buffer" });
  const parts: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;
    parts.push(`--- Sheet: ${sheetName} ---`);
    parts.push(XLSX.utils.sheet_to_csv(sheet));
  }
  return parts.join("\n");
}

/**
 * Extract text from downloaded PDF/DOCX/XLSX files into dataDir/{id}/extracted/.
 * @param rfps - RFP details whose attachments have been downloaded
 * @param dataDir - Root data directory path
 * @param concurrency - Max concurrent extractions (default 10)
 */
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
      } else if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
        const txtPath = join(
          extractedDir,
          file.replace(/\.xlsx?$/i, ".txt"),
        );
        tasks.push(async () => {
          const buf = readFileSync(filePath);
          const text = xlsxToText(buf);
          ensureDir(txtPath);
          writeFileSync(txtPath, text, "utf-8");
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
    if (r.status === "fulfilled") extracted++;
    else {
      failed++;
      const msg =
        r.reason instanceof Error
          ? r.reason.message
          : String(r.reason ?? "unknown error");
      console.warn(`  Extract failed: ${msg}`);
    }
  }

  console.log(
    `  Extracted ${extracted}/${tasks.length} documents${failed > 0 ? ` (${failed} failed)` : ""}`,
  );
  return extracted;
}
