import Dexie, { type EntityTable } from "dexie";

export interface VaultConfig {
  token: string;
  owner: string;
  repo: string;
  branch: string;
}

/**
 * One row per file in the repo. Text files carry their content; binary files
 * (images, PDFs) only carry metadata for now.
 *
 * `base` is the content as of the last synced commit and is what 3-way merges
 * are computed against. `content` is what the user sees and edits.
 */
export interface VaultFile {
  path: string;
  /** Git blob sha of `base`; null for files created locally and never pushed. */
  sha: string | null;
  isText: boolean;
  content: string;
  base: string;
  dirty: boolean;
  deleted: boolean;
  updatedAt: number;
}

/** Downloaded bytes of binary files (images), keyed by git blob sha. */
export interface CachedBlob {
  sha: string;
  data: Blob;
}

interface KV {
  key: string;
  value: unknown;
}

class VaultDB extends Dexie {
  files!: EntityTable<VaultFile, "path">;
  kv!: EntityTable<KV, "key">;
  blobs!: EntityTable<CachedBlob, "sha">;

  constructor() {
    super("obsidian-note-access");
    this.version(1).stores({
      // Booleans aren't valid IndexedDB keys, so dirty/deleted are filtered, not indexed.
      files: "path",
      kv: "key",
    });
    this.version(2).stores({ blobs: "sha" });
  }
}

export const db = new VaultDB();

export async function getKV<T>(key: string): Promise<T | undefined> {
  return (await db.kv.get(key))?.value as T | undefined;
}

export async function setKV(key: string, value: unknown) {
  await db.kv.put({ key, value });
}

export const getConfig = () => getKV<VaultConfig>("config");
/** The commit the local `base` contents correspond to. */
export const getHeadOid = () => getKV<string>("headOid");

export async function resetVault() {
  await db.transaction("rw", db.files, db.kv, db.blobs, async () => {
    await db.files.clear();
    await db.kv.clear();
    await db.blobs.clear();
  });
}

/** Called by the editor (debounced) on every change. */
export async function saveContent(path: string, content: string) {
  await db.transaction("rw", db.files, async () => {
    const file = await db.files.get(path);
    if (!file) return;
    await db.files.update(path, {
      content,
      dirty: file.deleted || file.sha === null || content !== file.base,
      updatedAt: Date.now(),
    });
  });
}

export async function createFile(path: string, content = "") {
  const existing = await db.files.get(path);
  if (existing && !existing.deleted) throw new Error(`${path} already exists`);
  await db.files.put({
    path,
    sha: existing?.sha ?? null,
    isText: true,
    content,
    base: existing?.base ?? "",
    dirty: true,
    deleted: false,
    updatedAt: Date.now(),
  });
}

export async function deleteFile(path: string) {
  await db.transaction("rw", db.files, async () => {
    const file = await db.files.get(path);
    if (!file) return;
    // Never pushed: nothing to delete remotely.
    if (file.sha === null) await db.files.delete(path);
    else await db.files.update(path, { deleted: true, dirty: true, updatedAt: Date.now() });
  });
}

export async function renameFile(from: string, to: string) {
  const file = await db.files.get(from);
  if (!file) return;
  await createFile(to, file.content);
  await deleteFile(from);
}
