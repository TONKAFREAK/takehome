import axios, { type AxiosInstance } from "axios";
import type {
  ESBDListResponse,
  ESBDListRequest,
  RFPDetail,
  RFPListing,
} from "./types.js";
import { withRetry, runConcurrent } from "./utils.js";

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
}
