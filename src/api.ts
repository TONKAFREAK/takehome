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
  NYCListResponse,
  NYCPageViews,
  NYCListResponseitem,
} from "./types.js";
import { withRetry, runConcurrent, ensureDir } from "./utils.js";

const BASE_URL = "https://www.txsmartbuy.gov";
const NYC_BASE_URL = "https://data.cityofnewyork.us/api/catalog/v1?explicitly_hidden=false&limit=200&offset=0&order=createdAt&published=true&q=&search_context=data.cityofnewyork.us&show_unsupported_data_federated_assets=false&tags=&approval_status=approved&audience=public&categories=City%20Government";
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

  /**
   * Initialize a session by visiting the ESBD page and capturing cookies.
   */
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

  /**
   * Fetch a single page of solicitation listings.
   * @param page - Page number (default 1)
   * @param filters - Optional filters (status, keyword, agency, etc.)
   * @returns Paginated listing response
   */
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

  /**
   * Fetch all listing pages concurrently.
   * @param filters - Optional filters (status, keyword, agency, etc.)
   * @param concurrency - Max concurrent page requests (default 6)
   * @returns All listings across all pages
   */
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

  /**
   * Fetch full details for a single solicitation.
   * @param solicitationId - The solicitation ID to look up
   * @returns Full solicitation detail record
   */
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

  /**
   * Fetch details for multiple listings concurrently.
   * @param listings - Array of listings to fetch details for
   * @param concurrency - Max concurrent detail requests (default 10)
   * @returns Array of successfully fetched detail records
   */
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
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason ?? "unknown error");
        console.warn(
          `  Detail ${listings[i]!.solicitationId} ✗ (${msg})`,
        );
      }
    }

    console.log(`  Fetched ${details.length}/${listings.length} details${failed > 0 ? ` (${failed} failed)` : ""}`);
    return details;
  }

  /**
   * Download all attachments for the given RFPs to data/{solicitationId}/.
   * @param rfps - Array of RFP details with attachments
   * @param dataDir - Root data directory path
   * @param concurrency - Max concurrent downloads (default 10)
   * @returns Number of successfully downloaded files
   */
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
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason ?? "unknown error");
        console.warn(`  Download failed: ${msg}`);
      }
    }

    console.log(`  Downloaded ${downloaded}/${tasks.length} attachments${failed > 0 ? ` (${failed} failed)` : ""}`);
    return downloaded;
  }

  /**
   * Download a single file and write it to disk.
   * @param fileURL - Relative URL on the ESBD server
   * @param filePath - Local path to save the file
   * @returns The local file path on success
   */
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

export class NYCCLIENT {
  private client: AxiosInstance;
  private cookies: string = "";

  constructor() {
    this.client = axios.create({
      baseURL: NYC_BASE_URL,
      timeout: 30_000,
    });
  }

  /**
   * Initialize a session by visiting the ESBD page and capturing cookies.
   */
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

  /**
   * Fetch a single page of solicitation listings.
   * @param page - Page number (default 1)
   * @param filters - Optional filters (status, keyword, agency, etc.)
   * @returns Paginated listing response
   */
  async fetchListings(
  ): Promise<NYCListResponse> {

    const res = await withRetry(() =>
      this.client.post<NYCListResponse>(
        `${NYC_BASE_URL}`,
        {
          headers: this.cookies ? { Cookie: this.cookies } : {},
        },
      ),
    );

    return res.data;
  }

  /**
   * Fetch all listing pages concurrently.
   * @param filters - Optional filters (status, keyword, agency, etc.)
   * @param concurrency - Max concurrent page requests (default 6)
   * @returns All listings across all pages
   */
  async fetchAllListings(
  ): Promise<NYCListResponse> {
    const first = await this.fetchListings();

    return first;
  } 
  
  /**
   * Download all attachments for the given RFPs to data/{solicitationId}/.
   * @param rfps - Array of RFP details with attachments
   * @param dataDir - Root data directory path
   * @param concurrency - Max concurrent downloads (default 10)
   * @returns Number of successfully downloaded files
   */
  async downloadAttachments(
    rfps: NYCListResponseitem[],
    dataDir: string,
    concurrency: number = 10,
  ): Promise<number> {
    const tasks: (() => Promise<string>)[] = [];

    for (const rfp of rfps) {
      for (const att of rfp.attachments.files.id) {
        const dir = join(dataDir, rfp.id);
        const filePath = join(dir, rfp.id);
        tasks.push(() => this.downloadFile(`https://data.cityofnewyork.us/api/views/${rfp.id}/files/${rfp.attachments.files.id}?download=true&filename=${rfp.attachments.files.id}`, filePath));
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
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason ?? "unknown error");
        console.warn(`  Download failed: ${msg}`);
      }
    }

    console.log(`  Downloaded ${downloaded}/${tasks.length} attachments${failed > 0 ? ` (${failed} failed)` : ""}`);
    return downloaded;
  }

  /**
   * Download a single file and write it to disk.
   * @param fileURL - Relative URL on the ESBD server
   * @param filePath - Local path to save the file
   * @returns The local file path on success
   */
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


/**
 * Extract text from downloaded PDFs and DOCX files into data/{id}/extracted/.
 * @param rfps - Array of RFP details whose attachments have been downloaded
 * @param dataDir - Root data directory path
 * @param concurrency - Max concurrent extractions (default 10)
 * @returns Number of successfully extracted documents
 */
export async function extractDocuments(
  rfps: NYCListResponseitem[],
  dataDir: string,
  concurrency: number = 10,
): Promise<number> {
  const tasks: (() => Promise<string>)[] = [];

  for (const rfp of rfps) {
    const rfpDir = join(dataDir, rfp.id);
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

      if (lower.endsWith(".xlsx")) {
        const txtPath = join(extractedDir, file.replace(/\.xlsx$/i, ".txt"));
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
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason ?? "unknown error");
      console.warn(`  Extract failed: ${msg}`);
    }
  }

  console.log(`  Extracted ${extracted}/${tasks.length} documents${failed > 0 ? ` (${failed} failed)` : ""}`);
  return extracted;
}
