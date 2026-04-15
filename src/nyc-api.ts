import axios, { type AxiosInstance } from "axios";
import { writeFileSync } from "fs";
import { join } from "path";
import type {
  NYCCatalogResponse,
  NYCCatalogItem,
  NYCViewDetail,
  RFPDetail,
  RFPListing,
  Attachment,
} from "./types.js";
import { withRetry, runConcurrent, ensureDir, stripHtml } from "./utils.js";

const BASE_URL = "https://data.cityofnewyork.us";
const CATALOG_PATH = "/api/catalog/v1";
const VIEW_PATH = "/api/views";
const PAGE_SIZE = 20;

const DEFAULT_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Referer: `${BASE_URL}/`,
};

/** Client for the NYC OpenData (Socrata) catalog. */
export class NYCClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      timeout: 30_000,
      headers: DEFAULT_HEADERS,
    });
  }

  /** Initialize does nothing — the NYC API needs no session/auth. */
  async initSession(): Promise<void> {
    console.log("NYC session ready (no auth needed)");
  }

  /**
   * Fetch a single page of catalog results.
   * @param offset - Record offset
   * @param limit - Page size (default 20)
   */
  async fetchCatalogPage(
    offset: number,
    limit: number = PAGE_SIZE,
  ): Promise<NYCCatalogResponse> {
    const res = await withRetry(() =>
      this.client.get<NYCCatalogResponse>(CATALOG_PATH, {
        params: {
          explicitly_hidden: false,
          limit,
          offset,
          order: "createdAt",
          published: true,
          search_context: "data.cityofnewyork.us",
          show_unsupported_data_federated_assets: false,
          approval_status: "approved",
          audience: "public",
          categories: "City Government",
        },
      }),
    );
    return res.data;
  }

  /**
   * Fetch all catalog results as RFPListings, across all pages concurrently.
   * @param concurrency - Max concurrent page requests (default 6)
   * @param maxRecords - Optional cap on total records fetched
   */
  async fetchAllListings(
    concurrency: number = 6,
    maxRecords?: number,
  ): Promise<RFPListing[]> {
    const first = await this.fetchCatalogPage(0);
    const total = Math.min(
      first.resultSetSize ?? first.results.length,
      maxRecords ?? Infinity,
    );
    const totalPages = Math.ceil(total / PAGE_SIZE);

    console.log(`Found ${total} NYC datasets (${totalPages} pages)`);

    const all: NYCCatalogItem[] = [...first.results];
    if (totalPages > 1) {
      const tasks = Array.from({ length: totalPages - 1 }, (_, i) => {
        const offset = (i + 1) * PAGE_SIZE;
        return () => this.fetchCatalogPage(offset);
      });
      const results = await runConcurrent(tasks, concurrency);
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        if (r.status === "fulfilled") {
          all.push(...r.value.results);
        } else {
          console.warn(`  NYC page ${i + 2} failed: ${r.reason}`);
        }
      }
    }

    const listings = all.slice(0, maxRecords ?? all.length).map(toListing);
    console.log(`  Fetched ${listings.length} NYC listings`);
    return listings;
  }

  /**
   * Fetch view detail (including attachment metadata with filenames).
   * @param id - Socrata view id (e.g. "m5vz-tzqv")
   */
  async fetchViewDetail(id: string): Promise<NYCViewDetail> {
    const res = await withRetry(() =>
      this.client.get<NYCViewDetail>(`${VIEW_PATH}/${id}.json`),
    );
    return res.data;
  }

  /**
   * Enrich listings into RFPDetail records by fetching view detail + attachment list.
   * @param listings - NYC listings from fetchAllListings
   * @param concurrency - Max concurrent requests (default 10)
   */
  async fetchDetails(
    listings: RFPListing[],
    concurrency: number = 10,
  ): Promise<RFPDetail[]> {
    const tasks = listings.map((listing) => async () => {
      const detail = await this.fetchViewDetail(listing.solicitationId);
      const attachments = buildAttachments(listing.solicitationId, detail);
      return toDetail(listing, detail, attachments);
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
        const msg =
          r.reason instanceof Error
            ? r.reason.message
            : String(r.reason ?? "unknown error");
        console.warn(`  NYC detail ${listings[i]!.solicitationId} ✗ (${msg})`);
      }
    }

    console.log(
      `  Fetched ${details.length}/${listings.length} NYC details${failed > 0 ? ` (${failed} failed)` : ""}`,
    );
    return details;
  }

  /**
   * Download all attachments for the given RFPs to dataDir/{id}/.
   */
  async downloadAttachments(
    rfps: RFPDetail[],
    dataDir: string,
    concurrency: number = 10,
  ): Promise<number> {
    const tasks: (() => Promise<string>)[] = [];

    for (const rfp of rfps) {
      if (rfp.source !== "nyc") continue;
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
        console.warn(`  NYC download failed: ${msg}`);
      }
    }

    console.log(
      `  Downloaded ${downloaded}/${tasks.length} NYC attachments${failed > 0 ? ` (${failed} failed)` : ""}`,
    );
    return downloaded;
  }

  private async downloadFile(fileURL: string, filePath: string): Promise<string> {
    const res = await withRetry(() =>
      this.client.get(fileURL, { responseType: "arraybuffer" }),
    );
    ensureDir(filePath);
    writeFileSync(filePath, Buffer.from(res.data));
    return filePath;
  }
}

// ---------- mapping helpers ----------

function formatDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function toListing(item: NYCCatalogItem): RFPListing {
  const r = item.resource;
  const agency =
    r.attribution ||
    item.classification.domain_metadata.find(
      (m) => m.key === "Dataset-Information_Agency",
    )?.value ||
    item.owner.display_name ||
    "";

  return {
    source: "nyc",
    internalid: r.id,
    title: r.name,
    solicitationId: r.id,
    responseDue: "",
    responseTime: "",
    agencyNumber: "",
    agencyName: agency,
    status: "open",
    statusName: r.type,
    postingDate: formatDate(r.createdAt),
    cancelledDate: "",
    created: r.createdAt,
    lastModified: r.updatedAt,
    // Join category columns + tags into a pseudo-NIGP field so keyword scoring
    // has structured signals beyond the free-text description.
    nigpCodes: [
      ...(r.columns_name ?? []),
      ...item.classification.domain_tags,
    ].join(", "),
    repostURL: "",
    url: item.link,
    detailUrl: item.permalink,
  };
}

function toDetail(
  listing: RFPListing,
  detail: NYCViewDetail,
  attachments: Attachment[],
): RFPDetail {
  return {
    ...listing,
    description: detail.description ?? "",
    contactName: "",
    contactNumber: "",
    contactEmail: "",
    value: "",
    attachments,
  };
}

function buildAttachments(
  viewId: string,
  detail: NYCViewDetail,
): Attachment[] {
  const list = detail.metadata?.attachments ?? [];
  const result: Attachment[] = [];
  for (const a of list) {
    const fileId = a.blobId || a.assetId;
    if (!fileId || !a.filename) continue;
    const url = `${VIEW_PATH}/${viewId}/files/${fileId}?download=true&filename=${encodeURIComponent(a.filename)}`;
    result.push({
      id: fileId,
      fileId,
      fileName: a.filename,
      fileURL: url,
      fileDescription: a.name ?? "",
    });
  }
  return result;
}
