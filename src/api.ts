import axios, { type AxiosInstance } from "axios";
import type {
  ESBDListResponse,
  ESBDListRequest,
  RFPDetail,
  RFPListing,
} from "./types.js";

const BASE_URL = "https://www.txsmartbuy.gov";
const SERVICES_PATH = "/app/extensions/CPA/CPAMain/1.0.0/services";

const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  Referer: `${BASE_URL}/esbd`,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 2000,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const wait = baseDelay * Math.pow(2, attempt);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `  Retry ${attempt + 1}/${maxRetries} in ${wait}ms... (${msg})`,
      );
      await delay(wait);
    }
  }
  throw new Error("unreachable");
}

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
  ): Promise<RFPListing[]> {
    const first = await this.fetchListings(1, filters);
    const totalPages = Math.ceil(
      first.totalRecordsFound / first.recordsPerPage,
    );

    console.log(
      `Found ${first.totalRecordsFound} solicitations (${totalPages} pages)`,
    );

    const allListings: RFPListing[] = [...first.lines];

    for (let page = 2; page <= totalPages; page++) {
      await delay(1200);
      const result = await this.fetchListings(page, filters);
      allListings.push(...result.lines);
      console.log(
        `  Page ${page}/${totalPages} — ${allListings.length} records`,
      );
    }

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
    delayMs: number = 1200,
  ): Promise<RFPDetail[]> {
    const details: RFPDetail[] = [];
    let failed = 0;

    for (let i = 0; i < listings.length; i++) {
      const listing = listings[i]!;
      try {
        if (i > 0) await delay(delayMs);
        const detail = await this.fetchDetail(listing.solicitationId);
        details.push(detail);
        console.log(
          `  Detail ${i + 1}/${listings.length}: ${listing.solicitationId} ✓`,
        );
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `  Detail ${i + 1}/${listings.length}: ${listing.solicitationId} ✗ (${msg})`,
        );
      }
    }

    if (failed > 0) {
      console.warn(`  ${failed} detail fetch(es) failed`);
    }

    return details;
  }
}
