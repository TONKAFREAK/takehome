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
export function deduplicateByField<T extends { solicitationId: string; lastModified: string }>(
  items: T[]
): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    const existing = map.get(item.solicitationId);
    if (!existing || item.lastModified > existing.lastModified) {
      map.set(item.solicitationId, item);
    }
  }
  return Array.from(map.values());
}
