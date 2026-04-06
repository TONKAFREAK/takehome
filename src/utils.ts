import { mkdirSync, existsSync } from "fs";
import { dirname } from "path";

/**
 * Ensure a directory exists before writing a file.
 * @param filePath - Path to the file whose parent directory should exist
 */
export function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Format elapsed seconds as a human-readable string.
 * @param seconds - Elapsed time in seconds
 * @returns Formatted string like "2m 15s" or "45s"
 */
export function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Deduplicate items by solicitationId, keeping the one with the latest lastModified.
 * @param items - Array of objects with solicitationId and lastModified fields
 * @returns Deduplicated array
 */
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

/**
 * Promise-based delay.
 * @param ms - Milliseconds to wait
 * @returns Promise that resolves after the delay
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async function with exponential backoff.
 * @param fn - Async function to retry
 * @param maxRetries - Maximum number of retry attempts (default 3)
 * @param baseDelay - Base delay in ms, doubled each attempt (default 2000)
 * @returns The result of fn() on success
 * @throws The last error if all retries are exhausted
 */
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

/**
 * Strip HTML tags and decode common entities to plain text.
 * @param html - Raw HTML string
 * @returns Clean plain text
 */
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

/**
 * Truncate text to a max length, breaking at the last space.
 * @param text - Input string
 * @param maxLen - Maximum character length (default 250)
 * @returns Truncated string with "..." appended if cut
 */
export function truncate(text: string, maxLen: number = 250): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const last = cut.lastIndexOf(" ");
  return (last > 0 ? cut.slice(0, last) : cut) + "...";
}

/**
 * Escape HTML special characters for safe embedding in markup.
 * @param s - Raw string
 * @returns Escaped string with &, <, >, " replaced
 */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Generate a deterministic hue (0-359) from a string for consistent badge colors.
 * @param name - Category name
 * @returns Hue value for use in HSL colors
 */
export function categoryHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

/**
 * Calculate the number of days from today until a given date string.
 * @param dateStr - Date in MM/DD/YYYY format
 * @returns Number of days until the date (negative if past)
 */
export function daysUntil(dateStr: string): number {
  const parts = dateStr.split("/");
  if (parts.length !== 3) return 999;
  const [month, day, year] = parts;
  const due = new Date(Number(year), Number(month) - 1, Number(day));
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.ceil((due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Run async tasks with a concurrency limit using a worker pool.
 * @param tasks - Array of async task functions
 * @param concurrency - Max number of tasks running at once
 * @returns PromiseSettledResult for each task (fulfilled or rejected)
 */
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

/**
 * Format a numeric string as US currency with commas and 2 decimal places.
 * @param value - Raw value string (may contain commas)
 * @returns Formatted string like "1,234,567.00"
 */
export function formatCurrency(value: string): string {
  const num = parseFloat(value.replace(/,/g, ""));
  if (isNaN(num)) return value;
  return num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * Map days-until-due to a CSS urgency class name.
 * @param days - Number of days until the due date
 * @returns "overdue" | "urgent" | "soon" | "normal"
 */
export function urgencyClass(days: number): string {
  if (days < 0) return "overdue";
  if (days <= 3) return "urgent";
  if (days <= 7) return "soon";
  return "normal";
}
