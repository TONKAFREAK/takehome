import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";

/** Ensure a directory exists before writing a file */
export function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Format elapsed seconds as "Xm Ys" */
export function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Deduplicate RFPs by solicitationId, keeping the latest modified */
export function deduplicateByField<
  T extends { solicitationId: string; lastModified: string },
>(items: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    const existing = map.get(item.solicitationId);
    if (!existing || item.lastModified > existing.lastModified) {
      map.set(item.solicitationId, item);
    }
  }
  return Array.from(map.values());
}

/** Promise-based delay */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry a function with exponential backoff */
export async function withRetry<T>(
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

/** Strip HTML tags and decode common entities */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Truncate text to maxLen, breaking at last space */
export function truncate(text: string, maxLen: number = 250): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const last = cut.lastIndexOf(" ");
  return (last > 0 ? cut.slice(0, last) : cut) + "...";
}

/** Escape HTML special characters */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Generate a deterministic hue from a category name */
export function categoryHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

/** Calculate days from now until a MM/DD/YYYY date string */
export function daysUntil(dateStr: string): number {
  const parts = dateStr.split("/");
  if (parts.length !== 3) return 999;
  const [month, day, year] = parts;
  const due = new Date(Number(year), Number(month) - 1, Number(day));
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

/** Run async tasks with a concurrency limit */
export async function runConcurrent<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const idx = next++;
      try {
        results[idx] = { status: "fulfilled", value: await tasks[idx]!() };
      } catch (reason) {
        results[idx] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

/** Format a number string as $1,234,567.00 */
export function formatCurrency(value: string): string {
  const num = parseFloat(value.replace(/,/g, ""));
  if (isNaN(num)) return value;
  return num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Map days-until-due to a CSS urgency class */
export function urgencyClass(days: number): string {
  if (days < 0) return "overdue";
  if (days <= 3) return "urgent";
  if (days <= 7) return "soon";
  return "normal";
}
