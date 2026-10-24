import { db, getConfig } from "./db";
import { getBlobBytes } from "./github";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
  ico: "image/x-icon",
};

const ext = (path: string) => path.slice(path.lastIndexOf(".") + 1).toLowerCase();
export const isImagePath = (path: string) => ext(path) in MIME;

// Object URLs by blob sha, shared across notes for the life of the page.
const urls = new Map<string, Promise<string | null>>();

/**
 * Object URL for an image in the vault. Downloaded from GitHub on first use and
 * kept in IndexedDB, so it's available offline afterwards. Null if the file is
 * unknown, or offline and not cached yet.
 */
export async function imageUrl(path: string): Promise<string | null> {
  const sha = (await db.files.get(path))?.sha;
  if (!sha) return null;
  let url = urls.get(sha);
  if (!url) {
    url = loadImage(sha, MIME[ext(path)] ?? "application/octet-stream");
    urls.set(sha, url);
    // Don't cache failures: retry next time (e.g. once back online).
    void url.then((u) => u === null && urls.delete(sha));
  }
  return url;
}

async function loadImage(sha: string, type: string): Promise<string | null> {
  const cached = await db.blobs.get(sha);
  if (cached) return URL.createObjectURL(cached.data);
  const cfg = await getConfig();
  if (!cfg) return null;
  try {
    const data = new Blob([await getBlobBytes(cfg, sha)], { type });
    await db.blobs.put({ sha, data });
    return URL.createObjectURL(data);
  } catch {
    return null;
  }
}
